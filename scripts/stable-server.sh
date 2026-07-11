#!/usr/bin/env bash
# Stable monitoring-server swap: pin a worktree to a merged ref, verify it
# boots on a side port, then gracefully swap the live server — with automatic
# rollback to --rollback-ref if the new pin fails to serve.
#
# Single invocation contains verify → swap → post-check → rollback, so the
# operator (or an agent whose own traffic rides this proxy) never has to make
# a mid-flight decision. Idempotent: already-at-ref + healthy → exit 0.
#
# Usage:
#   scripts/stable-server.sh --worktree <path> --ref <sha|origin/main> \
#       --rollback-ref <sha> [--port 5577] [--idle-min 3] [--force]
#
# Exit: 0 = serving requested ref   1 = swap failed, ROLLED BACK OK
#       2 = auto-recovery failed (worktree or server may need manual fix)
#       3 = precondition/usage error (nothing touched)
set -u

WORKTREE="" REF="" ROLLBACK="" PORT=5577 IDLE_MIN=3 FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree) WORKTREE="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --rollback-ref) ROLLBACK="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --idle-min) IDLE_MIN="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 3 ;;
  esac
done
[[ -n "$WORKTREE" && -n "$REF" && -n "$ROLLBACK" ]] || { echo "need --worktree --ref --rollback-ref" >&2; exit 3; }
[[ -d "$WORKTREE" ]] || { echo "worktree not found: $WORKTREE" >&2; exit 3; }
WORKTREE_ABS="$(cd "$WORKTREE" && pwd -P)"

LOG="${HOME}/.ccxray/stable-server.log"
LOCKDIR="${HOME}/.ccxray/stable-server.lock"
say() { echo "[stable-server] $*"; }

# ── canonicalization ──────────────────────────────────────────────────────
canon() { (cd "$(dirname "$1")" 2>/dev/null && echo "$(pwd -P)/$(basename "$1")") || echo "$1"; }

# ── serialisation ─────────────────────────────────────────────────────────
mkdir "$LOCKDIR" 2>/dev/null || { echo "another stable-server is running (lock: $LOCKDIR)" >&2; exit 3; }
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# ── identity helpers ──────────────────────────────────────────────────────
# is_ccxray_process PID — true when PID is `node server/index.js` (argv[0]
# ends with /node or is literally "node", argv[1] is exactly
# "server/index.js") and its cwd is exactly WORKTREE_ABS.
is_ccxray_process() {
  local pid="$1"
  local cmd
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  # Parse argv tokens: $1=executable, $2=script.  A flag before the script
  # (e.g. node -e "..." server/index.js) makes $2="-e", not the script.
  local exe script
  exe=$(awk '{print $1}' <<< "$cmd")
  script=$(awk '{print $2}' <<< "$cmd")
  [[ "$(basename "$exe")" == "node" ]] || return 1
  [[ "$script" == "server/index.js" ]] || return 1
  # Verify the script file exists at the expected path
  [[ -f "$WORKTREE_ABS/server/index.js" ]] || return 1
  # Verify cwd is exactly the worktree (canonicalized)
  local cwd
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2-)
  [[ -z "$cwd" ]] && return 1
  cwd="$(canon "$cwd")"
  [[ "$cwd" == "$WORKTREE_ABS" ]] || return 1
  return 0
}

listener_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# ── preconditions ─────────────────────────────────────────────────────────
git -C "$WORKTREE" diff --quiet && git -C "$WORKTREE" diff --cached --quiet \
  || { echo "worktree dirty — refusing to move pin: $WORKTREE" >&2; exit 3; }
git -C "$WORKTREE" fetch origin --quiet || { echo "git fetch failed" >&2; exit 3; }
TARGET=$(git -C "$WORKTREE" rev-parse --verify "$REF^{commit}" 2>/dev/null) || { echo "bad --ref: $REF" >&2; exit 3; }
git -C "$WORKTREE" rev-parse --verify "$ROLLBACK^{commit}" >/dev/null 2>&1 || { echo "bad --rollback-ref: $ROLLBACK" >&2; exit 3; }
CUR=$(git -C "$WORKTREE" rev-parse HEAD)

health() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; }

