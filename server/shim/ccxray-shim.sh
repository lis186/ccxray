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
secs=${CCXRAY_SHIM_DEADLINE_SECS:-2}
case $secs in ''|*[!0-9]*) secs=2 ;; esac
{ [ "$secs" -ge 1 ] && [ "$secs" -le 30 ]; } || secs=2

decision=
if [ -x "$node" ] && [ -r "$probe" ]; then
  decision=$(
    {
      "$node" "$probe" "$tool" "$@" 2>/dev/null </dev/null & hp=$!
      ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
        sleep "$secs" & sp=$!
        wait "$sp"
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
    url=${decision#claude }; print=${url#* }; url=${url% *}
    ANTHROPIC_BASE_URL=$url; export ANTHROPIC_BASE_URL
    if [ "$print" = 1 ]; then
      ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS
}X-Ccxray-Print-Mode: true"; export ANTHROPIC_CUSTOM_HEADERS
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
# or refuse in strict mode. The log is best-effort: private (0700/0600 whatever
# the umask), ASCII-only JSON, bounded, and silent on every failure.
reason=helper-unavailable; [ "$decision" = timeout ] && reason=timeout
action=bypass; [ "$CCXRAY_SHIM_STRICT" = 1 ] && action=refused
(
  umask 077
  log=$home/shim-bypass.log
  [ -d "$home" ] || mkdir -p "$home"
  # Never open a FIFO, device or symlink planted at the log path.
  if [ ! -L "$log" ] && { [ -f "$log" ] || [ ! -e "$log" ]; }; then
    if [ -f "$log" ]; then
      set -- $(wc -c < "$log")
      [ "${1:-0}" -gt 1048576 ] && mv -f "$log" "$log.1"
    fi
    esc=$(printf %s "$PWD" | LC_ALL=C tr -c ' -~' '?' | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"t":"%s","tool":"%s","cwd":"%s","reason":"%s","action":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$tool" "$esc" "$reason" "$action" >> "$log"
  fi
) 2>/dev/null
if [ "$action" = refused ]; then
  echo "ccxray shim: probe unavailable ($reason); refusing to launch $tool because CCXRAY_SHIM_STRICT=1" >&2
  exit 111
fi
exec "$real" "$@"
