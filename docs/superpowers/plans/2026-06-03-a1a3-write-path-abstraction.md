# A1-A3 Write-Path Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-memory `entry` object the single source of truth and derive the `index.ndjson` line as a pure projection of it, eliminating the 4 hand-rolled entry/index builders and their drift (Codex `cost`/`maxContext` going null on restore).

**Architecture:** Each of the 4 write paths produces a canonical `entry` via `getParser(provider).buildEntryFields(ctx)` (caller adds identity fields); `buildIndexLine(entry)` projects a fixed `INDEX_FIELDS` set. `broadcast`, `store`, the index write, and restore all read the same definitions, so drift is structurally impossible. The Anthropic SSE HUD/intercept stream injection is untouched — only the post-`clientRes.end()` entry assembly moves.

**Tech Stack:** Node.js, `node:test` + `node:assert`, no build step. Tests: `node --test test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-06-03-codex-write-path-abstraction-design.md`
**Pre-mortem (risks/gates):** `docs/superpowers/specs/2026-06-03-a1a3-premortem.md`

---

## Go/No-Go before starting

- [ ] Confirm `:5577` hub is **not** `--watch` on this tree: `ps -o command= -p "$(lsof -iTCP:5577 -sTCP:LISTEN -t | head -1)"` shows plain `node server/index.js`. (Re-run if the hub is ever restarted — editing `server/` while a `--watch` hub serves the live session would hot-reload partial code.)
- [ ] On branch `feat/codex-dashboard-foundation`: `git branch --show-current`.
- [ ] Baseline green: `node --test test/*.test.js` (record the count, ~654+).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `server/providers.js` | `PROVIDER_AGENT` map (provider→agent label) | Modify (add export) |
| `server/entry.js` | `INDEX_FIELDS` + `buildIndexLine(entry)` (pure projection) | **Create** |
| `server/wire-parsers/anthropic.js` | `buildEntryFields(ctx)`, `registerPromptVersion(ctx)` | Modify |
| `server/wire-parsers/openai.js` | `buildEntryFields(ctx)`, `registerPromptVersion(ctx)` | Modify |
| `server/wire-parsers/index.js` | drop dead `normalizeListMeta`/`extractAgentType` from interface | Modify |
| `server/forward.js` | 3 sites call `buildIndexLine` then `buildEntryFields` | Modify (≈585/622, 720/754, 862/901) |
| `server/ws-proxy.js` | `recordWebSocketEntry` calls them | Modify (≈272/314) |
| `server/sse-broadcast.js` | use `PROVIDER_AGENT` instead of inline ternary | Modify (≈11) |
| `server/restore.js` | WS-restore guard (T8) | Modify (≈133) |
| `test/entry.test.js` | INDEX_FIELDS golden-file (T1) + projection | **Create** |
| `test/wire-parsers-build-entry.test.js` | buildEntryFields per provider/transport (T2) | **Create** |
| `test/ws-restore-guard.test.js` | T8 WS restore regression | **Create** |

**Reference — the 4 current index-line key sets (the T1 baseline):**
- Anthropic SSE (`forward.js`≈622): has `thinkingStripped, hasCredential, toolSources`; **no** `responseMetadata`.
- OpenAI SSE (`forward.js`≈754): has `responseMetadata, hasCredential`; writes `cost:null, maxContext:null` (the drift); **no** `thinkingStripped, toolSources`.
- non-SSE (`forward.js`≈901): has `responseMetadata`; writes `cost:null`; `maxContext` real(anthropic)/null(openai).
- WS (`ws-proxy.js`≈314): most complete — has `responseMetadata, thinkingStripped, hasCredential, toolSources`.

`INDEX_FIELDS` = the union (codex-approved):
`id, ts, sessionId, provider, agent, model, msgCount, toolCount, toolCalls, isSubagent, sessionInferred, cwd, isSSE, usage, cost, maxContext, responseMetadata, stopReason, title, thinkingDuration, toolFail, elapsed, status, receivedAt, sysHash, toolsHash, coreHash, thinkingStripped, hasCredential, toolSources`.
Allowlisted deliberate additions vs legacy: OpenAI SSE gains real `cost`+`maxContext`; non-SSE OpenAI gains real `cost`.

---

## Phase 3a — PROVIDER_AGENT map

### Task 1: Single provider→agent map

