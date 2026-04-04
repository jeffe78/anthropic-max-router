/**
 * OAuth utilities for OpenAI Codex authentication (ChatGPT Plus/Pro subscriptions)
 *
 * Uses the same PKCE flow as Anthropic but against auth.openai.com endpoints
 * with the official Codex CLI client_id.
 */

import crypto from 'crypto';
import { URL } from 'url';
import type { OpenAIOAuthTokens } from './types.js';

export interface OpenAIOAuthConfig {
  client_id: string;
  authorize_url: string;
  token_url: string;
  redirect_uri: string;
  scope: string;
}

export const OPENAI_OAUTH_CONFIG: OpenAIOAuthConfig = {
  client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorize_url: 'https://auth.openai.com/oauth/authorize',
  token_url: 'https://auth.openai.com/oauth/token',
  redirect_uri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
};

/**
 * Generate PKCE code verifier and challenge
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Build authorization URL for OpenAI Codex OAuth flow
 */
export function getOpenAIAuthorizationUrl(codeChallenge: string, state: string): string {
  const url = new URL(OPENAI_OAUTH_CONFIG.authorize_url);
  url.searchParams.set('client_id', OPENAI_OAUTH_CONFIG.client_id);
  url.searchParams.set('redirect_uri', OPENAI_OAUTH_CONFIG.redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OPENAI_OAUTH_CONFIG.scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeOpenAICodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<OpenAIOAuthTokens> {
  // OpenAI uses standard OAuth form-urlencoded (unlike Anthropic's JSON)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OPENAI_OAUTH_CONFIG.client_id,
    redirect_uri: OPENAI_OAUTH_CONFIG.redirect_uri,
    code_verifier: codeVerifier,
    code,
  });

  const response = await fetch(OPENAI_OAUTH_CONFIG.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI token exchange failed: ${error}`);
  }

  const tokens = (await response.json()) as OpenAIOAuthTokens;
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  tokens.created_at = new Date().toISOString();
  return tokens;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshOpenAIAccessToken(refreshToken: string): Promise<OpenAIOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_OAUTH_CONFIG.client_id,
    refresh_token: refreshToken,
  });

  const response = await fetch(OPENAI_OAUTH_CONFIG.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI token refresh failed: ${error}`);
  }

  const tokens = (await response.json()) as OpenAIOAuthTokens;
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  tokens.created_at = new Date().toISOString();
  return tokens;
}

/**
 * Start interactive OpenAI OAuth flow
 */
export async function startOpenAIOAuthFlow(
  askQuestion: (prompt: string) => Promise<string>
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const authUrl = getOpenAIAuthorizationUrl(challenge, state);

  console.log('\n🔐 Starting OpenAI Codex OAuth flow...\n');
  console.log('Please visit this URL to authorize with your ChatGPT account:\n');
  console.log(authUrl);
  console.log('\n' + '='.repeat(70));
  console.log('After authorizing, the browser will redirect to localhost.');
  console.log('Copy the "code" parameter from the redirect URL and paste it below.');
  console.log('='.repeat(70) + '\n');

  const code = (await askQuestion('Paste authorization code here: ')).trim();

  if (!code) {
    throw new Error('No authorization code provided');
  }

  console.log('\n✅ Authorization code received!\n');
  return { code, verifier };
}
