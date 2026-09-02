# Issue #611 verification report

## Files changed

- `server/providers.js`
- `server/forward.js`
- `server/entry.js`
- `test/auth-launcher.test.js`
- `test/auth-header-injection.e2e.test.js`
- `test/entry.test.js`
- `test/index-fields.e2e.test.js`
- `docs/testing.md`
- `docs/wire-protocol-reference.md`

## Guards and checks

- G-strip — `node --test test/auth-header-injection.e2e.test.js` (exit 0):
  actual upstream HTTP and WebSocket handshake header sets contain no
  `x-ccxray-*` headers.
- G-addonly — `node --test test/index-fields.e2e.test.js` (exit 0): projected
  byte comparisons use the live `forward.js` constructors and `ws-proxy.js`;
  its rebuild/import cases receive a synthetic launch-account config and still
  omit the account snapshot.
- G-hotpath — `node --test test/auth-launcher.test.js test/entry.test.js`
  (exit 0): the account config is read only while building the Claude launch
  environment, and missing/malformed config is harmless. The proxy receives
  the launch value through a header; it does no config-file read.
- Syntax and whitespace — `node --check` on every changed JS file and
  `git diff --check` (all exit 0).
- Differential — `CCXRAY_HOME=$(mktemp -d) scripts/diff-check.sh origin/main
  test/index-fields.e2e.test.js -- node --test --test-name-pattern 'persists a
  received launch account header' test/index-fields.e2e.test.js` (exit 0): new
  code passes; `origin/main` fails because `accountEmail` is `undefined`.

## Full suite

`perl -e 'alarm shift @ARGV; exec @ARGV' 300 sh -c 'CCXRAY_HOME=$(mktemp -d) node --test test/*.test.js'`

Exit code: **1** — 2,512/2,513 tests passed. The failure was
`test/herdr-plugin.test.js`'s `persists no-evidence diagnostics and target
identity after a zero-row import`: its expected synthetic stderr was prefixed
by an `anthropic upstream http://localhost:5577` warning. No issue #611 source
file participates in that assertion.

## Decisions

- For compound request headers, the last `X-Ccxray-Account` segment wins: it is
  the innermost/newest nested ccxray launch snapshot.
- Sanitization is local to the HTTP request seam: trim, lowercase, and reject
  values longer than 512 characters, mirroring the hub identity bound without
  widening its fixed IPC identity-key contract.
- `rebuild-index` and `importer` deliberately do not stamp accounts: they
  reconstruct/import historical turns, where the current launch account would
  be a false label.
- No `store._foldEntry` or `session-index._upsert` merge rule was added. This
  is capture-only metadata and has no summary consumer. Likewise, no cold-load
  API whitelist/client plumbing was added; the domain-filter consumer is #612.

## Not verified

- A real authenticated Claude installation and its real account config; all
  fixtures use synthetic account data and throwaway homes.
- The #612 domain-filter consumer or any UI display.
- A fully green complete suite in this environment (the exact required run is
  recorded above with its one failure).

## Round 2

- `getClaudeLaunchAccountEmail(env)` now reads the same launch environment that
  Claude receives. Account fixtures pass `CLAUDE_CONFIG_DIR` through the launch
  argument, and a precedence case proves launch-config `b@example.com` wins over
  parent-config `a@example.com`.
- Differential: `git stash push -m 'temp-611-provider-env-differential' --
  server/providers.js`, then `node --test --test-name-pattern 'uses the launch
  environment config over the parent process config' test/auth-launcher.test.js`.
  With the provider change stashed it failed with `a@example.com`; after
  `git stash pop` it passed with `b@example.com`.
- Not verified: a real authenticated Claude installation, the #612 consumer/UI,
  or the complete test suite beyond the four requested test files.
