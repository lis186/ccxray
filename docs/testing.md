# Testing

How ccxray's test suite is run, and the hygiene rules every test must follow.

```bash
npm test                          # node --test test/*.test.js
node --test test/usage.test.js    # one file
```

No build step, no test framework beyond Node's built-in `node:test`.

## Test hygiene

A test must produce the same result on the author's machine and on a clean CI
runner. The failure mode this section exists to prevent: a test silently reads
the developer's real data, passes locally, and fails (or worse, passes for the
wrong reason) in CI.

This actually happened — PR #94's `usage` CLI e2e tests defaulted `CCXRAY_HOME`
to `~/.ccxray`. They passed locally because the author's home had logs; CI's
home was empty, `usage` exited 1, and 11 assertions failed. The same fallback
also risked leaking the runner's username and home path into recorded data.

The rules below make isolation the default, not an afterthought.

### 1. Isolate `CCXRAY_HOME`

ccxray reads logs, the hub lockfile, and secrets from `CCXRAY_HOME` (default
`~/.ccxray`). Any test that invokes the CLI/server or touches storage **must**
point `CCXRAY_HOME` at a throwaway temp dir and write its own synthetic
`logs/index.ndjson`. Never read the real `~/.ccxray`.

Server tests that do not exercise transcript importing must also set
`CCXRAY_IMPORT_DISABLE=1`. Import discovery intentionally scans real
`$HOME/.claude*` and `$HOME/.codex*/sessions`; isolating `CCXRAY_HOME` alone
does not stop an active local agent session from contaminating a proxy test.

Exporter status tests may create `export-cursor.json` fixtures under the isolated
home. The absent, valid, and corrupt cursor shapes are intentional test data; a
corrupt-cursor status read must leave the original file and directory entries
unchanged.

For in-process tests, set it before requiring any module that captures it at
load time:

```js
process.env.CCXRAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-foo-'));
// ...then require the modules under test
```

The hub recovery differential harness (`test/hub-recovery-outcomes.test.js`)
uses the same throwaway home and a synthetic `logs/index.ndjson`. Its launch
failure case runs the VM-loaded hub in a short-lived worker so the old
unhandled-child-error behavior can be observed as a process failure without
putting the test runner at risk.

For tests that spawn the CLI, pass it in the child env instead of mutating the
parent process:

```js
execFileSync(process.execPath, ['server/index.js', 'usage'],
  { env: { ...process.env, CCXRAY_HOME: FIX_HOME } });
```

### 1b. Scrub `HERDR_*` for Herdr plugin tests

`plugins/herdr` reads its workspace scope, pane identity, socket path, and CLI
path from the ambient `HERDR_*` environment. A developer who runs the suite from
inside a Herdr pane exports those variables, so a spawn that inherits
`process.env` resolves to the **live** workspace: scope-dependent wording
changes, and cwd filtering drops the fixture entries. `HERDR_WORKSPACE_ID` alone
turned 14 tests red; the full ambient set, 16.

`test/herdr-plugin.test.js` therefore builds every child env through
`pluginEnv()`, which drops all `HERDR_*` **and** `CCXRAY_*` keys — plus
`PROXY_PORT`, which joined the plugin's env surface with the #555 launch port
escape hatch — before applying the test's own overrides (and defaults
`CCXRAY_HOME` to an empty throwaway home, per rule 1). Tests that call plugin library functions in-process pass the same
`pluginEnv({...})` object rather than `{ ...process.env, ... }`. The guard test
`ignores the ambient Herdr environment of the shell running the suite` sets those
variables deliberately and asserts the output is unaffected.

CI is green either way because it has no `HERDR_*` set — this rule exists for the
local run, which is where the plugin is actually developed.

### 2. No real data in fixtures

Fixtures contain only synthetic session ids, cwds, and titles — never real
logs, project names, usernames, or home paths. Build them as literals; don't
copy a slice of your own `~/.ccxray`.

Claude launcher account fixtures must set `CLAUDE_CONFIG_DIR` to a test-owned
directory and write `<CLAUDE_CONFIG_DIR>/.claude.json`, never the real Claude
config. The `oauthAccount` fixture shape in `test/auth-launcher.test.js` and
`test/index-fields.e2e.test.js` mirrors the known file: string `accountUuid`,
`emailAddress`, `organizationUuid`, `billingType`, `accountCreatedAt`,
`subscriptionCreatedAt`, `displayName`, `fullName`, `organizationRole`,
`organizationName`, `organizationType`, and `organizationRateLimitTier`;
boolean `hasExtraUsageEnabled`; numeric `profileFetchedAt`; and nullable
`ccOnboardingFlags`, `claudeCodeTrialEndsAt`, `claudeCodeTrialDurationDays`,
`seatTier`, `workspaceRole`, and `userRateLimitTier`. Keep synthetic values.

