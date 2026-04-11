/**
 * Write-through sync to a Kubernetes Secret.
 *
 * After every successful token refresh, PATCH the K8s Secret that holds
 * the bootstrap credentials so a fresh pod (on any node) can recover
 * without a manual re-auth flow.
 *
 * If K8S_SECRET_NAME is unset (local dev, non-K8s), all calls are no-ops.
 * Failures are logged + counted but never thrown — a Secret PATCH failure
 * must not break the in-flight request.
 *
 * Uses the in-cluster ServiceAccount token directly via node's built-in
 * `https` module so we don't need to add @kubernetes/client-node as a
 * dependency.
 */

import https from 'https';
import fs from 'fs';

const SECRET_NAME = process.env.K8S_SECRET_NAME;

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

export let secretSyncSuccesses = 0;
export let secretSyncFailures = 0;

interface SaContext {
  token: string;
  ca: Buffer;
  namespace: string;
}

let cachedContext: SaContext | null = null;
let contextLoadFailed = false;

function loadServiceAccountContext(): SaContext | null {
  if (cachedContext) return cachedContext;
  if (contextLoadFailed) return null;
  try {
    cachedContext = {
      token: fs.readFileSync(SA_TOKEN_PATH, 'utf-8').trim(),
      ca: fs.readFileSync(SA_CA_PATH),
      namespace: fs.readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim(),
    };
    return cachedContext;
  } catch {
    contextLoadFailed = true;
    console.warn(
      `[k8s-secret-sync] Not running in-cluster (no ServiceAccount token at ${SA_TOKEN_PATH}). Sync disabled.`
    );
    return null;
  }
}

/**
 * Strategic-merge PATCH a single key in the configured K8s Secret.
 * Silent on failure.
 */
export async function syncToSecret(key: string, jsonValue: string): Promise<void> {
  if (!SECRET_NAME) return;
  const ctx = loadServiceAccountContext();
  if (!ctx) return;

  const base64 = Buffer.from(jsonValue, 'utf-8').toString('base64');
  const patchBody = JSON.stringify({ data: { [key]: base64 } });

  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'kubernetes.default.svc',
          port: 443,
          path: `/api/v1/namespaces/${encodeURIComponent(ctx.namespace)}/secrets/${encodeURIComponent(SECRET_NAME!)}`,
          method: 'PATCH',
          ca: ctx.ca,
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            'Content-Type': 'application/strategic-merge-patch+json',
            Accept: 'application/json',
            'Content-Length': Buffer.byteLength(patchBody),
          },
          timeout: 5000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('K8s API request timeout'));
      });
      req.write(patchBody);
      req.end();
    });

    if (result.status >= 200 && result.status < 300) {
      secretSyncSuccesses++;
      console.log(
        `[k8s-secret-sync] ✅ Updated ${ctx.namespace}/${SECRET_NAME} key=${key} (${secretSyncSuccesses} ok / ${secretSyncFailures} fail)`
      );
    } else {
      secretSyncFailures++;
      console.warn(
        `[k8s-secret-sync] ❌ HTTP ${result.status} updating ${ctx.namespace}/${SECRET_NAME} key=${key}: ${result.body.slice(0, 200)}`
      );
    }
  } catch (err: unknown) {
    secretSyncFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[k8s-secret-sync] ❌ Error updating ${SECRET_NAME} key=${key}: ${msg}`);
  }
}
