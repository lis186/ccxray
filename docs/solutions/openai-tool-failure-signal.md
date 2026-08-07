# OpenAI-wire tool 失敗訊號：Codex 與 Grok 的實測結構差異 (#470)

> **這是診斷記錄，不是 spec。** 所有數據來自 2026-08-07 的隔離環境實測（獨立 port、
> 獨立 `CCXRAY_HOME`），不是推論。
>
> **結論**：失敗訊號存在但兩個 provider 格式不同；**差異來自 provider 而非 transport
> （已用交叉實驗證明）**；因此 **provider protocol 不需要擴充** —按 wire 上的 `type`
> 名稱分派即可。仍需 owner 選 A / B / C 決定範圍。
>
> 本文件經兩次修正，過程記在末段「修正記錄」（含一次歸因錯誤與一次變因未隔離）。

## 為什麼需要這份診斷

#470 要修 `server/wire-parsers/openai.js` 的 `toolFail: false` 硬編碼。但實作前卡在一個
設計題：**OpenAI wire 有沒有 tool 失敗的等價訊號？**

- 若**無** → 只能照 `public/weather.js:137` `sigCacheHealth` 的 provider guard 明確排除
- 若**有** → 映射它

判斷所需的資料（真實 tool 失敗的 wire 記錄）原本只存在於開發者的活 hub，而 pipeline 硬規則
禁止讀取它。因此改用隔離環境**產生新資料**，而不是讀既有資料。

## 方法

每次都是：起獨立 ccxray（自訂 port、獨立 `CCXRAY_HOME`、`CCXRAY_IMPORT_DISABLE=1`）→
真實 CLI 經該 proxy → 故意觸發一次 tool 失敗（`cat` 不存在的檔案）→ 逐欄位檢視
`index.ndjson` / `_req.json` / `_res.json`。三次都確認 tool **真的執行且真的失敗**
（`cat: ...: No such file or directory`, exit 1）。

### 三個已測組合（第三次是為了隔離變因而補跑）

| # | provider | transport | 取得方式 |
|---|---|---|---|
| 1 | codex | **WebSocket** | 預設（`transport:"websocket"`, endpoint `/v1/responses`） |
| 2 | grok | **HTTP SSE** | 預設（`isSSE: true`） |
| 3 | codex | **HTTP SSE** | 讓 proxy 拒絕 WS upgrade（`socket.destroy()`），codex 自動降級 |

第 3 次是關鍵：前兩次的 provider 與 transport **同時不同**，無法歸因。補跑後變因隔離。

## 實測結果

### 共通：兩邊都壞，壞法相同

| 欄位 | 實測值 | 應為 |
|---|---|---|
| `toolFail` | `false` | `true`（tool 確實失敗） |
| `stopReason` | `"completed"` | 需能被 weather 的 `'tool_use'` 判斷命中 |

這證實了 #470 的主張：**不是壞掉（不報錯），是沉默地說「沒失敗」。**

### 歸因：差異跟著 provider 走，不跟 transport 走

| 固定 | 變動 | response 側 tool call type | 結果 |
|---|---|---|---|
| provider = codex | WS → HTTP | `custom_tool_call` → `custom_tool_call` | **不變** |
| transport = HTTP SSE | codex → grok | `custom_tool_call` → `function_call` | **改變** |

**結論：結構差異由 provider 決定。** per-transport 分派因此被排除。

### 分歧的完整內容

| | Codex | Grok |
|---|---|---|
| **response** tool call type | `custom_tool_call` | `function_call` |
| **request** input 的 tool output type | `custom_tool_call_output` | `function_call_output`（標準） |
| `toolCalls` 抓到？ | ❌ `{}` | ✅ `{"run_terminal_command":1}` |
| `output` 格式 | **雙層 JSON** | **純文字** |
| 失敗訊號 | `"exit_code":1`（JSON 欄位） | `EXIT_CODE=1`（文字行） |
| 陷阱 | 需兩層 parse | **`output` 同時含 `exit: 0` 與 `EXIT_CODE=1`** |

