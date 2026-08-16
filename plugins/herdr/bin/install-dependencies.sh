#!/bin/sh
set -u

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PLUGIN_DIR/../.." && pwd)
set -- ci --omit=dev --ignore-scripts --prefix "$REPO_ROOT"

if [ -n "${CCXRAY_NPM:-}" ]; then
  exec "$CCXRAY_NPM" "$@"
fi

if command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  exec npm "$@"
fi

if [ -n "${CCXRAY_NODE:-}" ]; then
  NODE_BIN_DIR=$(dirname -- "$CCXRAY_NODE")
  if [ -x "$NODE_BIN_DIR/npm" ]; then
    PATH="$NODE_BIN_DIR:$PATH"
    export PATH
    exec "$NODE_BIN_DIR/npm" "$@"
  fi
fi

if command -v mise >/dev/null 2>&1; then
  MISE_NODE_VERSION=$(mise latest --installed node 2>/dev/null || true)
  if [ -n "$MISE_NODE_VERSION" ]; then
    exec mise exec "node@$MISE_NODE_VERSION" -- npm "$@"
  fi
fi

printf '%s\n' 'ccxray for Herdr needs npm from Node.js 18 or newer to install dependencies.' >&2
printf '%s\n' 'Install Node.js, or set CCXRAY_NPM to the npm executable, then retry the plugin install.' >&2
exit 127
