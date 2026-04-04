import { AnthropicRequest, AnthropicResponse, BackendResult, BackendOptions, BackendExecutor } from '../types.js';
import { logger } from './logger.js';

// Anthropic API configuration (shared with server.ts)
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

/**
 * API backend — forwards requests to Anthropic API via HTTP fetch.
 * This is the existing behavior, extracted from server.ts.
 */
export async function apiBackend(
  request: AnthropicRequest,
  options: BackendOptions,
): Promise<BackendResult> {
  if (!options.accessToken) {
    throw new Error('API backend requires an access token');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    },
    body: JSON.stringify(request),
  });

  const isStream = response.headers.get('content-type')?.includes('text/event-stream') ?? false;

  if (isStream) {
    return {
      status: response.status,
      isStream: true,
      stream: response.body as AsyncIterable<Uint8Array>,
    };
  } else {
    const json = (await response.json()) as AnthropicResponse;
    return {
      status: response.status,
      isStream: false,
      json,
    };
  }
}

/**
 * Returns the configured backend executor based on BACKEND env var.
 * Defaults to 'api' if not set.
 */
export function getBackend(): BackendExecutor {
  const backendType = process.env.BACKEND || 'api';

  if (backendType === 'cli') {
    // Lazy import to avoid loading CLI deps when not needed
    let cliBackendFn: BackendExecutor | null = null;
    return async (request, options) => {
      if (!cliBackendFn) {
        const mod = await import('./cli-backend.js');
        cliBackendFn = mod.cliBackend;
      }
      return cliBackendFn(request, options);
    };
  }

  if (backendType === 'openai') {
    // Lazy import to avoid loading OpenAI deps when not needed
    let openaiBackendFn: BackendExecutor | null = null;
    return async (request, options) => {
      if (!openaiBackendFn) {
        const mod = await import('./openai-backend.js');
        openaiBackendFn = mod.openaiBackend;
      }
      return openaiBackendFn(request, options);
    };
  }

  if (backendType === 'ollama') {
    let ollamaBackendFn: BackendExecutor | null = null;
    return async (request, options) => {
      if (!ollamaBackendFn) {
        const mod = await import('./ollama-backend.js');
        ollamaBackendFn = mod.ollamaBackend;
      }
      return ollamaBackendFn(request, options);
    };
  }

  if (backendType !== 'api') {
    logger.info(`Unknown BACKEND="${backendType}", falling back to "api"`);
  }

  return apiBackend;
}

/** Returns the backend type string for display */
export function getBackendType(): string {
  return process.env.BACKEND || 'api';
}