**Files:**
- Modify: `server/providers.js` (add `PROVIDER_AGENT` + export)
- Modify: `server/sse-broadcast.js:11`, `server/forward.js:723`, `server/forward.js:865`, `server/ws-proxy.js:279`
- Test: `test/providers.test.js` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

```js
// test/providers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { PROVIDER_AGENT, agentForProvider } = require('../server/providers');

test('PROVIDER_AGENT maps providers to agent labels', () => {
  assert.equal(agentForProvider('openai'), 'codex');
  assert.equal(agentForProvider('anthropic'), 'claude');
  assert.equal(agentForProvider('unknown'), 'claude'); // default
  assert.equal(PROVIDER_AGENT.openai, 'codex');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/providers.test.js`
Expected: FAIL — `agentForProvider is not a function`.

- [ ] **Step 3: Implement in `server/providers.js`**

Add near the top (after `AGENT_PROVIDERS`):

```js
const PROVIDER_AGENT = Object.freeze({ anthropic: 'claude', openai: 'codex' });
function agentForProvider(provider) { return PROVIDER_AGENT[provider] || 'claude'; }
```

Add `PROVIDER_AGENT, agentForProvider` to `module.exports`.

- [ ] **Step 4: Replace the 4 inline sites**

- `server/sse-broadcast.js:11`: `agent: entry.agent || agentForProvider(entry.provider),` (add `const { agentForProvider } = require('./providers');` at top).
- `server/forward.js:723` and `:865`: replace `agent: 'codex'` / `agent: provider === 'openai' ? 'codex' : 'claude'` with `agent: agentForProvider(provider)` (require at top of forward.js).
- `server/ws-proxy.js:279`: `agent: agentForProvider('openai')` (or keep `'codex'` literal — WS is always openai; using the map keeps one source).

- [ ] **Step 5: Run full suite**

Run: `node --test test/*.test.js`
Expected: PASS, same count as baseline +1.

- [ ] **Step 6: Commit**

```bash
git add server/providers.js server/sse-broadcast.js server/forward.js server/ws-proxy.js test/providers.test.js
git commit -m "refactor(3a): single PROVIDER_AGENT map replaces 4 inline provider→agent literals"
```

---

## Phase 3b① — buildIndexLine, swap the 4 sites (no field-computation move)

### Task 2: `server/entry.js` with INDEX_FIELDS + buildIndexLine, T1 golden-file test

**Files:**
- Create: `server/entry.js`
- Test: `test/entry.test.js`

- [ ] **Step 1: Write the failing tests (projection + exclusions)**

```js
// test/entry.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { INDEX_FIELDS, buildIndexLine } = require('../server/entry');

const EXCLUDED = ['req','res','tokens','duplicateToolCalls','method','url','_loaded','_writePromise','_loadingPromise'];

test('buildIndexLine projects only INDEX_FIELDS, drops excluded + undefined', () => {
  const entry = {
    id: 'X', ts: '00:00:00', sessionId: 's', provider: 'openai', agent: 'codex',
    model: 'gpt-5.5', msgCount: 3, toolCount: 1, toolCalls: { Bash: 1 },
    isSubagent: false, sessionInferred: false, cwd: '/p', isSSE: true,
    usage: { input_tokens: 10 }, cost: { cost: 0.09 }, maxContext: 400000,
    responseMetadata: { transport: 'http' }, stopReason: 'completed', title: 't',
    thinkingDuration: null, toolFail: false, elapsed: '1.0', status: 200,
    receivedAt: 1, sysHash: null, toolsHash: null, coreHash: null,
    thinkingStripped: undefined, hasCredential: undefined, toolSources: undefined,
    // excluded / extra:
    req: { big: 1 }, res: [1,2,3], tokens: { total: 99 }, duplicateToolCalls: null,
    method: 'POST', url: '/v1/responses', _loaded: true, _writePromise: Promise.resolve(),
  };
  const obj = JSON.parse(buildIndexLine(entry));
  for (const k of EXCLUDED) assert.ok(!(k in obj), `excluded key leaked: ${k}`);
  assert.equal(obj.cost.cost, 0.09);        // the OpenAI drift fix: real value, not null
  assert.equal(obj.maxContext, 400000);
  for (const k of Object.keys(obj)) assert.ok(INDEX_FIELDS.includes(k), `non-INDEX key: ${k}`);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/entry.test.js`
Expected: FAIL — cannot find `../server/entry`.

- [ ] **Step 3: Implement `server/entry.js`**

