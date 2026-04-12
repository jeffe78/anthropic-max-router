import { Pool } from 'pg';
import { Request } from 'express';
import { AnthropicRequest } from '../types.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fingerprint {
  source_ip: string;
  endpoint: string; // 'anthropic' | 'openai'
  model: string;
  has_images: boolean;
  system_prefix: string; // first 300 chars of first system message
  tool_names: string[]; // names of tools in the request
  message_count: number;
}

export interface UsageRecord {
  // Explicit headers (optional — clients may or may not send these)
  agent: string | null;
  automation: string | null;
  // Request fingerprint
  fingerprint: Fingerprint;
  fingerprint_text: string; // human-readable summary for embedding
  // Usage metrics
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

// ---------------------------------------------------------------------------
// Postgres pool
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

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

  logger.startup('✅ Usage tracking enabled (Postgres + embeddings)');
}

// ---------------------------------------------------------------------------
// Fingerprint extraction
// ---------------------------------------------------------------------------

/**
 * Extract a fingerprint from an incoming request + parsed body.
 */
export function extractFingerprint(
  req: Request,
  body: AnthropicRequest,
  endpointType: 'anthropic' | 'openai'
): Fingerprint {
  // System prompt prefix
  let systemPrefix = '';
  const sys = body.system as unknown;
  if (sys) {
    if (typeof sys === 'string') {
      systemPrefix = sys.slice(0, 300);
    } else if (Array.isArray(sys) && sys.length > 0) {
      systemPrefix = ((sys[0] as Record<string, string>).text || '').slice(0, 300);
    }
  }

  // Check for images in messages
  let hasImages = false;
  for (const msg of body.messages || []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const blockType = block.type as string;
        if (blockType === 'image' || blockType === 'image_url') {
          hasImages = true;
          break;
        }
      }
    }
    if (hasImages) break;
  }

  // Tool names
  const toolNames = (body.tools || []).map((t) => t.name).sort();

  return {
    source_ip: req.ip || req.socket.remoteAddress || 'unknown',
    endpoint: endpointType,
    model: body.model || 'unknown',
    has_images: hasImages,
    system_prefix: systemPrefix,
    tool_names: toolNames,
    message_count: (body.messages || []).length,
  };
}

/**
 * Build a human-readable text summary of the fingerprint for embedding.
 * Designed to produce semantically meaningful text that clusters well.
 */