### 證據摘錄（已脫敏）

**Codex** — `output` 是 JSON-in-string，內層陣列的第二個元素才含 `exit_code`：

```
{"type":"custom_tool_call_output","call_id":"call_...",
 "output":"[{\"type\":\"input_text\",\"text\":\"Script completed\\nWall time 0.1 seconds\\n...\"},
            {\"type\":\"input_text\",\"text\":\"{\\\"chunk_id\\\":\\\"...\\\",\\\"exit_code\\\":1,...}\"}]"}
```

**Grok** — `output` 是純文字，且 `exit: 0` 出現在 `EXIT_CODE=1` **之前**：

```
{"type":"function_call_output","call_id":"call-...",
 "output":"exit: 0\ncat: <path>: No such file or directory\nEXIT_CODE=1\n"}
```

## 四個缺口

| # | 缺口 | 位置 | 影響 |
|---|---|---|---|
| 1 | `toolFail` 硬編碼 `false`，從不解析 | `openai.js:334` | 兩者 |
| 2 | `stopReason` 取 `response?.status`，永不等於 `'tool_use'`/`'max_tokens'` | `openai.js:327` | 兩者 |
| 3 | `extractOpenAIToolCalls` 只認 `function_call`，不認 `custom_tool_call` | `helpers.js:806` | **Codex only** |
| 4 | `turnStepCount` 只 filter `function_call`/`function_call_output` | `openai.js:402` | **Codex only** |

缺口 3 與 4 是**獨立的兩個** —位置不同、讀的資料側不同（3 讀 response、4 讀 request input）。
對照組：`anthropic.js:112` 有真實的 `helpers.hasToolFail()`（結構化 `tool_result.is_error`）。

## 設計題是三選一

| 選項 | 內容 | 代價 |
|---|---|---|
| **A** | 只修 Codex；Grok 照 `sigCacheHealth` 模式**明確排除** | Grok 的 weather 仍不可信，但**誠實**（有痕跡說明不適用） |
| **B** | 兩者各自解析 | 範圍加倍；**必須先解決 Grok 的 `exit: 0` 歧義** |
| **C** | 統一 defensive parser（掃所有 `*_output`、找任何 exit 訊號） | **不建議** —Grok 的 `exit: 0` 會讓它靜默判成功，等於用新寫法重現同一個 bug |

**建議 B**（前提：補 Grok 樣本確認 `exit: 0` 語意）。若不願擴大範圍，**A 可接受** —
「誠實地不適用」正是 `sigCacheHealth` 已建立的模式。

## provider protocol：不需要擴充

`server/providers.js` 的 `OPENAI_WIRE_CLIENTS` 現行欄位全屬**路由/識別層**：
`id` / `upstreamKey` / `rawSessionId` / `modelPattern` / `titleGenWindowMs` /
`sessionHeaderNames` / `controlPlaneIsNoise` —沒有 wire 語意 hook。而
`extractOpenAIToolCalls(responseEventsOrOutput)`（`helpers.js:806`）**簽名不帶 client
context**，架構上無法做 per-client 分派。

原本擔心選 B 就必須擴充 protocol（否則只能加 `if (provider === 'codex')` 分支，違反
`CLAUDE.md` 的「avoid new `if (provider === …)` branches」）。**交叉實驗解除了這個顧慮**：

- 差異由 provider 決定，而 provider 與 tool `type` 名稱是**一對一**的
  （codex ⇔ `custom_tool_call*`、grok ⇔ `function_call*`）
- 因此**按 `type` 分派就等價於按 provider 分派，但不需要 client context**
- `type` 是 wire 上的事實，不是 agent 身分 → 不算 provider branch，符合既有原則
- 副效果：未來若有第三個 client 也發 `custom_tool_call*`，它自動受益

三種曾考慮的形狀，結論：

