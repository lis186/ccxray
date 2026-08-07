# OpenAI-wire tool 失敗訊號：Codex 與 Grok 的實測結構差異 (#470)

> **這是診斷記錄，不是 spec。** 所有數據來自 2026-08-07 的隔離環境實測（獨立 port、
> 獨立 `CCXRAY_HOME`），不是推論。
>
> **⚠️ 本文件第一版有兩處錯誤，已於同日修正**（見「修正記錄」）：缺口歸因錯位、
> 以及誤稱 WebSocket 路徑未測。修正後的結論方向不變，但**多找到一個缺口**，並暴露
> 一個**實驗設計缺陷**（provider 與 transport 兩個變因同時變動，無法歸因）。

## 為什麼需要這份診斷

#470 要修 `server/wire-parsers/openai.js` 的 `toolFail: false` 硬編碼。但實作前卡在一個
設計題：**OpenAI wire 有沒有 tool 失敗的等價訊號？**

- 若**無** → 只能照 `public/weather.js:137` `sigCacheHealth` 的 provider guard 明確排除
- 若**有** → 映射它

判斷所需的資料（真實 tool 失敗的 wire 記錄）原本只存在於開發者的活 hub，而 pipeline 硬規則
禁止讀取它。因此改用隔離環境**產生新資料**，而不是讀既有資料。

## 方法

1. 起獨立 ccxray（自訂 port、獨立 `CCXRAY_HOME`、`CCXRAY_IMPORT_DISABLE=1`）
2. 真實 CLI 經該 proxy，故意觸發一次 tool 失敗（`cat` 一個不存在的檔案）
3. 兩個 provider 各跑一次：**codex**（ChatGPT auth, `gpt-5.6-sol`）、**grok**（`grok-4.5-build`）
4. 逐欄位檢視 `index.ndjson`、`_req.json`、`_res.json`

兩次都確認 tool **真的執行且真的失敗**（`cat: ...: No such file or directory`, exit 1）。

### ⚠️ 實驗設計缺陷：兩個變因同時變動

事後從 `responseMetadata` 判定 transport 時才發現：

| | provider | transport |
|---|---|---|
| 第一次 | codex | **WebSocket**（`transport:"websocket"`, endpoint `/v1/responses`） |
| 第二次 | grok | **HTTP SSE**（`isSSE: true`） |

**因此本次觀察到的結構差異，無法歸因於 provider 還是 transport。** 要區分需要補跑交叉
組合（codex 走 HTTP、或 grok 走 WS）。這直接影響下方選項的抽象層級選擇 —
「per-client 分派」與「per-transport 分派」哪個才是正確切面，目前**沒有證據可判**。

## 實測結果

### 共通：兩邊都壞，壞法相同

| 欄位 | 實測值 | 應為 |
|---|---|---|
| `toolFail` | `false` | `true`（tool 確實失敗） |
| `stopReason` | `"completed"` | 需能被 weather 的 `'tool_use'` 判斷命中 |

這證實了 #470 的主張：**不是壞掉（不報錯），是沉默地說「沒失敗」。**

### 分歧：tool 相關結構完全不同

| | Codex (WS) | Grok (HTTP SSE) |
|---|---|---|
| **request** input 的 tool output type | `custom_tool_call_output` | `function_call_output`（標準） |
| **response** 的 tool call type | `custom_tool_call`（`output_item.done` 的 `item.type`） | `function_call` |
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

## 四個缺口（修正後）

### 1. `toolFail` 硬編碼 —兩者皆受影響

`server/wire-parsers/openai.js:334` 是常數 `false`，從不解析。對照
`server/wire-parsers/anthropic.js:112` 有真實的 `helpers.hasToolFail()`。

### 2. `stopReason` 永不匹配 —兩者皆受影響

`openai.js:327` 取 `response?.status`（值為 `completed`/`incomplete`），永遠不等於
weather 需要的 `'tool_use'` 或 `'max_tokens'`。

### 3. `extractOpenAIToolCalls` 不認 `custom_tool_call` —**只影響 Codex**

`server/helpers.js:806` 掃 response 側的 output/events，只認 `function_call`。Codex 的
tool call 在 `response.output_item.done` 的 `item.type === 'custom_tool_call'`，因此
`toolCalls` 恆為 `{}`。Grok 用標準 `function_call` 所以正常。

### 4. `turnStepCount` 不認 `custom_tool_call_output` —**只影響 Codex**（第一版遺漏）

`openai.js:402`（函式 `turnStepCount`）只 filter `function_call` /
`function_call_output`，所以 Codex 的 turn step 數被低估。**這是與缺口 3 獨立的第二個
Codex 專屬缺口** —兩者位置不同、讀的資料側不同（3 讀 response，4 讀 request input）。

## 因此設計題是三選一，不是 A/B