export function buildFingerprintText(fp: Fingerprint): string {
  const parts: string[] = [];

  parts.push(`endpoint:${fp.endpoint}`);
  parts.push(`model:${fp.model}`);
  parts.push(
    `source:${fp.source_ip === '127.0.0.1' || fp.source_ip === '::1' ? 'local' : 'remote'}`
  );

  if (fp.has_images) parts.push('has_images:true');
  if (fp.tool_names.length > 0) parts.push(`tools:${fp.tool_names.join(',')}`);

  parts.push(`messages:${fp.message_count}`);

  if (fp.system_prefix) {
    parts.push(`system:${fp.system_prefix}`);
  }

  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Embedding via Ollama
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://worldslab.tailb1596.ts.net:11434';

// nomic-embed-text has a 2048-token context window. fingerprint_text from
// openclaw agents can exceed 50k chars (huge tool lists), causing
// `the input length exceeds the context length` 500s and silent null embeddings.
// 4000 chars is the safe cap: real production fingerprints (commas + readable
// tool names) tokenize at ~4 chars/token so 4000 chars ≈ 1000 tokens, well
// under the 2048 limit. Adversarial content (lots of underscores, long
// snake_case identifiers) can hit ~2.5 chars/token, so 4000 still leaves
// margin even in worst-case tokenization. Head-truncation is fine for
// similarity clustering since the prefix carries the most signal.
const MAX_EMBED_INPUT_CHARS = 4000;

async function embed(text: string): Promise<number[] | null> {
  const input = text.length > MAX_EMBED_INPUT_CHARS ? text.slice(0, MAX_EMBED_INPUT_CHARS) : text;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: input }),
    });
    if (!resp.ok) {
      logger.error(`Embedding request failed: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { embedding: number[] };
    return data.embedding;
  } catch (err) {
    logger.error('Embedding error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming token parser
// ---------------------------------------------------------------------------

export function parseStreamTokens(
  event: Record<string, unknown>,
  accumulator: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
  }
): void {
  if (event.type === 'message_start') {
    const usage = (event.message as Record<string, unknown>)?.usage as
      | Record<string, number>
      | undefined;
    if (usage) {
      accumulator.input_tokens = usage.input_tokens || 0;
      accumulator.cache_read_tokens = usage.cache_read_input_tokens || 0;
      accumulator.cache_create_tokens = usage.cache_creation_input_tokens || 0;
    }
  } else if (event.type === 'message_delta') {
    const usage = event.usage as Record<string, number> | undefined;
    if (usage) {
      accumulator.output_tokens = usage.output_tokens || 0;
      // Non-API backends (CLI, OpenAI, Ollama) emit input_tokens here
      // since the count isn't known until after the stream completes
      if (usage.input_tokens) {
        accumulator.input_tokens = usage.input_tokens;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Client resolution
// ---------------------------------------------------------------------------

function resolveClient(fp: Fingerprint, agent: string | null): string {
  if (agent) return agent;
  if (fp.endpoint === 'openai') return 'ynab-categorizer';
  if (fp.has_images && !fp.system_prefix) return 'lastwar-automation';
  if (fp.system_prefix.includes('<instructions>') && fp.system_prefix.includes('Plan out actions'))
    return 'magnitude';
  const agentMatch = fp.system_prefix.match(/agent=(\S+)/);
  if (agentMatch) return agentMatch[1];
  if (fp.system_prefix.includes('OpenClaw')) return 'openclaw';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Log to Postgres (fire-and-forget)
// ---------------------------------------------------------------------------

export async function logUsage(record: UsageRecord): Promise<void> {
  if (!pool) return;

  try {
    // Embed the fingerprint text (async, but we await to get the vector before INSERT)
    const embedding = await embed(record.fingerprint_text);
    const client = resolveClient(record.fingerprint, record.agent);

    await pool.query(
      `INSERT INTO max_proxy_usage
        (agent, automation, model, input_tokens, output_tokens,
         cache_read_tokens, cache_create_tokens, duration_ms, status, stream,
         request_id, source_ip, endpoint, has_images, system_prompt,
         tool_names, message_count, fingerprint_text, embedding, account, instance, client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
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
        record.fingerprint.source_ip,
        record.fingerprint.endpoint,
        record.fingerprint.has_images,
        record.fingerprint.system_prefix,
        record.fingerprint.tool_names,
        record.fingerprint.message_count,
        record.fingerprint_text,
        embedding ? `[${embedding.join(',')}]` : null,
        process.env.ACCOUNT_LABEL || null,
        process.env.INSTANCE_LABEL || null,
        client,
      ]
    );
  } catch (err) {
    logger.error('Failed to log usage:', err);
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export async function shutdownUsageTracker(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Usage readings poller — polls /api/oauth/usage and writes to postgres
// ---------------------------------------------------------------------------

import { getValidAccessToken } from '../token-manager.js';

const USAGE_POLL_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

interface UsageReading {
  utilization: number;
  resets_at: string | null;
}

interface UsageResponse {
  five_hour: UsageReading | null;
  seven_day: UsageReading | null;
  seven_day_sonnet: UsageReading | null;
  extra_usage: {
    monthly_limit: number;
    used_credits: number;
  } | null;
}

async function pollUsageReadings(): Promise<void> {
  if (!pool) return;

  const account = process.env.ACCOUNT_LABEL;
  if (!account) {
    logger.error('Usage poll: ACCOUNT_LABEL not set, skipping');
    return;
  }

  try {
    const token = await getValidAccessToken();
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!resp.ok) {
      logger.error(`Usage poll: HTTP ${resp.status} — ${await resp.text()}`);
      return;
    }

    const data = (await resp.json()) as UsageResponse;

    await pool.query(
      `INSERT INTO max_proxy_usage_readings
        (account, five_hour_pct, five_hour_resets_at,
         seven_day_pct, seven_day_resets_at,
         seven_day_sonnet_pct, seven_day_sonnet_resets_at,
         extra_usage_limit, extra_usage_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        account,
        data.five_hour?.utilization ?? null,
        data.five_hour?.resets_at ?? null,
        data.seven_day?.utilization ?? null,
        data.seven_day?.resets_at ?? null,
        data.seven_day_sonnet?.utilization ?? null,
        data.seven_day_sonnet?.resets_at ?? null,
        data.extra_usage?.monthly_limit ?? null,
        data.extra_usage?.used_credits ?? null,
      ]
    );

    logger.info(`📊 Usage reading: ${account} — 5h: ${data.five_hour?.utilization ?? '?'}%, 7d: ${data.seven_day?.utilization ?? '?'}%`);
  } catch (err) {
    logger.error('Usage poll failed:', err);
  }
}

let usagePollTimer: ReturnType<typeof setInterval> | null = null;

export function startUsagePolling(): void {
  if (!pool) {
    logger.startup('⚠️  No DB pool — usage polling disabled');
    return;
  }

  // Poll once at startup (after a short delay for token readiness)
  setTimeout(() => pollUsageReadings(), 10_000);

  usagePollTimer = setInterval(() => pollUsageReadings(), USAGE_POLL_INTERVAL);
  logger.startup('📊 Usage polling enabled (every 2h)');
}

export function stopUsagePolling(): void {
  if (usagePollTimer) {
    clearInterval(usagePollTimer);
    usagePollTimer = null;
  }
}