Exporter account-domain fixtures use the account-bearing index-line shape
covered by `test/index-fields.e2e.test.js`; keep every field, email, domain,
session id, and path synthetic. Build their `index.ndjson` under `mkHome()`'s
temporary `CCXRAY_HOME`, then exercise them through `_setUploader()` and
`flushExport()` as `test/export-sync.test.js` does. Do not sample either
`~/.ccxray` or a real Claude account config.

If a test needs to exercise `~` expansion, set a throwaway `$HOME` for that
single test — don't resolve against the real `os.homedir()`. Note this is
narrow: see the `$HOME` caveat below before scrubbing `$HOME` broadly.

### 3. CI-equivalent check

Before pushing, confirm the suite passes against an empty home:

```bash
CCXRAY_HOME=$(mktemp -d) npm test
```

If a test forgot to isolate, it inherits this empty `CCXRAY_HOME`, finds no
logs, and fails — the same `~/.ccxray`-dependency that bit PR #94. This checks
the isolation condition CI enforces (see below); CI additionally runs the
Node 20/22 matrix, so a green local run covers isolation but not the matrix.

### 4. Clean up

Remove temp dirs when the process exits, so repeated runs don't fill `/tmp`:

```js
process.on('exit', () => { try { fs.rmSync(FIX_HOME, { recursive: true, force: true }); } catch {} });
```

Use `finally` instead for dirs scoped to a single test.

### 5. Evaluation harnesses live in `scripts/`, not `test/`

`node --test` auto-discovers every `.js` file under `test/` and tries to run
each as a test. Scripts that intentionally scan the real `~/.ccxray` (e.g.
`scripts/agent-classify-eval.js`) must never live in `test/` — they read live
user data, so their runtime and result depend on whatever the machine has
captured (issue #134: a 30s+ scan of ~100k files whose verdict drifts with the
data). Anything in `scripts/` is a manual developer tool invoked explicitly;
anything in `test/` must be a hygienic, self-contained test.

## Canonical pattern

`test/usage.test.js` is the reference. Copy its setup:

```js
const FIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-test-'));
fs.mkdirSync(path.join(FIX_HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(FIX_HOME, 'logs', 'index.ndjson'),
                 FIXTURE.map(e => JSON.stringify(e)).join('\n') + '\n');
process.on('exit', () => { try { fs.rmSync(FIX_HOME, { recursive: true, force: true }); } catch {} });

const cli = (...args) => execFileSync(process.execPath,
  ['server/index.js', 'usage', ...args],
  { env: { ...process.env, CCXRAY_HOME: FIX_HOME }, timeout: 10000 }).toString();
```

```
   real ~/.ccxray   ✗  (never read by tests)
        │
        ▼
   [ test process ] ── CCXRAY_HOME ──▶  /tmp/ccxray-test-XXXX/logs/index.ndjson
                                         (synthetic, deterministic, cleaned on exit)
```

## `$HOME` vs `CCXRAY_HOME`

These are different layers of isolation — don't conflate them:

- **`CCXRAY_HOME`** is ccxray's own data dir. Isolate it in every storage/CLI
  test (rule 1). The full-suite CI-equivalent check scrubs this one.
- **`$HOME`** is the toolchain's cache dir. The puppeteer-based browser e2e
  tests (`test/rebuild-index.e2e.test.js`, `test/dashboard-codex-e2e.test.js`)
  launch a real Chrome whose binary lives at `$HOME/.cache/puppeteer`.
  Scrubbing `$HOME` for the whole suite breaks them with "Could not find
  Chrome" — that's a missing toolchain cache, not a hygiene violation.

One test injects a throwaway `$HOME` into its child processes by design:
`test/cost-worker-exit.test.js`. `server/cost-worker.js` reads `os.homedir()`
directly (it scans `$HOME/.claude*`, `$HOME/.codex*`, `$HOME/.config/claude` —
not `CCXRAY_HOME`), so the override goes into the forked worker's env only; the
test process itself keeps the real `$HOME`, leaving the puppeteer cache intact.
Its fixture shape is a synthetic `.claude/projects/<p>/*.jsonl` of usage lines
with unique `message.id`s (the worker dedupes by messageId). Its orphan test
also writes two tiny child-process entrypoints (a surrogate parent and a
`--require` hold-open pin) into the same temp dir at runtime — executable
fixtures, not tests; generating them outside `test/` keeps them invisible to
`node --test` auto-discovery.

