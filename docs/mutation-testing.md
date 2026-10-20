# Mutation testing

Mutation testing makes small deliberate changes ("mutants") to production code —
flip a `===`, drop an `?.`, empty a string — and reruns the tests. A mutant the
tests still pass on ("survived") marks behaviour no test asserts. The score is
killed ÷ (killed + survived + no-coverage).

Scope: `server/wire-parsers/**`, `server/pricing.js` and
`server/default-rates.js`. It is **not** part of `npm test` and **not** in CI.

```bash
npm run test:mutation              # incremental: only re-tests mutants whose code or tests changed
npm run test:mutation -- --force   # full run, ignore the incremental cache
```

Reports land in `reports/mutation/mutation.html` (open in a browser) and
`reports/mutation/mutation.json`. The incremental cache is
`reports/stryker-incremental.json`. `reports/` and `.stryker-tmp/` are
git-ignored — never commit them.

## Setup

- Node prerequisite: Stryker 10 needs Node >=22, and the locked Babel 8
  dependencies need `^22.18.0` or `>=24.11.0`. This is for the opt-in pilot
  only; the package's own `engines` is unchanged.
- Config: `stryker.config.mjs` (`mutate`, the test-file list, `concurrency: 2`).
- Runner: `@stryker-mutator/tap-runner`. The suite is `node:test`, so the
  vitest/jest runners do not apply. The tap runner runs each test file as
  `node --require ./test/helpers/home-guard.js --test-reporter=tap <file>`,
  so every run keeps the HOME guard (`docs/testing.md`) and never touches the
  real `~/.ccxray`. It treats one test file as one "test", so
  `coverageAnalysis: 'perTest'` selects the *files* that cover a mutant, not
  individual `it()` blocks.
- `forceBail: false`: bailing kills the test process, which skips home-guard's
  exit cleanup and leaks `/tmp/ccxray-suite-*` homes.
- Test files are listed explicitly. When a new test exercises a mutated file,
  add it to `testFiles` or its kills will not count. Keep spawn-heavy e2e files
  out; they are slow and do not add mutant coverage here.
- Pricing isolation. The config sets `CCXRAY_PRICING_CACHE` to a path that does
  not exist before any test starts, so no run reads or writes the
  package-relative `pricing-cache.json`; tests that need a cache write a
  synthetic one to a temp dir. A second preload, `test/helpers/no-network.js`,
  makes every non-loopback `http`/`https`/`net`/`tls`/`fetch` connection throw
  (in the test process and, through `NODE_OPTIONS`, its Node children):
  ~80 pricing mutants break `fetchPricing()`'s cache/TTL checks and would
  otherwise download LiteLLM. Set `CCXRAY_NETWORK_GUARD_LOG=<file>` to log the
  blocked attempts. The unmutated test list makes zero attempts.
- `fetchPricing()`'s network path is tested through a stubbed `https.get`
  (`test/pricing-edges.test.js`), never the real network.

## What to expect

Measured on an 8-core / 15 GiB Linux box (Node 22, `nice`):

| Run | Wall time | Stryker parent peak RSS | Process-tree peak RSS |
|-----|-----------|-------------------------|-----------------------|
| Wire parsers only (1,209 mutants, 12 test files) | 76–84 s | ~0.5 GB | ~0.6 GB |
| Incremental after editing one test file | 30–40 s | ~0.5 GB | ~0.6 GB |
| + pricing (1,689 mutants, 23 test files) | 220–231 s | ~0.25 GB | ~0.65 GB |

`MemAvailable` never dropped by more than ~0.6 GB. Do not raise `concurrency`
above 2 on shared machines. One config covers both scopes: a full run stays
under 4 minutes, and the incremental cache keeps day-to-day reruns short.

## Results

### Wire parsers

| File | Before | After |
|------|--------|-------|
| `anthropic.js` | 69.66% | 98.60% |
| `openai.js` | 61.98% | 96.58% |
| `index.js` | 100% | 100% |
| **Total** | **64.43%** | **97.19%** |

The new assertions live in `test/wire-parsers-anthropic-edges.test.js` and
`test/wire-parsers-openai-edges.test.js`. No `// Stryker disable` comments
were added: those would be production-code edits.

### Pricing

