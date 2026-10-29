#!/bin/sh
# ccxray-launcher-shim-v1 (#732) — installed by `ccxray setup --wrap-binaries`.
# Fail-open: every path ends in `exec` of the real binary, so exit codes,
# signals and stdio belong to it. Remove with `ccxray setup --wrap-binaries --remove`.
tool=${0##*/}
case $tool in
  claude|codex) ;;
  *) echo "ccxray shim: unsupported invocation name (only claude and codex are shimmed)" >&2; exit 127 ;;
esac
case $0 in */*) selfdir=${0%/*} ;; *) selfdir=. ;; esac
[ -n "$selfdir" ] || selfdir=/
shimdir=$(cd "$selfdir" 2>/dev/null && pwd -P)
node=@NODE@
probe=@PROBE@
home=@HOME@
default_strict=@STRICT@

is_shim() { { IFS= read -r _a; IFS= read -r _b; } < "$1" 2>/dev/null; case $_b in *ccxray-launcher-shim*) return 0 ;; esac; return 1; }

# An override is honoured only when it is an executable regular file that is
# neither one of our shims nor inside the shim directory (no recursion).
case $tool in
  claude) override=${CCXRAY_SHIM_REAL_CLAUDE-} ;;
  codex) override=${CCXRAY_SHIM_REAL_CODEX-} ;;
esac
real=
if [ -n "$override" ] && [ -f "$override" ] && [ -x "$override" ] && ! is_shim "$override"; then
  case $override in */*) odir=${override%/*} ;; *) odir=. ;; esac
  [ -n "$odir" ] || odir=/
  ophys=$(cd "$odir" 2>/dev/null && pwd -P)
  [ "$ophys" = "$shimdir" ] || real=$override
  # A bare name would be searched on PATH by `exec` (finding the shim again), not
  # run from the directory it was validated in: make it an explicit path.
  case $real in ''|*/*) ;; *) real=./$real ;; esac
fi

