# ccxray for Herdr 支援說明

ccxray 把 live proxy observability 放進 Herdr：使用者可以從 Herdr 啟動 Claude、Codex 或 Grok，在 agent pane 的 sidebar 看到 compact context／cost／health summary，並在 Mission Control 與 dashboard 查看 session、tool 與完整 turn detail。

[English](herdr-support.md) · [繁體中文](herdr-support.zh-TW.md) · [日本語](herdr-support.ja.md)

> 截至 2026-08-24，本指南已對齊合入的 parser baseline `d8176cc` 與 current `main`。`server/helpers.js` 已支援已觀察到的 `custom_tool_call` 與 `use_tool` 形狀。Provider 個別限制是支援契約的一部分，不是對所有 provider 的泛化保證。

## 範圍與閱讀順序

本指南刻意分開三種資料來源：

- **Live proxy**：請求實際經過 ccxray 時擷取的資料。
- **Herdr integration**：Herdr pane、badge、Mission Control、Notifications、launcher 與可選 sidebar rows。
- **Local transcript import**：從 `~/.claude` 或 `~/.codex*` 重建歷史資料；資料比 live proxy 弱。

建議先看「快速判斷」，再看「Provider 支援矩陣」比較 live parity；需要歷史資料或診斷訊號時，再看「Local transcript import」與「Weather 與健康訊號」。wire reference 是觀察欄位的證據，不是 provider 支援保證。

本 [繁體中文指南](herdr-support.zh-TW.md) 是支援範圍、信心與限制的 normative semantic source；英文與日文指南都必須保留相同 scope，而不是摘要。

為了讓跨語言審查保留相同契約詞彙，本文明確保留：**Notifications**、**not linked**、**Weather**、**reversible**、**Context window**、**Reset time**、**source of truth**、**lower bound**、**duplicate**。

## 支援圖例

以下圖例適用於後面的每個矩陣：

- **✅ 完整支援**：有明確來源的 contractual 或 obs-stable 行為，且沒有會改變該列語義的已知限制。
- **△ 可用但有明確限制**：obs-fragile、regex／heuristic、provider-live-unverified，或已知只代表 lower bound 的行為。每一個 △ row 都會在同列說明限制，並連到 [`wire-protocol-reference.md`](wire-protocol-reference.md) 或相關 ADR／證據。
- **— 不支援或不適用**：在本範圍內 provider 或 surface 沒有這項能力。
- **❌ source 沒有暴露該欄位**：指定的 local source 沒有這份資料；這不同於 live observation 尚未抵達。

## 快速判斷

| 問題 | 結論 |
|---|---|
| 能否從 Herdr 啟動支援的 Provider？ | 可以：Claude、Codex、Grok。 |
| 三者都能看到 live cost、context、session 和 badge 嗎？ | 可以，但各 Provider 的語義與信心不同。 |
| 三者功能完全 parity 嗎？ | 不完全。Intercept、cache breakdown、local import、quota window 與 pane identity 有差異。 |
| 是否會自動支援其他 CLI？ | 不會。未知 launcher provider command 會直接失敗；手動指向 proxy 的第三方 client 仍可能被記錄。 |
| 需要哪些條件？ | macOS／Linux、Herdr 0.8+、Node.js 18+，以及至少一個已支援的 agent CLI。 |

## Herdr integration 提供的功能

| Herdr surface | 契約 |
|---|---|
| Quick Start | 檢查 ccxray、偵測已安裝 CLI、顯示需求，並提供 Provider 啟動 action。 |
| Provider launcher | 建立新的 Herdr tab，讓選定的 Provider 經由 ccxray 路由。 |
| Sidebar badge | 顯示 compact context bar、cost／age fact 或一個 alert，以及 `ready`／`not linked`／freshness 狀態；不是完整的 model 或 cost card。 |
| Mission Control | 將 Herdr agent 與 ccxray session 合併，依注意程度排序，顯示 evidence confidence，並 deep-link 到 dashboard。 |
| Sidebar summary | 可選、依寬度調整的 Herdr state rows，加上 ccxray context／fact／alert rows。安裝／移除是 **reversible**：既有 table 只加入或移除 ccxray rows；若 table 是 plugin 建立的，則可以整張移除。 |
| Notifications | 背景 pane 進入 done 或 blocked 時可通知；可以關閉，或只保留 blocked。 |
| Capability Footprint | 彙整 MCP schema 與 MCP／skill 使用觀察；少於五個合資格 session 時只顯示 observation，候選建議需五個 session 且仍是 experimental。 |
| Doctor | 檢查 Herdr runtime、ccxray command、hub、最近 usage 與 pane connection metadata。 |
| Dashboard | 對 live entries 提供完整 Miller dashboard、turn detail、timeline、system prompt 與 raw request／response。 |

