# Spec — Server Write-Path Abstraction (A1-A3)

**Date**: 2026-06-03
**Branch**: `feat/codex-dashboard-foundation`
**Status**: design approved (user + codex review); ready for implementation plan
**Step**: 3 of the Codex-parity cleanup (Step 1 truth-marker ✓, Step 2 gap ledger ✓)

## Problem

ccxray's server builds each captured turn's `entry` object and its `index.ndjson`
line in **four hand-rolled places**, with ~26 scattered `provider === …` ternaries:

1. `forward.js` Anthropic SSE tail (entry ≈585 / index ≈622)
2. `forward.js` OpenAI SSE (`handleOpenAISSE`, entry ≈720 / index ≈754)
3. `forward.js` non-SSE (entry ≈862 / index ≈901)
4. `ws-proxy.js` `recordWebSocketEntry` (entry ≈272 / index ≈314)

The `entry` (in-memory, broadcast to dashboard) and the `indexLine` (persisted, read
back on restore) are computed **separately** in each, so they drift. The OpenAI SSE
path (`handleOpenAISSE`) is where the `cost`/`maxContext` drift is most visible.

Confirmed drift (gap ledger, 2026-06-03 smoke): OpenAI/Codex SSE sets
`entry.maxContext = 400000` but the index line writes `maxContext: null`; non-SSE
OpenAI writes `cost: null` / `maxContext: null`. Result: a Codex turn shows correct
context/cost live, but after a restart (restore reads the index line) those fields
go null. The same structural hazard threatens every field.

This is also the root cause of several smaller Codex gaps (stopReason missing,
counter/turn-step) and the blocker for a clean per-provider abstraction.

## Goals

1. **One source of truth**: the `entry` object is canonical; the index line is a
   pure projection of it. `broadcast`, `store`, index-write, and restore all read
   the same field definitions — drift becomes structurally impossible.
2. Collapse the three hand-rolled builders into `parser.buildEntryFields(ctx)`
   (per-provider) + a single `buildIndexLine(entry)`.
3. Consolidate the scattered `provider → agent` literal (4 sites) into one map.
4. Unify the dual prompt-version registration into `parser.registerPromptVersion(ctx)`.
5. Remove dead WIRE_PARSERS interface methods.
6. Fix, as a direct consequence, Codex `maxContext`/`cost`/`stopReason` live↔restore
   consistency.

## Non-Goals (explicit)

- **Not** building the index-rebuild / self-heal feature itself. This spec only makes
  `buildIndexLine(entry)` reusable so a future rebuild step can call it. (Parked:
  `reason/260602-index-rebuild-resilience/handoff.md`.)
- **Not** routing agent detection through a registry. `server/system-prompt.js`'s
  `extractAgentType` stays as-is (still used by `index.js:384` + restore
  `buildVersionIndex`). A registry-based agent detection is a separate later step.
- **Not** merging the three SSE/non-SSE/WS stream handlers. Only the post-stream
  entry-assembly tail is extracted.
- **Not** changing wire formats, dashboard rendering, or pruning/delta-log behavior.

## Architecture

```
forward SSE-anthropic   ─┐
forward SSE-openai       ├─▶ getParser(provider).buildEntryFields(ctx) ─▶ entry (canonical)
forward non-SSE          ├     per-parser; reads its own transport          │
ws-proxy recordWS       ─┘                                                  │
                  ┌──────────────────────┬──────────────────────┬─────────┘
                  ▼                       ▼                      ▼
           broadcast(entry)        store.push(entry)     buildIndexLine(entry)
                                                         = pick(entry, INDEX_FIELDS)
                                                                 │ index.ndjson
           restore reads index line ── same INDEX_FIELDS ──▶ entry
```

The `entry` is assembled by the caller from two parts: **transport/identity fields**
the caller owns (`id`, `ts`, `receivedAt`, `elapsed`, `isSSE`, `status`) and
**canonical fields** returned by `parser.buildEntryFields(ctx)`. `status` comes from
`proxyRes.statusCode` on the HTTP paths and from `result.status` on the WS path.
Together they cover every `INDEX_FIELDS` key.

## Components

### `parser.buildEntryFields(ctx)` — per-provider, in `server/wire-parsers/{anthropic,openai}.js`

- **Output contract** (shared across providers): returns the canonical fields —
  `model, msgCount, toolCount, toolCalls, isSubagent, sessionInferred, cwd, usage,
  cost, maxContext, responseMetadata, stopReason, title, thinkingDuration, toolFail,
  sysHash, toolsHash, coreHash, thinkingStripped, provider, agent, sessionId`. Fields
  not applicable to a provider take their honest value (e.g. OpenAI cache_creation 0),
  never silently dropped. **`hasCredential` and `toolSources` are NOT returned by the
  parser** — the caller computes them on the fully-assembled entry (they depend on the
  complete entry incl. `req/res/tokens`) *before* nulling `req/res`. The caller also
  passes Anthropic `title`/`thinkingDuration`/`thinkingStripped` in via `ctx` (their
  helpers live in `forward.js`/`helpers.js`; the parser must not require `forward.js`).
  `ctx` carries an explicit `transport: 'sse' | 'http' | 'websocket'` discriminant.
- **Input** (`ctx`): a small transport-shaped context, **not** a pre-normalized union.
  Each parser reads what its transport provides:
  - anthropic: parsed request body + collected SSE events (or non-SSE response object).
  - openai: parsed request body + SSE events / response object / WS frame ctx
    (`lastUsage`, `lastModel`, `clientRequest`, frame metadata).
  Rationale (codex): Anthropic SSE carries transport side effects (HUD/intercept/
  heldEvents) and WS carries frame metadata; pre-unifying would mix side effects into
  canonical fields. Shared helpers may be extracted **after** all three paths are stable.

