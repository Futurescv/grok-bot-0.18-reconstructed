#!/usr/bin/env bash
# Launch the desktop app against the self-hosted ACS box.
#
# Three things have to be true or agent turns fail in ways that look like the
# app hanging rather than a misconfiguration:
#
#  * Proxy env vars must NOT leak into the app. With them set, boot took 137 s
#    (every Cursor backend call waited out the broken proxy) and the routed
#    provider's turn never produced a reply. Cleared, boot is ~7 s and a turn
#    answers in ~1.5 s. This is the single highest-value line in this script.
#  * SAND_HOST_GATEWAY_URL/TOKEN select the env-descriptor host connector
#    (box-host-connector.ts) and the API-key login session
#    (account/api-key-session.ts). Point the URL at gateway-proxy.mjs, not at
#    `kubectl port-forward` -- the port-forward tunnel rots under this client's
#    connection churn (measured 0/20 API calls through it, 20/20 through the
#    proxy).
#  * CLAUDE_CODE_PATH: non-Cursor providers run in the DESKTOP coordinator
#    (node-agent-coordinator/inference-router.ts intercepts sendPrompt), so the
#    claude CLI is spawned on this machine, not in the box. Electron's PATH does
#    not include nvm, so name the binary explicitly.
#
# Inference credentials and model: whatever ANTHROPIC_BASE_URL /
# ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY are exported here is what the local
# CLI uses -- they are inherited, so check them before blaming the app for
# answering as an unexpected model. Export nothing and it uses this machine's
# own Claude Code login instead.
#
# SAND_CLAUDE_MODEL pins the model and outranks ANTHROPIC_MODEL, because
# claudeExecutor passes it to the SDK as an explicit `model`
# (provider-session.ts:213-214) rather than letting the CLI pick its default.
# Use the plain API model name: the Claude Code "[1m]" context-window suffix is a
# CLI-level convention and the Messages API rejects it as an unknown model.
set -uo pipefail

APP="${APP:-/Applications/Grok Bot 0.18 Reconstructed.app}"
GATEWAY_URL="${SAND_HOST_GATEWAY_URL:-http://127.0.0.1:11340}"
LOG="${APP_LOG:-/tmp/app.log}"
CLAUDE_CLI="${CLAUDE_CODE_PATH:-$HOME/.local/bin/claude}"
MODEL="${SAND_CLAUDE_MODEL:-}"

token="${SAND_HOST_GATEWAY_TOKEN:-$(launchctl getenv SAND_HOST_GATEWAY_TOKEN 2>/dev/null)}"
[ -n "$token" ] || { echo "SAND_HOST_GATEWAY_TOKEN is not set (env or launchctl)" >&2; exit 1; }
[ -d "$APP" ] || { echo "no app bundle at $APP" >&2; exit 1; }
[ -x "$CLAUDE_CLI" ] || echo "warning: no claude CLI at $CLAUDE_CLI -- routed claude-code turns will fail" >&2

# Fail before the 7 s boot rather than after it, with a cover screen that only
# says the gateway is unreachable.
if ! curl -sf --noproxy '*' -m 8 -o /dev/null "$GATEWAY_URL/health"; then
  echo "gateway not answering at $GATEWAY_URL/health -- start deploy/acs/gateway-proxy.mjs first" >&2
  exit 1
fi

pkill -f "$APP" 2>/dev/null && sleep 3

env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy \
  NO_PROXY='*' no_proxy='*' \
  SAND_HOST_GATEWAY_URL="$GATEWAY_URL" SAND_HOST_GATEWAY_TOKEN="$token" \
  CLAUDE_CODE_PATH="$CLAUDE_CLI" \
  ${MODEL:+SAND_CLAUDE_MODEL="$MODEL"} \
  nohup "$APP/Contents/MacOS/Grok Bot" "$@" >"$LOG" 2>&1 &

echo "launched $APP (log: $LOG)"
echo "  gateway:  $GATEWAY_URL"
echo "  claude:   $CLAUDE_CLI"
echo "  model:    ${MODEL:-(CLI default; ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-unset})}"
echo "  endpoint: ${ANTHROPIC_BASE_URL:-(this machine own Claude Code login)}"
echo "pass --remote-debugging-port=9222 to drive the UI over CDP"
