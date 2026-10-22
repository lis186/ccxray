# Wire Protocol Reference: Claude Code, Codex, and Grok

> This document records observable wire-level behavior of Claude Code, Codex, and Grok
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
| 2026-10-23 | Codex | ccxray Unreleased | Header-aware routing (#745); log label fix (#744). |
| 2026-10-23 | Codex | ccxray Unreleased | Routing fix: shared header/wire/hub signals, Claude JWT shapes, and pathname-only 421 records (#740). |
| 2026-10-22 | Codex | ccxray Unreleased | Routing fix: unknown-path handling and provider header hygiene (#740); see the routing row below. |
| 2026-10-21 | Claude Code / ccxray | CC 2.1.304 · ccxray Unreleased | **`context_management` is dropped when a gateway rejects it, and the request is resent** (`obs-fragile`). Without it, the env/cwd block is only in a `role:'system'` message; on a delta body that message has aged out and the only cwd is `safeguards[].classifier_context.live_cwd` (top-level `system` without an env line, `tools`, `safeguards`, no `role:'system'` message). ccxray now scans `role:'system'` messages from index 0 and reads safeguards regardless of `context_management`, except on a title/name-generation side request (generator key, or top-level `system` with no `tools` and ≤2 messages); observed title-gen requests carry no `tools` and no `safeguards`. The main prompt's agent key is a regex-fallback role slug (`agent-working-with-the-user-to` on 2.1.304), not a `KNOWN_AGENTS` key, so `agentKey` alone no longer classifies it: only main and known-subagent keys are trusted, and other slugs follow the structural `isSubagent` flag. |
| 2026-10-17 | Claude Code / ccxray | CC 2.1.302 · ccxray Unreleased | **First user message opens with several `<system-reminder>` text blocks before the typed prompt block** (`obs-fragile`). ccxray's first-prompt/title-gen anchor now takes the first user text block that is non-empty after stripping injected tags, instead of the first text block, and never latches an injected-only value. Separately, Claude Code transcript lines carry `gitBranch` (`"HEAD"` when detached, `""` outside git) and Codex `session_meta` carries `git.branch`; the importer records them as the entry `branch` (`obs-stable`). |
| 2026-10-17 | Codex CLI / ccxray | Codex 0.159.2–0.163.0 · ccxray Unreleased | **#671 resolved: the ChatGPT-OAuth launcher sets only `openai_base_url=<proxy>/v1`.** Codex keeps its default `chatgpt_base_url`, so workspace discovery (`/backend-api/wham/accounts/check`) and other account/plugin/connector calls go directly to chatgpt.com over HTTPS; model traffic still reaches ccxray. Codex applies a discovered workspace origin to the `openai` provider only when its `base_url` is unset or ends in `/backend-api/codex` (`supports_codex_backend_routes()`), so the `/v1` proxy URL keeps model traffic on ccxray under every discovery outcome. Live: `account/read` succeeds (`NO_CONSTRAINT`) on 0.163.0; source gate identical in 0.159.2. `us`/`us_cr` routing override is not sent for the loopback provider. Supersedes the row below. `obs-fragile` — re-check the gate on each Codex bump. |
| 2026-10-17 | Codex CLI / ccxray | Codex 0.159.2 / 0.163.0 · ccxray 2.5.0-rc.3 | **Workspace discovery blocks local HTTP proxy bootstrap (#671).** With a local `/v1` ChatGPT base URL, discovery requests `/v1/api/codex/accounts/check`; ccxray forwards to `/backend-api/codex/api/codex/accounts/check` (HTTP 404 observed on 0.163.0). Native ChatGPT discovery uses `/backend-api/wham/accounts/check`. Source in both releases requires an HTTPS workspace backend; model routing replaces the proxy origin with the discovered origin. A path correction alone is insufficient. See [findings](codex-workspace-routing.md); `obs-fragile` (live bootstrap on 0.163.0 only, source inspected for both releases). |
| 2026-10-17 | ccxray / Herdr | ccxray 2.5.0-rc.3 · plugin 0.4.0 | **Native Grok/Codex pane attribution.** Plugin proxy URLs carry `/_ccxray/agent/<encoded herdr: identity>` before `/v1`. HTTP and WebSocket dispatch strip the prefix, validate the identity with the existing 512-character bound, and persist `agentId`. This is local ccxray routing metadata, not provider wire behavior or authentication (`obs-stable`: covered by synthetic HTTP/WS integration tests). |
| 2026-10-17 | Codex CLI / ccxray | Codex 0.155.1, 0.163.0 · ccxray Unreleased | **#508: rollouts persist a `token_usage_record` line carrying the upstream response id.** `{type:'token_usage_record', payload:{response_id:'resp_…', usage:{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}, turn_token_usage, thread_token_usage, session_id, thread_id, turn_id, root_turn_id}}`, written just before the `event_msg`/`token_count` it reports. Measured on local rollouts (key names and pairing counts only): 109/111 files; 7,356/7,356 nonzero `token_count`s preceded by a record have equal `last_token_usage`; the 425 without one are re-emissions of the previous usage. `resp_…` is the same id the wire carries as `response.id` (`responseMetadata.id` on proxy entries). The importer now sets `responseId` from it (§4.2.1). `obs-fragile` — two versions observed. |
| 2026-10-17 | Codex agent | Codex 0.133 / 0.145 | #508: distinguished wire response IDs from persisted rollout records; see §4.2.1 and the linked investigation. No importer key added. |
| 2026-10-16 | ccxray | 2.5.0-rc.3 | **Claude print-mode Context HUD opt-out.** The Claude launcher adds `X-Ccxray-Print-Mode: true` when `-p` / `--print` appears before a bare `--`; Claude Code help identifies those as the non-interactive mode switches. Options such as `--input-format`, `--output-format`, `--no-session-persistence`, `--max-budget-usd`, and `--include-partial-messages` are print-only modifiers and do not enable print mode by themselves. ccxray consumes the marker to preserve the model's final text block without appending the Context HUD, then strips it before upstream forwarding. |
| 2026-10-16 | Claude Code / ccxray | Claude Code 2.1.x · ccxray 2.5.0-rc.3 | **Claude custom headers are newline-separated.** Claude Code parses `ANTHROPIC_CUSTOM_HEADERS` one `Name: Value` line at a time; ccxray and Herdr now append auth, account, and pane-identity headers on separate lines while preserving existing user entries. Hub auth requires an exact `X-Ccxray-Auth` value; malformed comma-joined legacy values are not recovered for authentication. |
| 2026-10-15 | ccxray | 2.5.0-rc.2 | **Corrected Claude's default account-config path.** With `CLAUDE_CONFIG_DIR` set, account snapshots read `$CLAUDE_CONFIG_DIR/.claude.json`; otherwise they read `$HOME/.claude.json`. The launcher header and setup-statusline label now follow that layout. |
| 2026-09-27 | Claude Code / ccxray | CC 2.1.283 | **The live request keeps a top-level `system`; only the env block moved.** A 2.1.283 `context_management` request still carries `system` (billing header + "You are Claude Code…" / "You are a Claude agent…" blocks) without any `Primary working directory:` line; the env block, cwd included, is a `role:'system'` message (`messages[1]`, later ones folded to a string). The #637 fix was derived from `_req.json`, which never stores `system` (only `sysHash`), so it missed that the live `extractCwd` stopped at the cwd-less `system` block and logged `cwd: null` for every live Claude turn. `extractCwd` now falls through to the `role:'system'` / `messages[0]` / `safeguards` scan when a `context_management` request's `system` has no env line, reading `role:'system'` messages before `messages[0]` (which embeds CLAUDE.md and can quote an env line); without `context_management` a cwd-less `system` still yields null (`obs-fragile`: seen at 2.1.283 only). Title-generation requests carry no cwd of their own; their entry takes the session's already-known cwd. |
| 2026-09-03 | ccxray | #611 | **Claude launch account snapshot.** `ccxray claude` reads `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set, otherwise `$HOME/.claude.json`, once at launch and appends `X-Ccxray-Account: <oauthAccount.emailAddress>` to `ANTHROPIC_CUSTOM_HEADERS`. The header is ccxray-internal (never forwarded upstream); the HTTP proxy normalizes and persists its email plus exact post-`@` domain as the account logged in for that launch, not as a per-request identity. Missing or malformed config is ignored. |
| 2026-08-31 | Claude Code | CC 2.1.251 (absent at 2.1.206) · #601/#604 | **Local transcript event `cost-state` carries the `[1m]` window-variant declaration.** New record type `{"type":"cost-state", modelUsage: {...}}` aggregates per-model usage keyed by the **client-internal model id, `[1m]` suffix included** (`claude-fable-5[1m]` observed) — the only per-session window-variant declaration reachable by the import path (transcript `message.model` stays bare; system prompt is not stored). `obs-fragile`: positive-only — bare/empty `modelUsage` keys occur on sessions whose usage proves 1M (7/13 in the measured corpus, mechanism undetermined), so absence must never be read as 200K; coverage starts at 2.1.251 and the record is written late in a session's life (see the enrichment-timing note in `docs/solutions/history-only-1m-context-denominator.md` §F1a). Not a wire event — local transcript shape, same class as the 2026-08-25 Codex `compacted` row. |
| 2026-08-25 | Codex CLI / ccxray | Codex 0.148+ · ccxray · #606 | **Compaction boundaries are observable in the local Codex transcript.** Codex emits a top-level `{"type":"compacted"}` record without a `token_count` payload. ccxray latches that marker across zero-token/non-turn records and persists `compacted: true` on the next indexed turn, so live SSE and cold-load rendering agree. This is a local transcript event rather than an OpenAI Responses API wire event (`obs-stable` in Codex CLI transcript shape; version may change). |
| 2026-08-24 | Codex CLI / Grok CLI / ccxray | ccxray · #585 | **Gateway tool extraction is now covered.** Codex `custom_tool_call` items are counted, MCP names embedded in `exec` JavaScript input are extracted, and Grok `use_tool` `arguments.tool_name` is normalized to the underlying MCP name. When both WebSocket `.added` and `.done` events exist, the complete `.done` payload wins over the empty `.added` stub (`obs-stable`). Live smoke confirmed Codex `{mcp__node_repl__js: 1, Bash: 1}` and Grok `{github__pull_request_read: 1}`. |
| 2026-08-17 | Claude Code / ccxray | ccxray · #533/#535/#536 | **Refines the 2026-07-10 and 2026-06-09 rows.** The `context-1m-2025-08-07` value is now persisted verbatim as the index field `ctxBeta` (whitelisted, shape-filtered to `context-<n><k\|m>-` so the unrelated `context-management-*` beta cannot land in a window field); `beta1m` remains its capability-gated interpretation, and the two may legitimately disagree on a model the gate refuses. Verified live on 2026-08-16: `claude-opus-5[1m]` sends `context-1m-2025-08-07` and the bare model sends nothing, matching the fable-5 era observation, so the per-model `[1m]` selection rule holds across model families. The capability gate itself is no longer the hand-maintained `SUPPORTS_1M` regex alone but a UNION of that list and LiteLLM's `max_input_tokens` — LiteLLM may ADD 1M capability, never DENY it, because the field is semantically inconsistent (capability for `claude-fable-5` → 1M, default serving window for `claude-sonnet-4-5` → 200K although 4.5 serves 1M under the beta). That does not weaken the 2026-07-10 rule below: LiteLLM still never supplies the session-window denominator, only the answer to "could this model serve 1M at all". |
| 2026-08-15 | Codex CLI / ccxray | Codex 0.148.0-alpha.9 · ccxray 2.3.1 | ChatGPT platform routing is path-scoped, not one universal `/backend-api/codex` prefix. Responses remain `/backend-api/codex/responses`; plugin catalogs and connectors use `/backend-api/{plugins,ps/plugins,connectors}`; analytics uses `/backend-api/codex/analytics-events/events`; Apps MCP normalizes the launcher's local `/v1/api/codex/ps/mcp` back to `/backend-api/ps/mcp`. Confirmed against Codex source tests and a real OAuth run: plugin, Apps MCP, and analytics 404 warnings all fell to zero. |
| 2026-08-11 | Claude Code / ccxray | ccxray · #504 | Documented the observed global-instructions marker `Contents of <configDir>/CLAUDE.md (user's private global instructions for all projects)` used to recover the session config directory. Unix separators are observed; ccxray defensively accepts Windows backslashes, but that variant has not been tested on Windows (`obs-fragile`). |
| 2026-08-10 | Codex CLI / Grok CLI / ccxray | ccxray · #485 | **Three decoder fixes.** (1) Grok `decodeGrokToolOutput` now accepts both old footer format (`EXIT_CODE[=:]N` on last line) and new first-line format (`exit: N`); footer has priority when both are present (real 2026-08-07 capture: `exit: 0` first-line was unreliable in dual-format payloads). (2) Codex async commands (>~11s) split into a start segment (`custom_tool_call_output`, "Script running...") and a retrieval segment (`function_call_output`, carries real `exit_code`); `codex:function_call_output` is now registered in the decoder table. Start segments are detected and marked `eligible:false` so the retrieval pairs correctly with the pending call in weather. (3) `decodeCodexToolOutput` now unwraps top-level array-shaped payloads with per-element `exit_code` validation and failure-dominates aggregation (#482). |
| 2026-08-08 | Codex CLI / ccxray | Codex 0.145.0 · ccxray 2.3.0 · #475 | Real Codex WebSocket traffic confirms `custom_tool_call_output.output` reaches the parser as an already-parsed `input_text[]`, while older captures may retain the serialized JSON-array form; both envelopes are accepted. A single envelope may contain multiple command-result JSON texts, so any decoded non-zero top-level safe-integer `exit_code` dominates clean results. The matching response-side `custom_tool_call.name` is `exec`; it maps to `Bash`. Weather eligibility requires both an eligible decoder and a call name positively normalized to `Bash` by the process/shell allowlist; non-process and unrecognized tool names are excluded. |
| 2026-08-08 | ccxray | 2.3.0 · #475 | OpenAI tool-failure weather attribution now persists response-side tool call IDs and request-side result facts add-only in the index, then joins them by `call_id` at assessment time. It does not rewrite a prior entry or infer tool use from `response.status`; only paired process/shell results whose allowlisted decoder is eligible enter failure rates, and undecodable eligible results remain unknown and visibly reduce known-rate. |
| 2026-08-08 | OpenAI Responses / ccxray | Responses API (2026-08-08) · #473 | Responses tool invocations are a type family, not only names containing `tool_call`: `computer_call`, `local_shell_call`, `web_search_call`, `file_search_call`, `code_interpreter_call`, `mcp_call`, and `image_generation_call` are tool-call output items, with corresponding `*_call_output` result items where applicable (`contractual`). ccxray's defensive renderer now classifies unfamiliar `*_call` / `*_call_output` pairs symmetrically while leaving `message`, `reasoning`, and `mcp_list_tools` outside the tool path. |
| 2026-08-08 | ccxray | 2.3.0 | #472 review hardening: `metadata.client` is proxy-asserted only on HTTP and WS turns. A matched wire client overwrites any body claim; without a match, body-supplied `client` is removed before raw-session selection or tool-result decoding. Codex tool-result `exit_code` is decoded only when it is a safe integer; non-integers remain unchecked while negative integers remain valid failure codes. |
| 2026-08-08 | ccxray | 2.3.0 | #472: OpenAI-wire HTTP `input[]` is cumulative history, so per-request tool-result attribution uses only the trailing contiguous `*_call_output` block; earlier output items are historical and must not be reported again. No trailing output block means the turn is unchecked (`turnToolFail: undefined`), not checked-clean. |
| 2026-08-07 | Codex CLI / Grok CLI | Codex 0.145.0 · Grok 0.2.114 | **Tool-call item types differ per client AND per version — do not treat either as a provider constant** (`obs-fragile`, #470). Codex 0.145.0 emits `custom_tool_call` (response `output_item.done` `item.type`, plus `response.custom_tool_call_input.delta/.done` events) and `custom_tool_call_output` in request `input[]` — whereas this repo's own fixture `test/fixtures/wire-parsers/openai/turn1_res.json` records the **same `shell` tool** as `function_call` on an earlier version. Grok 0.2.114 uses standard `function_call` / `function_call_output`. Item type is understood to follow the **request-side tool declaration** (custom/freeform vs function tool), which is a per-tool CLI choice, not a client identity — so a single-key dispatch on `type` will mis-route a future client. **Failure-signal payloads also differ**: Codex `output` is an outer `input_text[]` envelope (already parsed in real WS request data, but serialized in older fixtures), whose text fields may contain inner JSON carrying `"exit_code":N`; Grok `output` is plain text whose wrapper footer uses `EXIT_CODE=N` on failure but `EXIT_CODE:N` on success; **2026-08-09/10 captures show the footer absent, replaced by first-line `exit: N`** (`obs-fragile`). ccxray now accepts both: last-line `EXIT_CODE[=:]N` (footer priority) then first-line `exit: N`; middle lines are never scanned. Both payload conventions are CLI-wrapper output, not API contract. ccxray records the checked result in tri-state `turnToolFail` using a `(metadata.client, item.type)` allowlist; unknown combinations remain unknown. `stopReason` remains the response status (`completed`/`incomplete`, never `tool_use`/`max_tokens`); since #475 weather instead pairs the response-side call with a later request-side result by `call_id`. Measured in isolated instances (own port + own `CCXRAY_HOME`); three combinations covered (Codex/WS, Codex/HTTP-SSE via rejected upgrade, Grok/HTTP-SSE). Full diagnosis: `docs/solutions/openai-tool-failure-signal.md`. |
| 2026-08-01 | Grok CLI / ccxray | 0.2.114 | **Supersedes the 2026-07-30 row below.** `buildPricingTable` spread restored to `{ ...DEFAULT_PRICING, ...mirrored }` (PR #405, issue #397): LiteLLM wins again and `DEFAULT_PRICING` is the offline floor, so no hardcoded row shadows live data. Mirroring is now restricted to an `xai/` allow-list — previously any `provider/model` key could claim a bare id, and `azure_ai/grok-code-fast-1` was in fact winning bare `grok-code-fast-1` with a 10x wrong cached-input rate (0.20 vs xAI's 0.02). |
| 2026-08-01 | Grok CLI | 0.2.114 | Title-gen attribution has a narrower success condition than the 60s window implies: the parent must still be **in flight** when the title turn completes, not merely start within the window. Measured over four runs — three short `-p` prompts had the title turn arrive ~0.5s before the parent and resolve; one agentic prompt had the title turn complete **7.2s before the parent's first request even opened**, and attribution returned null. The CLI emits the title request at session start, then may spend seconds on tool setup before the first main turn exists (`obs-stable`). See issue #399. |
| 2026-07-30 | Grok CLI / ccxray | 0.2.93+ | Wire model id `grok-4.5-build` price pinned in `DEFAULT_PRICING` at input 2 / output 6 / cache_read 0.50 USD per 1M tokens (`obs-fragile`). Spread order `{ ...mirrored, ...DEFAULT_PRICING }` means the pin permanently shadows LiteLLM until the row is deleted once LiteLLM lists `xai/grok-4.5-build`. **Superseded 2026-08-01 — the spread was inverted back; see the entry above.** |
| 2026-07-19 | Grok CLI / ccxray | 0.2.93+ | Title-gen attribution: parallel `model=grok-build` + forced `session_title` tool; empty `x-grok-session-id` → `grok-raw` bucket. Generated title is `function_call` args `{"session_title":"…"}` on Responses SSE (`response.function_call_arguments.done` / `response.completed.output`). Anchor match uses normalized `<user_query>` body so main turns (user_info first) link to title-gen. Attribution window 60s while parent is inflight. Wire model id `grok-4.5-build` seen on main turns. |
| 2026-07-10 | Claude Code | 2.1.206 | Discovered via loopback wire capture (fable-5 era, #211): per-model `[1m]` selection changes the wire signals per mode. `/model claude-fable-5` (bare, 200K session): no `context-1m-*` in `anthropic-beta`, marker says `...is claude-fable-5.` — even on an account with 1M available. `/model claude-fable-5[1m]` (1M session): `context-1m-2025-08-07` present + marker says `...is claude-fable-5[1m].`; request `model` field stays bare in both modes. Refines the 2026-06-09 observation: header presence follows the **selected model mode**, not bare account capability. Also: LiteLLM `max_input_tokens` records API max capability (fable-5 → 1M, the API default) which is NOT the Claude Code session window — ccxray now clamps LiteLLM data to 200K for `claude-*` and relies on the wire signals for 1M. |
| 2026-07-09 | Grok CLI | 0.2.93 | First wire capture + integration: `POST /v1/responses` SSE (no WS) via `cli-chat-proxy.grok.com`; client redirect `GROK_CLI_CHAT_PROXY_BASE_URL`. System prompt in `input[role=system]` (string content), not `instructions`. Session via `x-grok-session-id` / `x-grok-conv-id`. Header-based upstream routing to `UPSTREAMS.xai` keeps Codex on `api.openai.com` in a shared hub. Control-plane `/v1/*` (settings/feedback) classified as noise for Grok clients. Full notes: `docs/grok-wire-experiment-2026-07-09.md`. |
| 2026-07-07 | ccxray | 1.10.x | Codex parity fix: ccxray now treats Codex/OpenAI `thread_id` as a session-id fallback when `session_id` is absent, normalizes `metadata.workspaces` / `x-codex-turn-metadata.workspaces` into `metadata.cwd`, and promotes WS sessions from the synthetic `codex-raw` bucket once `response.create.metadata` arrives. `codex-raw` remains only for OpenAI traffic with no session/thread signal. |
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

| Aspect | Claude Code | Codex | Grok CLI | Confidence |
|--------|-------------|-------|----------|------------|
| Protocol | HTTP POST + SSE streaming | HTTP POST (SSE) + WebSocket upgrade | HTTP POST + SSE streaming (no WS on normal turns) | `contractual` / `obs-stable` |
| Primary path | `POST /v1/messages` | `POST /v1/responses` (HTTP) or WS upgrade on `/v1/responses` | `POST /v1/responses` (SSE) via `cli-chat-proxy.grok.com` | `contractual` / `obs-stable` Grok ≥0.2.93 |
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
| ChatGPT OAuth routing | N/A | `chatgpt-account-id` header present OR request matches Codex platform paths. Responses route under `/backend-api/codex`; plugin catalogs, connectors, and Apps MCP route under `/backend-api`; `/v1/codex/*` already carries its `codex` segment | `obs-stable` codex ≥0.148 |
| ChatGPT base paths | N/A | Path-scoped: `/v1/responses` → `/backend-api/codex/responses`; `/v1/ps/plugins/*` → `/backend-api/ps/plugins/*`; `/v1/connectors/*` → `/backend-api/connectors/*`; `/v1/codex/*` → `/backend-api/codex/*`; launcher-derived `/v1/api/codex/ps/mcp` → `/backend-api/ps/mcp` | `obs-stable` codex 0.148 (Codex source + real OAuth run) |
| Workspace discovery | N/A | Not proxied: the launcher leaves `chatgpt_base_url` at Codex's default, so discovery goes to `chatgpt.com/backend-api/wham/accounts/check` directly. Model routing to a discovered workspace origin applies only when the `openai` provider `base_url` is unset or ends in `/backend-api/codex`; the `/v1` proxy URL keeps it off. A hand-configured loopback `chatgpt_base_url` still produces `GET /v1/api/codex/accounts/check` → 404 and `-32603`; see [#671](codex-workspace-routing.md) | `obs-fragile` codex 0.163.0 live; 0.159.2 / 0.163.0 source |
| Version header | `anthropic-version: 2023-06-01` | N/A | `contractual` |
| Beta features | `anthropic-beta: ...` (comma-separated) | `openai-beta: ...` | `contractual` |
| ccxray launch account header | `ccxray claude` appends `X-Ccxray-Account: <oauthAccount.emailAddress>` from `$CLAUDE_CONFIG_DIR/.claude.json` when set, otherwise `$HOME/.claude.json`; the header is consumed by ccxray only and removed from the forwarded set by the `x-ccxray-*` prefix rule. | N/A | `obs-stable` ccxray #611 |
| ccxray Claude print-mode header | `ccxray claude` appends `X-Ccxray-Print-Mode: true` when `-p` / `--print` appears before a bare `--`. ccxray consumes it to skip the Context HUD, preserving Claude Code's last model text block in print output; the `x-ccxray-*` prefix rule removes it before upstream forwarding. Claude Code help identifies `--input-format`, `--output-format`, `--no-session-persistence`, `--max-budget-usd`, and `--include-partial-messages` as print-only modifiers; they do not independently switch the session to print mode. | N/A | `obs-stable` ccxray ≥2.5.0-rc.2 |
| Claude custom-header environment | `ANTHROPIC_CUSTOM_HEADERS` uses newline-separated `Name: Value` entries. Claude Code splits on `/\r?\n/` and each ccxray auth, account, or Herdr pane-identity header arrives separately; existing user-provided lines are preserved. Hub auth compares the complete `X-Ccxray-Auth` value and does not recover auth text embedded in another header. | N/A | `contractual` (Claude Code env var) / `obs-stable` ccxray ≥2.5.0-rc.2 |
| 1M context window signal | `anthropic-beta` list contains `context-1m-2025-08-07` (present on every request when 1M enabled — a client-level flag, also on haiku turns; does **not** lag a mid-session model switch, unlike the system-prompt `[1m]` marker). Persisted verbatim as `ctxBeta` since #533, so a future tier such as `context-400k-*` is legible without a code change; the tier is parsed out of the id rather than tabulated | N/A | `obs-stable` Claude Code ≥2.1.x |
| Per-model `[1m]` selection | `/model <id>[1m]` (fable-5 era): request `model` field stays **bare** in both modes; the system-prompt marker carries the suffix (`...is claude-fable-5[1m].`); `context-1m-2025-08-07` appears **only in `[1m]` mode** — the bare model sends neither signal even on an account with 1M available. Session window follows the selection (200K bare / 1M with `[1m]`), NOT the model's API capability: LiteLLM `max_input_tokens` records the API max (fable-5 → 1M, the API default) and must never be used as the session-window denominator (#211) | N/A | `obs-stable` Claude Code ≥2.1.206 |
| ~~Rate-limit ≠ context window~~ | `anthropic-ratelimit-tokens-limit` (e.g. `80000`) is a per-window quota, **not** the context window — never use it to size the denominator | N/A | `obs-stable` |

---

## 3. Request Shape

### 3.1 Top-level fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Model | `model: "claude-sonnet-4-6"` | `model: "gpt-5.5"` | `contractual` |
| System prompt | `system: [{type:"text", text:"...", cache_control?}]` (array of blocks) | `instructions: "..."` (string) | `contractual` |
| Global CLAUDE.md marker | System-prompt text includes `Contents of <configDir>/CLAUDE.md (user's private global instructions for all projects)`. The observed form uses `/`; ccxray also accepts `\` because Windows paths use backslashes, but the Windows form has **not** been observed or tested on Windows. | N/A | `obs-fragile` Claude Code 2.1.x (#504) |
| Conversation | `messages: [{role, content}]` | `input: [{type, role, content}]` | `contractual` |
| Tools | `tools: [{name, description, input_schema}]` | `tools: [{type:"function", name, description, parameters}]` | `contractual` |
| Max output | `max_tokens: 16384` | `max_output_tokens: 4000` | `obs-stable` (typical observed values; vary by model and plan) |
| Streaming | `stream: true` | Implicit (SSE mode) or WS mode (no `stream` field) | `contractual` |
| Turn chaining | N/A (full history in `messages`) | `previous_response_id: "resp_..."` (WS mode) | `contractual` |
| Session metadata | `metadata: {session_id: "..."}` (in body) | `metadata: {session_id, thread_id, turn_id, workspaces, ...}` (in body) + `x-codex-turn-metadata` header. ccxray consumes `session_id`, `thread_id`, and `workspaces`; `turn_id` is present on the wire but not consumed | `contractual` (body) / `obs-stable` (header) |
| Tool choice | `tool_choice: {type:"auto"}` | `tool_choice: "auto"` (string; OpenAI also accepts object form) | `obs-stable` |
| Model rewriting | ccxray supports `CCXRAY_MODEL_PREFIX`/`REWRITE_MODEL_PREFIX` to rewrite model names in-flight | Same | `obs-stable` (ccxray feature) |

### 3.2 Message/Input item structure

| Aspect | Claude Code | Codex | Confidence |
|--------|-------------|-------|------------|
| User text | `{role:"user", content:[{type:"text", text:"..."}]}` | `{type:"message", role:"user", content:[{type:"input_text", text:"..."}]}` | `contractual` |
| Assistant text | `{role:"assistant", content:[{type:"text", text:"..."}]}` | `{type:"message", role:"assistant", content:[{type:"output_text", text:"..."}]}` | `contractual` |
| System in conversation | `{role:"user", content:[{type:"text", text:"<system>..."}]}` (injected tags) | `{type:"message", role:"developer", content:[...]}` | `obs-stable` |
| Tool invocation | In assistant message: `{type:"tool_use", id, name, input}` | Response output items include `function_call`, `tool_call`, `custom_tool_call`, `computer_call`, `local_shell_call`, `web_search_call`, `file_search_call`, `code_interpreter_call`, `mcp_call`, and `image_generation_call` | `contractual` |
| Tool result | `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` | Input/result items use the corresponding `*_call_output` type where applicable and pair through `call_id` | `contractual` |
| Thinking | `{type:"thinking", thinking:"..."}` in assistant content | `{type:"reasoning", ...}` as separate input item (content is null/opaque) | `contractual` (Anthropic) / `obs-stable` (Codex) |
| Image input | `{type:"image", source:{type:"base64", ...}}` | `{type:"input_image", image_url:"..."}` | `contractual` |

### 3.3 WebSocket client→server frames (Codex only)

| Frame type | Payload | Confidence |
|------------|---------|------------|
| `response.create` | Full request body: `{model, instructions, input, tools, tool_choice, previous_response_id, metadata?, generate?}`. `metadata` may carry `thread_id` and `workspaces`. `generate: false` sends a warm-up frame (see Section 6.3) | `contractual` / `obs-stable` (`metadata` shape) |
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
| `response.output_item.added` | `{item:{id, type:"message"\|"reasoning"\|<tool>_call, name?, call_id?, status:"in_progress"}, output_index}`; tool call types include the family listed in §3.2 | `contractual` |
| `response.function_call_arguments.delta` | `{delta:"...", item_id, output_index}` | `contractual` |
| `response.function_call_arguments.done` | `{arguments:"{...}", item_id, output_index}` | `contractual` |
| `response.output_text.delta` | `{delta:"...", item_id, content_index, output_index}` | `contractual` |
| `response.output_text.done` | `{text:"...", item_id, content_index}` | `contractual` |
| `response.content_part.added` | `{part:{type:"output_text"}, item_id, content_index}` | `contractual` |
| `response.content_part.done` | `{part:{type:"output_text", text:"..."}, item_id}` | `contractual` |
| `response.output_item.done` | `{item:{id, type:"message"\|"reasoning"\|<tool>_call, name?, call_id?, arguments?, status:"completed"}}`; tool call types include the family listed in §3.2 | `contractual` |
| `response.completed` | `{response:{id, model, status, usage, ...}}` — ccxray extracts only `usage` and `model` before discarding; `output: null`, `input: null` observed but unverified | `obs-fragile` codex 0.133 |
| `response.done` | Same shape as `response.completed`; observed as a separate event type in some Codex versions. Proxies should handle both | `obs-fragile` |
| `codex.rate_limits` | `{...}` rate limit info (non-standard, Codex-specific). Payload shape is not parsed by ccxray; exact fields undocumented | `obs-stable` codex ≥0.131 |

### 4.2.1 Saved Codex transcripts are not wire event streams

| Saved field/event | ID availability | Confidence / version |
|-------------------|-----------------|----------------------|
| `event_msg` / `token_count` | Usage totals and last usage do not contain the enclosing upstream response ID | `obs-fragile`, Codex 0.133 schema |
| `response_item` / message or reasoning ID | Item identity is distinct from response identity; these IDs are skipped during serialization in 0.133 | `obs-fragile`, Codex 0.133 schema |
| `raw_response_completed.response_id` | Defined as an event in 0.145, but explicitly excluded from rollout persistence; cannot supply an importer key from ordinary saved JSONL | `obs-fragile`, Codex 0.145 persistence policy |
| `token_usage_record.response_id` | Upstream `resp_…` id, persisted with that response's exact usage just before its `token_count`. The importer attaches it as `responseId` only when the record's `usage` equals the `token_count`'s `last_token_usage`; a `token_count` without one (older Codex, re-emissions) keeps no key | `obs-fragile`, observed in Codex 0.155.1 and 0.163.0 rollouts |

Versioned upstream source links, scope limits and follow-up options are in the
[#508 investigation](solutions/codex-import-response-id.md). Do not infer that
the wire `response.completed.response.id` is present in a saved transcript;
the persisted key is `token_usage_record.response_id`, where present.

### 4.3 Usage/cost fields

| Field | Claude Code | Codex | Confidence |
|-------|-------------|-------|------------|
| Wire model id `grok-4.5-build` (Grok CLI) | N/A | N/A — Grok only: `DEFAULT_PRICING` carries input **2** / output **6** / cache_create **0** / cache_read **0.50** (USD per 1M) as the **offline floor**. Since PR #405 the spread is `{...DEFAULT_PRICING, ...mirrored}`, so a live LiteLLM row wins whenever the fetch succeeds; the bare id resolves today via the `xai/grok-4.5` mirror plus longest-prefix match. Delete the pinned row once LiteLLM lists `xai/grok-4.5-build` (2026-08-01) | `obs-fragile` |
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
| Session ID source | `body.metadata.session_id` | Header `session_id` or `x-openai-session-id`, or `x-codex-turn-metadata` JSON → `.session_id`, or `body.metadata.session_id`, then `x-codex-turn-metadata.thread_id` / `body.metadata.thread_id` as fallback. Falls back to literal `codex-raw` sentinel when no session/thread source yields an ID | `contractual` (body) / `obs-stable` (headers, `thread_id`) |
| Session ID format | UUID v4 (e.g. `06e8a0f7-...`) | UUID v7 (e.g. `019e809a-...`) | `obs-stable` |
| Turn ID | Not explicit; each HTTP request = one turn | `x-codex-turn-metadata` → `turn_id` (present on wire but not consumed by ccxray) | `obs-stable` codex ≥0.131 |
| Agent type (Codex) | N/A | Priority: `x-openai-agent-type` / `x-codex-agent-type` header, then `x-codex-turn-metadata` JSON → `.agent_type`, then `x-openai-subagent` as fallback. Values: `explorer`, `worker`, `default` | `obs-stable` |
| Subagent flag (Claude) | Heuristic (`isAnthropicSubagent`): `context_management` → main; a known subagent/side-request key → subagent; a structurally recovered cwd → main; no cwd and no `session_id` → subagent; otherwise main only for a main or `unknown`/`agent` key (#725). Also: stricter `isLikelySubagent()` heuristic in store.js for session inference (multi-condition: inflight + temporal) | N/A | `obs-stable` |
| Subagent flag (Codex) | N/A | Header `x-openai-subagent` (truthy, checked first) or `body.metadata.is_subagent`/`isSubagent` (fallback). WS path derives from `agentType === 'explorer' \|\| agentType === 'worker'` | `obs-stable` codex ≥0.131 |
| CWD detection (WS) | `Primary working directory:` line in the `system` prompt; when the `system` has none (CC 2.1.283+), a `role:'system'` message, then `messages[0]` (`context_management` requests only), then `safeguards[].classifier_context.live_cwd` (not on a title/name-generation side request, #725) | `response.create.metadata.cwd` / `.workspaces`, `x-codex-turn-metadata.cwd` / `.workspaces`, then `instructions` `CWD:` line. Workspace extraction uses 5 strategies: (1) `workspaces.cwd`, (2) `workspaces.current`, (3) first string value, (4) nested object with `.cwd`, (5) first key starting with `/` | `obs-fragile` (format varies across Codex versions) |
| CWD detection (HTTP) | (same as WS) | `parsedBody.metadata.cwd`, `parsedBody.metadata.workspaces`, `x-codex-turn-metadata.cwd/workspaces`, `instructions` `CWD:` line, then hub client CWD or `process.cwd()` | `obs-stable` / `obs-fragile` (`workspaces`) |
| Multi-turn | Full `messages[]` history in every request | WS: `previous_response_id` + incremental `input`. HTTP: full cumulative `input[]` history; the immediately preceding turn's tool results form the trailing contiguous `*_call_output` block | `contractual` (history) / `obs-stable` (trailing output block) |

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
| Startup platform pings | Codex 0.133+ sends requests to `/v1/plugins/*`, `/v1/ps/plugins/*`, `/v1/connectors/*`, `/v1/api/codex/*`, `/v1/codex/*`, and `/v1/models`. They are noise-filtered (`skipEntry: true`) but still forwarded to path-scoped ChatGPT upstreams. Codex 0.148 real OAuth validation returned no plugin, Apps MCP, or analytics 404 after path normalization | `obs-stable` codex 0.148 |
| `codex-raw` session | Any OpenAI request lacking both `session_id` and `thread_id` (WS or HTTP) is grouped under the synthetic `codex-raw` session ID. WS sessions can be promoted out of `codex-raw` once `response.create.metadata` provides a thread/session id | `obs-stable` (ccxray convention) |
| Proxy client identity | `metadata.client` is never trusted from the request body. ccxray derives it from the wire-client matcher, overwrites conflicting body values, and removes unmatched claims before session attribution and decoder dispatch | `obs-stable` ccxray ≥2.3.0 (ccxray convention) |
| Codex tool-result exit code | Codex tool output is an `input_text[]` envelope, observed already parsed on WebSocket and retained as a serialized JSON array in older fixtures. In each `input_text.text` inner JSON object, only a top-level safe-integer `exit_code` is decoded. `0` is clean; any non-zero integer, including a negative integer, is failure; fractional or unsafe numeric values are undecodable. Across multiple decoded command results, failure dominates | `obs-fragile` Codex 0.145.0 (CLI payload) / `obs-stable` ccxray ≥2.3.0 (ccxray convention) |
| Header-aware routing | Shared `/v1/models*` follows provider signals (default OpenAI); conflicting signals return local 421. Anthropic-side signals on other OpenAI paths return local 421, including WS upgrades. Unlisted paths require provider headers, a wire client, or attached hub identity; a bare JWT or bare non-Anthropic `sk-` bearer alone returns 421. Grok hub identity selects xAI. Bodyless GET/HEAD `/` and `/api/hello` pass through to Anthropic without OpenAI-side signals. Routing fix (#745); log label fix uses the failing request's agent label (#744). | `obs-stable` (ccxray convention) |
