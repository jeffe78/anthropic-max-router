#!/usr/bin/env node

import express, { Request, Response } from 'express';
import readline from 'readline';
import { getValidAccessToken, loadTokens, saveTokens } from '../token-manager.js';
import { startCliCredentialsWatcher } from '../cli-credentials-watcher.js';
import { startOAuthFlow, exchangeCodeForTokens } from '../oauth.js';
import { ensureRequiredSystemPrompt, stripUnknownFields } from './middleware.js';
import {
  AnthropicRequest,
  AnthropicResponse,
  BackendExecutor,
} from '../types.js';
import { logger } from './logger.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  initUsageTracker,
  logUsage,
  parseStreamTokens,
  extractFingerprint,
  buildFingerprintText,
  shutdownUsageTracker,
  startUsagePolling,
  stopUsagePolling,
} from './usage-tracker.js';
import { getBackend, getBackendType, ANTHROPIC_VERSION } from './backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

function createReadline() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Extracts bearer token from Authorization header
 * @param req Express request object
 * @returns Bearer token if present, null otherwise
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

// Endpoint configuration
const endpointConfig = {
  allowBearerPassthrough: true, // default - allow clients to use their own bearer tokens
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v') {
      console.log(`Anthropic MAX Plan Router v${packageJson.version}`);
      process.exit(0);
    }

    if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }

    if (arg === '--quiet' || arg === '-q') {
      logger.setLevel('quiet');
    } else if (arg === '--minimal' || arg === '-m') {
      logger.setLevel('minimal');
    } else if (arg === '--verbose' || arg === '-V') {
      logger.setLevel('maximum');
    } else if (arg === '--port' || arg === '-p') {
      const portValue = args[i + 1];
      if (portValue && !portValue.startsWith('-')) {
        PORT = parseInt(portValue);
        i++; // Skip next arg since we consumed it
      }
    } else if (arg === '--disable-bearer-passthrough') {
      endpointConfig.allowBearerPassthrough = false;
    } else if (arg === '--backend') {
      const backendValue = args[i + 1];
      if (backendValue && !backendValue.startsWith('-')) {
        process.env.BACKEND = backendValue;
        i++; // Skip next arg since we consumed it
      }
    }
    // medium is default, no flag needed
  }
}

function showHelp() {
  console.log(`
Anthropic MAX Plan Router v${packageJson.version}

Usage: npm run router [options]

Options:
  -h, --help                Show this help message
  -v, --version             Show version number
  -p, --port PORT           Port to listen on (default: 3000)

  Authentication control (default: passthrough enabled):
  --disable-bearer-passthrough  Force all requests to use router's OAuth tokens

  Backend selection (default: api):
  --backend api                 Use Anthropic API backend (default)
  --backend cli                 Use Claude Code CLI backend (claude -p)

  Verbosity levels (default: medium):
  -q, --quiet               Quiet mode - no request logging
  -m, --minimal             Minimal logging - one line per request
                            Default: Medium logging - summary per request
  -V, --verbose             Maximum logging - full request/response bodies

Environment variables:
  ROUTER_PORT               Port to listen on (default: 3000)
  BACKEND                   Backend type: "api" (default) or "cli"
  CLI_BARE_MODE             Set to "true" to skip hooks/CLAUDE.md in CLI backend
  CLI_TIMEOUT               CLI process timeout in ms (default: 300000)
  CLI_SESSION_TTL           CLI session TTL in ms (default: 3600000)
`);
}

let PORT = process.env.ROUTER_PORT ? parseInt(process.env.ROUTER_PORT) : 3000;
parseArgs();

const app = express();

// Backend executor — selected by BACKEND env var or --backend flag
const backend: BackendExecutor = getBackend();
const backendType = getBackendType();
const isCli = backendType === 'cli';

// Parse JSON request bodies with increased limit for large payloads
app.use(express.json({ limit: '50mb' }));

// Health check endpoint
const backendDisplayName = isCli ? 'Anthropic CLI' : 'Anthropic Max Pro';
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'anthropic-max-plan-router',
    account: process.env.ACCOUNT_LABEL || 'default',
    backend: backendDisplayName,
  });
});

// OpenAI Models endpoint - proxy to Anthropic API with API key
app.get('/v1/models', async (req: Request, res: Response) => {
  try {
    // Check for API key in headers
    const apiKey =
      req.headers['x-api-key'] ||
      (req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].substring(7)
        : null);

    if (!apiKey) {
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message:
            'x-api-key header is required for /v1/models endpoint. Note: API key is only used for this endpoint; other endpoints use OAuth authentication.',
        },
      });
      return;
    }

    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey as string,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      type: 'error',
      error: {
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'Failed to fetch models',
      },
    });
  }
});