| 形狀 | 判定 |
|---|---|
| per-client 欄位（擴充 `OPENAI_WIRE_CLIENTS`） | 可行但**不必要**，且把解析邏輯放進路由註冊表是職責混合 |
| per-transport 分派 | **已被實驗排除**（codex 換 transport 結構不變） |
| **per-`type` 分派** | ✅ **建議** —不動 protocol、不需 client context、不加 provider branch |

`output` **內容**的慣例仍是 client 特有的（Grok 的 `EXIT_CODE=` 是它 CLI wrapper 產生的，
不是 OpenAI 標準），所以 per-type 分派解決「該用哪個 parser」，不解決「parser 內怎麼容錯」。
後者靠 defensive parsing，與 protocol 無關。

## 未驗證（明確標註，不假裝涵蓋）

- **grok-over-WebSocket 未測**：grok CLI 沒有 transport 選項（`--help` 無 websocket 相關），
  可能不支援 WS。因此「grok 換 transport 是否也不變」未驗證 —但 codex 那組已足以排除
  per-transport 分派。
- **`exit: 0` 語意未確定**：Grok `output` 開頭那個 `exit: 0` 可能是 shell wrapper 自身的
  exit，而非指令的。2 個樣本不足以判斷哪個權威。**選 B 前必須釐清。**
- **latency baseline 樣本不足**：codex 4 筆（elapsed 3.0 / 4.8s + HTTP 那次 2 筆）、grok 3 筆。
  遠不足以定 p75。`weather.js` 的 `MODEL_BASELINES` 缺 OpenAI/Grok 鍵需獨立收集，
  **不應照抄 `BASELINE_FALLBACK` 的 20000**。
- **只測一種失敗型態**（檔案不存在）。權限錯誤、timeout、被 sandbox 拒絕的 output 格式
  可能不同。
- **⚠️ 附帶觀察，未確認原因**：codex-over-HTTP 那次的 log **只有 `_res.json`，沒有
  `_req.json`**（WS 那次兩者都有）。若屬實，代表 HTTP 路徑的 request body 未落盤 →
  事後無法從 log 重建 `toolFail`（執行時仍有 `parsedBody`，所以不影響修復本身）。
  **n=1、未確認是否為預期行為**，需要獨立驗證才能判斷是否為缺陷。

## 對 #470 的影響

1. **主張成立** —`toolFail` 恆 false 已由三次實測證實。
2. **範圍比 body 描述的大**：多兩個 Codex 專屬缺口（3、4）、多一個 Grok 的解析陷阱。
3. **protocol 不需動** —按 `type` 分派即可（本次診斷的主要交付）。
4. **仍需 owner 選 A / B / C** —這是範圍決策，不是實作細節。

## 修正記錄

**第一版（同日）有兩處錯誤，由撰寫者自查發現：**

1. **缺口歸因錯位**：寫「`toolCalls` 缺口 = `openai.js:402` 的 filter 漏掉
   `custom_tool_call_output`」。實際上 `:402` 屬於 `turnStepCount()`（讀 request input），
   而 `toolCalls` 來自 `helpers.js:806` `extractOpenAIToolCalls()`（讀 response）。兩者是
   **獨立的兩個缺口** —照第一版實作會改錯地方。
   成因：從 `grep` 命中的單行推斷函式歸屬，未確認該行所屬函式。
2. **誤稱 WebSocket 路徑未測**：實際上 `responseMetadata.transport` 顯示 codex 走的**就是**
   WebSocket。成因：在判定 transport 前就寫下 transport 結論。

**第二版標註了「實驗設計缺陷：變因未隔離」，第三版補跑交叉組合後解除** —這是本文件
唯一靠新實驗（而非重讀程式碼）才能解決的問題，也是 protocol 結論得以成立的前提。

## 連結

- issue: #470
- 相關 ADR: `docs/decisions/0018-turn-tool-calls-null-vs-empty.md`（OpenAI entry 的
  `toolCalls` 已是 per-turn；新增 `toolFail` 解析不得改動該契約）
- 正確模式範本: `public/weather.js:137` `sigCacheHealth` 的 provider guard —
  「誠實地不適用」對比 `openai.js:334` 的「靜默假裝正常」
