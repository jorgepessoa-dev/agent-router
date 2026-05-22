#!/usr/bin/env bash
# Launches Claude Code transparently through the local router.
# Usage: scripts/cc.sh [claude args...]
set -euo pipefail

ROUTER_PORT="${ROUTER_PORT:-8787}"
ROUTER_URL="http://localhost:${ROUTER_PORT}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Start the router if it is not already listening.
if ! curl -fsS "${ROUTER_URL}/health" >/dev/null 2>&1; then
  echo "[cc] starting router on ${ROUTER_URL} ..."
  (cd "$PROJECT_DIR" && npm start >/tmp/ccrouter.log 2>&1 &)
  for _ in $(seq 1 30); do
    if curl -fsS "${ROUTER_URL}/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! curl -fsS "${ROUTER_URL}/health" >/dev/null 2>&1; then
    echo "[cc] router failed to start; see /tmp/ccrouter.log" >&2
    exit 1
  fi
fi

# Point Claude Code at the router. The route-* sentinels let the router read
# each request's intended tier from its model field.
export ANTHROPIC_BASE_URL="$ROUTER_URL"
export ANTHROPIC_AUTH_TOKEN="router-local"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="route-haiku"
export ANTHROPIC_DEFAULT_SONNET_MODEL="route-sonnet"
export ANTHROPIC_DEFAULT_OPUS_MODEL="route-opus"
export ANTHROPIC_SMALL_FAST_MODEL="route-background"
export API_TIMEOUT_MS="3000000"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

echo
echo "[agent-router] routed -> MiniMax-M2.7 (cheap mode)"
echo "[agent-router] Claude Code self-reports Claude tier names; the actual model is MiniMax."
echo "[agent-router] dashboard: ${ROUTER_URL}/"
echo

exec claude "$@"