// Shared handler for /v1/messages endpoint
const handleMessagesRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();
  const startTime = Date.now();

  // Optional usage tracking headers (use if present, null otherwise)
  const agent = (req.headers['x-agent'] as string) || null;
  const automation = (req.headers['x-automation'] as string) || null;

  try {
    // Get the request body and strip unknown fields (e.g., context_management from Agent SDK)
    const originalRequest = stripUnknownFields(req.body as Record<string, unknown>);

    // Extract fingerprint before modifying the request
    const fingerprint = extractFingerprint(req, originalRequest, 'anthropic');
    const fingerprint_text = buildFingerprintText(fingerprint);

    const hadSystemPrompt = !!(originalRequest.system && originalRequest.system.length > 0);

    // Ensure the required system prompt is present
    const modifiedRequest = ensureRequiredSystemPrompt(originalRequest);

    // Determine which authentication method to use (skip for CLI backend)
    let accessToken: string | undefined;
    if (!isCli) {
      const clientBearerToken = extractBearerToken(req);
      const usePassthrough = endpointConfig.allowBearerPassthrough && clientBearerToken !== null;

      if (usePassthrough) {
        accessToken = clientBearerToken!;
      } else {
        accessToken = await getValidAccessToken();
      }
    }

    const finalRequest = modifiedRequest;

    // Execute via the configured backend (API fetch or CLI spawn)
    const result = await backend(finalRequest, { requestId, accessToken });

    // Forward the status code and response
    if (result.isStream && result.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(result.status);

      // Parse streaming events to extract token counts
      const tokenAccumulator = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
      };
      const decoder = new TextDecoder();
      let sseBuffer = '';

      for await (const chunk of result.stream) {
        res.write(chunk);

        // Parse SSE events from chunk to extract usage
        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const event = JSON.parse(line.slice(6));
              parseStreamTokens(event, tokenAccumulator);
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
      res.end();

      // Log usage for streaming response
      logUsage({
        agent,
        automation,
        fingerprint,
        fingerprint_text,
        model: originalRequest.model,
        ...tokenAccumulator,
        duration_ms: Date.now() - startTime,
        status: result.status,
        stream: true,
        request_id: requestId,
      });

      logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
        status: result.status,
        data: undefined,
      });
    } else {
      const responseData = result.json as AnthropicResponse;

      // Log usage for non-streaming response
      logUsage({
        agent,
        automation,
        fingerprint,
        fingerprint_text,
        model: originalRequest.model,
        input_tokens: responseData.usage?.input_tokens || 0,
        output_tokens: responseData.usage?.output_tokens || 0,
        cache_read_tokens: responseData.usage?.cache_read_input_tokens || 0,
        cache_create_tokens: responseData.usage?.cache_creation_input_tokens || 0,
        duration_ms: Date.now() - startTime,
        status: result.status,
        stream: false,
        request_id: requestId,
      });

      res.status(result.status).json(responseData);
      logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
        status: result.status,
        data: responseData,
      });
    }
  } catch (error) {
    // Log the error
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error')
    );

    // Log failed request usage (build fingerprint from raw body if possible)
    const errorBody = req.body as AnthropicRequest;
    const errorFp = extractFingerprint(
      req,
      errorBody || { model: 'unknown', max_tokens: 0, messages: [] },
      'anthropic'
    );
    logUsage({
      agent,
      automation,
      fingerprint: errorFp,
      fingerprint_text: buildFingerprintText(errorFp),
      model: errorBody?.model || 'unknown',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      duration_ms: Date.now() - startTime,
      status: 500,
      stream: false,
      request_id: requestId,
    });

    // If headers were already sent (e.g., streaming response in progress),
    // we cannot send an error response - just log and return
    if (res.headersSent) {
      logger.error(`[${requestId}] Error occurred after headers sent:`, error);
      return;
    }

    // Handle specific error cases
    if (error instanceof Error) {
      res.status(500).json({
        error: {
          type: 'internal_error',
          message: error.message,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        type: 'internal_error',
        message: 'An unexpected error occurred',
      },
    });
  }
};

// Register Anthropic endpoint
app.post('/v1/messages', handleMessagesRequest);

