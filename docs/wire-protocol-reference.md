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

**Version baseline**: Claude Code 2.1.159 · Codex CLI 0.133.0-alpha.1 · 2026-06-01

**Official references**:
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Anthropic Streaming: https://docs.anthropic.com/en/api/messages-streaming
- OpenAI Responses API: https://developers.openai.com/api/reference/responses/overview
- OpenAI WebSocket Mode: https://developers.openai.com/api/docs/guides/websocket-mode

---

## Changelog

| Date | Agent | Version | Change |
|------|-------|---------|--------|
| 2026-06-01 | Codex | 0.133 | Baseline: all observations below recorded |
| 2026-06-01 | Claude Code | 2.1.159 | Baseline: all observations below recorded |

---

## 1. Transport

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Protocol | HTTP POST + SSE streaming | HTTP POST (SSE) + WebSocket upgrade | `contractual` |
| Primary path | `POST /v1/messages` | `POST /v1/responses` (HTTP) or WS upgrade on `/v1/responses` | `contractual` |
| Alternative paths | — | `/v1/realtime` (Realtime API, not used by Codex CLI for chat) | `contractual` |
| WS upgrade detection | N/A | `upgrade: websocket` header on `/v1/responses` or `/v1/realtime` | `contractual` |
| WS handshake header | N/A | `openai-beta: responses_websockets=2026-02-06` | `obs-stable` codex ≥0.131 |
| WS idle timeout | N/A | Server-side: 60s default (configurable). OpenAI docs: 60-min connection limit | `contractual` (OpenAI limit) / `obs-stable` (server default) |
| WS warm-up | N/A | `response.create` with `generate: false` pre-warms state | `contractual` |
| Content-Type | `application/json` | `application/json` (HTTP); binary/text frames (WS) | `contractual` |
| Upstream host | `api.anthropic.com:443` | `api.openai.com:443` (API key) or `chatgpt.com:443` (ChatGPT OAuth) | `contractual` / `obs-stable` |

---

## 2. Auth & Routing

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Auth header | `x-api-key: sk-ant-...` | `authorization: Bearer sk-...` (API key) or JWT (ChatGPT OAuth) | `contractual` |
| ChatGPT OAuth routing | N/A | `chatgpt-account-id` header present → route to `chatgpt.com/backend-api/codex` | `obs-stable` codex ≥0.131 |
| ChatGPT base path | N/A | `/backend-api/codex/v1/...` | `obs-stable` codex ≥0.131 |
| Version header | `anthropic-version: 2023-06-01` | N/A | `contractual` |
| Beta features | `anthropic-beta: ...` (comma-separated) | `openai-beta: ...` | `contractual` |

---

## 3. Request Shape

### 3.1 Top-level fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Model | `model: "claude-sonnet-4-6"` | `model: "gpt-5.5"` | `contractual` |
| System prompt | `system: [{type:"text", text:"...", cache_control?}]` (array of blocks) | `instructions: "..."` (string) | `contractual` |
| Conversation | `messages: [{role, content}]` | `input: [{type, role, content}]` | `contractual` |
| Tools | `tools: [{name, description, input_schema}]` | `tools: [{type:"function", name, description, parameters}]` | `contractual` |
| Max output | `max_tokens: 16384` | `max_output_tokens: 4000` | `contractual` |
| Streaming | `stream: true` | Implicit (SSE mode) or WS mode (no `stream` field) | `contractual` |
| Turn chaining | N/A (full history in `messages`) | `previous_response_id: "resp_..."` (WS mode) | `contractual` |
| Session metadata | `metadata: {session_id: "..."}` (in body) | `metadata: {session_id, turn_id, ...}` (in body) + `x-codex-turn-metadata` header | `contractual` (body) / `obs-stable` (header) |
| Tool choice | `tool_choice: {type:"auto"}` | `tool_choice: "auto"` (string) | `contractual` |

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
| `response.create` | Full request body: `{model, instructions, input, tools, tool_choice, previous_response_id}` | `contractual` |
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
| `response.created` | `{response:{id, model, status:"in_progress", ...}}` ~35KB (contains full instructions+tools) | `contractual` |
| `response.in_progress` | Same shape as `response.created` | `contractual` |
| `response.output_item.added` | `{item:{id, type:"function_call"\|"message", name?, call_id?, status:"in_progress"}, output_index}` | `contractual` |
| `response.function_call_arguments.delta` | `{delta:"...", item_id, output_index}` | `contractual` |
| `response.function_call_arguments.done` | `{arguments:"{...}", item_id, output_index}` | `contractual` |
| `response.output_text.delta` | `{delta:"...", item_id, content_index, output_index}` | `contractual` |
| `response.output_text.done` | `{text:"...", item_id, content_index}` | `contractual` |
| `response.content_part.added` | `{part:{type:"output_text"}, item_id, content_index}` | `contractual` |
| `response.content_part.done` | `{part:{type:"output_text", text:"..."}, item_id}` | `contractual` |
| `response.output_item.done` | `{item:{id, type:"function_call"\|"message", name, call_id, arguments, status:"completed"}}` | `contractual` |
| `response.completed` | `{response:{id, model, status, usage, ...}}` — **`output: null`, `input: null`** (large fields stripped) | `obs-fragile` codex 0.133 |
| `response.done` | Alias for `response.completed` in some versions | `obs-fragile` |
| `codex.rate_limits` | `{...}` rate limit info (non-standard, Codex-specific) | `obs-stable` codex ≥0.131 |