```js
'use strict';

const INDEX_FIELDS = [
  'id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls',
  'isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata',
  'stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt',
  'sysHash','toolsHash','coreHash','thinkingStripped','hasCredential','toolSources',
];

// Pure projection: the index line is entry's INDEX_FIELDS, nothing else.
// undefined values are dropped by JSON.stringify (keeps lines lean, matches legacy).
function buildIndexLine(entry) {
  const out = {};
  for (const k of INDEX_FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
  return JSON.stringify(out);
}

module.exports = { INDEX_FIELDS, buildIndexLine };
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/entry.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/entry.js test/entry.test.js
git commit -m "feat(3b): add server/entry.js — INDEX_FIELDS + buildIndexLine projection"
```

### Task 3: Swap the 4 index-line literals to `buildIndexLine(entry)` + T1 superset/allowlist guard

**Files:**
- Modify: `server/forward.js` (≈622, ≈754, ≈901 — replace the 3 inline `JSON.stringify({...})` index objects)
- Modify: `server/ws-proxy.js` (≈314 — replace inline index object)
- Test: `test/entry.test.js` (add legacy-parity cases)

- [ ] **Step 1: Add the T1 legacy-parity test** (append to `test/entry.test.js`)

```js
// Legacy parity: for each provider/transport, buildIndexLine(entry) must keep every
// key the old hand-rolled line wrote, add new keys only from the allowlist, and keep
// legacy values deepEqual (except the allowlisted OpenAI fixes).
const LEGACY_KEYS = {
  anthropicSSE: ['id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt','sysHash','toolsHash','coreHash','thinkingStripped','hasCredential','toolSources'],
  openaiSSE: ['id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata','stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt','sysHash','toolsHash','coreHash','hasCredential'],
  nonSSE: ['id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata','stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt','sysHash','toolsHash','coreHash','thinkingStripped','hasCredential','toolSources'],
  ws: ['id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata','stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt','sysHash','toolsHash','coreHash','thinkingStripped','hasCredential','toolSources'],
};
test('INDEX_FIELDS is a superset of every legacy key set', () => {
  for (const [site, keys] of Object.entries(LEGACY_KEYS))
    for (const k of keys) assert.ok(INDEX_FIELDS.includes(k), `${site} legacy key missing from INDEX_FIELDS: ${k}`);
});
```

> Note: this locks INDEX_FIELDS ⊇ each legacy set. The allowlisted additions (OpenAI gaining real `cost`/`maxContext`, and `responseMetadata`/`thinkingStripped`/`toolSources` appearing where a site lacked them) are intentional and covered by Task 4-6's consistency tests. A field present as `undefined` on an entry is dropped by `buildIndexLine`, so sites that never set e.g. `toolSources` still emit no such key.

- [ ] **Step 2: Run, expect pass** (the test only needs `INDEX_FIELDS`)

Run: `node --test test/entry.test.js`
Expected: PASS (if FAIL, a legacy key is missing from INDEX_FIELDS — add it).

- [ ] **Step 3: Replace the 4 index-line objects**

In each site, delete the inline `const indexLine = JSON.stringify({ ... });` and replace with:

```js
const { buildIndexLine } = require('./entry'); // add require at top of forward.js / ws-proxy.js
// ...
const indexLine = buildIndexLine(entry);
```

The 3 forward.js sites and the ws-proxy site all already have a fully-populated `entry` object in scope at the point the index line is built — so this is a pure swap. **Do not** touch any field computation above it yet.

- [ ] **Step 4: Smoke — confirm the OpenAI SSE drift is fixed on disk**

Run an isolated server + a real Codex turn (see Completion Gate, steps 1-2), then:
```bash
grep -o '"maxContext":[0-9]*' "$LEDGER_HOME/logs"/*_res.json 2>/dev/null; \
node -e 'const fs=require("fs"),p=process.env.LEDGER_HOME+"/logs/index.ndjson";for(const l of fs.readFileSync(p,"utf8").trim().split("\n")){const o=JSON.parse(l);if(o.provider==="openai"&&o.isSSE)console.log("openai SSE index maxContext=",o.maxContext,"cost=",JSON.stringify(o.cost))}'
```
Expected: OpenAI SSE index lines now show real `maxContext`/`cost`, not null.

- [ ] **Step 5: Full suite**

Run: `node --test test/*.test.js`
Expected: PASS (same +N).

- [ ] **Step 6: Commit**