// Route alias to handle Stagehand v3 SDK bug that doubles the /v1 prefix
app.post('/v1/v1/messages', handleMessagesRequest);

// Startup sequence
async function startRouter() {
  logger.startup('');
  logger.startup('███╗   ███╗ █████╗ ██╗  ██╗    ██████╗ ██╗      █████╗ ███╗   ██╗');
  logger.startup('████╗ ████║██╔══██╗╚██╗██╔╝    ██╔══██╗██║     ██╔══██╗████╗  ██║');
  logger.startup('██╔████╔██║███████║ ╚███╔╝     ██████╔╝██║     ███████║██╔██╗ ██║');
  logger.startup('██║╚██╔╝██║██╔══██║ ██╔██╗     ██╔═══╝ ██║     ██╔══██║██║╚██╗██║');
  logger.startup('██║ ╚═╝ ██║██║  ██║██╔╝ ██╗    ██║     ███████╗██║  ██║██║ ╚████║');
  logger.startup('╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝');
  logger.startup('                         ═══════ Router ═══════                     ');
  logger.startup('');

  // Initialize usage tracking (requires USAGE_DB_URL env var)
  initUsageTracker();

  if (isCli) {
    // CLI backend — no OAuth needed, claude CLI handles its own auth
    logger.startup(`🔧 Backend: CLI (claude -p)`);
    logger.startup('✅ Using Claude Code CLI subscription auth.');
    // Periodically push refreshed CLI credentials to the K8s Secret so a
    // fresh pod on a new node can recover without re-auth.
    startCliCredentialsWatcher();
  } else {
    // API backend — need OAuth tokens
    logger.startup(`🔧 Backend: API (Anthropic HTTP)`);

    // Check if we have tokens
    let tokens = await loadTokens();

    if (!tokens && !endpointConfig.allowBearerPassthrough) {
      // OAuth is required when bearer passthrough is disabled
      logger.startup('No OAuth tokens found. Starting authentication...');
      logger.startup('');

      const rl = createReadline();
      try {
        const { code, verifier, state } = await startOAuthFlow((prompt: string) => askQuestion(rl, prompt));
        logger.startup('✅ Authorization received');
        logger.startup('🔄 Exchanging for tokens...\n');

        const newTokens = await exchangeCodeForTokens(code, verifier, state);
        await saveTokens(newTokens);
        tokens = newTokens;

        logger.startup('✅ Authentication successful!');
        logger.startup('');
      } catch (error) {
        logger.error('❌ Authentication failed:', error instanceof Error ? error.message : error);
        rl.close();
        process.exit(1);
      }
      rl.close();
    } else {
      logger.startup('✅ OAuth tokens found.');
    }

    // Validate/refresh token (skip if no tokens and passthrough is enabled)
    if (tokens) {
      try {
        await getValidAccessToken();
        logger.startup('✅ Token validated.');
      } catch (error) {
        logger.error('❌ Token validation failed:', error);
        logger.info('Please delete .oauth-tokens.json and restart.');
        process.exit(1);
      }
    } else if (endpointConfig.allowBearerPassthrough) {
      logger.startup('⚠️  No OAuth tokens - bearer passthrough mode only');
    }
  }

  logger.startup('');

  // Start usage polling for API backends (they have OAuth tokens)
  if (!isCli) {
    startUsagePolling();
  }

  // Start the server
  app.listen(PORT, () => {
    logger.startup(`🚀 Router running on http://localhost:${PORT}`);
    logger.startup('');
    logger.startup('📋 Endpoints:');
    logger.startup(`   POST http://localhost:${PORT}/v1/messages`);
    logger.startup(`   GET  http://localhost:${PORT}/health`);
    logger.startup('');

    if (endpointConfig.allowBearerPassthrough) {
      logger.startup('🔑 Bearer token passthrough: ENABLED');
    } else {
      logger.startup('🔑 Bearer token passthrough: DISABLED - all requests use router OAuth');
    }

    logger.startup('');
  });
}

// Graceful shutdown — drain usage tracker pool and kill CLI processes
async function shutdown() {
  stopUsagePolling();
  await shutdownUsageTracker();
  if (isCli) {
    const { shutdownCliBackend } = await import('./cli-backend.js');
    shutdownCliBackend();
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await shutdown();
  process.exit(0);
});
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await shutdown();
  process.exit(0);
});

// Start the router
startRouter().catch((error) => {
  logger.error('Failed to start router:', error);
  process.exit(1);
});
