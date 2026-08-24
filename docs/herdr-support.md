# ccxray for Herdr 支援說明

ccxray for Herdr 把 ccxray 的 live proxy observability 放進 Herdr：使用者可以從 Herdr 啟動 Claude、Codex 或 Grok，在 agent pane 的 sidebar 看到 compact context／cost／health summary，並在 Mission Control 與 dashboard 查看 session、tool 與完整 turn detail。

> **最新驗證（2026-08-24）**：`ccxray` workspace 的 Codex 與 Grok 對 PR #585 做了 live smoke。Codex 實際落盤 `toolCalls: {mcp__node_repl__js: 1, Bash: 1}`；Grok 透過 `use_tool` 實際落盤 `github__pull_request_read: 1`。PR #585 已於 2026-08-24 合入 `main`（merge commit `d8176cc`），因此下面矩陣反映 current `main` 的 parser 行為。

這份文件是支援範圍與限制的單一入口。它刻意區分：

- **Live proxy**：請求實際經過 ccxray 時可取得的資料。
- **Herdr integration**：Herdr pane、badge、Mission Control 與 launcher。
- **Local transcript import**：ccxray 從 `~/.claude` 或 `~/.codex` 重建歷史資料時可取得的資料。

## 快速判斷

| 問題 | 結論 |
|---|---|
| 能否從 Herdr 啟動三個 Provider？ | 可以：Claude、Codex、Grok。 |
| 三者都能看到 live cost、context、session 和 badge 嗎？ | 可以，但資料語義依 Provider 不同。 |
| 三者功能完全 parity 嗎？ | 不完全。Intercept、cache breakdown、local import 和 quota window 有差異。 |
| 是否支援其他 CLI？ | ccxray launcher 不會自動支援；未知 provider command 會直接失敗，但手動指向 proxy 的第三方 client 仍可能被記錄。 |
| Herdr plugin 支援哪些平台？ | 支援範圍是 macOS、Linux；需要 Herdr 0.8+、Node.js 18+ 與至少一個已支援的 agent CLI。 |

## Herdr 提供的功能

| Herdr surface | 支援內容 |
|---|---|
| Quick Start | 檢查 ccxray、偵測已安裝的 CLI、啟動 Provider、顯示需求與狀態。 |
| Provider launcher | 在目前 workspace 建立新的 Herdr tab，注入 proxy URL 與 pane identity。 |
| Sidebar badge | 顯示 compact context bar、cost／age 或一個 alert，以及 ready／not-linked／freshness 狀態。 |
| Mission Control | 合併 Herdr agent 與 ccxray session，依風險排序並提供下一步與 dashboard deep-link。 |
| Sidebar summary | 可選、可移除的 Herdr state rows 與 ccxray context／facts／alert rows；不是完整的 model／cost card。 |
| Notifications | 背景 pane 進入 done 或 blocked 時通知；可關閉或只保留 blocked。 |
| Capability Footprint | 彙整 MCP schema、MCP／skill 使用觀察；少於五個合資格 session 時只顯示觀察，不產生候選建議；仍是 experimental。 |
| Doctor | 檢查 Herdr runtime、ccxray command、hub、最近 usage 與 pane 連線 metadata。 |
| Dashboard | 開啟完整 Miller dashboard、turn detail、timeline、system prompt 與 raw request／response。 |

Provider launcher 目前在 [`server/providers.js`](../server/providers.js) 集中註冊；Herdr manifest 的三個 launch action 在 [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml) 中宣告。

## Provider 功能矩陣

符號：✅ 完整支援；△ 可用但有明確限制；— 不支援或不適用；❌ local source 沒有該資料。

### 啟動、路由與身份

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| `ccxray <provider>` launcher | ✅ | ✅ | ✅ |
| Herdr Quick Start launcher | ✅ | ✅ | ✅ |
| Herdr 新 tab 啟動 | ✅ | ✅ | ✅ |
| 共用 hub／dashboard | ✅ | ✅ | ✅ |
| Proxy routing | Anthropic Messages | OpenAI Responses／ChatGPT | xAI Responses |
| Proxy auth | `X-Ccxray-Auth` header | API key model provider；ChatGPT OAuth 原生 marker | CLI 原生 auth 經 proxy |
| Pane identity | Anthropic custom header | 無 provider-specific pane header；依 native session id 或 cwd fallback | 無 provider-specific pane header；依 native session id 或 cwd fallback |
| Exact pane → session mapping | ✅ | △ native session id 可精確；否則可能退回 cwd／unlinked | △ native session id 可精確；否則可能退回 cwd／unlinked |

Codex 支援 API-key 與 ChatGPT OAuth；Grok 使用 OpenAI Responses parser，但有自己的 xAI upstream、agent label 與 `grok-raw` session bucket。

