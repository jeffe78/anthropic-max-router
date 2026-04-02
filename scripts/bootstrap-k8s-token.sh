#!/usr/bin/env bash
# Bootstrap OAuth tokens for a K8s max-router instance.
#
# Usage: ./scripts/bootstrap-k8s-token.sh <secret-name> [namespace]
#
# 1. Runs the interactive OAuth CLI flow (opens browser, paste code#state)
# 2. Creates/updates a K8s Secret with the resulting token file
# 3. Tells you how to restart the pod to pick up new tokens
#
# Requires: kubectl configured for worldslab K3s

set -euo pipefail

SECRET_NAME="${1:?Usage: $0 <secret-name> [namespace]}"
NAMESPACE="${2:-default}"
TOKEN_FILE=".oauth-tokens.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Max Router OAuth Bootstrap ==="
echo "Secret:    $SECRET_NAME"
echo "Namespace: $NAMESPACE"
echo ""
echo "Starting OAuth flow... Log in with the account for this instance."
echo ""

cd "$REPO_DIR"

# Run the router interactively to trigger OAuth flow, then Ctrl-C after tokens are saved
node dist/router/server.js --port 0 --disable-bearer-passthrough 2>&1 &
ROUTER_PID=$!

# Wait for token file to appear (OAuth flow creates it)
echo "Waiting for OAuth flow to complete (token file to appear)..."
while [ ! -f "$TOKEN_FILE" ]; do
  sleep 1
done

# Give it a moment to finish writing
sleep 2

# Kill the router
kill $ROUTER_PID 2>/dev/null || true
wait $ROUTER_PID 2>/dev/null || true

if [ ! -s "$TOKEN_FILE" ]; then
  echo "ERROR: Token file is empty or missing. OAuth flow may have failed."
  exit 1
fi

echo ""
echo "Token file created. Creating K8s secret..."

kubectl create secret generic "$SECRET_NAME" \
  --from-file=oauth-tokens.json="$TOKEN_FILE" \
  --namespace="$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret $SECRET_NAME created/updated in namespace $NAMESPACE"

rm -f "$TOKEN_FILE"
echo "Local token file cleaned up."

echo ""
echo "Done! If the pod is already running, restart it:"
echo "  kubectl rollout restart deployment/<instance-name> -n $NAMESPACE"
