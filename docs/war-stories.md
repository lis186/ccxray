# War Stories: Dual-Provider Implementation

> Lessons learned, gotchas, and historical context from making ccxray work with both Claude Code (Anthropic) and Codex (OpenAI).
> Read [Wire Protocol Reference](wire-protocol-reference.md) for what each agent sends on the wire.
> Read [Normalization Map](normalization-map.md) for how ccxray maps those fields internally.

**Covers**: ccxray 1.9.x → 1.10.0 migration · 2026-05-28 — 2026-06-02

---

## Why the Abstraction

ccxray started as a Claude Code proxy. Every function assumed Anthropic wire format. When Codex support was added, the initial instinct was "just add `if (provider === 'openai')` everywhere." That path was rejected after counting the call sites — it would have scattered 20+ conditional branches across server and client code. Instead, ccxray was refactored to a per-provider strategy registry (`WIRE_PARSERS` + `RENDERERS`), where adding a future provider means adding one module per registry, zero if-else branches in shared code.

The refactoring happened on `feat/two-domain-auth` across 8 phases, 40+ commits, producing +5142 -1096 lines across 74 files.

---

## War Story 1: The `generate:false` Warm-Up Bug

**Symptom**: Every Codex first-turn had `input: []` — empty request content.

**False diagnosis**: "Codex doesn't send input on the first turn — it's a protocol limitation." A 34-line `backfillFirstTurnInput` workaround was written to retroactively patch Turn 1's `_req.json` when Turn 2 arrived with history.