| File | Before | After |
|------|--------|-------|
| `pricing.js` | 41.38% (96 killed / 62 survived / 74 no-cov) | 83.62% (194 / 25 / 13) |
| `default-rates.js` | 65.57% (160 / 57 / 27) | 88.93% (217 / 7 / 20) |
| **All mutated files** | **84.93%** | **94.12%** |

Wire-parser scores are unchanged by the pricing scope. The new assertions live
in `test/pricing-edges.test.js` and `test/default-rates-edges.test.js`. No
`// Stryker disable` comments.

#### Known equivalent / unreachable pricing survivors (65)

- **Lag-override machinery with an empty `LITELLM_LAG_OVERRIDES`** (45) — the
  frozen array is empty, so `applyLagOverrides`' loop body in
  `default-rates.js` is never entered and `logLagOverrideStatus` in
  `pricing.js` always gets `[]`: its filters, branches, messages, the six
  `logLagOverrideStatus(...)` call sites and the initial
  `lastLagOverrideStatus = []` (overwritten at load) have no effect. They
  become testable when an override row is added.
- **`'utf8'` → `''`** in the three cache reads: `readFile` then returns a
  Buffer, which `JSON.parse` coerces to the same string.
- **Cache TTL `<` → `<=`** — a one-millisecond boundary.
- **`toLocaleString(…, { timeZone })` → `{}`** — log format only.
- **`fetchPricing`'s `done()` once-guard** — `resolve()` is idempotent.
- **Redundant guards** — `if (!model)` in `getModelPricingWithConfidence`
  (`lookupRates` checks again); `if (cached.context)` → `true` in
  `ensureContextTable` (an absent context throws inside the same `try`);
  `typeof cc !== 'object'` in `hasCacheTierSplit` (primitives read
  `undefined` tiers and fail the next check); the `cached && cached.pricing`
  part of `_ensureRateTable`'s check (a null pricing reaches
  `buildRateTable`'s own `|| {}`); `slash === -1` (a key without a slash
  "mirrors" onto itself, which already exists).
- **`getModelContext`'s `xai/` fallback** (5) — every context table passes
  through `mirrorProviderPrefixedKeys` (all providers), so a bare key always
  exists wherever an `xai/` key does; the branch is unreachable.
- **`lookupRates` provider plumbing** — `if (provider)` → `true` looks up
  `undefined/<model>` (always a miss); `startsWith` → `endsWith` on an
  already-prefixed id misses step 1 but step 2 finds the same key.

### Known equivalent wire-parser survivors (34)

These do not change observable behaviour; do not write tests to "kill" them.

- **Defaults that cannot be observed** — `|| ''` → `"Stryker was here!"` where
  the replacement still fails the next check (no `cc_version`, shorter than 500
  chars, no `Workspace Path:`/`CWD:` match), `[]` → `["Stryker was here"]`
  where the element never matches, `url || ''` on a value that only feeds
  prefix checks.
- **Redundant type guards on primitive input** — `typeof x === 'object'` /
  `!x || typeof x !== 'object'` mutants in `extractResponseId`,
  `getOpenAIInstructionsText`, `extractOpenAICwd`, `getCodexInputCwd`,
  `getCodexWorkspaceCwd` (nested branch) and `withCodexMetadata`'s
  `hasBodyClient`: every primitive falls through to the same `null`/no-op.
- **Initialised-to-the-same-value** — `if (raw)` and the empty `catch {}` in
  `parseCodexTurnMetadata` (`parsed` already starts `null`); `if (!value)` in
  `getOpenAIAgentTypeFromHeaders` (`'undefined'` is not a known type);
  `ctx.lastUsage != null &&` (the helper already returns false for nullish).
- **Pricing-provider argument** — `calculateCost(…, 'anthropic')` → `''` and
  `agentForProvider('anthropic')` → `''`: Claude rows and the agent default do
  not depend on it. In `openai.js`, `describeAgentModule(agent)?.upstreamKey ||
  'openai'`: every OpenAI-wire agent has an `upstreamKey`, so the `?.` and the
  `'openai'` fallback are unreachable. (The Grok `xai` upstream *is* asserted.)
- **Regex alternatives shadowed by the fallback** — dropping `$` or `\s+` → `\s`
  in the first `Workspace Path:` regex, and `.trim()` on a `\S+` capture: the
  second regex returns the same token.
- **Explicit-session `detectSession` plumbing** — `metadata || {}`,
  `detected.sessionId || sessionId`, `detected.inferred || false`: on the
  explicit path the store always returns the same id and no `inferred` flag.
