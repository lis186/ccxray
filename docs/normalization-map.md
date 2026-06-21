# ccxray Normalization Map

> How ccxray maps wire protocol fields to its internal model.
> Read [Wire Protocol Reference](wire-protocol-reference.md) first for what each agent sends on the wire.
> This document covers what ccxray **does** with those fields.

**Version baseline**: ccxray 1.10.0 · 2026-06-02

---

## Dispatch Architecture

Two-layer dispatch: `WIRE_PARSERS` (server) and `RENDERERS` (client).

```
Wire traffic → config.getUpstreamForRequestAndHeaders()
             → upstream.provider ("anthropic" | "openai")
             → server/wire-parsers/{provider}.js    ← server-side normalization
             → public/renderers/{provider}.js        ← client-side event rendering
```

| Layer | Registry | Source | Dispatch key |
|-------|----------|--------|-------------|
| Server | `server/wire-parsers/index.js` | `{ anthropic, openai }` | `upstream.provider` |
| Client | `public/renderers/index.js` | `{ anthropic, openai, fallback }` | `entry.provider` |

### WIRE_PARSERS interface

Every provider module exports:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `isNoiseRequest` | `(url, headers, body) → bool` | Filter startup/platform noise |
| `normalizeListMeta` | `(entry) → ThinCanonical` | Raw stored entry → list-layer metadata |
| `extractUsage` | `(resData) → usage obj` | Response data → canonical token counts |
| `extractAgentType` | `(systemBlob, headers) → {key, label}` | Agent classification |
| `detectSession` | `(req, headers, body) → {sessionId, isNewSession, inferred}` | Session extraction |
| `preprocessBody` | `(body, headers) → body` | Inject header metadata before storage (OpenAI only) |

---

## 1. Session Detection

### Anthropic

Single source — `body.metadata.session_id`. Delegates to `store.detectSession(parsedBody)`.

### OpenAI

Priority chain (`wire-parsers/openai.js:getCodexSessionId`):

```
1. header "session_id" or "x-openai-session-id"
2. header "x-codex-turn-metadata" → JSON parse → .session_id
3. body.metadata.session_id
4. fallback → "codex-raw" (synthetic bucket)
```

`preprocessBody` (`withCodexMetadata`) merges header-derived `session_id` + `agent_type` into `body.metadata` so downstream code treats both providers uniformly.

### Subagent detection

| Provider | Source | Logic |
|----------|--------|-------|
| Anthropic | System prompt heuristic | Absence of `cwd` metadata → likely subagent. `store.isLikelySubagent()` adds temporal heuristic (inflight + timing) |
| OpenAI | Headers/body | `x-openai-subagent` (truthy, checked first) → `body.metadata.is_subagent`/`isSubagent` (fallback) |
| OpenAI | Agent type | `explorer`/`worker` → subagent; `default` → main |

---

## 2. Working Directory (CWD)

### Anthropic

Regex extraction from system prompt content (`store.extractCwd`).

### OpenAI — HTTP

`parsedBody.metadata.cwd`, falling back to hub client CWD or `process.cwd()`.

### OpenAI — WebSocket

`x-codex-turn-metadata` header → `workspaces` object (`ws-proxy.js:getWorkspaceCwd`).

5-strategy fallback:

```
1. workspaces.cwd        (string)
2. workspaces.current    (string)
3. First string value in workspaces
4. Nested object with .cwd field
5. First key starting with "/"  ← Codex format: key IS the path
```

Step 5 is the workaround for Codex's `{ "/path/to/project": { metadata } }` where the key itself is the cwd.

---

## 3. Usage & Cost

`pricing.js:calculateCost(usage, model)` — identical call for both providers.

### Usage extraction

| Provider | Source | Extractor |
|----------|--------|-----------|
| Anthropic | SSE events `message_start` + `message_delta` | `wire-parsers/anthropic.js:extractUsage` |
| OpenAI (HTTP) | `response.usage` from SSE events or body | `wire-parsers/openai.js:extractUsage` |
| OpenAI (WS) | `ctx.lastUsage` captured before `WS_SKIP_EVENTS` filter | Same `extractUsage` |

### Field mapping (→ canonical)