[`server/providers.js`](../server/providers.js) 的 provider launcher registry 是 launcher 的 **source of truth**；三個 Herdr launch action 宣告在 [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml)。plugin README 是安裝與信任的 source of truth；本指南是支援契約的 source of truth。

## Provider 支援矩陣

### 啟動、路由與身份

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| `ccxray <provider>` launcher | ✅ | ✅ | ✅ |
| Herdr Quick Start 與新 tab 啟動 | ✅ | ✅ | ✅ |
| 共用 hub 與 dashboard | ✅ | ✅ | ✅ |
| Proxy route | Anthropic Messages | OpenAI Responses／ChatGPT | xAI Responses |
| Proxy auth | `X-Ccxray-Auth` header | API-key provider 或 ChatGPT OAuth 原生 marker | CLI 原生 auth 經 proxy |
| Pane identity | Anthropic custom header | 無 provider-specific pane header；依 native session id 或 cwd fallback | 無 provider-specific pane header；依 native session id 或 cwd fallback |
| Exact pane → session mapping | ✅ | △ native session id 可精確；cwd fallback 可能模糊或變成 `not linked`（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ native session id 可精確；cwd fallback 可能模糊或變成 `not linked`（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） |

Codex 支援 API-key 與 ChatGPT OAuth。Grok 共用 OpenAI Responses parser，但有自己的 xAI upstream、agent label 與 `grok-raw` session bucket。同一 workspace／cwd 開啟多個 Codex 或 Grok pane、而 Herdr 沒有提供 native session id 時，ccxray 不能保證 pane-perfect attribution，也不會借用另一個 pane 的 telemetry。