# Idempotence: already at target, serving, AND listener is our ccxray → done.
if [[ "$CUR" == "$TARGET" ]] && health; then
  LP=$(listener_pid)
  if [[ -n "$LP" ]] && is_ccxray_process "$LP"; then
    say "already at $(git -C "$WORKTREE" rev-parse --short "$TARGET") and healthy on :$PORT (pid $LP)"
    exit 0
  fi
fi

# ── idle check (skippable with --force) ───────────────────────────────────
if [[ "$FORCE" -ne 1 ]] && health; then
  LAST_MS=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/_api/entries" 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const es=JSON.parse(d).entries;const last=es[es.length-1];console.log(last?Math.round(Number(last.receivedAt)+(parseFloat(last.elapsed)||0)*1000):0)}catch(e){console.log(0)}})")
  NOW_MS=$(node -e 'console.log(Date.now())')
  AGE_MIN=$(( (NOW_MS - LAST_MS) / 60000 ))
  if [[ "$LAST_MS" -gt 0 && "$AGE_MIN" -lt "$IDLE_MIN" ]]; then
    echo "not idle: last activity ${AGE_MIN}m ago (< ${IDLE_MIN}m). Re-run with --force to swap anyway." >&2
    exit 3
  fi
fi

# ── checked pin + deps restore ────────────────────────────────────────────
restore_pin() {
  local to="$1" from="$2"
  if ! git -C "$WORKTREE" checkout --detach --quiet "$to"; then
    say "ERROR: checkout $to failed"
    return 1
  fi
  if ! git -C "$WORKTREE" diff --quiet "$from" "$to" -- package-lock.json 2>/dev/null; then
    say "package-lock changed ($from → $to) — npm ci"
    if ! (cd "$WORKTREE" && npm ci --silent); then
      say "ERROR: npm ci failed for $to"
      return 1
    fi
  fi
  return 0
}

# ── side-port verification (live server untouched) ────────────────────────
side_verify() {
  restore_pin "$1" "$CUR" || return 1
  local SIDE=$(( PORT + 71 ))
  if [[ -x "$WORKTREE/scripts/boot-smoke.sh" ]]; then
    "$WORKTREE/scripts/boot-smoke.sh" "$SIDE" || return 1
  else
    local SMOKE_HOME SMOKE_LOG BP _smoke_trapped_sig=""
    SMOKE_HOME="$(mktemp -d)"
    SMOKE_LOG="$(mktemp)"
    local _smoke_cleanup_done=0
    _smoke_cleanup() {
      [[ "$_smoke_cleanup_done" -eq 1 ]] && return; _smoke_cleanup_done=1
      kill "$BP" 2>/dev/null; wait "$BP" 2>/dev/null
      rm -rf "$SMOKE_HOME" "$SMOKE_LOG"
    }
    _smoke_signal_handler() {
      _smoke_trapped_sig="$1"
      _smoke_cleanup
      trap - "$1"
      kill -s "$1" $$
    }
    env -u ANTHROPIC_BASE_URL CCXRAY_HOME="$SMOKE_HOME" PROXY_PORT="$SIDE" \
      node "$WORKTREE/server/index.js" >"$SMOKE_LOG" 2>&1 & BP=$!
    # Trap installed AFTER BP is assigned (set -u safe)
    trap '_smoke_cleanup' RETURN
    trap '_smoke_signal_handler INT' INT
    trap '_smoke_signal_handler TERM' TERM
    local ok=1
    for _ in $(seq 1 30); do
      if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SIDE/" 2>/dev/null)" = "200" ]; then
        local side_lp
        side_lp=$(lsof -nP -iTCP:"$SIDE" -sTCP:LISTEN -t 2>/dev/null | head -1)
        if [[ "$side_lp" == "$BP" ]]; then
          grep -m1 "listening" "$SMOKE_LOG" || true
          say "BOOT OK: dashboard HTTP 200 on :$SIDE (pid $BP)"
          ok=0; break
        fi
      fi
      kill -0 "$BP" 2>/dev/null || break
      sleep 0.5
    done
    if [[ "$ok" -ne 0 ]]; then
      say "BOOT FAIL: no dashboard HTTP 200 on :$SIDE within bound"
      tail -20 "$SMOKE_LOG" >&2
    fi
    _smoke_cleanup
    trap - RETURN INT TERM
    return $ok
  fi
}

