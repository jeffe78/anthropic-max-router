/**
 * OpenAI Codex backend — forwards requests to OpenAI's Responses API
 * using ChatGPT subscription OAuth tokens.
 *
 * Requests arrive in Anthropic format (the router's internal format),
 * get translated to Codex Responses API format, sent upstream,
 * and responses are translated back to Anthropic format.
 *
 * The Codex Responses API requires stream=true, so we always stream
 * from upstream. If the client requested non-streaming, we buffer
 * the stream and return a complete Anthropic response object.
 */

import { AnthropicRequest, AnthropicResponse, BackendResult, BackendOptions, ContentBlock } from '../types.js';
import { translateAnthropicToCodex, translateCodexStreamToAnthropic } from './codex-translator.js';
import { logger } from './logger.js';

// ChatGPT Plus/Pro OAuth tokens must use the ChatGPT backend endpoint
// (api.openai.com/v1/responses requires the api.responses.write scope
// which the Codex OAuth client doesn't grant)
const CODEX_API_URL = process.env.OPENAI_API_URL || 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Buffer an Anthropic-format SSE stream into a complete response object.
 * Used when the client requested non-streaming but the upstream always streams.
 */
async function bufferStreamToResponse(
  stream: AsyncIterable<Uint8Array>,
  model: string,
): Promise<AnthropicResponse> {
  const decoder = new TextDecoder();
  let text = '';
  let messageId = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const lines = decoder.decode(chunk, { stream: true }).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (!data || data === '[DONE]') continue;
      try {
        const event = JSON.parse(data);
        if (event.type === 'message_start' && event.message) {
          messageId = event.message.id;
          inputTokens = event.message.usage?.input_tokens || 0;
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text;
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    id: messageId || `msg_codex_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text } as ContentBlock],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/**
 * OpenAI backend — translates to Codex Responses API and proxies upstream.
 */
export async function openaiBackend(
  request: AnthropicRequest,
  options: BackendOptions,
): Promise<BackendResult> {
  if (!options.accessToken) {
    throw new Error('OpenAI backend requires an access token');
  }

  const clientWantsStream = request.stream ?? false;

  // Translate Anthropic request → Codex Responses API format (always stream=true)
  const codexRequest = translateAnthropicToCodex(request);

  logger.info(`[openai] ${options.requestId} → ${CODEX_API_URL} model=${codexRequest.model} clientStream=${clientWantsStream}`);

  const response = await fetch(CODEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify(codexRequest),
  });

  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = `OpenAI API error: ${response.status} ${response.statusText}`;
    }
    logger.error(`[openai] ${options.requestId} error ${response.status}: ${errorBody}`);
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  // Translate Codex SSE events to Anthropic SSE format
  const anthropicStream = translateCodexStreamToAnthropic(
    response.body as AsyncIterable<Uint8Array>,
    codexRequest.model,
  );

  if (clientWantsStream) {
    // Client wants streaming — pass through the translated stream
    return {
      status: response.status,
      isStream: true,
      stream: anthropicStream,
    };
  } else {
    // Client wants non-streaming — buffer the stream into a complete response
    const anthropicResponse = await bufferStreamToResponse(anthropicStream, codexRequest.model);
    return {
      status: response.status,
      isStream: false,
      json: anthropicResponse,
    };
  }
}
