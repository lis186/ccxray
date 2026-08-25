# ccxray for Herdr Support

ccxray brings live proxy observability into Herdr. Launch Claude, Codex, or Grok from Herdr, see a compact context/cost/health summary in the agent sidebar, and use Mission Control or the dashboard for session, tool, and turn detail.

[English](herdr-support.md) · [繁體中文](herdr-support.zh-TW.md) · [日本語](herdr-support.ja.md)

> As of 2026-08-24, this guide is aligned with the merged parser baseline `d8176cc` and current `main`. `server/helpers.js` recognizes the observed `custom_tool_call` and `use_tool` shapes. Provider-specific caveats are part of the support contract; they are not claims of universal provider support.

## Scope and reading order

This guide separates three data sources:

- **Live proxy**: data captured when a request actually passes through ccxray.
- **Herdr integration**: Herdr panes, badges, Mission Control, notifications, launchers, and optional sidebar rows.
- **Local transcript import**: historical data rebuilt from `~/.claude` or `~/.codex*`; it is weaker than live proxy capture.

Read **Quick judgment** first, then the **Provider support matrix** for live parity. Read **Local transcript import** and **Weather and health** when you need history or diagnostic-signal details. The wire reference is evidence about observed fields, not a provider-support promise.

The [Traditional Chinese guide](herdr-support.zh-TW.md) is the normative semantic source for support scope, confidence, and limitations. English and Japanese preserve that scope as complete translations, not summaries.

For cross-language review, the contract vocabulary is kept explicit: **Notifications**, **not linked**, **Weather**, **reversible**, **Context window**, **Reset time**, **source of truth**, **lower bound**, and **duplicate**.

## Support legend

The legend applies to every matrix below:

- **✅ Complete support**: contractual or `obs-stable` (observation-stable) behavior with a defined source and no known limitation that changes the row's meaning.
- **△ Usable with an explicit limitation**: `obs-fragile` (observation-fragile), regex/heuristic, provider-live-unverified, or known lower-bound behavior. Every △ row names the limitation and links to [`wire-protocol-reference.md`](wire-protocol-reference.md) or the relevant ADR/evidence.
- **— Unsupported or not applicable**: the provider or surface does not offer the capability in this scope.
- **❌ Source does not expose the field**: the named local source has no such data; this is different from a live observation that has not arrived yet.

## Quick judgment

| Question | Answer |
|---|---|
| Can Herdr launch the supported providers? | Yes: Claude, Codex, and Grok. |
| Do all three expose live cost, context, sessions, and badges? | Yes, with provider-specific semantics and confidence. |
| Is feature parity complete? | No. Intercept, cache breakdown, local import, quota windows, and pane identity differ. |
| Are other CLIs supported automatically? | No. Unknown launcher provider commands fail fast; a manually pointed third-party client may still be recorded by the proxy. |
| What are the requirements? | macOS/Linux, Herdr 0.8+, Node.js 18+, and at least one supported agent CLI. |

## What the Herdr integration provides

| Herdr surface | Contract |
|---|---|
| Quick Start | Checks ccxray, detects installed CLIs, shows requirements, and offers provider launch actions. |
| Provider launcher | Opens a new Herdr tab and routes the selected provider through ccxray. |
| Sidebar badge | Shows a compact context bar, a cost/age fact or one alert, and `ready`/`not linked`/freshness state. It is not a full model or cost card. |
| Mission Control | Joins Herdr agents to ccxray sessions, ranks attention, shows evidence confidence, and links to the dashboard. |
| Sidebar summary | Optional, width-aware Herdr state rows plus ccxray context/fact/alert rows. The install/remove action is **reversible**: it adds only ccxray rows to an existing table and removes only those rows; a table created by the plugin can be removed whole. |
| Notifications | Background panes can notify when an agent becomes done or blocked. Notifications can be disabled or restricted to blocked. |
| Capability Footprint | Observes MCP schema and MCP/skill use. Fewer than five eligible sessions show observations only; candidate suggestions require five sessions and remain experimental. |
| Doctor | Checks the Herdr runtime, ccxray command, hub, recent usage, and pane connection metadata. |
| Dashboard | Provides the complete Miller dashboard, turn detail, timeline, system prompt, and raw request/response for live entries. |