# ── swap with identity verification ───────────────────────────────────────
swap_to() {
  local commit="$1"
  local head_now
  head_now=$(git -C "$WORKTREE" rev-parse HEAD)
  if [[ "$head_now" != "$(git -C "$WORKTREE" rev-parse --verify "$commit^{commit}" 2>/dev/null)" ]]; then
    git -C "$WORKTREE" checkout --detach --quiet "$commit" || return 1
  fi

  local OLD_PID
  OLD_PID=$(listener_pid)
  if [[ -n "$OLD_PID" ]]; then
    if ! is_ccxray_process "$OLD_PID"; then
      say "ERROR: pid $OLD_PID on :$PORT is NOT a ccxray process in $WORKTREE_ABS — refusing to kill"
      return 1
    fi
    kill "$OLD_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      say "ERROR: old listener (pid $OLD_PID) did not exit within 10s"
      return 1
    fi
    local stale
    stale=$(listener_pid)
    if [[ -n "$stale" ]]; then
      say "ERROR: port :$PORT still occupied by pid $stale after old listener exited"
      return 1
    fi
  fi

  (cd "$WORKTREE" && trap '' HUP && exec env -u ANTHROPIC_BASE_URL PROXY_PORT="$PORT" \
    node server/index.js >> "$LOG" 2>&1) </dev/null &
  local NEW_PID=$!
  disown "$NEW_PID" 2>/dev/null

  for _ in $(seq 1 30); do
    if health; then
      local live_pid
      live_pid=$(listener_pid)
      if [[ "$live_pid" == "$NEW_PID" ]]; then
        return 0
      fi
    fi
    kill -0 "$NEW_PID" 2>/dev/null || { say "ERROR: new server (pid $NEW_PID) died during startup"; return 1; }
    sleep 0.5
  done
  say "ERROR: new server (pid $NEW_PID) did not become healthy within 15s"
  kill "$NEW_PID" 2>/dev/null
  return 1
}

say "verifying $(git -C "$WORKTREE" rev-parse --short "$TARGET") on side port before touching :$PORT"
if ! side_verify "$TARGET"; then
  say "side-port verification FAILED — restoring pin+deps, live server untouched"
  if ! restore_pin "$CUR" "$TARGET"; then
    echo "[stable-server] FATAL: side-verify failed AND pin restore failed — worktree at wrong ref." >&2
    echo "  manual recovery: (cd $WORKTREE && git checkout --detach $CUR && npm ci --silent)" >&2
    exit 2
  fi
  exit 1
fi

say "swapping :$PORT to $(git -C "$WORKTREE" rev-parse --short "$TARGET")"
if swap_to "$TARGET"; then
  say "OK — :$PORT serving $(git -C "$WORKTREE" rev-parse --short HEAD) pid $(listener_pid) (log: $LOG)"
  exit 0
fi

# ── rollback ──────────────────────────────────────────────────────────────
say "swap FAILED — rolling back to $(git -C "$WORKTREE" rev-parse --short "$ROLLBACK")"

if ! restore_pin "$ROLLBACK" "$TARGET"; then
  echo "[stable-server] FATAL: rollback pin+deps failed — :$PORT may be DOWN." >&2
  echo "  manual recovery: (cd $WORKTREE && git checkout --detach $ROLLBACK && npm ci --silent && env -u ANTHROPIC_BASE_URL PROXY_PORT=$PORT nohup node server/index.js >> $LOG 2>&1 &)" >&2
  exit 2
fi

if swap_to "$ROLLBACK"; then
  say "rolled back — :$PORT serving $(git -C "$WORKTREE" rev-parse --short HEAD)"
  exit 1
fi

echo "[stable-server] FATAL: rollback also failed — :$PORT is DOWN." >&2
echo "  manual recovery: (cd $WORKTREE && git checkout --detach $ROLLBACK && npm ci --silent && env -u ANTHROPIC_BASE_URL PROXY_PORT=$PORT nohup node server/index.js >> $LOG 2>&1 &)" >&2
exit 2
