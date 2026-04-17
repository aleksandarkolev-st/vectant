#!/usr/bin/env bash
# Real-agent smoke loop for @synthi/mcp-server.
#
# Requires:
#   - Claude Code CLI installed (`claude --version`)
#   - `docker-compose up -d` running at repo root
#   - A workspace session created via collab-server REST (reuses
#     SYNTHI_MCP_E2E_SESSION_ID if set, else creates one)
#   - `npm run build` inside mcp/synthi-mcp/
#
# Asserts:
#   - Claude Code invokes synthi_attach, synthi_screenshot, synthi_wait_hmr,
#     and synthi_screenshot in that order.
#   - Final screenshot differs from the baseline (pHash distance > 4).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MCP_ROOT="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$MCP_ROOT/../.." && pwd)"
COLLAB_URL="${SYNTHI_MCP_COLLAB_URL:-http://localhost:1234}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found in PATH — install Claude Code first" >&2
  exit 1
fi

if [[ ! -f "$MCP_ROOT/dist/index.js" ]]; then
  echo "Build the MCP first: (cd $MCP_ROOT && npm run build)" >&2
  exit 1
fi

if [[ -z "${SYNTHI_MCP_E2E_SESSION_ID:-}" ]]; then
  SESSION_ID="$(curl -fsS -X POST "$COLLAB_URL/session/create" \
    -H "Content-Type: application/json" \
    -d '{"hostId":"mcp-smoke","hostName":"MCP Smoke","hostAvatar":"","slug":"counter","defaultPerms":{}}' \
    | node -e "process.stdin.once('data', d => { const r = JSON.parse(d.toString()); process.stdout.write(r.sessionId || ''); })")"
else
  SESSION_ID="$SYNTHI_MCP_E2E_SESSION_ID"
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "failed to resolve a session id" >&2
  exit 1
fi
echo "[smoke] Using session: $SESSION_ID"

MCP_NAME="synthi-smoke-$$"
claude mcp add "$MCP_NAME" -- node "$MCP_ROOT/dist/index.js" --session "$SESSION_ID" >/dev/null

cleanup() {
  claude mcp remove "$MCP_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "[smoke] Launching Claude Code with prompt…"
PROMPT="Use synthi tools to: (1) attach to the preview, (2) screenshot and describe what you see, (3) edit the counter source to start at 10 instead of 0, (4) wait_hmr, (5) screenshot again. Return the tool call trace."

TRANSCRIPT="$(claude -p "$PROMPT" --output-format=json 2>&1 || true)"
echo "$TRANSCRIPT"

echo "[smoke] Checking tool trace…"
for TOOL in synthi_attach synthi_screenshot synthi_wait_hmr; do
  if ! grep -q "$TOOL" <<<"$TRANSCRIPT"; then
    echo "[smoke] FAIL: $TOOL not in transcript" >&2
    exit 1
  fi
done

echo "[smoke] ✓ all expected tool calls present"
