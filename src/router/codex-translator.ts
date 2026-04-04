/**
 * Translates between Anthropic Messages API format (the router's internal format)
 * and OpenAI Codex Responses API format.
 *
 * When the openai backend is selected, requests arrive in Anthropic format
 * (after translation by the existing translator if they came in as OpenAI chat/completions)
 * and need to be converted to Responses API format before hitting the OpenAI API.
 * Responses come back in Responses API format and need to be converted to Anthropic format
 * so the existing response pipeline (usage tracking, OpenAI translation, etc.) works unchanged.
 */

import {
  AnthropicRequest,
  AnthropicResponse,
  ContentBlock,
  CodexResponsesRequest,
  CodexResponsesResponse,
  CodexInputItem,
  CodexToolDefinition,
} from '../types.js';

/**
 * Default model for OpenAI Codex backend
 */
const DEFAULT_CODEX_MODEL = process.env.OPENAI_DEFAULT_MODEL || 'gpt-5.3-codex';

/**
 * Translate an Anthropic Messages request into a Codex Responses API request.
 */
export function translateAnthropicToCodex(request: AnthropicRequest): CodexResponsesRequest {
  // Build instructions from system messages
  let instructions: string | undefined;
  if (request.system && request.system.length > 0) {
    instructions = request.system.map((s) => s.text).join('\n\n');
  }

  // Build input items from messages
  const input: CodexInputItem[] = [];
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      input.push({
        role: msg.role,
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      // Handle content block arrays
      const parts: string[] = [];
      const toolResults: Array<{ call_id: string; output: string }> = [];

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Tool use from assistant — encode as assistant message text
          parts.push(JSON.stringify({
            tool_use: { id: block.id, name: block.name, input: block.input },
          }));
        } else if (block.type === 'tool_result') {
          // Tool results — collect for function_call_output items
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          toolResults.push({
            call_id: block.tool_use_id as string,
            output: resultContent,
          });
        }
      }

      if (parts.length > 0) {
        input.push({ role: msg.role, content: parts.join('\n') });
      }

      // Add function call outputs as separate items
      for (const tr of toolResults) {
        input.push({
          type: 'message',
          role: 'user',
          content: JSON.stringify({ function_call_output: tr }),
        });
      }
    }
  }

  // Build tools
  let tools: CodexToolDefinition[] | undefined;
  if (request.tools && request.tools.length > 0) {
    tools = request.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    }));
  }

  const codexRequest: CodexResponsesRequest = {
    model: DEFAULT_CODEX_MODEL,
    input,
    stream: request.stream ?? false,
    store: false,
  };

  if (instructions) {
    codexRequest.instructions = instructions;
  }

  if (tools) {
    codexRequest.tools = tools;
    codexRequest.tool_choice = 'auto';
  }

  if (request.max_tokens) {
    codexRequest.max_output_tokens = request.max_tokens;
  }

  return codexRequest;
}

/**
 * Translate a non-streaming Codex Responses API response into an Anthropic Messages response.
 */
export function translateCodexToAnthropic(
  codexResponse: CodexResponsesResponse,
  requestModel: string,
): AnthropicResponse {
  const content: ContentBlock[] = [];

  for (const item of codexResponse.output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text') {
          content.push({ type: 'text', text: part.text });
        }
      }
    }
  }

  // If no content was extracted, add an empty text block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: codexResponse.id,
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: codexResponse.status === 'completed' ? 'end_turn' : 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: codexResponse.usage?.input_tokens || 0,
      output_tokens: codexResponse.usage?.output_tokens || 0,
    },
  };
}

/**
 * Translate streaming Codex Responses API SSE events into Anthropic-format SSE events.
 *
 * The Codex streaming format uses events like:
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 *
 * We translate these into Anthropic-format SSE events that the existing
 * streaming pipeline (server.ts, translator.ts) already knows how to handle.
 */
export async function* translateCodexStreamToAnthropic(
  stream: AsyncIterable<Uint8Array>,
  requestModel: string,
): AsyncGenerator<Uint8Array, void, unknown> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let messageId = '';
  let outputIndex = 0;

  // Emit message_start
  const messageStart = {
    type: 'message_start',
    message: {
      id: `msg_codex_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: requestModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  yield encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

  // Emit content_block_start for first text block
  yield encoder.encode(
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
        continue;
      }

      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (currentEvent === 'response.created' || currentEvent === 'response.in_progress') {
            messageId = parsed.id || messageId;
            if (parsed.usage) {
              totalInputTokens = parsed.usage.input_tokens || 0;
            }
          } else if (currentEvent === 'response.output_text.delta') {
            // Text delta — translate to Anthropic content_block_delta
            const delta = parsed.delta ?? parsed.text ?? '';
            yield encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              })}\n\n`
            );
          } else if (currentEvent === 'response.completed') {
            // Final event with usage
            if (parsed.response?.usage || parsed.usage) {
              const usage = parsed.response?.usage || parsed.usage;
              totalInputTokens = usage.input_tokens || totalInputTokens;
              totalOutputTokens = usage.output_tokens || totalOutputTokens;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  // Emit content_block_stop
  yield encoder.encode(
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0,
    })}\n\n`
  );

  // Emit message_delta with stop reason and usage
  yield encoder.encode(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: totalOutputTokens },
    })}\n\n`
  );

  // Emit message_stop
  yield encoder.encode(
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  );
}