**True root cause**: Codex sends a `response.create` frame with `generate: false` as a warm-up ping before the real `response.create`. The capture guard `!ctx.clientRequest` let the warm-up (which has `input: []`) claim the slot, silently dropping the real request (which had the user's messages).

**Fix**: 1 line — add `parsed.generate !== false` to the guard. The 34-line backfill was deleted.

**Lesson**: When you see an anomalous value, verify the root cause before writing a workaround. The wire dump had the real `response.create` frame with full input — we just weren't looking at it because the workaround "fixed" the visible symptom.

---

## War Story 2: The Invisible RAF Crash

**Symptom**: Selecting a Codex turn in the dashboard → Timeline stuck on "Loading…" forever. No errors in console.

**False diagnosis**: Spent 30 rounds investigating scheduling races in `scheduleRender` / coalesce guards. The theory was that a timing issue was preventing `renderDetailCol()` from being called.

**True root cause**: `renderSectionsCol()` was crashing. It iterated `req.tools` and called `t.name.startsWith('mcp__')` — but Codex has 3 meta-tools (`tool_search`, `web_search`, `image_generation`) that have no `.name` field. The crash happened inside a `requestAnimationFrame` callback, and **uncaught errors in RAF don't show in the console**. The crash aborted the entire RAF, so `renderDetailCol()` (which ran later in the same callback) never executed.

**How it was found**: Adding a `try-catch` around `renderSectionsCol()` immediately revealed the TypeError.

**Fix**: `t.name &&` guard at 3 sites.

**Lesson**: When a function "isn't being called," check if its *caller* is crashing. Don't theorize about scheduling races when a `try-catch` would answer the question in 5 minutes.

---

## War Story 3: The `safeCall` False Safety Net

**Symptom**: Phase 3 wire-up (dispatching to `WIRE_PARSERS` from `index.js`) failed on first attempt. Functions were being called but silently producing wrong results.

**Root cause**: The initial approach wrapped every `WIRE_PARSERS` call in a `safeCall` helper that caught and logged exceptions. This hid real bugs — `dedupExtract` returning a complex nested object that didn't match the caller's expectations, `detectOpenAISession` receiving 2 params when its new signature expected 3, etc.

**Fix**: Remove `safeCall`. Let functions crash visibly. Simplify `dedupExtract` return value. Align function signatures.

**Lesson**: Error-swallowing wrappers are anti-patterns during development. If a new abstraction boundary is crashing, that's signal — you *want* it to crash loudly so you can fix the interface.

---

## War Story 4: Mock Content-Type Breaks SSE Dispatch

**Symptom**: Regression test for `extractOpenAIToolCalls` passed, but the integration test (forwarding a real Codex response through the proxy) didn't extract tool calls.

**Root cause**: The test mocked the upstream response with `Content-Type: application/json`. But the SSE dispatch in `forward.js` only calls `handleOpenAISSE` when `Content-Type` is `text/event-stream`. With `application/json`, it took the JSON path, which doesn't call `extractOpenAIToolCalls`.

**Fix**: Change test mock to `text/event-stream`.

**Lesson**: Mock headers must match real dispatch conditions. A unit test that passes with wrong headers proves the function works in isolation but misses the wiring.

---

## War Story 5: `response.completed` — To Skip or Not to Skip

**Initial state**: `WS_SKIP_EVENTS` included `response.completed` and `response.done`, dropping ~35KB envelope events from stored response events.

**Concern**: Aren't we losing usage data?

**Answer**: No — usage and model are extracted from these events *before* the skip filter runs (ws-proxy.js lines 488-489). The events are then discarded from `ctx.responseEvents` to save disk, but the extracted data is already captured.

**Why keep skipping**: Each `response.completed` event is ~35KB (it echoes back instructions + tools). Storing it would roughly double log size per WS turn for data that's redundant with the already-captured `_req.json`.

**Tool calls**: Tool call extraction uses `response.output_item.done` events (which are NOT skipped), not `response.completed`. The `output` field in `response.completed` is `null` in Codex 0.133+.

---

## Gotcha Catalog

### Meta-tools without `.name`

Codex defines at minimum 3 meta-tools (`tool_search`, `web_search`, `image_generation`) that have no `.name` property in their tool definition. Any `t.name.startsWith(...)` or `t.name.includes(...)` crashes unless guarded.

**Affected code paths**: `categorizeTools()`, `renderSectionsCol()`, `extractToolCalls()`.

### Two aliases, two locations

Codex tool names (`exec_command`, `shell`, `read_mcp_resource`, `apply_patch`) are aliased to familiar names (`Bash`, `Read`, `Edit`). The alias map exists in two places:
- Server: `helpers.js:OPENAI_TOOL_ALIASES` (for `extractOpenAIToolCalls`)
- Client: `messages.js:CODEX_TOOL_ALIASES` (for timeline rendering and tool preview)

They must stay in sync manually.

### `entry.provider` must be set at `addEntry` time

The provider field is needed before lazy-load — list rendering, renderer selection, and session metadata all depend on it. If `addEntry` doesn't store `provider` from the SSE broadcast, it defaults to `'anthropic'` and OpenAI entries render with the wrong renderer.

### OpenAI responses: events vs output array

Codex responses come in two shapes depending on transport:
- **WS**: Stored as array of event objects (`[{type: "response.output_text.delta", ...}, ...]`)
- **HTTP SSE**: Stored as array of parsed SSE events (same structure after parsing)
- **HTTP non-SSE**: Stored as response body object with `output[]` array

`extractOpenAIToolCalls` handles both: it detects event-wrapped items by checking `ev.type.startsWith('response.')` and unwraps `ev.item`.

### Delta-log is Anthropic-only

Delta storage (writing only new messages + a pointer to the previous turn) only applies to Anthropic sessions with explicit `session_id`. OpenAI entries store full request bodies. This is acceptable because:
- WS entries are typically single-turn (1 connection = 1 response)
- Codex uses `previous_response_id` for chaining instead of repeating full history
- HTTP OpenAI entries are rarer (most Codex traffic is WS)

### Restore-time OpenAI normalization

When loading OpenAI `_res.json` from disk, `normalizeOpenAIResponseSummary` extracts metadata that was only available at response time (model, usage, stopReason, title). This is necessary because OpenAI entries don't split usage across request start/delta events like Anthropic — the data comes from the response object.

### System prompt: string vs array

Anthropic system prompts are arrays of `{type:"text", text, cache_control?}` blocks — the B2 splitting logic assumes this structure. OpenAI system prompts are a single `instructions` string. The client-side `renderSystemBlockViewer` handles both via `req.system || req.instructions`, but B2 section splitting (for the system prompt version comparison UI) only works on Anthropic format.

### ChatGPT OAuth routing

When `chatgpt-account-id` header is present with a JWT-shaped authorization token, requests route to `chatgpt.com/backend-api/codex/...` instead of `api.openai.com`. The proxy strips the `/v1` prefix before prepending the base path. This is transparent to the dashboard — `provider` is still `'openai'`.