| Wire field | Anthropic | OpenAI | Canonical field |
|------------|-----------|--------|-----------------|
| Input tokens | `usage.input_tokens` | `usage.input_tokens` or `prompt_tokens` | `input_tokens` |
| Output tokens | `message_delta.usage.output_tokens` | `usage.output_tokens` or `completion_tokens` | `output_tokens` |
| Cache creation | `usage.cache_creation_input_tokens` | N/A (hardcoded 0) | `cache_creation_input_tokens` |
| Cache creation detail | `usage.cache_creation.ephemeral_{5m,1h}_input_tokens` | N/A | `cache_creation` (nested) |
| Cache read | `usage.cache_read_input_tokens` | `usage.input_tokens_details.cached_tokens` | `cache_read_input_tokens` |

OpenAI's `extractUsage` also preserves native `input_tokens_details` and `output_tokens_details` for provider-specific display.

---

## 4. Token Breakdown

`helpers.js:tokenizeRequest(body)` produces `{ system, tools, messages, perMessage[], total }`.

Both providers share the same function. It branches on `body.messages` (Anthropic) vs `body.input` (OpenAI) vs `body.instructions` (OpenAI system prompt).

### perMessage mapping (OpenAI input items)

| Input item type | Mapped block type | Content source |
|-----------------|-------------------|----------------|
| `function_call_output` | `tool_result` | `item.output` |
| `{content: "string"}` | `text` | `item.content` |
| `{content: [{text}]}` | `text` (per block) | `b.text` |
| Items with no `.type` | `text` | `item.content` (string fallback) |

---

## 5. Tool Call Extraction

### Anthropic

`helpers.js:extractToolCalls(messages)` — scans `messages[].content[]` for `type:"tool_use"` blocks, counts by `name` (e.g. `{Skill: 3, Bash: 1}`). `Skill`/`Workflow` are **not** expanded to per-name keys here — the key stays the plain tool name so `toolCalls` remains a stable contract for the dashboard (`tc['Skill']`, tool chips, tool-utilization).

`helpers.js:extractSkillCalls(messages)` — companion that counts only the model-initiated `Skill` tool, keyed by the invoked skill name (e.g. `{ "superpowers:brainstorming": 2 }`). Persisted as the separate `skillCalls` index field and read by `ccxray usage` for per-skill stats. (`Workflow` has no `skill` input, so it is excluded.)

Why two fields instead of one: see [ADR 0001 — toolCalls vs skillCalls](decisions/0001-toolcalls-vs-skillcalls.md). Short version: `toolCalls` is a dashboard contract, so per-skill detail lives in a separate index — don't merge them back.

### OpenAI

`helpers.js:extractOpenAIToolCalls(responseEventsOrOutput)` — scans:

- **WS events**: `response.output_item.done` / `.added` with `item.type:"function_call"`
- **HTTP output[]**: flat items `{ type: "function_call", name, ... }`

Dedup by `item.call_id` or `item.id` (avoids double-counting `.added` + `.done`).

### Alias maps

Both server and client maintain identical maps:

```js
{ exec_command: 'Bash', shell: 'Bash', read_mcp_resource: 'Read', apply_patch: 'Edit' }
```

- Server: `helpers.js:OPENAI_TOOL_ALIASES`
- Client: `messages.js:CODEX_TOOL_ALIASES`

**Guard**: meta-tools (`tool_search`, `web_search`, `image_generation`) have no `.name` — all `t.name` access sites guard with `t.name &&`.

---

## 6. Timeline Rendering (Client)

`messages.js:buildMergedSteps(messages, resEvents, provider)` builds the unified timeline.

### Auto-detection + normalization

```
messages[].type has "message" | "function_call" | "function_call_output"?
  → yes: normalizeOpenAIInput(messages) → Anthropic-shaped messages
  → no:  pass through as-is (already Anthropic format)
```

### normalizeOpenAIInput conversion