### Live wire observability

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| HTTP request／response | ✅ | ✅ | ✅ |
| SSE streaming | ✅ | ✅ | ✅ |
| WebSocket | — | ✅ | △ 共用 OpenAI path，但尚未驗證 Grok-specific WebSocket acceptance（[wire reference](wire-protocol-reference.md)） |
| Turn list／順序 | ✅ | ✅ | ✅ |
| Cost／model／timing | ✅ | ✅ | △ model 與 timing 可觀察，但 cost 會 fallback 到 obs-fragile 的 offline floor；有可用資料時 mirrored LiteLLM pricing 會勝出（[wire:168](wire-protocol-reference.md#L168)） |
| Session ID | body metadata；可用 socket／session inference fallback | header／metadata／thread id | `x-grok-session-id`／`x-grok-conv-id` |
| CWD／project | system prompt | metadata／header／instructions／fallback | user info／metadata／fallback |
| Main／subagent classification | △ prompt heuristic；未知 prompt variant 會 fallback（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ header／metadata／agent type 證據，仍有 fallback case（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ 共用 parser，但沒有已驗證的 Grok-specific subagent signal（[wire reference](wire-protocol-reference.md)） |
| Request／response raw detail | ✅ | ✅ | ✅ |
| TTFT／streaming timeline | ✅ | ✅ | ✅ |
| Startup／control-plane noise filtering | △ `count_tokens` 會被過濾，但 Claude path 沒有同等 startup probe（[wire reference](wire-protocol-reference.md)） | ✅ | ✅ |

Codex WebSocket 的部分大型 envelope 可能以 compact timing anchor 保存，因此個別 turn 的 raw detail 不一定與 Claude 一樣完整。Grok 的 title-generation attribution 是 best-effort；沒有 cwd 的 raw title session 可能不會出現在 project sidebar。wire reference 記錄欄位來源與 confidence tags。

### Token、成本與 Context window 來源

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Input／output token | ✅ | ✅ | ✅ |
| Cache read | ✅ | ✅ | ✅ |
| Cache creation | ✅ | — | — |
| Cache 5m／1h breakdown | △ wire field pair `usage.cache_creation.ephemeral_5m_input_tokens`／`usage.cache_creation.ephemeral_1h_input_tokens` 是 observation-dependent 的 `obs-fragile` 觀察；只有實際觀察到這兩個欄位時才提供 breakdown（[wire reference](wire-protocol-reference.md)）。 | — | — |
| Aggregate cost confidence | ✅ | ✅ | ✅ |
| Context window provenance | △ 預設 200K；只有觀察到 `context-1m-2025-08-07`／`[1m]` evidence 才是 1M，不使用 API maximum（[wire reference](wire-protocol-reference.md)；[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ 來自 model／usage evidence，不套用 Claude 200K／1M 規則（[wire reference](wire-protocol-reference.md)） | △ 來自 model／usage evidence，不可移植套用 Claude／Codex window 規則（[wire reference](wire-protocol-reference.md)） |
| Dashboard context percentage | ✅ | ✅ | ✅ |
| Sidebar badge Context window／ctx% provenance | △ badge 顯示 selected-session value，但沒有 dashboard denominator provenance（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ 同樣沒有暴露 dashboard denominator evidence（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ model／usage evidence 不是 dashboard denominator citation（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） |
| Provider-native usage detail | Anthropic cache fields | OpenAI input／output details | 依 Grok response 提供內容 |

OpenAI wire 的 cached input 會正規化成 cache-read，沒有 Claude ephemeral cache-create breakdown。LiteLLM `max_input_tokens` 是 API capability hint，不是 session Context window denominator。持久化的 `ctxBeta` 與 `beta1m` interpretation 可以有意不同，詳見 wire reference 與 ADR 0013。

Herdr plugin 有 `public/format.js` 時會使用 shared aggregate-cost confidence fold。若安裝環境缺少該 helper，成本數字會不加 marker，只保留 `—`（沒有已定價資料）或 `+`（已知 lower bound），不會套用 worst-of `~`；這是 degraded display，不代表數字已完整校準（[ADR 0017](decisions/0017-aggregate-cost-confidence.md)）。

### Tools、MCP attribution、thinking 與 prompt

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Tool call count | ✅ | △ 已知 call 會計數，但 gateway／unknown shape 與 plugin tail 可能讓數量成為 lower bound（[wire reference](wire-protocol-reference.md)） | △ 已知 call 會計數，但 gateway／unknown shape 與 plugin tail 可能讓數量成為 lower bound（[wire reference](wire-protocol-reference.md)） |
| MCP tool-name attribution | ✅ | △ 會解析已知 `custom_tool_call` 的 `exec` input；其他 OpenAI-wire shape 可能只保留外層名稱（[wire reference](wire-protocol-reference.md)） | △ 會解析已知 `use_tool.arguments.tool_name`；其他 gateway shape 可能只保留外層名稱（[wire reference](wire-protocol-reference.md)） |
| Tool result detail | ✅ | △ 只有部分 response item 暴露必要 result fields（[wire reference](wire-protocol-reference.md)） | △ 取決於 response event 是否送出完整資料（[wire reference](wire-protocol-reference.md)） |
| Tool-failure signal | △ 多條 data path 仍有限制；只計入 eligible、paired evidence（[wire reference](wire-protocol-reference.md)） | △ 未知或無法 decode 的 result combination 會保持 unknown（[wire reference](wire-protocol-reference.md)） | △ 未知或無法 decode 的 result combination 會保持 unknown（[wire reference](wire-protocol-reference.md)） |
| Thinking／reasoning timeline | ✅ thinking blocks | ✅ reasoning events | △ 取決於 Grok 是否送出對應 event（[wire reference](wire-protocol-reference.md)） |
| System prompt／instructions capture | ✅ | ✅ | ✅ |
| Prompt version／hash／diff | ✅ | ✅ | ✅ |
| `skillCalls` 統計 | ✅ | — | — |

合入的 baseline `d8176cc` 涵蓋已觀察到的 parser shape：Codex `custom_tool_call` item 與嵌在 `exec` JavaScript input 的 MCP name，以及 Grok `use_tool` 的 `arguments.tool_name`。live smoke 的例子是 Codex `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` 與 Grok `{github__pull_request_read: 1}`；這不表示未來所有 provider event 都能保證完整計數。

### Dashboard 與控制功能

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Miller dashboard | ✅ | ✅ | ✅ |
| Timeline renderer | ✅ | ✅ | ✅ |
| Tool detail | ✅ | △ 受 response-item coverage 限制（[wire reference](wire-protocol-reference.md)） | △ 受 response-event coverage 限制（[wire reference](wire-protocol-reference.md)） |
| System Prompt tab（live wire） | ✅ | ✅ | ✅ |
| Request／Response tab（live wire） | ✅ | ✅ | ✅ |
| Session title | ✅ | ✅ | △ title-generation attribution 是 best-effort（[wire reference](wire-protocol-reference.md)） |
| Resume command | ✅ `claude --resume` | △ 需要可用的 local／session usage evidence（[import matrix](import-provider-support.md)） | △ 需要 usage 且尚未 live-verified（[wire reference](wire-protocol-reference.md)） |
| Intercept／edit request | ✅ | △ 可 hold request，但 editor 不是 Codex WebSocket 專用（[wire reference](wire-protocol-reference.md)） | △ 可 hold request，但 editor 不支援 Grok Responses body（[wire reference](wire-protocol-reference.md)） |
| Mission Control／Herdr badge | ✅ | ✅ | ✅ |

Intercept 的 session arm 與 request hold 不是 provider-exclusive；但完整可編輯的 dashboard editor 是為 Anthropic Messages body 設計。Codex WebSocket 或 Grok Responses 能被 hold，不代表有同等 edit support。

### Quota 與帳戶用量

這裡是唯一的 quota matrix；token table 已移除重複的 quota-card row。

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Account card | △ 需要 `ccxray setup-statusline` 寫入 `rate_limits`（[import matrix](import-provider-support.md)） | ✅ | ✅ |
| 多帳號／alias | ✅ | ✅ `.codex-*` | △ live billing 目前寫入 `default` alias（[wire reference](wire-protocol-reference.md)） |
| 5-hour window | ✅ | ✅ | — |
| 7-day／weekly window | ✅ | ✅ | ✅ weekly pool |
| Reset time | ✅ | ✅ | △ 只有 upstream 提供該欄位時才顯示；沒有欄位就不宣稱 reset time（[wire reference](wire-protocol-reference.md)） |
| Provider-native quota semantics | statusline `rate_limits`、Anthropic header samples、plan | Codex rate-limit events、transcript | Grok billing credits／Weekly SuperGrok Limit |

Grok 帳戶卡片代表 Weekly SuperGrok Limit，不是 Claude／Codex 的 5-hour quota，因此百分比不能跨 Provider 直接比較。Claude quota card 不會只靠 proxy traffic 自動出現；請先執行 `ccxray setup-statusline`。Grok adapter 保留 alias field，但 live billing path 尚未提供多 credential alias 隔離。

## Local transcript import

Live proxy 資料最完整。本機 importer 讀取 Claude Code 與 Codex transcript 格式；Grok 沒有外部 local transcript importer。

| 功能 | Claude Code local | Codex local | Grok local |
|---|:---:|:---:|:---:|
| Turn list／順序 | ✅ | ✅ | — |
| Cost／model／timing | ✅ | ✅ | — |
| Session／cwd／project | ✅ | ✅ | — |
| Context percentage | ✅ 合計值，沒有 system／tools 拆分 | ❌ | — |
| Thinking blocks | ✅ | ❌ | — |
| Tool use／result | ✅ | △ 只有部分 response item（[import matrix](import-provider-support.md)） | — |
| Cache breakdown | ✅ | ❌ | — |
| stop reason | ✅ | ❌ | — |
| Conversation branching | ✅ `parentUuid` | ❌ | — |
| Error／retry events | ✅ | ❌ | — |
| Raw request／response | ❌ | ❌ | — |
| TTFT／streaming timeline | ❌ | ❌ | — |
| Rate-limit headers | ❌ | ❌ | — |

Grok 用量來自 ccxray 自己的 `index.ndjson` 與 Grok billing endpoint，不是 local transcript。Imported entries 會保留 `importSource`，但 frontend 尚未把每個不可用 tab 都轉成明確提示；部分 tab 仍可能只是空殼。

Import 與 live proxy record 可能代表同一個 turn。index／session merge 完成前，Mission Control 可能顯示 **duplicate import×proxy turn**；這是已知 integration limitation，不代表 provider 送了兩個 turn（[ADR 0012](decisions/0012-response-id-read-time-merge.md)）。

## Weather 與健康訊號

**Weather** 計算會持續保存，但在 tool-failure signals 修復期間，dashboard 顯示**預設關閉**。若要檢查，請使用 [`docs/weather.md`](weather.md) 記載的 toggle。

- Context pressure、compaction、truncation 與 latency 可跨 Provider 評估，但證據強度不完全相同。
- `cache_health` 只套用 provider 明確為 Anthropic 的 entries；沒有 provider 的 legacy entry 仍可能走相容路徑，被當成 Anthropic。
- Tool-failure Weather 只使用 eligible、paired 的 process／shell evidence；無法 decode 的 eligible result 會保持 unknown，並降低 known-rate。不能只靠 response status 推斷 failure（[wire reference](wire-protocol-reference.md)）。
- Weather 不是 quota field；provider-neutral badge 看起來健康，也不代表 provider parity 完整。

## 已知限制

- Plugin 支援範圍是 macOS／Linux。Windows hub mode 需要 Unix socket，目前不是支援的 plugin target。
- 只保證三個已註冊 launcher：Claude、Codex、Grok；其他 provider command 不會自動 fallback。
- Provider-neutral Herdr badge 不代表 cache、quota、reasoning、Context window 或 local-import data 相同。
- `not linked` 表示 pane identity／session evidence 不足；plugin 不會為了顯示綠色而借用其他 session 的 telemetry。
- Notifications 是便利訊號：done／blocked transition 以 pane 去重，可關閉；不是 provider outcome。
- Sidebar 安裝是 **reversible** 且需要明確同意，但使用者選擇 action 時確實會變更 Herdr 設定；user-owned table 與非 ccxray rows 會保留。
- Capability Footprint 是 experimental，只描述觀察到的 MCP／skill 使用，不推斷任務成功，outcome impact 保持 unknown。
- Codex／Grok MCP name 可能包在 gateway tool 裡。baseline 處理已知 `exec`／`use_tool` shape；未知或版本改變的 gateway event 可能只保留外層名稱（[wire reference](wire-protocol-reference.md)）。
- Codex／Grok tool count 可能是 **lower bound**：parser 採防禦式處理，未來 gateway event 可能未知，且 badge 只讀最多 4 MiB 的 index tail。tail-based cost／turn summary 是 sample，不是完整歷史總和。
- Mission Control 可能在 local import 與 live proxy 證據尚未合併時顯示 duplicate import×proxy turn。
- Sidebar badge 的 ctx% 缺少 dashboard denominator provenance：它報告 badge selected-session value，不是 dashboard denominator 的引用（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)）。
- 缺少 shared `public/format.js` 時，degraded aggregate cost 會刻意不加 marker，只保留 `—`／`+`；這不是已校準的完整總額，也不會使用被否決的 worst-of `~` marker（[ADR 0017](decisions/0017-aggregate-cost-confidence.md)）。
- Codex 仍標示 Beta；Grok 的 title-generation 與 non-main session attribution 有 conditional edge cases，且 Grok `Reset time` 取決於 upstream 是否提供欄位。

## 驗證與 source references

2026-08-24 的 workspace live smoke 記錄 Codex `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` 與 Grok `toolCalls: {github__pull_request_read: 1}`。PR #585 已以 `d8176cc` 合入 `main`；這些例子支持指定 parser shape，不代表所有未來 provider version。

- [`plugins/herdr/README.md`](../plugins/herdr/README.md)：安裝、操作、trust disclosure、local-data scope 與解除安裝。
- [`docs/grok-testing.md`](grok-testing.md)：Grok unit、proxy e2e、browser 與 live acceptance 證據。
- [`docs/import-provider-support.md`](import-provider-support.md)：local transcript import source matrix 與限制。
- [`docs/normalization-map.md`](normalization-map.md)：wire parser 到 canonical model 的欄位 mapping。
- [`docs/wire-protocol-reference.md`](wire-protocol-reference.md)：觀察到的 wire field、版本、confidence tags，以及 `custom_tool_call`／`use_tool` 證據；不是 provider-support guarantee。
- [`docs/weather.md`](weather.md)：Weather 推導與預設關閉的顯示行為。
- [`server/providers.js`](../server/providers.js)：launcher 與 OpenAI-wire client registry 的 source of truth。
- [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml)：Herdr action／manifest 的 source of truth。
- [`docs/decisions/0005-agent-key-unreliable-shared-contract.md`](decisions/0005-agent-key-unreliable-shared-contract.md)：identity fallback 與 badge classification 限制。
- [`docs/decisions/0013-beta1m-persist-session-window-derive.md`](decisions/0013-beta1m-persist-session-window-derive.md)：Context window denominator provenance。
- [`docs/decisions/0017-aggregate-cost-confidence.md`](decisions/0017-aggregate-cost-confidence.md)：aggregate cost confidence 與 degraded plugin wording。
