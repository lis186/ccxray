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

For in-process tests, set it before requiring any module that captures it at
load time:

```js
process.env.CCXRAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-foo-'));
// ...then require the modules under test
```

For tests that spawn the CLI, pass it in the child env instead of mutating the
parent process:

```js
execFileSync(process.execPath, ['server/index.js', 'usage'],
  { env: { ...process.env, CCXRAY_HOME: FIX_HOME } });
```

### 2. No real data in fixtures

Fixtures contain only synthetic session ids, cwds, and titles — never real
logs, project names, usernames, or home paths. Build them as literals; don't
copy a slice of your own `~/.ccxray`.

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
