/**
 * OpenAI Codex backend — forwards requests to OpenAI's Responses API
 * using ChatGPT subscription OAuth tokens.
 *
 * Requests arrive in Anthropic format (the router's internal format),
 * get translated to Codex Responses API format, sent upstream,
 * and responses are translated back to Anthropic format.
 */

import { AnthropicRequest, BackendResult, BackendOptions, CodexResponsesResponse } from '../types.js';
import { translateAnthropicToCodex, translateCodexToAnthropic, translateCodexStreamToAnthropic } from './codex-translator.js';
import { logger } from './logger.js';

// ChatGPT Plus/Pro OAuth tokens must use the ChatGPT backend endpoint
// (api.openai.com/v1/responses requires the api.responses.write scope
// which the Codex OAuth client doesn't grant)
const CODEX_API_URL = process.env.OPENAI_API_URL || 'https://chatgpt.com/backend-api/codex/responses';

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

  // Translate Anthropic request → Codex Responses API format
  const codexRequest = translateAnthropicToCodex(request);

  logger.info(`[openai] ${options.requestId} → ${CODEX_API_URL} model=${codexRequest.model} stream=${codexRequest.stream}`);

  const response = await fetch(CODEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
    },
    body: JSON.stringify(codexRequest),
  });

  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    // Non-streaming error — try to parse and translate
    let errorBody: string;
    try {
      errorBody = await response.text();
    } catch {
      errorBody = `OpenAI API error: ${response.status} ${response.statusText}`;
    }
    logger.error(`[openai] ${options.requestId} error ${response.status}: ${errorBody}`);
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  const isStream = response.headers.get('content-type')?.includes('text/event-stream') ?? false;

  if (isStream) {
    // Streaming — translate Codex SSE events to Anthropic SSE format
    const anthropicStream = translateCodexStreamToAnthropic(
      response.body as AsyncIterable<Uint8Array>,
      codexRequest.model,
    );
    return {
      status: response.status,
      isStream: true,
      stream: anthropicStream,
    };
  } else {
    // Non-streaming — parse and translate response
    const codexResponse = (await response.json()) as CodexResponsesResponse;
    const anthropicResponse = translateCodexToAnthropic(codexResponse, codexRequest.model);
    return {
      status: response.status,
      isStream: false,
      json: anthropicResponse,
    };
  }
}