### 4.3 Usage/cost fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Input tokens | `message_start.message.usage.input_tokens` | `response.usage.input_tokens` or `prompt_tokens` | `contractual` |
| Output tokens | `message_delta.usage.output_tokens` | `response.usage.output_tokens` or `completion_tokens` | `contractual` |
| Cache creation | `usage.cache_creation_input_tokens` | N/A (no equivalent field) | `contractual` (Anthropic) |
| Cache read | `usage.cache_read_input_tokens` | `usage.input_tokens_details.cached_tokens` | `contractual` |
| Stop reason | `message_delta.delta.stop_reason` (`end_turn`, `tool_use`, `max_tokens`) | `response.status` (`completed`, `failed`, `cancelled`) | `contractual` |

---

## 5. Session & Turn Lifecycle

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| Session ID source | `body.metadata.session_id` | Header `session_id` or `x-openai-session-id`, or `x-codex-turn-metadata` JSON → `.session_id`, or `body.metadata.session_id` | `obs-stable` |
| Session ID format | UUID v4 (e.g. `06e8a0f7-...`) | UUID v7 (e.g. `019e809a-...`) | `obs-stable` |
| Turn ID | Not explicit; each HTTP request = one turn | `x-codex-turn-metadata` → `turn_id` | `obs-stable` codex ≥0.131 |
| Subagent detection | Heuristic: absence of `cwd` in system prompt metadata | Header `x-openai-subagent` or `x-openai-agent-type` / `x-codex-agent-type` (values: `explorer`, `worker`, `default`) | `obs-stable` |
| Subagent (body) | N/A | `body.metadata.is_subagent` or `body.metadata.isSubagent` | `obs-stable` codex ≥0.131 |
| CWD detection | Extracted from system prompt content (regex on `cwd` path) | `x-codex-turn-metadata` → `workspaces` object | `obs-stable` |
| CWD format | String path in system prompt block | `workspaces: {"/path/to/project": {associated_remote_urls, latest_git_commit_hash, ...}}` — **key is the cwd** | `obs-fragile` codex 0.133 |
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
| 1009 | Message too big (client buffer > 4 MiB) | `obs-stable` |
| 1011 | Internal error (idle timeout, upstream reject, socket error) | `obs-stable` |

### 6.3 Codex-specific edge cases

| Behavior | Detail | Confidence |
|----------|--------|------------|
| WS warm-up before real turn | Codex sends `response.create` with `generate: false` (warm-up) before the real `response.create`. The warm-up has `input: []`; the real request has user messages. Proxies must skip `generate: false` frames when capturing request data | `obs-stable` codex ≥0.131 |
| `response.completed` stripped fields | `output: null`, `input: null` — large fields omitted from WS event despite being present in HTTP response | `obs-fragile` codex 0.133 |
| Meta-tools without `.name` | `tool_search`, `web_search`, `image_generation` — these tool definitions have no `name` field. Any `t.name.startsWith(...)` crashes | `obs-stable` codex ≥0.131 |
| Startup platform pings | Codex 0.133+ sends ~10 requests on startup to `/v1/plugins/*`, `/v1/ps/plugins/*`, `/v1/connectors/*`, `/v1/api/codex/apps`, `/v1/api/codex/usage` | `obs-fragile` codex 0.133 |
| `codex-raw` session | Non-WS HTTP requests (e.g. `/v1/models`) are grouped under a synthetic `codex-raw` session ID | `obs-stable` (ccxray convention) |
| WS `generate: false` | Warm-up frame: `response.create` with `generate: false` pre-loads request state without generating output | `contractual` |
