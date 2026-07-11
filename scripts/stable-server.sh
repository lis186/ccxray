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
#       2 = swap AND rollback failed (server down — see recovery line)
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

LOG="${HOME}/.ccxray/stable-server.log"
say() { echo "[stable-server] $*"; }

# ── preconditions ──────────────────────────────────────────────────────────
git -C "$WORKTREE" diff --quiet && git -C "$WORKTREE" diff --cached --quiet \
  || { echo "worktree dirty — refusing to move pin: $WORKTREE" >&2; exit 3; }
git -C "$WORKTREE" fetch origin --quiet || { echo "git fetch failed" >&2; exit 3; }
TARGET=$(git -C "$WORKTREE" rev-parse --verify "$REF^{commit}" 2>/dev/null) || { echo "bad --ref: $REF" >&2; exit 3; }
git -C "$WORKTREE" rev-parse --verify "$ROLLBACK^{commit}" >/dev/null 2>&1 || { echo "bad --rollback-ref: $ROLLBACK" >&2; exit 3; }
CUR=$(git -C "$WORKTREE" rev-parse HEAD)

health() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; }

# Idempotence: already at target and serving → done.
if [[ "$CUR" == "$TARGET" ]] && health; then
  say "already at $(git -C "$WORKTREE" rev-parse --short "$TARGET") and healthy on :$PORT"
  exit 0
fi

# ── idle check (skippable with --force) ────────────────────────────────────
# Approximation: last completed entry within IDLE_MIN minutes = sessions are
# active. In-flight requests that started AFTER a quiet period are invisible
# to this check (entries record on completion) — hence supervised first runs
# and --force being explicit. ponytail: refine only if false swaps happen.
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

# ── pin + install + side-port verification (live server untouched so far) ──
pin_and_verify() { # $1 = commit
  git -C "$WORKTREE" checkout --detach --quiet "$1" || return 1
  if ! git -C "$WORKTREE" diff --quiet "$CUR" "$1" -- package-lock.json 2>/dev/null; then
    say "package-lock changed — npm ci"
    (cd "$WORKTREE" && npm ci --silent) || return 1
  fi
  local SIDE=$(( PORT + 71 ))
  if [[ -x "$WORKTREE/scripts/boot-smoke.sh" ]]; then
    "$WORKTREE/scripts/boot-smoke.sh" "$SIDE" || return 1
  else
    # ref predates boot-smoke.sh — inline minimal check
    env -u ANTHROPIC_BASE_URL CCXRAY_HOME="$(mktemp -d)" PROXY_PORT="$SIDE" \
      node "$WORKTREE/server/index.js" >/dev/null 2>&1 & local BP=$!
    local ok=1
    for _ in $(seq 1 30); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SIDE/" 2>/dev/null)" = "200" ] && { ok=0; break; }
      kill -0 "$BP" 2>/dev/null || break; sleep 0.5
    done
    kill "$BP" 2>/dev/null; wait "$BP" 2>/dev/null
    return $ok
  fi
}

swap_to() { # $1 = commit; returns 0 when :PORT serves 200 from $WORKTREE
  local OLD_PID
  OLD_PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [[ -n "$OLD_PID" ]]; then
    kill "$OLD_PID" 2>/dev/null   # SIGTERM → gracefulExit drains writes (≤5s)
    for _ in $(seq 1 20); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.5; done
  fi
  ( cd "$WORKTREE" && env -u ANTHROPIC_BASE_URL PROXY_PORT="$PORT" \
      nohup node server/index.js >> "$LOG" 2>&1 & ) </dev/null
  for _ in $(seq 1 30); do health && return 0; sleep 0.5; done
  return 1
}

say "verifying $(git -C "$WORKTREE" rev-parse --short "$TARGET") on side port before touching :$PORT"
if ! pin_and_verify "$TARGET"; then
  say "side-port verification FAILED — restoring pin, live server untouched"
  git -C "$WORKTREE" checkout --detach --quiet "$CUR"
  exit 1
fi

say "swapping :$PORT to $(git -C "$WORKTREE" rev-parse --short "$TARGET")"
if swap_to "$TARGET"; then
  say "OK — :$PORT serving $(git -C "$WORKTREE" rev-parse --short HEAD) (log: $LOG)"
  exit 0
fi

say "swap FAILED — rolling back to $(git -C "$WORKTREE" rev-parse --short "$ROLLBACK")"
git -C "$WORKTREE" checkout --detach --quiet "$ROLLBACK"
if swap_to "$ROLLBACK"; then
  say "rolled back — :$PORT serving $(git -C "$WORKTREE" rev-parse --short HEAD)"
  exit 1
fi

echo "[stable-server] FATAL: rollback also failed — :$PORT is DOWN." >&2
echo "  manual recovery: (cd $WORKTREE && git checkout --detach $ROLLBACK && PROXY_PORT=$PORT nohup node server/index.js >> $LOG 2>&1 &)" >&2
exit 2