| OpenAI input item | → Anthropic message |
|-------------------|---------------------|
| `{type:"message", role:"developer"}` | Skipped |
| `{type:"message", role:"user"\|"assistant"}` | `{role, content:[{type:"text", text}]}` |
| `{type:"function_call", call_id, name, arguments}` | `{role:"assistant", content:[{type:"tool_use", id:call_id, name, input:JSON.parse(arguments)}]}` |
| `{type:"function_call_output", call_id, output}` | `{role:"user", content:[{type:"tool_result", tool_use_id:call_id, content:output}]}` |

### Pipeline

| Phase | Input | Action |
|-------|-------|--------|
| 1a | User messages | Build `tool_use_id → tool_result` map |
| 2 | All messages | Emit `human`, `assistant-text`, `tool-group` steps |
| 3 | `resEvents` | Dispatch to `RENDERERS[provider].processEvent()` for current-turn events |

---

## 7. WS Frame Capture

`ws-proxy.js` captures Codex WebSocket content on the client→upstream path.

### Capture logic

```
clientWs.on('message') → JSON.parse → dispatch on parsed.type:
  "response.create" (generate !== false)  → first-wins capture of model/instructions/input/tools
  "session.update"                        → update instructions (forward compat)
```

`generate: false` frames are warm-up pings — skipped. Without this guard, the warm-up (which has `input: []`) would shadow the real request.

### Stored as `_req.json`

When `ctx.clientRequest` is populated: full `reqLog` with `{ provider, model, instructions, input, tools, ... }`.
When absent (non-JSON frames, binary): transport-only fallback with `{ provider: 'openai', transport: 'websocket', ... }`.

### Response events

`WS_SKIP_EVENTS` filters large envelope events from storage:

| Event | Stored? | Why |
|-------|---------|-----|
| `response.created` | No | ~35KB, redundant |
| `response.in_progress` | No | ~35KB, status-only |
| `response.completed` | No | Usage/model extracted before skip filter |
| `response.done` | No | Alias for `.completed` |
| `codex.rate_limits` | No | Non-standard metadata |
| All others | **Yes** | Tool calls, text deltas, content parts |

Usage and model are extracted from envelope events **before** the skip filter (`ws-proxy.js:488-489`), so cost data is never lost.

---

## 8. Restore-Time Normalization

`restore.js:loadEntryReqRes` handles lazy-loading from disk.

### Anthropic path

1. Read `_req.json` (may be delta format)
2. If `prevId` + `msgOffset`: follow chain recursively, splice `prevMessages[0..offset]` + delta
3. Rehydrate `sys_${hash}.json` → `entry.req.system`, `tools_${hash}.json` → `entry.req.tools`
4. Read `_res.json` → event array → `entry.res`

### OpenAI path

1. Read `_req.json` — store as-is (no dedup/delta for OpenAI)
2. Read `_res.json` → `normalizeOpenAIResponseSummary`:
   - Extract `response` object from events
   - Populate `model`, `usage`, `stopReason`, `title` on `entry`
   - Build `responseMetadata` object

### Provider dispatch

`entry.provider` (set by `addEntry` during live capture or inferred from `stripped.provider` at restore) determines which path.

---

## 9. Noise Filtering

### OpenAI

`wire-parsers/openai.js:isNoiseRequest` matches Codex 0.133+ platform pings:

```
/v1/plugins/*       /v1/ps/plugins/*     /v1/connectors/*
/v1/api/codex/apps/*                     /v1/api/codex/usage/*
```

Forwarded with `skipEntry: true` — response reaches Codex, no dashboard entry.

`/v1/codex/analytics-events/events` (telemetry) is also filtered — it 404s for API-key users, creating garbage dashboard entries.

### Anthropic

`isNoiseRequest` always returns `false` (no known startup noise).

---

## 10. System Prompt Display (Client)

`miller-columns.js` renders the System section:

```js
if (req.system || req.instructions) {
  renderSystemBlockViewer(req.system || req.instructions)
}
```

| Provider | Source | Format |
|----------|--------|--------|
| Anthropic | `req.system` | Array of `{type:"text", text, cache_control?}` blocks. B2 splitting extracts sections |
| OpenAI | `req.instructions` | Single string. Rendered as-is (no B2 splitting) |

Server-side version tracking (`system-prompt.js:registerPromptVersion`) uses `sysHash` (Anthropic) or instructions hash (OpenAI) for diff comparison.
