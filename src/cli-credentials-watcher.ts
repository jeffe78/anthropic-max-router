/**
 * Periodic poller that watches the Anthropic CLI's `.credentials.json` file
 * and pushes any changes through to the K8s Secret.
 *
 * Only used when BACKEND=cli. The Claude CLI manages its own OAuth refresh
 * inside the spawned subprocess and the router has no direct visibility
 * into refresh events. Polling beats fs.watch for reliability across
 * local-path filesystems.
 *
 * Worst-case window between a CLI refresh and the K8s Secret update is one
 * poll interval (5 minutes).
 */

import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { syncToSecret } from './k8s-secret-sync.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const CLI_CREDS_PATH = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');

let lastHash: string | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

async function pollOnce(): Promise<void> {
  let contents: string;
  try {
    contents = await fs.readFile(CLI_CREDS_PATH, 'utf-8');
  } catch {
    // File may not exist yet (CLI hasn't authenticated). Skip silently.
    return;
  }

  const hash = crypto.createHash('sha256').update(contents).digest('hex');
  if (hash === lastHash) return;

  console.log(
    `[cli-credentials-watcher] Detected ${CLI_CREDS_PATH} change (hash ${hash.slice(0, 12)}), syncing to Secret`
  );
  await syncToSecret('.credentials.json', contents);
  lastHash = hash;
}

/**
 * Start the periodic watcher. Idempotent — calling twice does nothing.
 * No-op if K8S_SECRET_NAME is unset (handled inside syncToSecret).
 */
export function startCliCredentialsWatcher(): void {
  if (intervalHandle) return;
  if (!process.env.K8S_SECRET_NAME) {
    console.log('[cli-credentials-watcher] K8S_SECRET_NAME unset, watcher disabled');
    return;
  }

  console.log(
    `[cli-credentials-watcher] Starting ${POLL_INTERVAL_MS / 1000}s poller on ${CLI_CREDS_PATH}`
  );
  // Run once immediately so the Secret picks up any pre-existing creds.
  void pollOnce();
  intervalHandle = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
}