| 選項 | 內容 | 代價 |
|---|---|---|
| **A** | 只修 Codex；Grok 照 `sigCacheHealth` 模式**明確排除** | Grok 的 weather 仍不可信，但**誠實**（有痕跡說明不適用） |
| **B** | 兩者各自 parser | 範圍加倍；且**必須先解決 Grok 的 `exit: 0` 歧義**；**且需先確認分派切面是 provider 還是 transport**（見實驗設計缺陷） |
| **C** | 統一 defensive parser（掃所有 `*_output` type、找任何 exit 訊號） | **風險最高** —Grok 的 `exit: 0` 會讓它靜默判成功，等於用新寫法重現同一個 bug |

**建議 B**，但有兩個前置：補 Grok 樣本確認 `exit: 0` 語意、補交叉組合確認分派切面。
若不願擴大 #470 範圍，**A 是可接受的** —它至少不騙人，而「誠實地不適用」正是
`sigCacheHealth` 已建立的模式。

**C 不建議**：它看起來最完整，但會把一個已知的解析歧義變成靜默的錯誤判定。

## 對 provider protocol 的影響（需要 owner 決定）

`server/providers.js` 的 `OPENAI_WIRE_CLIENTS` 現行欄位全部屬於**路由/識別層**：
`id` / `upstreamKey` / `rawSessionId` / `modelPattern` / `titleGenWindowMs` /
`sessionHeaderNames` / `controlPlaneIsNoise`。**沒有任何 wire 語意 hook。**

而 `extractOpenAIToolCalls(responseEventsOrOutput)`（`helpers.js:806`）的簽名**只有一個
參數，不帶 client context** —所以它目前在架構上無法做 per-client 分派。

`CLAUDE.md` 的既有意圖是「reuse `wire-parsers/openai.js`；do not fork a new parser per
agent」、且「avoid new `if (provider === …)` branches」。本次診斷顯示**該意圖在 tool
語意層不成立**：兩個 client 的 tool type 與 output 編碼確實不同。

選 B 就必須擴充 protocol（否則只能加 `if (provider === 'codex')` 分支，違反既有原則）。
擴充形狀取決於上述未解的分派切面問題 —**若差異其實來自 transport，per-client 欄位
就是錯的抽象**。選 A 則不需要動 protocol。

## 未驗證（明確標註，不假裝涵蓋）

- **交叉組合未測**：codex-over-HTTP 與 grok-over-WS 都沒跑，因此 provider 與 transport
  的貢獻無法分離（見實驗設計缺陷）。
- **`exit: 0` 語意未確定**：Grok 的 `output` 開頭那個 `exit: 0` 可能是 shell wrapper 自身
  的 exit，而非指令的。2 個樣本不足以判斷哪個權威。
- **latency baseline 樣本不足**：codex 2 筆（elapsed 3.0s / 4.8s）、grok 3 筆。遠不足以
  定 p75。`weather.js` 的 `MODEL_BASELINES` 缺 OpenAI/Grok 鍵需要獨立收集樣本，
  **不應照抄 `BASELINE_FALLBACK` 的 20000**。
- **只測一種失敗型態**（檔案不存在）。權限錯誤、timeout、被 sandbox 拒絕等其他失敗的
  output 格式可能不同。

## 對 #470 的影響

1. **主張成立** —`toolFail` 恆 false 已由實測證實，不再是推論。
2. **範圍比 body 描述的大**：多兩個 Codex 專屬缺口（缺口 3、4）、多一個 Grok 的解析
   陷阱、以及一個 protocol 層的擴充問題。
3. **需要 owner 選 A / B / C 才能派工實作** —這是設計決策，不是實作細節。

## 修正記錄

**2026-08-07 第一版的兩處錯誤**（由撰寫者自查發現，修正於同日）：

1. **缺口歸因錯位**：第一版寫「`toolCalls` 缺口 = `openai.js:402` 的 filter 漏掉
   `custom_tool_call_output`」。實際上 `:402` 屬於 `turnStepCount()`（讀 request input），
   而 `toolCalls` 來自 `helpers.js:806` `extractOpenAIToolCalls()`（讀 response）。
   兩者是**獨立的兩個缺口**，第一版把它們混為一個並指向錯的位置 —照它實作會改錯地方。
2. **誤稱 WebSocket 路徑未測**：第一版標註「本次兩者都走 HTTP，WS 未測」。實際上
   `responseMetadata` 顯示 codex 走的**就是 WebSocket**，grok 走 HTTP SSE。真正未測的是
   交叉組合，而這暴露了變因未隔離的實驗設計缺陷。

兩處錯誤的共同成因：從 `grep` 命中的單行推斷函式歸屬，未確認該行所屬的函式；以及在
判定 transport 前就寫下 transport 結論。

## 連結

- issue: #470
- 相關 ADR: `docs/decisions/0018-turn-tool-calls-null-vs-empty.md`（OpenAI entry 的
  `toolCalls` 已是 per-turn；新增 `toolFail` 解析不得改動該契約）
- 正確模式範本: `public/weather.js:137` `sigCacheHealth` 的 provider guard —
  「誠實地不適用」對比 `openai.js:334` 的「靜默假裝正常」