The provider launcher registry in [`server/providers.js`](../server/providers.js) is the launcher **source of truth**. The three Herdr launch actions are declared in [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml). The plugin README is the installation and trust source of truth; this guide is the support-contract source of truth.

## Provider support matrix

### Launch, routing, and identity

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| `ccxray <provider>` launcher | ✅ | ✅ | ✅ |
| Herdr Quick Start and new-tab launch | ✅ | ✅ | ✅ |
| Shared hub and dashboard | ✅ | ✅ | ✅ |
| Proxy route | Anthropic Messages | OpenAI Responses / ChatGPT | xAI Responses |
| Proxy auth | `X-Ccxray-Auth` header | API-key provider or ChatGPT OAuth native marker | CLI-native auth through proxy |
| Pane identity | Explicit Anthropic custom header | No provider-specific pane header; native session id or cwd fallback | No provider-specific pane header; native session id or cwd fallback |
| Exact pane → session mapping | ✅ | △ Native session id can be exact; cwd fallback can be ambiguous or `not linked` ([ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)) | △ Native session id can be exact; cwd fallback can be ambiguous or `not linked` ([ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)) |

Codex supports API-key and ChatGPT OAuth sessions. Grok uses the shared OpenAI Responses parser with its own xAI upstream, agent label, and `grok-raw` session bucket. When multiple Codex or Grok panes share a workspace/cwd and Herdr does not provide a native session id, ccxray cannot guarantee pane-perfect attribution and will not borrow another pane's telemetry.