### Live wire observability

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| HTTP request／response | ✅ | ✅ | ✅ |
| SSE streaming | ✅ | ✅ | ✅ |
| WebSocket | — | ✅ | △ 共用 OpenAI 路徑，但沒有同等 Grok-specific live acceptance |
| Turn list／順序 | ✅ | ✅ | ✅ |
| Cost／model／timing | ✅ | ✅ | ✅ |
| Session ID | body metadata；缺失時可由 socket／session inference 補足 | header／metadata／thread ID | `x-grok-session-id`／`x-grok-conv-id` |
| CWD／project | system prompt | metadata／header／instructions／fallback | user info／metadata／fallback |
| Main／subagent classification | prompt heuristic | header／metadata／agent type | △ 共用 OpenAI parser，但未有已驗證的 Grok-specific subagent signal |
| Request／response raw detail | ✅ | ✅ | ✅ |
| TTFT／streaming timeline | ✅ | ✅ | ✅ |
| Startup／control-plane noise filtering | △ `count_tokens` filter；沒有同等 startup probe | ✅ | ✅ |

Codex WebSocket 的少數大型 envelope 會被保存成 compact timing anchor，因此 turn detail 在部分情況不如 Claude 完整。Grok 的 title-generation attribution 是 best-effort；沒有 cwd 的 raw title session 可能不會出現在 project sidebar。

Codex 或 Grok 在同一 workspace／cwd 開啟多個 pane 時，若 Herdr 沒有提供 native session id，ccxray 不能保證只把 telemetry 歸給正確 pane。

### Token、成本與 context

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Input／output token | ✅ | ✅ | ✅ |
| Cache read | ✅ | ✅ | ✅ |
| Cache creation | ✅ | — | — |
| Cache 5m／1h breakdown | ✅ | — | — |
| Aggregate cost confidence | ✅ | ✅ | ✅ |
| Context window inference | 200K／1M header evidence | model／usage evidence | model／usage evidence |
| Context percentage | ✅ | ✅ | ✅ |
| Provider-native usage detail | Anthropic cache fields | OpenAI input／output details | 依 Grok response 提供內容 |

OpenAI wire 的 cache 語義會把 cached input 正規化成 cache-read；它沒有 Claude ephemeral cache 的 5 分鐘／1 小時 cache-create breakdown。Grok 的 context window 與 quota 也不能直接套用 Claude 的 200K／1M 或 Codex 的 window 語義。

Herdr plugin 會優先使用 shared `public/format.js` 的 aggregate-cost confidence fold；若 plugin 安裝環境缺少該 helper，成本仍會顯示，但會退化為不加 confidence marker 的數字。

### Tools、thinking 與 prompt

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Tool call count | ✅ | ✅ `function`／`tool`／`custom_tool_call` | ✅ `function_call`；`use_tool` gateway |
| MCP tool name attribution | ✅ | ✅ 從 `exec` input 解析 | ✅ 從 `use_tool.arguments.tool_name` 解析 |
| Tool result | ✅ | △ 部分 response item | △ 依 response event |
| Tool failure signal | △ 目前仍有跨資料路徑限制 | △ | △ |
| Thinking／reasoning timeline | ✅ thinking blocks | ✅ reasoning events | △ 取決於 Grok 是否送出對應事件 |
| System prompt／instructions capture | ✅ | ✅ | ✅ |
| Prompt version／hash／diff | ✅ | ✅ | ✅ |
| `skillCalls` 統計 | ✅ | — | — |

`skillCalls` 是 Anthropic 的明確 wire-level 語義。Codex 的 skills 是 prompt instructions，不是可獨立歸因的 tool call；Grok 也沒有等價的 ccxray skill protocol。

PR #585 的驗證也確認：Codex MCP 名稱可能藏在 `custom_tool_call` 的 `exec` JavaScript input，Grok MCP 名稱則可能藏在 `use_tool` 的 `arguments.tool_name`；這不是所有 OpenAI-wire tool event 都具備的 top-level 欄位。相關 wire 形狀與版本信心見 [`docs/wire-protocol-reference.md`](wire-protocol-reference.md)。

### Dashboard 與控制功能

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Miller dashboard | ✅ | ✅ | ✅ |
| Timeline renderer | ✅ | ✅ | ✅ |
| Tool detail | ✅ | △ | △ |
| System Prompt tab（live wire） | ✅ | ✅ | ✅ |
| Request／Response tab（live wire） | ✅ | ✅ | ✅ |
| Session title | ✅ | ✅ | △ title-gen attribution |
| Resume command | ✅ `claude --resume` | ✅ 有 usage 才可 resume | △ 有 usage 才可；尚未 live-verified |
| Intercept／edit request | ✅ | △ 可 hold，但 editor 不是 Codex WebSocket 專用 | △ 可 hold，但 editor 不支援 Grok Responses body |
| Mission Control／Herdr badge | ✅ | ✅ | ✅ |

Intercept 的 session arm／request hold 不是 provider-exclusive；但目前可完整編輯的 dashboard editor 是 Anthropic Messages shape。Codex WebSocket 與 Grok Responses 可能被 hold，卻不會進入同等完整的 request-edit 流程。

### Quota 與帳戶用量