```bash
git add server/forward.js server/ws-proxy.js test/entry.test.js
git commit -m "fix(3b): index line via buildIndexLine(entry) — fixes OpenAI SSE cost/maxContext restore drift"
```

---

## Phase 3b② — parser.buildEntryFields for OpenAI (SSE + non-SSE)

### Task 4: `openai.buildEntryFields(ctx)` contract + T2 test

**Files:**
- Modify: `server/wire-parsers/openai.js` (add `buildEntryFields`)
- Test: `test/wire-parsers-build-entry.test.js`

**Contract** (shared output across providers): `buildEntryFields(ctx)` returns an object with the canonical fields — everything in `INDEX_FIELDS` **except** the caller-owned `id, ts, receivedAt, elapsed, isSSE, status` — plus `provider, agent`. The caller spreads it into the entry. `ctx` for OpenAI SSE carries: `{ provider:'openai', parsedBody, events, response, proxyRes, sessionId, sessionInferred, isSubagent, sysHash, toolsHash, coreHash }`. **`ctx` must include `parsedBody`+`events`+`response` so `entryHasCredential`/`buildToolSources` can be computed here, before the caller nulls req/res** (T2).

- [ ] **Step 1: Write the failing test** (use an existing OpenAI SSE fixture)

```js
// test/wire-parsers-build-entry.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getParser } = require('../server/wire-parsers');

function loadOpenAISSEFixture() {
  // events array captured from a real codex turn
  const p = path.join(__dirname, 'fixtures/wire-parsers/openai/sse-events.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('openai.buildEntryFields yields canonical fields incl. non-null maxContext/cost/stopReason', () => {
  const events = loadOpenAISSEFixture();
  // response is derived inside the parser from ctx.events; no need to pass it.
  const ctx = {
    provider: 'openai', parsedBody: { model: 'gpt-5.5', input: [{}], tools: [] },
    events, proxyRes: { statusCode: 200 }, sessionId: 's', sessionInferred: false,
    isSubagent: false, sysHash: null, toolsHash: null, coreHash: null,
  };
  const f = getParser('openai').buildEntryFields(ctx);
  assert.equal(f.provider, 'openai');
  assert.equal(f.agent, 'codex');
  assert.ok(f.maxContext > 0, 'maxContext must be non-null');
  assert.ok(f.cost !== null && f.cost !== undefined, 'cost must be computed');
  assert.equal(typeof f.stopReason, 'string');
  assert.ok('responseMetadata' in f);
});
```

> If `test/fixtures/wire-parsers/openai/sse-events.json` does not exist, create it first by capturing `events` from a real codex turn (Completion Gate step 2 writes `_res.json`; copy a representative one). Document the capture in the fixture file header comment.

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/wire-parsers-build-entry.test.js`
Expected: FAIL — `buildEntryFields is not a function`.

- [ ] **Step 3: Implement `openai.buildEntryFields(ctx)`**

Move the field computation currently in `forward.js` `handleOpenAISSE` (≈716-748) into the parser. The method body mirrors that block, reading from `ctx` instead of closure vars:

```js
// server/wire-parsers/openai.js
const helpers = require('../helpers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');
// getOpenAIResponseFromEvents / buildResponseMetadata / getOpenAIInputSummary /
// getOpenAIOutputSummary already live in this module or forward; if in forward,
// move the pure ones (getOpenAIResponseFromEvents, getOpenAIInputSummary,
// getOpenAIOutputSummary, buildResponseMetadata) into openai.js and re-export to
// forward to avoid a require cycle.

function buildEntryFields(ctx) {
  const { parsedBody, proxyRes } = ctx;
  const response = ctx.response || getOpenAIResponseFromEvents(ctx.events || []);
  const responseMetadata = buildResponseMetadata('openai', response, proxyRes);
  if (ctx.events && ctx.events.length) responseMetadata.streaming = true;
  const usage = extractUsage(response);
  const model = response?.model || parsedBody?.model || null;
  return {
    provider: 'openai', agent: agentForProvider('openai'),
    model,
    msgCount: Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0,
    toolCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolCalls: helpers.extractOpenAIToolCalls((ctx.events && ctx.events.length) ? ctx.events : response?.output),
    isSubagent: ctx.isSubagent || false,
    sessionInferred: ctx.sessionInferred || false,
    cwd: ctx.cwd ?? null,
    usage,
    cost: calculateCost(usage, model),
    maxContext: config.inferMaxContext(model, parsedBody?.instructions, usage),
    responseMetadata,
    stopReason: response?.status || '',
    title: getOpenAIInputSummary(parsedBody?.input) || getOpenAIOutputSummary(response),
    thinkingDuration: null,
    toolFail: false,
    sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null, coreHash: ctx.coreHash || null,
    thinkingStripped: undefined,
    sessionId: ctx.sessionId,
  };
}
```

`hasCredential`/`toolSources` stay computed by the **caller** on the assembled entry (which still holds `req`/`res`) — see Task 5 — so they run before req/res release. Export `buildEntryFields` from the parser.

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/wire-parsers-build-entry.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/wire-parsers/openai.js test/wire-parsers-build-entry.test.js test/fixtures/wire-parsers/openai/sse-events.json
git commit -m "feat(3b): openai.buildEntryFields(ctx) — canonical fields incl. real cost/maxContext"
```