if [ -z "$real" ]; then
  # Walk PATH keeping every empty component (leading, interior, trailing, all
  # empty) as the current directory, with pathname expansion off.
  set -f
  rest=$PATH:
  while [ -n "$rest" ]; do
    d=${rest%%:*}; rest=${rest#*:}
    [ -n "$d" ] || d=.
    case $d in /*) ;; *) d=./$d ;; esac
    phys=$(cd "$d" 2>/dev/null && pwd -P) || continue
    [ "$phys" = "$shimdir" ] && continue
    c=$d/$tool
    [ -f "$c" ] && [ -x "$c" ] || continue
    is_shim "$c" && continue
    real=$c; break
  done
  set +f
fi
if [ -z "$real" ]; then
  echo "ccxray shim: cannot find the real '$tool' on PATH (the shim directory is skipped)" >&2
  exit 127
fi

[ -n "$CCXRAY_SHIM_DISABLE" ] && exec "$real" "$@"
: "${CCXRAY_SHIM_STRICT:=$default_strict}"
export CCXRAY_SHIM_STRICT CCXRAY_SHIM_HOME="${CCXRAY_SHIM_HOME:-$home}"
home=$CCXRAY_SHIM_HOME
# `exec` below keeps this pid, so it names the tool process to the hub.
export CCXRAY_SHIM_PID=$$

# The whole helper runs under a hard deadline enforced here, not by Node's event
# loop: a hung Node start, a stalled synchronous read or blocked I/O cannot keep
# the real tool from launching. The helper, a watchdog and an exit marker race to
# write the first line of a pipe; whoever wins decides, and the loser is killed.
# Absolute path: a `sleep` planted earlier on PATH must not be able to stall (or
# instantly fire) the deadline that exists to bound everything else.
sleepcmd=/bin/sleep; [ -x "$sleepcmd" ] || sleepcmd=/usr/bin/sleep
secs=${CCXRAY_SHIM_DEADLINE_SECS:-2}
case $secs in ''|*[!0-9]*) secs=2 ;; esac
{ [ "$secs" -ge 1 ] && [ "$secs" -le 30 ]; } || secs=2

decision=
shim_pid=$$
# SIGINT/SIGHUP during the helper or logger phase end the launch (the real tool is
# NOT started afterwards). A shell runs a trap once its foreground step returns, so
# this takes effect within the step's own bound (the deadline above, or the log
# budget below); SIGTERM keeps its default, immediate disposition.
trap 'exit 130' INT
trap 'exit 129' HUP
if [ -x "$node" ] && [ -r "$probe" ]; then
  decision=$(
    {
      "$node" "$probe" "$tool" "$@" 2>/dev/null </dev/null & hp=$!
      # The watchdog also ends the helper if this shell is gone (a SIGTERM/SIGINT/
      # SIGHUP during this phase): it checks once a second, so nothing outlives a
      # signalled launch by more than about a second. `$$` is this shell's pid.
      ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
        i=0
        while [ "$i" -lt "$secs" ]; do
          "$sleepcmd" 1 & sp=$!
          wait "$sp"
          kill -0 "$shim_pid" 2>/dev/null || { kill -9 "$hp" 2>/dev/null; exit 0; }
          i=$((i + 1))
        done
        kill -9 "$hp" 2>/dev/null
        echo timeout ) & wd=$!
      wait "$hp"
      kill "$wd" 2>/dev/null
      echo exit
    } 2>/dev/null </dev/null | { IFS= read -r line; printf '%s\n' "$line"; }
  )
fi

case $decision in
  "claude "*)
    url=${decision#claude }; details=${url#* }; url=${url%% *}
    print=${details%% *}; agent_id=
    case $details in *' '*) agent_id=${details#* } ;; esac
    ANTHROPIC_BASE_URL=$url; export ANTHROPIC_BASE_URL
    # Header allowlist: declare existing user names before adding ccxray headers.
    names=$(printf '%s\n' "$ANTHROPIC_CUSTOM_HEADERS" | PATH=${CCXRAY_SHIM_SYSPATH:-/usr/bin:/bin} LC_ALL=C awk '
      index($0, ":") {
        name = tolower(substr($0, 1, index($0, ":") - 1))
        gsub(/^[ \t]+|[ \t\r]+$/, "", name)
        if (name ~ /^[!#$%&\047*+.^_`|~0-9a-z-]+$/ && name !~ /^x-ccxray-/ && !seen[name]++) {
          printf "%s%s", sep, name; sep = ","
        }
      }')
    if [ -n "$names" ]; then
      ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS
}X-Ccxray-Forward-Headers: $names"; export ANTHROPIC_CUSTOM_HEADERS
    fi
    if [ "$print" = 1 ]; then
      ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS
}X-Ccxray-Print-Mode: true"; export ANTHROPIC_CUSTOM_HEADERS
    fi
    if [ -n "$agent_id" ]; then
      ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS
}X-Ccxray-Agent-Id: $agent_id"; export ANTHROPIC_CUSTOM_HEADERS
    fi
    exec "$real" "$@" ;;
  "codex "*)
    url=${decision#codex }
    exec "$real" -c "openai_base_url=\"$url/v1\"" "$@" ;;
  "refuse "*)
    echo "ccxray shim: ${decision#refuse }" >&2
    exit 111 ;;
  direct|passthrough)
    exec "$real" "$@" ;;
esac

# No usable decision: the probe could not run (or hit the deadline). Fail open,
# or refuse in strict mode. The log is best-effort and runs in its own bounded
# subshell: a stalled mkdir/chmod/mv/date or filesystem can cost at most
# $logsecs seconds and can never keep the real tool from starting (or the strict
# refusal from being printed). The record is private (0700/0600 whatever the
# umask), ASCII-only JSON, bounded, and silent on every failure.
reason=helper-unavailable; [ "$decision" = timeout ] && reason=timeout
action=bypass; [ "$CCXRAY_SHIM_STRICT" = 1 ] && action=refused

logsecs=1
shim_log() {
  # External commands (only mkdir, chmod, mv, rm, date) come from the system
  # directories, never from the inherited PATH; each runs as a tracked child so a
  # timeout can kill it instead of orphaning it.
  PATH=${CCXRAY_SHIM_SYSPATH:-/usr/bin:/bin}
  LC_ALL=C; export LC_ALL
  umask 077
  cur=
  trap '[ -z "$cur" ] || kill -9 "$cur" 2>/dev/null; exit 0' TERM
  step() { "$@" & cur=$!; wait "$cur"; rc=$?; cur=; return "$rc"; }
  log=$home/shim-bypass.log
  [ -d "$home" ] || step mkdir -p "$home" || return 0
  # Only a regular, non-symlink file (or nothing) is ever appended to: never a
  # FIFO, device or symlink planted at the log path.
  [ -L "$log" ] && return 0
  if [ -e "$log" ]; then
    [ -f "$log" ] || return 0
    step chmod 600 "$log" || return 0   # an older or looser log becomes private first
    size=0
    while IFS= read -r line || [ -n "$line" ]; do
      size=$((size + ${#line} + 1))
      [ "$size" -gt 1048576 ] && break
    done < "$log"
    if [ "$size" -gt 1048576 ]; then
      old=$log.1
      # Rotation never writes through or into a planted link or directory.
      if [ -L "$old" ] || [ ! -d "$old" ]; then
        step rm -f "$old" && step mv -f "$log" "$old"
      fi
    fi
  fi
  esc=; rest=$PWD; n=0
  while [ -n "$rest" ] && [ "$n" -lt 4096 ]; do
    tail=${rest#?}; c=${rest%"$tail"}; rest=$tail; n=$((n + 1))
    case $c in
      '\') esc=$esc'\\' ;;
      '"') esc=$esc'\"' ;;
      '%') esc=$esc'%%' ;;
      [\ -~]) esc=$esc$c ;;
      *) esc=$esc'?' ;;
    esac
  done
  # `date` writes the whole record, so no output has to be captured from a child.
  step date -u "+{\"t\":\"%Y-%m-%dT%H:%M:%S.000Z\",\"tool\":\"$tool\",\"cwd\":\"$esc\",\"reason\":\"$reason\",\"action\":\"$action\"}" >> "$log"
}

{
  ( shim_log ) </dev/null >/dev/null 2>&1 & lp=$!
  ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    "$sleepcmd" "$logsecs" & sp=$!
    wait "$sp"
    kill -TERM "$lp" 2>/dev/null
    "$sleepcmd" 1 & sp=$!
    wait "$sp"
    kill -9 "$lp" 2>/dev/null ) </dev/null >/dev/null 2>&1 & wd=$!
  wait "$lp"
  kill "$wd" 2>/dev/null
} 2>/dev/null
if [ "$action" = refused ]; then
  echo "ccxray shim: probe unavailable ($reason); refusing to launch $tool because CCXRAY_SHIM_STRICT=1" >&2
  exit 111
fi
exec "$real" "$@"
