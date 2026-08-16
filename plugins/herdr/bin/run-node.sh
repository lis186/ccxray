#!/bin/sh
set -u

if [ "$#" -lt 1 ]; then
  printf '%s\n' 'ccxray for Herdr: missing Node.js script path.' >&2
  exit 64
fi

if [ -n "${CCXRAY_NODE:-}" ]; then
  exec "$CCXRAY_NODE" "$@"
fi

node_supported() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

if command -v node >/dev/null 2>&1 && node_supported node; then
  exec node "$@"
fi

MISE_BIN=""
if command -v mise >/dev/null 2>&1; then
  MISE_BIN=$(command -v mise)
elif [ -x "${HOME:-}/.local/bin/mise" ]; then
  MISE_BIN="${HOME}/.local/bin/mise"
elif [ -x "${HOME:-}/.local/share/mise/bin/mise" ]; then
  MISE_BIN="${HOME}/.local/share/mise/bin/mise"
fi

if [ -n "$MISE_BIN" ]; then
  MISE_NODE_VERSION="$($MISE_BIN latest --installed node 2>/dev/null || true)"
  if [ -n "$MISE_NODE_VERSION" ]; then
    exec "$MISE_BIN" exec "node@$MISE_NODE_VERSION" -- node "$@"
  fi
fi

for NODE_CANDIDATE in \
  "${HOME:-}/.local/share/mise/installs/node"/*/bin/node \
  "${HOME:-}/.volta/bin/node" \
  "${HOME:-}/.nvm/versions/node"/*/bin/node \
  "${HOME:-}/.asdf/installs/nodejs"/*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node
do
  if [ -x "$NODE_CANDIDATE" ] && node_supported "$NODE_CANDIDATE"; then
    exec "$NODE_CANDIDATE" "$@"
  fi
done

printf '%s\n' 'ccxray for Herdr needs Node.js 18 or newer.' >&2
printf '%s\n' 'Install Node.js, set CCXRAY_NODE to its executable, then reopen Quick Start.' >&2
exit 127
