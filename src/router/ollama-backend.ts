/**
 * Ollama backend — forwards requests to a local Ollama instance
 * via its OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Requests arrive in Anthropic format (the router's internal format),
 * get translated to OpenAI Chat Completions format, sent to Ollama,
 * and responses are translated back to Anthropic format.
 */

import {
  AnthropicRequest,
  AnthropicResponse,
  BackendResult,
  BackendOptions,
  ContentBlock,
} from '../types.js';
import { logger } from './logger.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:26b-a4b-it-q8_0';

/**
 * OpenAI-compatible content part. Ollama's /v1/chat/completions accepts the
 * standard OpenAI multimodal content array shape: text parts and image_url
 * parts. When a message has only text, we still emit a plain string for
 * back-compat with older Ollama versions.
 */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Translate a single Anthropic content block into an OpenAI content part.
 * Returns null for unsupported block types (tool_use, tool_result), which
 * the caller drops — tool translation is not yet implemented in this backend.
 */
function translateContentBlock(block: ContentBlock): OpenAIContentPart | null {
  if (block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'image') {
    // Anthropic image block: { type: "image", source: { type: "base64", media_type, data } }
    //                    or: { type: "image", source: { type: "url", url } }
    const source = block.source as
      | { type: 'base64'; media_type: string; data: string }
      | { type: 'url'; url: string }
      | undefined;
    if (!source) return null;
    if (source.type === 'base64') {
      return {
        type: 'image_url',
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      };
    }
    if (source.type === 'url') {
      return { type: 'image_url', image_url: { url: source.url } };
    }
    return null;
  }
  return null;
}

/**
 * Convert Anthropic request to OpenAI Chat Completions format for Ollama.
 */
function translateToOllamaRequest(request: AnthropicRequest) {
  const messages: Array<{ role: string; content: string | OpenAIContentPart[] }> = [];

  // System messages
  if (request.system && request.system.length > 0) {
    const systemText = request.system.map((s) => s.text).join('\n\n');
    messages.push({ role: 'system', content: systemText });
  }

  // Conversation messages
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const parts = msg.content
      .map(translateContentBlock)
      .filter((p): p is OpenAIContentPart => p !== null);

    // If every part is text, collapse to a plain string for back-compat.
    // Otherwise emit the full multimodal parts array (required for image_url).
    const hasNonText = parts.some((p) => p.type !== 'text');
    if (!hasNonText) {
      const text = parts.map((p) => (p as { type: 'text'; text: string }).text).join('');
      messages.push({ role: msg.role, content: text });
    } else {
      messages.push({ role: msg.role, content: parts });
    }
  }

  return {
    model: OLLAMA_MODEL,
    messages,
    stream: request.stream ?? false,
    ...(request.max_tokens && { max_tokens: request.max_tokens }),
  };
}

/**
 * Parse a non-streaming OpenAI Chat Completions response into Anthropic format.
 */
function translateFromOllamaResponse(ollamaResp: Record<string, unknown>): AnthropicResponse {
  const choices = ollamaResp.choices as Array<{
    message?: { content?: string; reasoning?: string };
    finish_reason?: string;
  }>;
  const usage = ollamaResp.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
      }
    | undefined;

  const content = choices?.[0]?.message?.content || '';
  const reasoning = choices?.[0]?.message?.reasoning || '';
  // Use content if available; fall back to reasoning for thinking models like Gemma 4
  const text = content || reasoning;
  const finishReason = choices?.[0]?.finish_reason;

  let stopReason: string | null = 'end_turn';
  if (finishReason === 'length') stopReason = 'max_tokens';

  return {
    id: (ollamaResp.id as string) || `msg_ollama_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text } as ContentBlock],
    model: OLLAMA_MODEL,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

/**
 * Translate an Ollama OpenAI-format SSE stream into Anthropic SSE format.
 */
async function* translateOllamaStreamToAnthropic(
  stream: AsyncIterable<Uint8Array>,
  model: string
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_ollama_${Date.now()}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = '';

  // Emit message_start
  yield encoder.encode(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`
  );

  // Emit content_block_start
  yield encoder.encode(
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`
  );

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);

        // Extract usage if present (final chunk)
        if (event.usage) {
          inputTokens = event.usage.prompt_tokens || inputTokens;
          outputTokens = event.usage.completion_tokens || outputTokens;
        }

        const delta = event.choices?.[0]?.delta;
        // Emit content deltas; for thinking models, reasoning arrives before content
        const textDelta = delta?.content || delta?.reasoning;
        if (textDelta) {
          yield encoder.encode(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: textDelta },
            })}\n\n`
          );
        }
      } catch {
        // Ignore parse errors
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

  // Emit message_delta with usage
  // Include input_tokens here since message_start was emitted before we knew the count
  yield encoder.encode(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })}\n\n`
  );

  // Emit message_stop
  yield encoder.encode(
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  );
}

/**
 * Ollama backend — translates to OpenAI Chat Completions and proxies to Ollama.
 */
export async function ollamaBackend(
  request: AnthropicRequest,
  options: BackendOptions
): Promise<BackendResult> {
  const ollamaRequest = translateToOllamaRequest(request);
  const url = `${OLLAMA_URL}/v1/chat/completions`;

  logger.info(
    `[ollama] ${options.requestId} → ${url} model=${ollamaRequest.model} stream=${ollamaRequest.stream}`
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaRequest),
  });

  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = `Ollama error: ${response.status} ${response.statusText}`;
    }
    logger.error(`[ollama] ${options.requestId} error ${response.status}: ${errorBody}`);
    throw new Error(`Ollama error ${response.status}: ${errorBody}`);
  }

  const isStream = response.headers.get('content-type')?.includes('text/event-stream') ?? false;

  if (isStream) {
    const anthropicStream = translateOllamaStreamToAnthropic(
      response.body as AsyncIterable<Uint8Array>,
      ollamaRequest.model
    );
    return { status: 200, isStream: true, stream: anthropicStream };
  } else {
    const json = await response.json();
    const anthropicResponse = translateFromOllamaResponse(json as Record<string, unknown>);
    return { status: 200, isStream: false, json: anthropicResponse };
  }
}