### Task 5: Wire `handleOpenAISSE` + non-SSE OpenAI to use `buildEntryFields`

**Files:**
- Modify: `server/forward.js` `handleOpenAISSE` (≈716-760) and non-SSE OpenAI branch (≈836-905)

- [ ] **Step 1: Replace the OpenAI SSE entry assembly**

In `handleOpenAISSE`, replace the inline `const entry = { ...30 fields... }` with caller-owned + parser fields:

```js
const entry = {
  id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
  req: parsedBody, res: events,
  elapsed, status: proxyRes.statusCode, isSSE: true,
  receivedAt: startTime,
  tokens: helpers.tokenizeRequest(parsedBody),
  duplicateToolCalls: null,
  ...getParser('openai').buildEntryFields({
    provider: 'openai', parsedBody, events, response, proxyRes,
    sessionId: reqSessionId, sessionInferred: ctx.sessionInferred, isSubagent: ctx.isSubagent,
    sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
    cwd: store.sessionMeta[reqSessionId]?.cwd || null,
  }),
};
entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
entry.toolSources = helpers.buildToolSources(entry) || undefined;  // now also for OpenAI SSE
entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
```

(The index line is already `buildIndexLine(entry)` from Task 3.)

- [ ] **Step 2: Replace the non-SSE OpenAI branch** the same way, passing `ctx.response = openAIResponse || resData`, `events = openAIEvents`, `isSSE: !!openAIEvents`. Keep the Anthropic branch of non-SSE **unchanged** for now (it's migrated in Task 7); guard: `if (provider === 'openai') entry = {...buildEntryFields...}; else { /* existing anthropic inline */ }`.

- [ ] **Step 3: Consistency test (T2/primary acceptance) — live → indexLine → restore**

Add to `test/wire-parsers-build-entry.test.js`:

```js
const { INDEX_FIELDS, buildIndexLine } = require('../server/entry');
test('openai entry → buildIndexLine → parsed-back keeps cost/maxContext/stopReason/responseMetadata', () => {
  const events = loadOpenAISSEFixture();
  const f = getParser('openai').buildEntryFields({
    provider:'openai', parsedBody:{model:'gpt-5.5',input:[{}],tools:[]}, events,
    proxyRes:{statusCode:200}, sessionId:'s',
  });
  const entry = { id:'X', ts:'t', elapsed:'1.0', status:200, isSSE:true, receivedAt:1, ...f };
  const back = JSON.parse(buildIndexLine(entry));
  assert.equal(back.maxContext, f.maxContext);
  assert.deepEqual(back.cost, f.cost);
  assert.equal(back.stopReason, f.stopReason);
  assert.ok('responseMetadata' in back);
});
```

- [ ] **Step 4: Full suite + isolated smoke (OpenAI live↔restore)**

Run: `node --test test/*.test.js` → PASS.
Smoke: Completion-Gate steps for Codex; restart; confirm API `maxContext/cost/stopReason` identical live vs restore.

- [ ] **Step 5: Commit**

```bash
git add server/forward.js test/wire-parsers-build-entry.test.js
git commit -m "refactor(3b): handleOpenAISSE + non-SSE OpenAI build entry via buildEntryFields"
```

---

## Phase 3b③ — WS recordWebSocketEntry + T8 restore guard

### Task 6: Migrate WS entry + WS-restore-as-SSE guard

**Files:**
- Modify: `server/ws-proxy.js` `recordWebSocketEntry` (≈272-310)
- Modify: `server/restore.js` (≈133 — guard normalize for WS)
- Test: `test/ws-restore-guard.test.js`

- [ ] **Step 1: Write the failing T8 test**

```js
// test/ws-restore-guard.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeOpenAIResponseSummary } = require('../server/forward');

test('WS entry restore must not flip isSSE to true', () => {
  const meta = {
    id: 'X', provider: 'openai', isSSE: false,
    responseMetadata: { transport: 'websocket', capture: 'transport-only' },
    usage: { input_tokens: 1 }, model: 'gpt-5.5',
  };
  // even if a (future) richer WS res array is passed, transport=websocket wins
  const resData = [{ type: 'response.completed', data: { response: { status: 'completed' } } }];
  const { summary } = normalizeOpenAIResponseSummary(meta, resData);
  assert.equal(summary.isSSE, false, 'WS entry must stay isSSE:false');
  assert.equal(summary.responseMetadata.transport, 'websocket');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/ws-restore-guard.test.js`
Expected: FAIL (current normalize flips/derives from array).

- [ ] **Step 3: Guard in `normalizeOpenAIResponseSummary`**

At the top of the function, short-circuit the SSE-array path for WS:

```js
function normalizeOpenAIResponseSummary(meta, resData) {
  if (meta?.responseMetadata?.transport === 'websocket') {
    // WS is transport-only; never re-derive isSSE from a frame array.
    return { summary: { ...meta, isSSE: false }, resData };
  }
  // ... existing logic unchanged ...
}
```

Also in `restore.js:133`, the `meta.provider === 'openai' && (!meta.isSSE ...)` re-normalize block is now safe (guard returns early for WS), but add the same `transport==='websocket'` skip there if it computes independently.

- [ ] **Step 4: Migrate the WS entry assembly** to `openai.buildEntryFields`, passing WS ctx:

```js
const f = getParser('openai').buildEntryFields({
  provider: 'openai', parsedBody: cr || {}, events: ctx.responseEvents,
  response: null, wsResult: result, lastUsage: ctx.lastUsage, lastModel: ctx.lastModel,
  proxyRes: { statusCode: result.status },
  sessionId: ctx.sessionId, sessionInferred: ctx.sessionInferred,
  isSubagent: ctx.agentType === 'explorer' || ctx.agentType === 'worker',
  cwd: store.sessionMeta[ctx.sessionId]?.cwd || null,
});
```

Extend `openai.buildEntryFields` to honor WS inputs: when `ctx.wsResult` present, use `ctx.lastUsage`/`ctx.lastModel` for usage/model/cost/maxContext, `responseMetadata` = the WS metadata object (transport:'websocket'), `stopReason` = `result.close?.reason || result.error?.message || null`, `title` = `'Codex WebSocket session'`, `toolCalls` = `helpers.extractOpenAIToolCalls(ctx.responseEvents)`. Caller still computes `hasCredential`/`toolSources`.

- [ ] **Step 5: T8 WS restore regression via smoke**

After a real WS codex turn + restart, assert the restored entry: `isSSE===false`, `responseMetadata.transport==='websocket'` (query `/_api/entries`).

- [ ] **Step 6: Full suite + commit**

Run: `node --test test/*.test.js` → PASS.
```bash
git add server/ws-proxy.js server/restore.js test/ws-restore-guard.test.js server/wire-parsers/openai.js
git commit -m "refactor(3b): WS entry via buildEntryFields + guard WS restore from SSE mis-classification (T8)"
```

---

## Phase 3b④ — Anthropic SSE tail (last; HUD untouched)

### Task 7: `anthropic.buildEntryFields(ctx)` + migrate the SSE tail + non-SSE anthropic

**Files:**
- Modify: `server/wire-parsers/anthropic.js` (add `buildEntryFields`)
- Modify: `server/forward.js` Anthropic SSE tail (≈585-615, **only after `clientRes.end()`**) + non-SSE anthropic branch
- Test: `test/wire-parsers-build-entry.test.js` (anthropic cases)

- [ ] **Step 1: Failing test for `anthropic.buildEntryFields`** (use an anthropic SSE fixture covering thinking + tool use + subagent)

```js
test('anthropic.buildEntryFields keeps thinkingStripped/toolSources/hasCredential inputs', () => {
  const events = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/wire-parsers/anthropic/sse-events.json'),'utf8'));
  const parsedBody = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/wire-parsers/anthropic/req.json'),'utf8'));
  const f = getParser('anthropic').buildEntryFields({
    provider:'anthropic', parsedBody, events, proxyRes:{statusCode:200},
    sessionId:'s', sysHash:'h', toolsHash:'t', coreHash:'c',
    stopReason:'end_turn', startTime: 1,
  });
  assert.equal(f.provider,'anthropic');
  assert.equal(f.agent,'claude');
  assert.equal(typeof f.thinkingStripped, 'boolean');
  assert.ok('coreHash' in f);
});
```

- [ ] **Step 2: Run, expect fail.** Run: `node --test test/wire-parsers-build-entry.test.js` → FAIL.

- [ ] **Step 3: Implement `anthropic.buildEntryFields(ctx)`** by moving `forward.js` Anthropic SSE field computation (≈570-611: `maxContext, isSubagent, title, toolFail, thinkingDuration, thinkingStripped, model, msgCount, toolCount, toolCalls, sysHash/toolsHash/coreHash`) into the parser, reading from `ctx`. `stopReason` is passed in (the SSE loop computes it). Set `responseMetadata: undefined` (Anthropic has none → dropped). Keep `resolveTitleGenTitle`/`computeThinkingStripped` calls (import into the parser or pass results via ctx — prefer importing the pure helpers).

- [ ] **Step 4: Run, expect pass.** → PASS.

- [ ] **Step 5: Migrate the forward.js Anthropic SSE tail** — replace only the `const entry = {...}` assembly **below `clientRes.end()`** (≈585); **do not** touch the HUD/intercept stream code (≈493-555). Then migrate the non-SSE anthropic branch likewise.

```js
const entry = {
  id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
  req: parsedBody, res: events,
  elapsed, status: proxyRes.statusCode, isSSE: true, receivedAt: startTime,
  tokens: helpers.tokenizeRequest(parsedBody),
  duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
  ...getParser('anthropic').buildEntryFields({
    provider:'anthropic', parsedBody, events, proxyRes,
    sessionId, sessionInferred: ctx.sessionInferred, stopReason, startTime,
    sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
    cwd: store.sessionMeta[sessionId]?.cwd || null,
  }),
};
entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
entry.toolSources = helpers.buildToolSources(entry) || undefined;
entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
```

- [ ] **Step 6: T3 regression — HUD/intercept + Claude consistency**

Run: `node --test test/*.test.js` (intercept/HUD tests must stay green) → PASS.
Smoke: a live Claude turn through the isolated proxy renders HUD; entry maxContext/cost identical live↔restore.

- [ ] **Step 7: Commit**

```bash
git add server/wire-parsers/anthropic.js server/forward.js test/wire-parsers-build-entry.test.js test/fixtures/wire-parsers/anthropic/
git commit -m "refactor(3b): Anthropic SSE/non-SSE entry via buildEntryFields (HUD stream untouched)"
```

---

## Phase 3c — registerPromptVersion + dead-interface removal

### Task 8: Unify prompt-version registration

**Files:**
- Modify: `server/wire-parsers/{anthropic,openai}.js` (add `registerPromptVersion(ctx)`)
- Modify: `server/index.js` (≈305-318 openai, ≈379-406 anthropic → call `getParser(provider).registerPromptVersion(ctx)`)
- Test: `test/wire-parsers-build-entry.test.js` (T9 coreHash)

- [ ] **Step 1: T9 failing test** — assert that after registration the returned ctx/coreHash is present:

```js
test('anthropic.registerPromptVersion returns coreHash for the entry', () => {
  const parsedBody = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/wire-parsers/anthropic/req.json'),'utf8'));
  const out = getParser('anthropic').registerPromptVersion({ parsedBody });
  assert.ok(out && typeof out.coreHash === 'string' && out.coreHash.length > 0);
});
```

- [ ] **Step 2: Run, expect fail.** → FAIL.

- [ ] **Step 3: Implement** — move `index.js:379-406` (anthropic cc_version/B2/coreHash + `store.versionIndex` insert) into `anthropic.registerPromptVersion`, and `index.js:305-318` (openai instructions hash) into `openai.registerPromptVersion`. Each returns `{ coreHash }` (and sysHash/toolsHash if computed there) so `index.js` can thread `coreHash` onto the request ctx used by `buildEntryFields`. **coreHash must be produced before entry assembly** (T9).

- [ ] **Step 4: Run + full suite.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/wire-parsers/anthropic.js server/wire-parsers/openai.js server/index.js test/wire-parsers-build-entry.test.js
git commit -m "refactor(3c): unify prompt-version registration into parser.registerPromptVersion"
```

### Task 9: Remove dead WIRE_PARSERS interface methods

**Files:**
- Modify: `server/wire-parsers/{index.js,anthropic.js,openai.js}` (remove `normalizeListMeta`, `extractAgentType` from the interface)
- Test: existing suite (no new test; deletion is covered by green suite)

- [ ] **Step 1: Confirm no runtime caller**

Run: `grep -rnE "normalizeListMeta|\.extractAgentType\(" server --include='*.js' | grep -v 'wire-parsers/'`
Expected: empty (system-prompt's `extractAgentType` is called as `extractAgentType(...)` not `.extractAgentType(` on a parser — verify the matches that remain are `system-prompt`/`index.js:384`/`restore.js`, NOT parser-interface calls).

- [ ] **Step 2: Delete** `normalizeListMeta` and `extractAgentType` from `anthropic.js`/`openai.js` and their interface mention in `wire-parsers/index.js`. **Keep** `server/system-prompt.js`'s `extractAgentType`.

- [ ] **Step 3: Full suite** → PASS (fix any test that called the deleted parser methods — they were test-only).

- [ ] **Step 4: Commit**

```bash
git add server/wire-parsers/
git commit -m "refactor(3c): remove dead WIRE_PARSERS interface methods (normalizeListMeta, extractAgentType)"
```

---

## Completion Gate (browser-harness, both providers) — REQUIRED before "done"

### Task 10: Dual-provider live↔restore browser verification

- [ ] **Step 1: Start isolated smoke server**

```bash
LEDGER_HOME=/tmp/ccxray-a1a3-$$; export LEDGER_HOME
CCXRAY_HOME="$LEDGER_HOME" CCXRAY_LOOPBACK_NO_AUTH=1 node server/index.js --port 5611 --no-browser > "$LEDGER_HOME/server.log" 2>&1 &
```
(Confirm `:5611` free first; never use `:5577`.)

- [ ] **Step 2: Generate real traffic, both providers**

```bash
codex exec -c 'openai_base_url="http://localhost:5611/v1"' -c 'chatgpt_base_url="http://localhost:5611/v1"' "Run: echo hi — then say done. Be short."
ANTHROPIC_BASE_URL=http://localhost:5611 claude -p "Run: echo hi (one Bash call), then say done."
```
Capture each entry id from `curl -s localhost:5611/_api/entries?limit=20`.

- [ ] **Step 3: Screenshot live** (deep-link, not clicks)

```
browser-harness <<'PY'
new_tab("http://localhost:5611/?sec=timeline&target=turn&e=<CODEX_ENTRY_ID>"); wait_for_load()
import time; time.sleep(2); capture_screenshot("/tmp/a1a3-codex-live.png")
new_tab("http://localhost:5611/?sec=timeline&target=turn&e=<CLAUDE_ENTRY_ID>"); wait_for_load()
time.sleep(2); capture_screenshot("/tmp/a1a3-claude-live.png")
PY
```

- [ ] **Step 4: Restart same home → screenshot restore**

```bash
kill $(lsof -ti:5611); sleep 1
CCXRAY_HOME="$LEDGER_HOME" CCXRAY_LOOPBACK_NO_AUTH=1 node server/index.js --port 5611 --no-browser >> "$LEDGER_HOME/server.log" 2>&1 &
sleep 3
```
Re-open the same two deep-link URLs; screenshot `/tmp/a1a3-codex-restore.png`, `/tmp/a1a3-claude-restore.png`.

- [ ] **Step 5: Assert live == restore for both providers**

Read the 4 screenshots. For Codex and Claude: context bar (maxContext), cost, stopReason, tool chips, timeline steps must be identical live vs restore. Also `curl` both entries and assert `maxContext/cost/stopReason/responseMetadata` equal across the restart.

- [ ] **Step 6: Tear down + confirm :5577 untouched**

```bash
kill $(lsof -ti:5611) 2>/dev/null; rm -rf "$LEDGER_HOME"
lsof -iTCP:5577 -sTCP:LISTEN -t >/dev/null && echo "5577 hub intact"
```

- [ ] **Step 7: Run the Go/No-Go checklist** in the pre-mortem; all boxes ticked → A1-A3 done.

---

## Rollback

Each task is its own commit. To revert a phase: `git revert <commit>`. The 3b① commit (Task 3) is the highest-value low-risk one — if later phases destabilize, 3b① alone already fixes the OpenAI restore drift and can stand on its own.
