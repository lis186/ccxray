#!/bin/sh
set -u

if [ "$#" -lt 1 ]; then
  printf '%s\n' 'ccxray for Herdr: missing Node.js script path.' >&2
  exit 64
fi

if [ -n "${CCXRAY_NODE:-}" ]; then
  exec "$CCXRAY_NODE" "$@"
fi

if command -v node >/dev/null 2>&1 && node -e '' >/dev/null 2>&1; then
  exec node "$@"
fi

if command -v mise >/dev/null 2>&1; then
  MISE_NODE_VERSION="$(mise latest --installed node 2>/dev/null || true)"
  if [ -n "$MISE_NODE_VERSION" ]; then
    exec mise exec "node@$MISE_NODE_VERSION" -- node "$@"
  fi
fi

printf '%s\n' 'ccxray for Herdr needs Node.js 18 or newer.' >&2
printf '%s\n' 'Install Node.js, set CCXRAY_NODE to its executable, then reopen Quick Start.' >&2
exit 127
