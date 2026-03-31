import { Pool } from 'pg';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

export interface UsageRecord {
  agent: string;
  automation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  duration_ms: number;
  status: number;
  stream: boolean;
  request_id: string;
}

let pool: Pool | null = null;

/**
 * Initialize the Postgres connection pool for usage tracking.
 * Call once at startup. If USAGE_DB_URL is not set, logging is disabled (requests still pass through).
 */
export function initUsageTracker(): void {
  const connectionString = process.env.USAGE_DB_URL;
  if (!connectionString) {
    logger.startup('⚠️  USAGE_DB_URL not set — usage tracking disabled');
    return;
  }

  pool = new Pool({ connectionString, max: 5 });

  pool.on('error', (err) => {
    logger.error('Usage tracker pool error:', err);
  });

  logger.startup('✅ Usage tracking enabled (Postgres)');
}

/**
 * Express middleware that enforces X-Agent and X-Automation headers.
 * Returns 400 if either is missing. Skips /health and /v1/models.
 */
export function requireUsageHeaders(req: Request, res: Response, next: NextFunction): void {
  // Skip non-proxied endpoints
  if (req.path === '/health' || req.path === '/v1/models') {
    next();
    return;
  }

  const agent = req.headers['x-agent'] as string | undefined;
  const automation = req.headers['x-automation'] as string | undefined;

  if (!agent || !automation) {
    const missing: string[] = [];
    if (!agent) missing.push('X-Agent');
    if (!automation) missing.push('X-Automation');

    res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Missing required header(s): ${missing.join(', ')}. All requests must include X-Agent and X-Automation headers.`,
      },
    });
    return;
  }

  next();
}

/**
 * Write a usage record to Postgres. Fire-and-forget — errors are logged but never block the response.
 */
export async function logUsage(record: UsageRecord): Promise<void> {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO max_proxy_usage
        (agent, automation, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, duration_ms, status, stream, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.agent,
        record.automation,
        record.model,
        record.input_tokens,
        record.output_tokens,
        record.cache_read_tokens,
        record.cache_create_tokens,
        record.duration_ms,
        record.status,
        record.stream,
        record.request_id,
      ]
    );
  } catch (err) {
    logger.error('Failed to log usage:', err);
  }
}

/**
 * Parse token usage from Anthropic SSE stream events.
 * Call with each parsed SSE data object during streaming.
 */
export function parseStreamTokens(
  event: Record<string, unknown>,
  accumulator: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_create_tokens: number }
): void {
  if (event.type === 'message_start') {
    const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
    if (usage) {
      accumulator.input_tokens = usage.input_tokens || 0;
      accumulator.cache_read_tokens = usage.cache_read_input_tokens || 0;
      accumulator.cache_create_tokens = usage.cache_creation_input_tokens || 0;
    }
  } else if (event.type === 'message_delta') {
    const usage = event.usage as Record<string, number> | undefined;
    if (usage) {
      accumulator.output_tokens = usage.output_tokens || 0;
    }
  }
}

/**
 * Graceful shutdown — drain the pool.
 */
export async function shutdownUsageTracker(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
