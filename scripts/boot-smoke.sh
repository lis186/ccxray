#!/usr/bin/env bash
# Bounded boot smoke: start the server against an isolated CCXRAY_HOME, wait
# for the dashboard to answer HTTP 200, print the boot signal, exit 0/1.
# Never touches the real ~/.ccxray or the hub port.
#
# Usage: scripts/boot-smoke.sh [port]        (default 5642)
#   CCXRAY_HOME override respected; otherwise a throwaway mktemp dir.
#
# Evidence contract (pipeline runbook step 6): stdout carries the "listening"
# line + HTTP code; exit code is the verdict. Keep both in the PR evidence.
set -u

PORT="${1:-5642}"
HOME_DIR="${CCXRAY_HOME:-$(mktemp -d)}"
LOG="$(mktemp)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ANTHROPIC_BASE_URL inherited from a ccxray-proxied shell would trip the
# upstream-loop guard (42c80fb) or point upstream at the local hub — boot
# smoke must test default upstream config.
env -u ANTHROPIC_BASE_URL CCXRAY_HOME="$HOME_DIR" PROXY_PORT="$PORT" \
  node "$ROOT/server/index.js" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null' EXIT

for _ in $(seq 1 30); do  # ponytail: 15s hard bound, raise if slow machines ever miss it
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)
  if [ "$code" = "200" ]; then
    grep -m1 "listening" "$LOG" || true
    echo "BOOT OK: dashboard HTTP 200 on :$PORT"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break   # server died — stop waiting, dump log
  sleep 0.5
done

echo "BOOT FAIL: no dashboard HTTP 200 on :$PORT within bound" >&2
tail -20 "$LOG" >&2
exit 1
