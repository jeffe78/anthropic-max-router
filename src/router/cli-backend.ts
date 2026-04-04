import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import {
  AnthropicRequest,
  AnthropicResponse,
  BackendResult,
  BackendOptions,
  CliEvent,
  CliResultEvent,
  CliAssistantEvent,
} from '../types.js';
import { logger } from './logger.js';

// Active child processes for cleanup on shutdown
const activeProcesses = new Set<ChildProcess>();

// Session map for multi-turn: fingerprint key -> session_id
const sessionMap = new Map<string, { sessionId: string; lastUsed: number }>();

// Session TTL (default 1 hour)
const SESSION_TTL_MS = parseInt(process.env.CLI_SESSION_TTL || '3600000', 10);

// Process timeout (default 5 minutes)
const PROCESS_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT || '300000', 10);

/**
 * Convert a structured Messages API request into a text prompt for `claude -p`.
 */
function buildPrompt(request: AnthropicRequest): string {
  const messages = request.messages;
  if (!messages || messages.length === 0) {
    return '';
  }

  // Single user message: just extract the text
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractTextContent(messages[0].content);
  }

  // Multi-turn: format as conversation transcript
  const parts: string[] = [];
  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    if (text) {
      parts.push(`${msg.role}: ${text}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract text from message content (string or ContentBlock array).
 */
function extractTextContent(content: string | Array<{ type: string; text?: string; [key: string]: unknown }>): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('\n');
  }
  return '';
}

/**
 * Build the system prompt string from structured system messages.
 * Skips the "You are Claude Code" prefix since the CLI already has it.
 */
function buildSystemPrompt(system?: Array<{ type: string; text: string }>): string | null {
  if (!system || system.length === 0) return null;

  const CLAUDE_CODE_PREFIX = 'You are Claude Code';
  const parts = system
    .map((s) => s.text)
    .filter((text) => !text.startsWith(CLAUDE_CODE_PREFIX));

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Clean up expired sessions.
 */
function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, entry] of sessionMap) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      sessionMap.delete(key);
    }
  }
}

/**
 * Parse a line of stream-json output into a typed event.
 */
function parseCliLine(line: string): CliEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CliEvent;
  } catch {
    return null;
  }
}

/**
 * Synthesize Anthropic SSE events from a CLI assistant message.
 * The CLI emits full message snapshots — we convert these to the SSE event
 * sequence that clients expect: message_start, content_block_start,
 * content_block_delta(s), content_block_stop, message_delta, message_stop.
 */
function synthesizeSSEFromMessage(message: AnthropicResponse): string[] {
  const events: string[] = [];

  // message_start
  events.push(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: message.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: message.usage?.input_tokens || 0, output_tokens: 0 },
    },
  })}\n\n`);

  // Emit content blocks (skip thinking blocks — just emit text)
  const textBlocks = (message.content || []).filter(
    (block) => block.type === 'text' && block.text,
  );

  for (let i = 0; i < textBlocks.length; i++) {
    const block = textBlocks[i];

    // content_block_start
    events.push(`data: ${JSON.stringify({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'text', text: '' },
    })}\n\n`);

    // content_block_delta — emit the full text as one delta
    events.push(`data: ${JSON.stringify({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'text_delta', text: block.text },
    })}\n\n`);

    // content_block_stop
    events.push(`data: ${JSON.stringify({
      type: 'content_block_stop',
      index: i,
    })}\n\n`);
  }

  // message_delta with final usage and stop_reason
  events.push(`data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null },
    usage: { output_tokens: message.usage?.output_tokens || 0 },
  })}\n\n`);

  // message_stop
  events.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

  return events;
}

/**
 * Async generator that converts `claude -p` stream-json stdout into
 * Anthropic SSE-formatted chunks.
 *
 * The CLI emits `assistant` events with full message snapshots (not granular
 * SSE events). We wait for the final assistant message and synthesize SSE
 * events from it.
 */
async function* cliStreamToSSE(
  proc: ChildProcess,
  collector: { result?: CliResultEvent },
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  let lastAssistantMessage: AnthropicResponse | null = null;

  for await (const line of rl) {
    const event = parseCliLine(line);
    if (!event) continue;

    if (event.type === 'assistant') {
      // Track the latest assistant message snapshot
      lastAssistantMessage = (event as CliAssistantEvent).message;
    } else if (event.type === 'result') {
      collector.result = event as CliResultEvent;
    }
  }

  // After process completes, synthesize SSE from the final message
  if (lastAssistantMessage) {
    const sseEvents = synthesizeSSEFromMessage(lastAssistantMessage);
    for (const sseEvent of sseEvents) {
      yield encoder.encode(sseEvent);
    }
  }
}