### Live wire observability

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| HTTP request/response | ✅ | ✅ | ✅ |
| SSE streaming | ✅ | ✅ | ✅ |
| WebSocket | — | ✅ | △ Shared OpenAI path; Grok-specific WebSocket acceptance is not verified ([wire reference](wire-protocol-reference.md)) |
| Turn list and ordering | ✅ | ✅ | ✅ |
| Cost, model, and timing | ✅ | ✅ | △ Model and timing are observed, but cost falls back to an obs-fragile offline floor; mirrored LiteLLM pricing wins when available ([wire:168](wire-protocol-reference.md#L168)) |
| Session id | Body metadata, with socket/session inference fallback | Header, metadata, or thread id | `x-grok-session-id` / `x-grok-conv-id` |
| CWD/project | System prompt | Metadata, header, instructions, or fallback | User info, metadata, or fallback |
| Main/subagent classification | △ Prompt heuristic; unknown prompt variants can fall back ([ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)) | △ Header/metadata/agent-type evidence, with fallback cases ([ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)) | △ Shared parser; no verified Grok-specific subagent signal ([wire reference](wire-protocol-reference.md)) |
| Raw request/response detail | ✅ | ✅ | ✅ |
| TTFT/streaming timeline | ✅ | ✅ | ✅ |
| Startup/control-plane noise filtering | △ `count_tokens` is filtered, but the Claude path has no equivalent startup probe ([wire reference](wire-protocol-reference.md)) | ✅ | ✅ |

Codex WebSocket envelopes may be stored as compact timing anchors, so a particular turn can have less raw detail than a Claude turn. Grok title-generation attribution is best-effort; a raw title session without cwd may not appear in the project sidebar. The wire reference records the field-level provenance and confidence tags.

### Tokens, cost, and Context window provenance

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Input/output tokens | ✅ | ✅ | ✅ |
| Cache read | ✅ | ✅ | ✅ |
| Cache creation | ✅ | — | — |
| Cache 5m/1h breakdown | △ The wire field pair `usage.cache_creation.ephemeral_5m_input_tokens` / `usage.cache_creation.ephemeral_1h_input_tokens` is `obs-fragile` and observation-dependent; use the breakdown only when those fields are observed ([wire reference](wire-protocol-reference.md)). | — | — |
| Aggregate cost confidence | ✅ | ✅ | ✅ |
| Context window provenance | △ 200K by default; 1M requires the observed `context-1m-2025-08-07`/`[1m]` evidence, not API maximum ([wire reference](wire-protocol-reference.md); [ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)) | △ Derived from model/usage evidence; no Claude 200K/1M rule applies ([wire reference](wire-protocol-reference.md)) | △ Derived from model/usage evidence; no Claude/Codex window rule is transferable ([wire reference](wire-protocol-reference.md)) |
| Context percentage in dashboard | ✅ | ✅ | ✅ |
| Sidebar badge Context window / ctx% provenance | △ The badge shows its selected-session value but does not carry the dashboard denominator provenance ([ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)) | △ Same limitation; the badge does not expose the dashboard's denominator evidence ([ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)) | △ Same limitation; model/usage evidence is not a dashboard denominator citation ([ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)) |
| Provider-native usage detail | Anthropic cache fields | OpenAI input/output details | Depends on the Grok response |

OpenAI cached input is normalized as cache-read; it does not have Claude's ephemeral cache-create breakdown. LiteLLM `max_input_tokens` is an API capability hint, not a session Context window denominator. The persisted `ctxBeta` field and the `beta1m` interpretation can differ by design; see the wire reference and ADR 0013.

The Herdr plugin uses the shared aggregate-cost confidence fold from `public/format.js` when available. In degraded installations without that helper, the number is unmarked and only `—` (nothing priced) or `+` (known lower bound) is retained; it never applies a worst-of `~` marker. This is an accepted degraded display, not proof that the number is fully calibrated ([ADR 0017](decisions/0017-aggregate-cost-confidence.md)).

### Tools, MCP attribution, thinking, and prompts

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Tool call count | ✅ | △ Recognized calls are counted, but gateway/unknown shapes and the plugin tail can make the count a lower bound ([wire reference](wire-protocol-reference.md)) | △ Recognized calls are counted, but gateway/unknown shapes and the plugin tail can make the count a lower bound ([wire reference](wire-protocol-reference.md)) |
| MCP tool-name attribution | ✅ | △ Known `custom_tool_call` `exec` input is parsed; other OpenAI-wire shapes may retain only the outer name ([wire reference](wire-protocol-reference.md)) | △ Known `use_tool.arguments.tool_name` is parsed; other gateway shapes may retain only the outer name ([wire reference](wire-protocol-reference.md)) |
| Tool result detail | ✅ | △ Only some response items expose the needed result fields ([wire reference](wire-protocol-reference.md)) | △ Result detail depends on the emitted response event ([wire reference](wire-protocol-reference.md)) |
| Tool-failure signal | △ Cross-path limitations remain; only eligible, paired evidence is counted ([wire reference](wire-protocol-reference.md)) | △ Unknown or undecodable result combinations remain unknown ([wire reference](wire-protocol-reference.md)) | △ Unknown or undecodable result combinations remain unknown ([wire reference](wire-protocol-reference.md)) |
| Thinking/reasoning timeline | ✅ Thinking blocks | ✅ Reasoning events | △ Depends on whether Grok emits the corresponding event ([wire reference](wire-protocol-reference.md)) |
| System prompt/instructions capture | ✅ | ✅ | ✅ |
| Prompt version/hash/diff | ✅ | ✅ | ✅ |
| `skillCalls` statistics | ✅ | — | — |

The merged baseline `d8176cc` covers the observed parser shapes: Codex `custom_tool_call` items and MCP names embedded in `exec` JavaScript input, plus Grok `use_tool` `arguments.tool_name`. The live smoke examples are `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` for Codex and `{github__pull_request_read: 1}` for Grok; they do not turn every future provider event into a guaranteed complete count.

### Dashboard and control

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Miller dashboard | ✅ | ✅ | ✅ |
| Timeline renderer | ✅ | ✅ | ✅ |
| Tool detail | ✅ | △ Limited by response-item coverage ([wire reference](wire-protocol-reference.md)) | △ Limited by response-event coverage ([wire reference](wire-protocol-reference.md)) |
| System Prompt tab for live wire | ✅ | ✅ | ✅ |
| Request/Response tab for live wire | ✅ | ✅ | ✅ |
| Session title | ✅ | ✅ | △ Title-generation attribution is best-effort ([wire reference](wire-protocol-reference.md)) |
| Resume command | ✅ `claude --resume` | △ Requires usable local/session usage evidence ([import matrix](import-provider-support.md)) | △ Requires usage and is not live-verified ([wire reference](wire-protocol-reference.md)) |
| Intercept/edit request | ✅ | △ Requests can be held, but the editor is not Codex-WebSocket-specific ([wire reference](wire-protocol-reference.md)) | △ Requests can be held, but the editor does not support Grok Responses bodies ([wire reference](wire-protocol-reference.md)) |
| Mission Control / Herdr badge | ✅ | ✅ | ✅ |

Intercept session arm and request hold are not provider-exclusive. The fully editable dashboard editor is designed for Anthropic Messages bodies; holding a Codex WebSocket or Grok Responses request does not imply equivalent edit support.

### Quota and account usage

This is the single quota matrix; the earlier duplicate quota-card row has been removed from the token table.

| Capability | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Account card | △ Requires `ccxray setup-statusline` to write `rate_limits` ([import matrix](import-provider-support.md)) | ✅ | ✅ |
| Multiple accounts/aliases | ✅ | ✅ `.codex-*` | △ Live billing currently writes the `default` alias ([wire reference](wire-protocol-reference.md)) |
| 5-hour window | ✅ | ✅ | — |
| 7-day/weekly window | ✅ | ✅ | ✅ Weekly pool |
| Reset time | ✅ | ✅ | △ Shown only when the upstream supplies it; no provider reset-time claim is made without that field ([wire reference](wire-protocol-reference.md)) |
| Provider-native quota semantics | Statusline `rate_limits`, Anthropic header samples, and plan | Codex rate-limit events and transcript | Grok billing credits / Weekly SuperGrok Limit |

Grok's account card represents the Weekly SuperGrok Limit, not Claude/Codex's 5-hour quota, so percentages are not cross-provider comparable. Claude's quota card does not appear from proxy traffic alone; run `ccxray setup-statusline`. The Grok adapter keeps an alias field, but its live billing path does not yet provide multi-credential alias isolation.

## Local transcript import

Live proxy data is the most complete source. The local importer reads Claude Code and Codex transcript formats; Grok has no external local transcript importer.

| Capability | Claude Code local | Codex local | Grok local |
|---|:---:|:---:|:---:|
| Turn list/order | ✅ | ✅ | — |
| Cost/model/timing | ✅ | ✅ | — |
| Session/cwd/project | ✅ | ✅ | — |
| Context percentage | ✅ Aggregate only; no system/tools split | ❌ | — |
| Thinking blocks | ✅ | ❌ | — |
| Tool use/result | ✅ | △ Some response items only ([import matrix](import-provider-support.md)) | — |
| Cache breakdown | ✅ | ❌ | — |
| Stop reason | ✅ | ❌ | — |
| Conversation branching | ✅ `parentUuid` | ❌ | — |
| Error/retry events | ✅ | ❌ | — |
| Raw request/response | ❌ | ❌ | — |
| TTFT/streaming timeline | ❌ | ❌ | — |
| Rate-limit headers | ❌ | ❌ | — |

Grok usage comes from ccxray's own `index.ndjson` and the Grok billing endpoint, not a local transcript. Imported entries preserve `importSource`, but the frontend does not yet turn every unavailable tab into an explicit warning; some tabs can remain empty shells.

Import and live proxy records can also represent the same turn. Mission Control can therefore show a **duplicate import×proxy turn** while the index/session merge catches up. This is a known integration limitation, not evidence that the provider sent two turns ([ADR 0012](decisions/0012-response-id-read-time-merge.md)).

## Weather and health

**Weather** computation is persisted, but dashboard display is **off by default** while tool-failure signals are being repaired. Use the toggle documented in [`docs/weather.md`](weather.md) when you explicitly want to inspect it.

- Context pressure, compaction, truncation, and latency can be assessed across providers, but their evidence is not equally strong.
- `cache_health` is applied only to entries whose provider is explicitly Anthropic. A legacy entry with no provider can still follow the compatibility path and be treated as Anthropic.
- Tool-failure weather uses only eligible, paired process/shell evidence; undecodable eligible results remain unknown and reduce the known-rate. It must not infer failure from a response status alone ([wire reference](wire-protocol-reference.md)).
- The Weather field is not a quota field, and a healthy-looking provider-neutral badge is not proof of complete provider parity.

## Known limitations

- The plugin targets macOS/Linux. Windows hub mode needs Unix sockets and is not a supported plugin target.
- Only the three registered launchers—Claude, Codex, and Grok—are guaranteed. Other provider commands do not receive automatic fallback.
- A provider-neutral Herdr badge does not imply identical cache, quota, reasoning, Context window, or local-import data.
- `not linked` means there is not enough pane-identity/session evidence. The plugin never borrows another session just to show a green state.
- Notifications are convenience signals: done/blocked transitions are deduplicated per pane and can be disabled; they are not provider outcomes.
- Sidebar installation is **reversible** and consent-based, but it changes Herdr configuration when the user selects the action; a user-owned table and non-ccxray rows are preserved.
- Capability Footprint is experimental. It describes observed MCP/skill use, does not infer task success, and keeps outcome impact unknown.
- Codex/Grok MCP names can be wrapped in gateway tools. The baseline handles known `exec`/`use_tool` shapes; unknown or changed gateway events can leave only the outer name ([wire reference](wire-protocol-reference.md)).
- Codex and Grok tool counts can be a **lower bound** because the parser is defensive, future gateway events may be unknown, and the badge reads a maximum 4 MiB index tail. Tail-based cost/turn summaries are samples, not complete historical totals.
- Mission Control can show a duplicate import×proxy turn when local import and live proxy evidence have not merged.
- The sidebar badge's ctx% lacks dashboard denominator provenance: it reports the badge's selected-session value, not a citation for the dashboard's denominator ([ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)).
- Without shared `public/format.js`, degraded aggregate cost is intentionally unmarked and can retain only `—`/`+`; it is not a calibrated complete total and never uses the rejected worst-of `~` marker ([ADR 0017](decisions/0017-aggregate-cost-confidence.md)).
- Codex remains marked Beta. Grok title-generation and non-main-session attribution have conditional edge cases, and Grok `Reset time` is conditional on an upstream field.

## Verification and source references

The 2026-08-24 workspace live smoke recorded Codex `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` and Grok `toolCalls: {github__pull_request_read: 1}`. PR #585 is merged into `main` as `d8176cc`; those examples support the named parser shapes, not every future provider version.

- [`plugins/herdr/README.md`](../plugins/herdr/README.md): install, operation, trust disclosure, local-data scope, and uninstall.
- [`docs/grok-testing.md`](grok-testing.md): Grok unit, proxy e2e, browser, and live acceptance evidence.
- [`docs/import-provider-support.md`](import-provider-support.md): local transcript import source matrix and caveats.
- [`docs/normalization-map.md`](normalization-map.md): canonical field mapping from the wire parsers.
- [`docs/wire-protocol-reference.md`](wire-protocol-reference.md): observed wire fields, versions, confidence tags, and the `custom_tool_call`/`use_tool` evidence; it is not a provider-support guarantee.
- [`docs/weather.md`](weather.md): Weather derivation and default-off display behavior.
- [`server/providers.js`](../server/providers.js): launcher and OpenAI-wire client registry source of truth.
- [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml): Herdr action/manifest source of truth.
- [`docs/decisions/0005-agent-key-unreliable-shared-contract.md`](decisions/0005-agent-key-unreliable-shared-contract.md): identity fallback and badge classification limits.
- [`docs/decisions/0013-beta1m-persist-session-window-derive.md`](decisions/0013-beta1m-persist-session-window-derive.md): Context window denominator provenance.
- [`docs/decisions/0017-aggregate-cost-confidence.md`](decisions/0017-aggregate-cost-confidence.md): aggregate cost confidence and degraded plugin wording.
