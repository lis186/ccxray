# Data Model

Reference for the entry summary objects broadcast from server to dashboard via SSE, and persisted to `~/.ccxray/logs/index.ndjson`.

## Entry summary

Produced by `server/sse-broadcast.js` `summarizeEntry()`. The full request/response payloads are NOT included — they live on disk and are lazy-loaded when a turn is selected.

### Core identity

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Turn ID, format `YYYY-MM-DDTHH-MM-SS-mmm` |
| `ts` | number | Unix ms, when proxy first received the request |
| `receivedAt` | number \| null | Alias of `ts` retained for client-side gap timing |
| `sessionId` | string | Session ID (from request `metadata.user_id`, or inferred) |
| `sessionInferred` | boolean | true if session was attributed by inference (no explicit ID) |
| `method` | string | HTTP method (always `POST` for /v1/messages) |
| `url` | string | Request path |
| `cwd` | string \| null | Working dir extracted from system prompt |
| `isSubagent` | boolean | true if request has no cwd in system prompt (spawned via Agent tool) |

### Request shape

| Field | Type | Description |
|-------|------|-------------|
| `model` | string \| null | Model ID from request body (e.g., `claude-opus-4-6`) |
| `msgCount` | number | Length of `messages[]` |
| `toolCount` | number | Length of `tools[]` |
| `toolCalls` | object | `{ toolName: count }` — tool_use blocks across messages |
| `skillCalls` | object | `{ skillName: count }` — `Skill` tool calls by invoked skill (Anthropic only; absent on older entries). Read by `ccxray usage` for per-skill stats |

### Response outcome

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code |
| `elapsed` | string | Seconds as 1-decimal string (e.g., `"4.3"`) |
| `isSSE` | boolean | true if upstream response was streaming |
| `stopReason` | string | API `stop_reason` (`end_turn` \| `tool_use` \| `max_tokens` \| …) |
| `title` | string \| null | Turn description. Cascade: response text → last user text → tool-result summary (`↩ ToolA · ToolB`) → subagent's first user text |
| `thinkingDuration` | number \| null | Extended-thinking seconds if captured from SSE |

### Usage & cost

| Field | Type | Description |
|-------|------|-------------|
| `usage` | object \| null | `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` |
| `cost` | object \| null | `{ cost, inputCost, outputCost, cacheReadCost, cacheWriteCost }` |
| `maxContext` | number | Model context window (200K / 1M based on `[1m]` suffix in system prompt) |
| `tokens` | object \| null | `{ system, tools, messages, total, contextBreakdown, perMessage }` — structural breakdown from `tokenizeRequest` |

### Risk signals

| Field | Type | Description |
|-------|------|-------------|
| `toolFail` | boolean | At least one `tool_result` in the request had `is_error: true` |
| `duplicateToolCalls` | object \| null | `{ toolName: extraCount }` — repeated tool_use with same input |
| `hasCredential` | boolean \| undefined | Credential pattern (API key, SSH key, etc.) detected in response or messages |
| `toolSources` | object \| undefined | `{ tool_use_id: 'network' \| 'local' \| 'local:sensitive' }` — taint classification |

## Backward compatibility

Older `index.ndjson` entries may lack newer fields. Consumers SHOULD use nullish-coalescing defaults:

```js
const toolFail = entry.toolFail ?? false;
const duplicateToolCalls = entry.duplicateToolCalls ?? null;
const hasCredential = entry.hasCredential ?? false;
```

## Where fields are computed

| Field | Source file |
|-------|-------------|
| `usage`, `cost` | `server/pricing.js` |
| `maxContext` | `server/config.js` `getMaxContext()` |
| `title` | `server/forward.js` title cascade using `server/helpers.js` extractors |
| `tokens` | `server/helpers.js` `tokenizeRequest()` |
| `toolCalls`, `duplicateToolCalls` | `server/helpers.js` `extractToolCalls()` / `extractDuplicateToolCalls()` |
| `skillCalls` | `server/helpers.js` `extractSkillCalls()` |
| `toolFail` | `server/helpers.js` `hasToolFail()` |
| `hasCredential` | `server/helpers.js` `entryHasCredential()` |
| `toolSources` | `server/helpers.js` `buildToolSources()` |
| `isSubagent`, `cwd` | `server/store.js` `extractCwd()` |
