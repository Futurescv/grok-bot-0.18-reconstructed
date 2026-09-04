#!/usr/bin/env bash
# Hold a local port open onto the in-box Sand gateway, and keep it open.
#
# Two failure modes made the naive `kubectl port-forward` unusable here:
#
#  * The default SPDY tunnel rots. Individual streams start failing with
#    "error creating error stream for port ...: Timeout occurred" while the
#    kubectl process stays alive, so a supervisor that only restarts on exit
#    never fires and the desktop client sees a dead gateway. Setting
#    KUBECTL_PORT_FORWARD_WEBSOCKETS switches to the WebSocket protocol
#    (portforward.k8s.io), which the 1.36 apiserver speaks and which does not
#    exhibit the rot. The env var is how kubectl 1.30 exposes the still-alpha
#    gate; newer kubectl builds default to it.
#  * Corporate proxy env vars capture cluster traffic, so they are cleared for
#    the child rather than relied on being unset in the caller's shell.
#
# Health is judged by probing /health *through* the tunnel, never by whether
# kubectl is still running.
set -uo pipefail

NS="${NS:-grok-bot}"
TARGET="${TARGET:-svc/grok-bot-box}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-11399}"
REMOTE_PORT="${REMOTE_PORT:-1340}"
# Space-separated local:remote pairs. Defaults to the single pair above.
PORTS="${PORTS:-$LOCAL_PORT:$REMOTE_PORT}"
# Probed through the tunnel to detect rot. Set to "none" for ports with nothing
# to probe -- the noVNC ports, where a single long-lived socket per viewer is
# exactly the traffic shape port-forward handles well, so process-exit is a good
# enough signal.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$LOCAL_PORT/health}"
LOG="${LOG:-/tmp/pf-supervisor.log}"
PROBE_INTERVAL="${PROBE_INTERVAL:-8}"
MAX_FAILS="${MAX_FAILS:-2}"

export KUBECONFIG="${KUBECONFIG:-$HOME/Documents/auth/acs-internal/k8s.yaml}"
export NO_PROXY='*'
export KUBECTL_PORT_FORWARD_WEBSOCKETS=true

note() { echo "$(date '+%H:%M:%S') $*" >>"$LOG"; }

note "supervisor start: $TARGET $PORTS (websockets)"
trap 'note "supervisor stop"; kill ${KPID:-0} 2>/dev/null; exit 0' INT TERM

while true; do
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy \
    kubectl -n "$NS" port-forward "$TARGET" $PORTS \
      --address "$BIND_ADDRESS" --request-timeout=0 \
    >>"$LOG" 2>&1 &
  KPID=$!
  fails=0
  while kill -0 "$KPID" 2>/dev/null; do
    sleep "$PROBE_INTERVAL"
    if [ "$HEALTH_URL" = "none" ] || curl -sf --noproxy '*' -m 5 -o /dev/null "$HEALTH_URL"; then
      fails=0
    else
      fails=$((fails + 1))
      note "health probe failed ($fails/$MAX_FAILS)"
      [ "$fails" -ge "$MAX_FAILS" ] && break
    fi
  done
  kill "$KPID" 2>/dev/null
  wait "$KPID" 2>/dev/null
  note "kubectl recycled"
  sleep 1
done