| 能力 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Usage account card | △ 需要 `setup-statusline` | ✅ | ✅ |
| 多帳號／alias | ✅ | ✅ `.codex-*` | △ live billing 使用單一 `default` alias |
| 5-hour window | ✅ | ✅ | — |
| 7-day／weekly window | ✅ | ✅ | ✅ weekly pool |
| Reset time | ✅ | ✅ | ✅ 有 upstream 提供時 |
| Provider-native quota semantics | statusline `rate_limits`／Anthropic header samples／plan | Codex rate-limit events／transcript | Grok billing credits |

Grok 的帳戶卡片代表 Weekly SuperGrok Limit，不是 Claude／Codex 的 5-hour quota，因此百分比不能跨 Provider 直接比較。

Claude 的 quota account card 不會只靠 proxy traffic 自動出現；先執行 `ccxray setup-statusline`，讓 Claude statusline adapter 寫入 `rate_limits` snapshot。
Grok adapter 雖保留 alias 欄位，但目前 live billing path 以 `default` 寫入，不能宣稱已完成多 credential alias 隔離。

## Local transcript import

Live proxy 的資料最完整；本機 transcript 是另一個較弱的資料來源：

| 功能 | Claude Code local | Codex local | Grok local |
|---|:---:|:---:|:---:|
| Turn list | ✅ | ✅ | — |
| Cost／model／timing | ✅ | ✅ | — |
| Session／cwd／project | ✅ | ✅ | — |
| Context percentage | ✅ 合計值，沒有 system／tools 拆分 | ❌ | — |
| Thinking blocks | ✅ | ❌ | — |
| Tool use／result | ✅ | △ 部分 response item | — |
| Cache breakdown | ✅ | ❌ | — |
| stop reason | ✅ | ❌ | — |
| Conversation branching | ✅ `parentUuid` | ❌ | — |
| Error／retry events | ✅ | ❌ | — |
| Raw request／response | ❌ | ❌ | — |
| TTFT／streaming timeline | ❌ | ❌ | — |
| Rate-limit headers | ❌ | ❌ | — |

Grok 沒有本機 transcript importer；Grok 用量主要從 ccxray 自己的 `index.ndjson` 與 Grok billing endpoint 取得。詳細來源見 [`docs/import-provider-support.md`](import-provider-support.md)。

Local import entries 雖然保留 `importSource`，目前前端沒有依這份矩陣把缺少的功能改成明確提示；部分 tab 可能仍顯示空殼。

## Weather 與健康訊號

Context pressure、compaction、truncation 與 latency 可跨 Provider 使用，但不是每個訊號都具有相同可信度：

- `cache_health` 只套用 provider 明確為 Anthropic 的 entries；legacy entry 缺少 provider 時，仍可能依相容路徑被視為 Anthropic。
- tool-failure signals 目前在多種資料路徑仍有已知限制。
- Weather 計算會持續保存，但目前 dashboard 顯示預設關閉。

詳見 [`docs/weather.md`](weather.md)。

## 目前的限制

- Plugin 支援範圍限定 macOS／Linux；Windows 的 hub mode 需要 Unix socket，因此目前不是支援的 plugin target。
- 只保證 Claude、Codex、Grok 三個已註冊 launcher；其他 Provider 不會自動 fallback。
- Provider-neutral 的 Herdr badge 不代表每個 Provider 都有相同的 cache、quota、thinking 或 local transcript 資料。
- `not linked` 代表目前沒有足夠的 pane identity／session evidence；plugin 不會為了顯示綠色而借用其他 session。
- Capability Footprint 是 experimental，只描述觀察到的 MCP／skill 使用，不推斷任務成功或失敗。
- Codex／Grok 的 MCP 名稱可能被包在 gateway tool 裡；current `main` 已支援已知的 `exec`／`use_tool` 形狀，但未知或不同版本的 gateway event 仍可能只能保留外層 tool 名稱。
- Herdr plugin 的 pane badge 只讀 index tail；預設最多取 4 MiB，因此大型 index 的 cost／turn summary 可能是 tail sample，不是完整歷史總和。
- 沒有 shared `public/format.js` 時，aggregate cost 會退化成不加 confidence marker 的顯示；這不等於數字已被完整校準。
- Codex 目前仍標示 Beta；Grok 的 title-generation 與非主要 session 歸屬仍有 conditional edge cases。

## 驗證與延伸閱讀

- [`plugins/herdr/README.md`](../plugins/herdr/README.md)：安裝、操作、trust disclosure 與解除安裝。
- [`docs/grok-testing.md`](grok-testing.md)：Grok 的 unit、proxy e2e、browser 與 live acceptance。
- [`docs/import-provider-support.md`](import-provider-support.md)：local transcript import 矩陣。
- [`docs/normalization-map.md`](normalization-map.md)：兩個 wire parser 如何轉成 ccxray canonical model。
- [`docs/wire-protocol-reference.md`](wire-protocol-reference.md)：Claude、Codex、Grok 的 wire 形狀、版本與驗證信心。
- [`server/providers.js`](../server/providers.js)：Provider launcher 與 OpenAI-wire client registry 的 source of truth。
