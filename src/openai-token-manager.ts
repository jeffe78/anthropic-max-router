/**
 * Token management for OpenAI Codex OAuth tokens.
 * Same pattern as token-manager.ts but uses OpenAI refresh endpoint.
 */

import fs from 'fs/promises';
import type { OpenAIOAuthTokens } from './types.js';
import { refreshOpenAIAccessToken } from './openai-oauth.js';
import { syncToSecret } from './k8s-secret-sync.js';

const TOKEN_FILE =
  process.env.OPENAI_TOKEN_FILE_PATH || process.env.TOKEN_FILE_PATH || '.openai-oauth-tokens.json';

/**
 * Save tokens to file (and write through to K8s Secret if running in-cluster).
 */
export async function saveOpenAITokens(tokens: OpenAIOAuthTokens): Promise<void> {
  const json = JSON.stringify(tokens, null, 2);
  await fs.writeFile(TOKEN_FILE, json, 'utf-8');
  console.log(`✅ OpenAI tokens saved to ${TOKEN_FILE}`);
  // Write-through to K8s Secret. No-op outside cluster, silent on failure.
  await syncToSecret('oauth-tokens.json', json);
}

/**
 * Load tokens from file
 */
export async function loadOpenAITokens(): Promise<OpenAIOAuthTokens | null> {
  try {
    const content = await fs.readFile(TOKEN_FILE, 'utf-8');
    return JSON.parse(content) as OpenAIOAuthTokens;
  } catch {
    return null;
  }
}

/**
 * Check if token is expired (with 5 minute buffer)
 */
export function isOpenAITokenExpired(tokens: OpenAIOAuthTokens): boolean {
  if (!tokens.expires_at) {
    return true;
  }
  const buffer = 5 * 60 * 1000; // 5 minutes
  return Date.now() >= tokens.expires_at - buffer;
}

/**
 * Get valid access token, refreshing if necessary
 */
export async function getValidOpenAIAccessToken(): Promise<string> {
  const tokens = await loadOpenAITokens();

  if (!tokens) {
    throw new Error('No OpenAI tokens found. Please run OAuth flow first.');
  }

  if (isOpenAITokenExpired(tokens)) {
    console.log('🔄 OpenAI token expired, refreshing...');
    const newTokens = await refreshOpenAIAccessToken(tokens.refresh_token);

    // Preserve refresh token if not returned
    if (!newTokens.refresh_token) {
      newTokens.refresh_token = tokens.refresh_token;
    }

    await saveOpenAITokens(newTokens);
    console.log('✅ OpenAI token refreshed');
    return newTokens.access_token;
  }

  return tokens.access_token;
}
