#!/usr/bin/env bash
# Show status of all max-router instances on worldslab K3s.
#
# Usage: ./scripts/k8s-status.sh [namespace]
#
# Displays pods, services, and health check results with account labels.

set -euo pipefail

NAMESPACE="${1:-default}"
WORLDSLAB="worldslab.tailb1596.ts.net"

echo "=== Max Router K3s Status ==="
echo ""

echo "--- Pods ---"
kubectl get pods -n "$NAMESPACE" -l app=max-router -o wide 2>/dev/null || echo "  (no pods found or kubectl not configured)"
echo ""

echo "--- Services ---"
kubectl get svc -n "$NAMESPACE" -l app=max-router 2>/dev/null || echo "  (no services found)"
echo ""

echo "--- Health Checks ---"
for port in 30001 30002 30003; do
  printf "  :%d -> " "$port"
  result=$(curl -s --connect-timeout 3 "http://${WORLDSLAB}:${port}/health" 2>/dev/null) || result=""
  if [ -n "$result" ]; then
    account=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('account','?'))" 2>/dev/null || echo "?")
    status=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
    echo "status=$status  account=$account"
  else
    echo "UNREACHABLE"
  fi
done
echo ""

echo "--- PVCs ---"
kubectl get pvc -n "$NAMESPACE" -l app=max-router 2>/dev/null || echo "  (no PVCs found)"
echo ""

echo "--- Secrets ---"
kubectl get secrets -n "$NAMESPACE" | grep max-router 2>/dev/null || echo "  (no secrets found)"