/**
 * Collect all stream-json output and return the assistant message for non-streaming.
 */
async function collectCliResponse(
  proc: ChildProcess,
): Promise<{ response: AnthropicResponse; result?: CliResultEvent }> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  let lastAssistantMessage: AnthropicResponse | null = null;
  let resultEvent: CliResultEvent | undefined;

  for await (const line of rl) {
    const event = parseCliLine(line);
    if (!event) continue;

    if (event.type === 'assistant') {
      lastAssistantMessage = (event as CliAssistantEvent).message;
    } else if (event.type === 'result') {
      resultEvent = event as CliResultEvent;
    }
  }

  if (!lastAssistantMessage) {
    // Fallback: construct a minimal response from the result event
    lastAssistantMessage = {
      id: `msg_cli_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: resultEvent?.result || '' }],
      model: 'unknown',
      stop_reason: resultEvent?.stop_reason || 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: resultEvent?.usage?.input_tokens || 0,
        output_tokens: resultEvent?.usage?.output_tokens || 0,
        cache_creation_input_tokens: resultEvent?.usage?.cache_creation_input_tokens || 0,
        cache_read_input_tokens: resultEvent?.usage?.cache_read_input_tokens || 0,
      },
    };
  }

  return { response: lastAssistantMessage, result: resultEvent };
}

/**
 * CLI backend — spawns `claude -p` and bridges stream-json output to Anthropic format.
 */
export async function cliBackend(
  request: AnthropicRequest,
  options: BackendOptions,
): Promise<BackendResult> {
  // Clean expired sessions periodically
  cleanExpiredSessions();

  const prompt = buildPrompt(request);
  const systemPrompt = buildSystemPrompt(request.system);
  const isStream = request.stream ?? false;

  // Build claude -p args
  const args: string[] = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', request.model,
    '--permission-mode', 'bypassPermissions',
  ];

  // System prompt (skip the "You are Claude Code" part — CLI already has it)
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  // Bare mode (skip hooks/CLAUDE.md discovery) if configured
  if (process.env.CLI_BARE_MODE === 'true') {
    args.push('--bare');
  }

  logger.info(`[${options.requestId}] CLI backend: spawning claude -p (model: ${request.model}, stream: ${isStream})`);

  // Spawn the process
  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  activeProcesses.add(proc);

  // Collect stderr for error reporting
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Set up timeout
  const timeout = setTimeout(() => {
    logger.info(`[${options.requestId}] CLI backend: process timeout after ${PROCESS_TIMEOUT_MS}ms, killing`);
    proc.kill('SIGTERM');
  }, PROCESS_TIMEOUT_MS);

  // Clean up on process exit
  proc.on('close', () => {
    clearTimeout(timeout);
    activeProcesses.delete(proc);
  });

  // Wait for the process to start producing output or fail
  return new Promise<BackendResult>((resolve, reject) => {
    let resolved = false;

    proc.on('error', (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(proc);
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      }
    });

    // Give the process a moment to fail on spawn errors
    // Then resolve with the streaming/non-streaming result
    setTimeout(() => {
      if (resolved) return;
      resolved = true;

      if (isStream) {
        const collector: { result?: CliResultEvent } = {};
        const stream = cliStreamToSSE(proc, collector);

        resolve({
          status: 200,
          isStream: true,
          stream,
        });
      } else {
        // For non-streaming, collect all output then resolve
        collectCliResponse(proc)
          .then(({ response }) => {
            resolve({
              status: 200,
              isStream: false,
              json: response,
            });
          })
          .catch((err) => {
            reject(new Error(`CLI backend error: ${err.message}. stderr: ${stderr}`));
          });
      }
    }, 100);
  });
}

/**
 * Kill all active CLI processes. Called on server shutdown.
 */
export function shutdownCliBackend(): void {
  for (const proc of activeProcesses) {
    proc.kill('SIGTERM');
  }
  activeProcesses.clear();
  sessionMap.clear();
}