### `buildIndexLine(entry)` — new `server/entry.js`

- `INDEX_FIELDS` (exact projection list):
  `id, ts, sessionId, provider, agent, model, msgCount, toolCount, toolCalls,
  isSubagent, sessionInferred, cwd, isSSE, usage, cost, maxContext, responseMetadata,
  stopReason, title, thinkingDuration, toolFail, elapsed, status, receivedAt, sysHash,
  toolsHash, coreHash, thinkingStripped, hasCredential, toolSources`
- **Never projected**: `req, res, tokens, duplicateToolCalls, _loaded, _writePromise,
  _loadingPromise`.
- `buildIndexLine(entry)` = `JSON.stringify(pick(entry, INDEX_FIELDS))`. Pure; no
  provider branch. Used by the live write path now and by index-rebuild later.
- `responseMetadata` is included deliberately — WS/transport-only and OpenAI restore
  lose detail without it.

### `PROVIDER_AGENT` map — `server/providers.js`

- Single `{ openai: 'codex', anthropic: 'claude' }`-style map replacing the 4 hard-coded
  sites (`forward.js:723`, `forward.js:865`, `ws-proxy.js:279`, `sse-broadcast.js:11`).

### `parser.registerPromptVersion(ctx)` — per-provider

- Unifies the two inline version-registration paths (`index.js:379-406` anthropic
  cc_version+B2+coreHash; `index.js:305-318` openai instructions hash) that both write
  `store.versionIndex`. Each parser registers via this hook.

### Dead-code removal (A3)

- Delete `normalizeListMeta` and `extractAgentType` **from the WIRE_PARSERS interface**
  (`anthropic.js`/`openai.js`/`index.js`) — confirmed test-only, no server runtime
  caller.
- **Keep** `server/system-prompt.js`'s `extractAgentType` (live callers exist).

## Risk handling (F1 — do not break Anthropic HUD injection)

`forward.js` Anthropic SSE injects HUD / intercept-modification blocks into the live
SSE stream (≈ lines 493-555). That stream-side logic is **untouched**. Only the
entry-assembly tail (≈ line 563 onward) is migrated to `buildEntryFields`. The three
stream handlers remain separate functions.

## Phasing (≤5 files per phase; verify between phases)

- **3a** — `PROVIDER_AGENT` map. Replace 4 sites. Warm-up, lowest risk.
- **3b** — entry = single source, split by risk (forward.js is the hot spot):
  1. Add `server/entry.js` (`INDEX_FIELDS` + `buildIndexLine`). Change all **4 existing
     indexLine sites** (Anthropic SSE, `handleOpenAISSE`, non-SSE, WS) to
     `buildIndexLine(entry)` **without moving field computation**.
     → immediately fixes the OpenAI SSE index `cost`/`maxContext` drift.
  2. Add `parser.buildEntryFields` contract + tests; migrate OpenAI `handleOpenAISSE` +
     non-SSE.
  3. Migrate WS `recordWebSocketEntry`.
  4. Last: migrate Anthropic SSE tail (entry assembly only; HUD untouched).
- **3c** — `parser.registerPromptVersion` consolidation + dead-interface removal.

Each phase: full `node --test` green + isolated smoke before the next.

## Testing (TDD)

- **Unit**: `buildEntryFields` per parser from fixtures (anthropic SSE/non-SSE,
  openai SSE/WS) → assert canonical fields, incl. Codex `maxContext`/`stopReason`
  non-null where applicable.
- **Projection**: `JSON.parse(buildIndexLine(e))` keys ⊆ `INDEX_FIELDS`; values equal
  `e`'s; excluded fields absent.
- **Consistency (primary acceptance)**: build live entry → `buildIndexLine` → simulate
  restore → assert `maxContext, cost, usage, sessionId, provider, stopReason,
  responseMetadata, title` equal. Lock OpenAI specifically.
- **Anthropic regression**: an Anthropic SSE fixture confirming `buildIndexLine` keeps
  `thinkingStripped`, `toolSources`, `hasCredential`.
- Existing 654+ suite stays green.

## Acceptance criteria

1. All 4 live write sites (`forward.js` Anthropic SSE, `handleOpenAISSE`, non-SSE,
   `ws-proxy.js`) produce the entry/index line through `buildEntryFields` +
   `buildIndexLine`; a future index-rebuild *can call* `buildIndexLine(entry)` (the
   rebuild feature itself is out of scope — see Non-Goals).
2. Codex `maxContext`, `cost`, `stopReason`, `responseMetadata` are identical live and
   after restart-restore (smoke-verified).
3. The 4 `provider → agent` sites and the 2 version-registration paths are each a
   single source.
4. Dead WIRE_PARSERS methods removed; `system-prompt.extractAgentType` intact.
5. Anthropic HUD/intercept SSE injection behaves exactly as before.
6. Full test suite green **and** the browser-harness completion gate passes: on an
   isolated smoke server, real Codex **and** Claude traffic verified live↔restore
   (maxContext / cost / stopReason / tool chips / timeline steps identical before and
   after a restart), navigated via deep-link `?e=<entryId>` URLs. See pre-mortem
   (`2026-06-03-a1a3-premortem.md`) for the protocol and the Go/No-Go checklist. "Done"
   is not declared until this gate passes for both providers.

## Out of scope / deferred

index-rebuild self-heal feature; agent-detection-via-registry; P1-P5 feature work;
N-layer parity (N1 session-collapse, N2 credential, N3 MCP noise); per-provider cache
model. These follow in later steps.
