# Wire Protocol Reference: Claude Code vs Codex

> This document records observable wire-level behavior of two AI coding agents
> as seen by the ccxray proxy. It is **not a spec** — it documents what each
> agent actually sends on the wire, which may differ from official documentation
> and may change without notice.

**Confidence tags** (per-field):

| Tag | Meaning | Action when coding against it |
|-----|---------|-------------------------------|
| `contractual` | Appears in official API docs | Safe to depend on |
| `obs-stable` | Consistent across multiple versions, undocumented | Depend on with defensive fallback |
| `obs-fragile` | Seen in current version only, or already changed once | Guard with try-catch, log when violated |

**Version baseline**: Claude Code CLI 2.1.159 · Codex CLI 0.133.0-alpha.1 · ccxray 1.10.0 · 2026-06-01

**Official references**:
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Anthropic Streaming: https://docs.anthropic.com/en/api/messages-streaming
- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- OpenAI WebSocket Mode: https://platform.openai.com/docs/guides/websocket

---

## Changelog

| Date | Agent | Version | Change |
|------|-------|---------|--------|
| 2026-07-09 | Grok CLI | 0.2.93 | First wire capture + integration: `POST /v1/responses` SSE (no WS) via `cli-chat-proxy.grok.com`; client redirect `GROK_CLI_CHAT_PROXY_BASE_URL`. System prompt in `input[role=system]` (string content), not `instructions`. Session via `x-grok-session-id` / `x-grok-conv-id`. Header-based upstream routing to `UPSTREAMS.xai` keeps Codex on `api.openai.com` in a shared hub. Control-plane `/v1/*` (settings/feedback) classified as noise for Grok clients. Full notes: `docs/grok-wire-experiment-2026-07-09.md`. |
| 2026-07-06 | Claude Code | 2.1.x | Discovered: `POST /v1/messages/count_tokens` calls (token pre-counting for large content). Body is bare `{model, messages}` — no `system`, no `metadata`, no `tools`, no `max_tokens`; response is exactly `{"input_tokens": N}` (non-SSE). Satisfied every subagent heuristic and polluted sessions with fake single-turn subagent entries (#146). ccxray now classifies the path as noise (`skipEntry`), matching quota-check / codex-platform-ping handling. |
| 2026-06-09 | Claude Code | 2.1.x | Confirmed via loopback wire capture: `anthropic-beta` carries `context-1m-2025-08-07` on **every** request when the account's 1M context is enabled — including haiku title-gen turns (it is a client/account-level capability flag, not a per-turn window declaration). ccxray now uses it as the non-lagging 1M-window signal, gated by model capability (`SUPPORTS_1M`), replacing sole reliance on the lagging system-prompt `[1m]` marker (#58). |
| 2026-06-05 | ccxray | 1.11.x | Usage normalization: OpenAI `input_tokens` includes `cached_tokens` (subset), unlike Anthropic's disjoint fields. `normalizeUsageForProvider` now subtracts the overlap so canonical `input_tokens + cache_read + cache_creation = total context` holds for both providers. Normalized entries carry `_ccxrayUsageNormalized: true`. Historical entries normalized on restore (in-memory, index unchanged). Cache display: Codex sessions show `cache N% hit` instead of TTL countdown; topbar adapts per provider (`ephemeral-ttl` vs `server-managed`). `UPSTREAM_PROFILES` registry added to `providers.js`. |
| 2026-06-04 | ccxray | 1.10.x | Fix: WS `stopReason` now extracts `response.status` from terminal events (`completed`/`incomplete`/`failed`/`cancelled`) instead of WS close reason. WS `title` extracts user input summary via `getOpenAIInputSummary` instead of hardcoded string. Non-terminal statuses (`in_progress`/`queued`) are ignored to prevent masking close/error reasons. |
| 2026-06-02 | ccxray | 1.10.0 | Doc audit: 13 major + 25 minor corrections applied (F1–F38) |
| 2026-06-01 | Codex | 0.133 | Baseline: all observations below recorded |
| 2026-06-01 | Claude Code | 2.1.159 | Baseline: all observations below recorded |
| 2026-06-01 | ccxray | 1.9.x→1.10.0 | Discovered: meta-tools without `.name`, `generate:false` warm-up pattern, ephemeral cache fields, ChatGPT OAuth path-based routing |

---

## 1. Transport

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Protocol | HTTP POST + SSE streaming | HTTP POST (SSE) + WebSocket upgrade | `contractual` |
| Primary path | `POST /v1/messages` | `POST /v1/responses` (HTTP) or WS upgrade on `/v1/responses` | `contractual` |
| Alternative paths | `POST /v1/messages/count_tokens` (token pre-counting; bare `{model, messages}` body, non-SSE `{"input_tokens": N}` response; classified as noise by ccxray, #146) | `/v1/realtime` (Realtime API, not used by Codex CLI for chat) | `contractual` |
| WS upgrade detection | N/A | `upgrade: websocket` header on `/v1/responses` or `/v1/realtime`; ccxray also requires `upstream.provider === 'openai'` | `contractual` |
| WS handshake header | N/A | `openai-beta: responses_websockets=2026-02-06` (observed value from Codex wire traffic; ccxray passes through without validation) | `obs-stable` codex ≥0.131 |
| WS idle timeout (proxy) | N/A | ccxray: 60s default, configurable via `CCXRAY_WS_IDLE_TIMEOUT_MS` | `obs-stable` |
| WS connection limit (OpenAI) | N/A | OpenAI docs: 60-minute absolute connection limit | `contractual` |
| WS keepalive | N/A | Ping/pong frames relayed bidirectionally between client and upstream | `obs-stable` |
| Content-Type | `application/json` | `application/json` (HTTP); binary/text frames (WS) | `contractual` |
| Upstream host | `api.anthropic.com:443` | `api.openai.com:443` (API key) or `chatgpt.com:443` (ChatGPT OAuth) | `contractual` / `obs-stable` |

> **Note**: WS warm-up (`generate: false`) is a request-payload pattern, not a transport mechanism — see Section 6.3.

---

## 2. Auth & Routing

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Auth header | `x-api-key: sk-ant-...` | `authorization: Bearer sk-...` (API key) or JWT (ChatGPT OAuth) | `contractual` |
| ChatGPT OAuth detection | N/A | `chatgpt-account-id` header present AND JWT-shaped (dot-separated) authorization token | `obs-stable` codex ≥0.131 |
| ChatGPT OAuth routing | N/A | `chatgpt-account-id` header present OR request matches Codex platform paths (`/v1/api/codex/*`, `/v1/plugins/*`, `/v1/connectors/*`, etc.) → route to `chatgpt.com/backend-api/codex` | `obs-stable` codex ≥0.131 |
| ChatGPT base path | N/A | `/backend-api/codex/...` (the proxy strips the `/v1` prefix before prepending the base path, so `POST /v1/responses` → `/backend-api/codex/responses`) | `obs-stable` codex ≥0.131 |
| Version header | `anthropic-version: 2023-06-01` | N/A | `contractual` |
| Beta features | `anthropic-beta: ...` (comma-separated) | `openai-beta: ...` | `contractual` |
| 1M context window signal | `anthropic-beta` list contains `context-1m-2025-08-07` (present on every request when 1M enabled — a client-level flag, also on haiku turns; does **not** lag a mid-session model switch, unlike the system-prompt `[1m]` marker) | N/A | `obs-stable` Claude Code ≥2.1.x |
| ~~Rate-limit ≠ context window~~ | `anthropic-ratelimit-tokens-limit` (e.g. `80000`) is a per-window quota, **not** the context window — never use it to size the denominator | N/A | `obs-stable` |

---

## 3. Request Shape

### 3.1 Top-level fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Model | `model: "claude-sonnet-4-6"` | `model: "gpt-5.5"` | `contractual` |
| System prompt | `system: [{type:"text", text:"...", cache_control?}]` (array of blocks) | `instructions: "..."` (string) | `contractual` |
| Conversation | `messages: [{role, content}]` | `input: [{type, role, content}]` | `contractual` |
| Tools | `tools: [{name, description, input_schema}]` | `tools: [{type:"function", name, description, parameters}]` | `contractual` |
| Max output | `max_tokens: 16384` | `max_output_tokens: 4000` | `obs-stable` (typical observed values; vary by model and plan) |
| Streaming | `stream: true` | Implicit (SSE mode) or WS mode (no `stream` field) | `contractual` |
| Turn chaining | N/A (full history in `messages`) | `previous_response_id: "resp_..."` (WS mode) | `contractual` |
| Session metadata | `metadata: {session_id: "..."}` (in body) | `metadata: {session_id, turn_id, ...}` (in body) + `x-codex-turn-metadata` header. Note: `turn_id` is present on the wire but not consumed by ccxray | `contractual` (body) / `obs-stable` (header) |
| Tool choice | `tool_choice: {type:"auto"}` | `tool_choice: "auto"` (string; OpenAI also accepts object form) | `obs-stable` |
| Model rewriting | ccxray supports `CCXRAY_MODEL_PREFIX`/`REWRITE_MODEL_PREFIX` to rewrite model names in-flight | Same | `obs-stable` (ccxray feature) |

### 3.2 Message/Input item structure

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| User text | `{role:"user", content:[{type:"text", text:"..."}]}` | `{type:"message", role:"user", content:[{type:"input_text", text:"..."}]}` | `contractual` |
| Assistant text | `{role:"assistant", content:[{type:"text", text:"..."}]}` | `{type:"message", role:"assistant", content:[{type:"output_text", text:"..."}]}` | `contractual` |
| System in conversation | `{role:"user", content:[{type:"text", text:"<system>..."}]}` (injected tags) | `{type:"message", role:"developer", content:[...]}` | `obs-stable` |
| Tool invocation | In assistant message: `{type:"tool_use", id, name, input}` | In response events (not in input). Input has `{type:"function_call_output", call_id, output}` for results | `contractual` |
| Tool result | `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` | `{type:"function_call_output", call_id:"call_...", output:"..."}` | `contractual` |
| Thinking | `{type:"thinking", thinking:"..."}` in assistant content | `{type:"reasoning", ...}` as separate input item (content is null/opaque) | `contractual` (Anthropic) / `obs-stable` (Codex) |
| Image input | `{type:"image", source:{type:"base64", ...}}` | `{type:"input_image", image_url:"..."}` | `contractual` |

### 3.3 WebSocket client→server frames (Codex only)

| Frame type | Payload | Confidence |
|------------|---------|------------|
| `response.create` | Full request body: `{model, instructions, input, tools, tool_choice, previous_response_id, generate?}`. `generate: false` sends a warm-up frame (see Section 6.3) | `contractual` |
| `session.update` | `{session: {instructions: "..."}}` — updates system prompt mid-session | `obs-stable` codex ≥0.131 |

---

## 4. Response Shape & Events

### 4.1 Claude Code — SSE events

| SSE event type | `data` payload | Confidence |
|----------------|---------------|------------|
| `message_start` | `{type:"message_start", message:{id, model, usage:{input_tokens, cache_creation_input_tokens, cache_read_input_tokens}}}` | `contractual` |
| `content_block_start` | `{type:"content_block_start", index, content_block:{type:"text"\|"thinking"\|"tool_use", ...}}` | `contractual` |
| `content_block_delta` | `{type:"content_block_delta", index, delta:{type:"text_delta"\|"thinking_delta"\|"input_json_delta", ...}}` | `contractual` |
| `content_block_stop` | `{type:"content_block_stop", index}` | `contractual` |
| `message_delta` | `{type:"message_delta", delta:{stop_reason:"end_turn"\|"tool_use"\|"max_tokens"}, usage:{output_tokens}}` | `contractual` |
| `message_stop` | `{type:"message_stop"}` | `contractual` |

### 4.2 Codex — WebSocket server→client events

| WS event type | Payload (key fields) | Confidence |
|---------------|---------------------|------------|
| `response.created` | `{response:{id, model, status:"in_progress", ...}}` (contains full instructions+tools; typically ~35KB) | `contractual` |
| `response.in_progress` | Same shape as `response.created` | `contractual` |
| `response.output_item.added` | `{item:{id, type:"function_call"\|"message", name?, call_id?, status:"in_progress"}, output_index}` | `contractual` |
| `response.function_call_arguments.delta` | `{delta:"...", item_id, output_index}` | `contractual` |
| `response.function_call_arguments.done` | `{arguments:"{...}", item_id, output_index}` | `contractual` |
| `response.output_text.delta` | `{delta:"...", item_id, content_index, output_index}` | `contractual` |
| `response.output_text.done` | `{text:"...", item_id, content_index}` | `contractual` |
| `response.content_part.added` | `{part:{type:"output_text"}, item_id, content_index}` | `contractual` |
| `response.content_part.done` | `{part:{type:"output_text", text:"..."}, item_id}` | `contractual` |
| `response.output_item.done` | `{item:{id, type:"function_call"\|"message", name, call_id, arguments, status:"completed"}}` | `contractual` |
| `response.completed` | `{response:{id, model, status, usage, ...}}` — ccxray extracts only `usage` and `model` before discarding; `output: null`, `input: null` observed but unverified | `obs-fragile` codex 0.133 |
| `response.done` | Same shape as `response.completed`; observed as a separate event type in some Codex versions. Proxies should handle both | `obs-fragile` |
| `codex.rate_limits` | `{...}` rate limit info (non-standard, Codex-specific). Payload shape is not parsed by ccxray; exact fields undocumented | `obs-stable` codex ≥0.131 |

### 4.3 Usage/cost fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Input tokens | `message_start.message.usage.input_tokens` (non-cached only) | `response.usage.input_tokens` or `prompt_tokens` (**includes cached** — ccxray subtracts `cached_tokens` via `normalizeUsageForProvider` so canonical `input_tokens` = non-cached for both providers) | `contractual` |
| Output tokens | `message_delta.usage.output_tokens` | `response.usage.output_tokens` or `completion_tokens` | `contractual` |
| Cache creation | `usage.cache_creation_input_tokens` | N/A (no equivalent field) | `contractual` (Anthropic) |
| Cache creation breakdown | `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens` | N/A | `obs-fragile` |
| Cache read | `usage.cache_read_input_tokens` | `usage.input_tokens_details.cached_tokens` (ccxray maps to canonical `cache_read_input_tokens`) | `contractual` (Anthropic) / `obs-stable` (Codex) |
| Stop reason (HTTP) | `message_delta.delta.stop_reason` (`end_turn`, `tool_use`, `max_tokens`) | `response.status` (`completed`, `failed`, `cancelled`) | `contractual` |
| Stop reason (WS) | N/A | `response.completed` / `response.done` events carry `response.status` on the wire (`completed`, `incomplete`, `failed`, `cancelled`). ccxray extracts terminal status before `WS_SKIP_EVENTS` discards the envelope; non-terminal (`in_progress`, `queued`) ignored to preserve close/error fallback. | `contractual` (wire) / `obs-stable` (ccxray storage) |

---

## 5. Session & Turn Lifecycle

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Session ID source | `body.metadata.session_id` | Header `session_id` or `x-openai-session-id`, or `x-codex-turn-metadata` JSON → `.session_id`, or `body.metadata.session_id`. Falls back to literal `codex-raw` sentinel when no source yields an ID | `contractual` (body) / `obs-stable` (headers) |
| Session ID format | UUID v4 (e.g. `06e8a0f7-...`) | UUID v7 (e.g. `019e809a-...`) | `obs-stable` |
| Turn ID | Not explicit; each HTTP request = one turn | `x-codex-turn-metadata` → `turn_id` (present on wire but not consumed by ccxray) | `obs-stable` codex ≥0.131 |
| Agent type (Codex) | N/A | Priority: `x-openai-agent-type` / `x-codex-agent-type` header, then `x-codex-turn-metadata` JSON → `.agent_type`, then `x-openai-subagent` as fallback. Values: `explorer`, `worker`, `default` | `obs-stable` |
| Subagent flag (Claude) | Heuristic: absence of `cwd` in system prompt metadata. Also: stricter `isLikelySubagent()` heuristic in store.js for session inference (multi-condition: inflight + temporal) | N/A | `obs-stable` |
| Subagent flag (Codex) | N/A | Header `x-openai-subagent` (truthy, checked first) or `body.metadata.is_subagent`/`isSubagent` (fallback). WS path derives from `agentType === 'explorer' \|\| agentType === 'worker'` | `obs-stable` codex ≥0.131 |
| CWD detection (WS) | Extracted from system prompt content (regex on `cwd` path) | `x-codex-turn-metadata` → `.workspaces` with 5-strategy fallback: (1) `workspaces.cwd`, (2) `workspaces.current`, (3) first string value, (4) nested object with `.cwd`, (5) first key starting with `/` | `obs-fragile` (format varies across Codex versions) |
| CWD detection (HTTP) | (same as WS) | `parsedBody?.metadata?.cwd`, falling back to hub client CWD or `process.cwd()` | `obs-stable` |
| Multi-turn | Full `messages[]` history in every request | WS: `previous_response_id` + incremental `input`. HTTP: full `input[]` history | `contractual` |

---

## 6. Error & Edge Cases

### 6.1 HTTP error shapes

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Error body | `{type:"error", error:{type:"...", message:"..."}}` | `{error:{message:"...", type:"...", code:"..."}}` | `contractual` |
| Rate limit (429) | `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` headers | `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` | `contractual` |
| Overloaded (529) | Anthropic-specific overloaded status | N/A | `contractual` |

### 6.2 WebSocket close codes (Codex only)

| Code | Meaning | Confidence |
|------|---------|------------|
| 1000 | Normal closure | `contractual` |
| 1001 | Going away (proxy shutdown) | `obs-stable` |
| 1009 | Client→upstream send buffer overflow (> 4 MiB queued while upstream is still connecting). Once upstream is OPEN, messages forward with no size limit | `obs-stable` |
| 1011 | Internal error (idle timeout, upstream reject, socket error) | `obs-stable` |

> **Note**: Close reason strings are clamped to 120 bytes per RFC 6455 section 7.1.6.

### 6.3 Codex-specific edge cases

| Behavior | Detail | Confidence |
|----------|--------|------------|
| WS warm-up before real turn | Codex sends `response.create` with `generate: false` (warm-up) before the real `response.create`. ccxray gates on `generate !== false`; the `input: []` claim is an unverified wire observation. Proxies must skip `generate: false` frames when capturing request data. The `generate` parameter itself is `contractual`; the warm-up pattern is Codex CLI behavior | `obs-stable` codex ≥0.131 (pattern) / `contractual` (`generate` param) |
| `response.completed` stripped fields | `output: null`, `input: null` — large fields omitted from WS event despite being present in HTTP response. ccxray extracts only `usage` and `model` before discarding; null fields are unverified wire observation | `obs-fragile` codex 0.133 |
| Meta-tools without `.name` | At minimum `tool_search`, `web_search`, `image_generation` — these tool definitions have no `name` field. Any `t.name.startsWith(...)` crashes. Current code has guards (historical bug, now fixed) | `obs-stable` codex ≥0.131 |
| Startup platform pings | Codex 0.133+ sends ~10 requests on startup to `/v1/plugins/*`, `/v1/ps/plugins/*`, `/v1/connectors/*`, `/v1/api/codex/*`, `/v1/codex/*`, and `/v1/models`. All are noise-filtered (`skipEntry: true`). Analytics events (`/v1/codex/analytics-events/events`) are also filtered — they 404 for API-key users and pollute the dashboard with garbage entries | `obs-fragile` codex 0.133-0.136 |
| `codex-raw` session | Any OpenAI request lacking a session_id (WS or HTTP) is grouped under the synthetic `codex-raw` session ID | `obs-stable` (ccxray convention) |