The Herdr badge's staleness/link-repair check is a second reader of that layer, and it runs
**in-process** rather than in a fork. `evidenceStaleness` (`plugins/herdr/bin/
lib/ccxray.js`) stats and reads `$HOME/.claude*/projects/<slug>/<sessionId>.jsonl`
to decide whether a transcript holds turns ccxray never logged — a scan root
outside `CCXRAY_HOME`, the ADR 0015 R4 class. Because it runs in the test
process, a throwaway `$HOME` is not an option (it would take the puppeteer cache
with it). Set **`CCXRAY_IMPORT_HOMES`** instead: it is the same knob
`server/importer.js` honours, and its value is a comma-separated list of actual
Claude `projects/` scan roots (the `projects/` directory itself, not a config
home such as `~/.claude`); setting `~/.claude` imports zero and reports no error.
**Entries must be ABSOLUTE paths.** A relative entry is rejected rather than resolved,
because the same string is read by the hub and by the Herdr plugin, whose working
directories differ by construction — resolving it would silently mean two different
directories in the two processes. Rejected entries are reported once per distinct value
on stderr, and the foreground client repeats the complaint because a detached hub's
stderr goes to `hub.log`. `test/herdr-plugin.test.js` pins the contract by running both
parsers in child processes with different CWDs; a single-process check cannot observe
the divergence at all.
The plugin parses it the same way. A test that exercises staleness
without it silently reads the developer's real transcripts. Codex repair uses the parallel
**`CCXRAY_IMPORT_CODEX_HOMES`** override: its value is the `sessions/` root, and
the plugin inspects only the UUIDv7 session's UTC date plus the adjacent two
date directories. It never recursively scans that root. `pluginEnv()` defaults
both variables to separate empty roots; a direct Codex repair fixture must set
both explicitly. Two mechanisms guard the Claude path in
`test/herdr-plugin.test.js`. The structural one is `pluginEnv()` defaulting
`CCXRAY_IMPORT_HOMES` and `CCXRAY_IMPORT_CODEX_HOMES` to the empty
`NO_TRANSCRIPTS` / `NO_CODEX_TRANSCRIPTS` roots for every spawned
script (overridable per test). The second is a lint-class audit test (`audit:
sessionSummaryDetails call sites pin CCXRAY_IMPORT_HOMES`): any
`sessionSummaryDetails` call span that literally contains `CCXRAY_HOME`
without `CCXRAY_IMPORT_HOMES` fails the suite. The audit scans literal call
spans only — an env object assembled outside the call escapes it, so it is a
tripwire for the common inline-opts shape, not proof of isolation. Fixture shape: a `<cwd with every non-alphanumeric
flattened to '-'>/<sessionId>.jsonl` holding at least one `{type:'assistant',
timestamp, message.usage}` line — metadata-only records (`system`, `last-prompt`,
`mode`, `permission-mode`, `file-history-snapshot`) deliberately do NOT count as
turns, and a test asserting that is the regression guard for the file-mtime rule
this replaced. See `test/herdr-plugin.test.js`, `Herdr sidebar import freshness`.

So: scrub `CCXRAY_HOME` for the whole suite; only set a throwaway `$HOME` for a
specific non-browser test that needs to assert `~` expansion.

## CI enforcement

`.github/workflows/ci.yml` runs the suite with `CCXRAY_HOME` pointed at a fresh
empty dir under `$RUNNER_TEMP`. This guarantees two things: no test can read the
runner's real `~/.ccxray`, and every test starts from an empty log dir — so a
test that skips rule 1 and reads logs it didn't create finds none and fails,
which is exactly the PR #94 failure class.

This is a backstop, not full per-test isolation: a test that writes into the
shared home and reads its own data back could still pass without isolating, and
a shared home can introduce order-dependence between tests. Rule 1 (each test
makes its own temp home) is the real guard; CI just stops the real-data
dependency from going unnoticed. `$HOME` is left untouched so puppeteer's Chrome
cache stays intact. It costs nothing extra — it doesn't re-run the suite.

## `pricing-cache.json` is a second, non-`CCXRAY_HOME` input

`CCXRAY_HOME` does not isolate everything a test can accidentally read. The
LiteLLM cache (`pricing-cache.json`) lives **package-relative**, next to
`package.json`, and since the 1M-capability work it is read synchronously on
first use to resolve a model's context window — so a test that asserts window
behaviour resolves differently on a machine that has run the server (cache
present) than on CI (cache absent). Both directions pass today, which is exactly
why this is easy to miss: it is the ADR 0015 R4 / #407 class, one module over.

A test that exercises `getMaxContext` / `inferMaxContext` / `modelSupports1M`
must pin that input, by any of:

- stub `pricing.getModelContext` (the pattern already used throughout
  `test/config.test.js`, restored in `afterEach`),
- `pricing.__setContextTableForTests({...})` to inject a table through the real
  lookup, including its prefix matching, or
- set `CCXRAY_PRICING_CACHE` to a path that does not exist, for a spawned server
  or CLI that must resolve windows with no LiteLLM data at all.

The rule of thumb matches rule 1: never let an assertion depend on a file the
test did not create.
