#!/bin/sh
# ccxray-launcher-shim-v1 (#732) — installed by `ccxray setup --wrap-binaries`.
# Fail-open: every path ends in `exec` of the real binary, so exit codes,
# signals and stdio belong to it. Remove with `ccxray setup --wrap-binaries --remove`.
tool=${0##*/}
shimdir=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
node=@NODE@
probe=@PROBE@
home=@HOME@
default_strict=@STRICT@

is_shim() { { IFS= read -r _a; IFS= read -r _b; } < "$1" 2>/dev/null; case $_b in *ccxray-launcher-shim*) return 0 ;; esac; return 1; }

real=
eval "override=\${CCXRAY_SHIM_REAL_$(printf %s "$tool" | tr a-z A-Z)-}"
if [ -n "$override" ] && [ -x "$override" ]; then
  real=$override
else
  oldifs=$IFS; IFS=:
  for d in $PATH; do
    [ -n "$d" ] || d=.
    phys=$(cd "$d" 2>/dev/null && pwd -P) || continue
    [ "$phys" = "$shimdir" ] && continue
    c=$d/$tool
    [ -f "$c" ] && [ -x "$c" ] || continue
    is_shim "$c" && continue
    real=$c; break
  done
  IFS=$oldifs
fi
if [ -z "$real" ]; then
  echo "ccxray shim: cannot find the real '$tool' on PATH (the shim directory is skipped)" >&2
  exit 127
fi

[ -n "$CCXRAY_SHIM_DISABLE" ] && exec "$real" "$@"
: "${CCXRAY_SHIM_STRICT:=$default_strict}"
export CCXRAY_SHIM_STRICT CCXRAY_SHIM_HOME="${CCXRAY_SHIM_HOME:-$home}"

decision=
if [ -x "$node" ] && [ -r "$probe" ]; then
  decision=$("$node" "$probe" "$tool" "$@" 2>/dev/null </dev/null)
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

# No usable decision: the probe could not run. Fail open (or refuse in strict mode).
esc=$(printf %s "$PWD" | sed 's/\\/\\\\/g; s/"/\\"/g')
action=bypass; [ "$CCXRAY_SHIM_STRICT" = 1 ] && action=refused
if mkdir -p "$home" 2>/dev/null; then
  printf '{"t":"%s","tool":"%s","cwd":"%s","reason":"helper-unavailable","action":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$tool" "$esc" "$action" >> "$home/shim-bypass.log" 2>/dev/null
fi
if [ "$action" = refused ]; then
  echo "ccxray shim: probe unavailable; refusing to launch $tool because CCXRAY_SHIM_STRICT=1" >&2
  exit 111
fi
exec "$real" "$@"
