# OpenAI-wire tool 失敗訊號：Codex 與 Grok 的實測結構差異 (#470)

> **這是診斷記錄，不是 spec。** 目的是解除 #470 實作前的一個設計題。所有數據來自
> 2026-08-07 的隔離環境實測（獨立 port、獨立 `CCXRAY_HOME`），不是推論。
> 結論：**設計題不是 A/B，而是三選一，而且需要 owner 決定才能派工實作。**

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
4. 逐欄位檢視 `index.ndjson` 與 `_req.json`

兩次都確認 tool **真的執行且真的失敗**（`cat: ...: No such file or directory`, exit 1）。

## 實測結果

### 共通：兩個 provider 都壞，而且壞法相同

| 欄位 | 實測值 | 應為 |
|---|---|---|
| `toolFail` | `false` | `true`（tool 確實失敗） |
| `stopReason` | `"completed"` | 需能被 weather 的 `'tool_use'` 判斷命中 |

這證實了 #470 的主張：**不是壞掉（不報錯），是沉默地說「沒失敗」。**

### 分歧：兩者的 tool output 結構完全不同（決定性發現）

| | Codex | Grok |
|---|---|---|
| tool output type | `custom_tool_call_output` | `function_call_output`（標準） |
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

## 三個發現

### 1. `toolCalls` 缺口只影響 Codex（修正 #470 的範圍認知）

`openai.js:402` 只 filter `function_call` / `function_call_output`。Grok 用標準 type 所以
命中（`toolCalls` 有值）；Codex 用 `custom_tool_call_output` 所以被完全漏掉（`toolCalls`
是 `{}`）。**#470 body 沒提到這個缺口** —它是這次診斷才發現的。

### 2. 失敗訊號確實存在，但不是一個統一欄位

所以「只能明確排除」（原本的選項 A）**不是必要的**。但訊號在兩個 provider 是不同來源、
不同格式，因此需要 per-client 解析，不能靠單一 parser。

對照 Anthropic：`helpers.js:660` 用結構化 boolean `tool_result.is_error === true`。
OpenAI 側沒有等價的頂層 flag，但有更豐富的資訊（實際 exit code 數字）。

### 3. ⚠️ Grok 的 `output` 有順序陷阱

`exit: 0` 出現在 `EXIT_CODE=1` 之前。**任何用「第一個 exit 值」的 regex 都會判定成功** —
這會產生和目前 `toolFail: false` 一樣的靜默錯誤，只是換了個實作方式。

**2 個樣本不足以確定 `exit: 0` 的語意**（可能是 shell wrapper 自身的 exit，而非指令的）。
實作前需要更多樣本確認哪一個才是權威訊號。

## 因此設計題是三選一，不是 A/B

| 選項 | 內容 | 代價 |
|---|---|---|
| **A** | 只修 Codex；Grok 照 `sigCacheHealth` 模式**明確排除** | Grok 的 weather 仍不可信，但**誠實**（有痕跡說明不適用） |
| **B** | 兩者各自 parser | 範圍加倍；且**必須先解決 Grok 的 `exit: 0` 歧義** |
| **C** | 統一 defensive parser（掃所有 `*_output` type、找任何 exit 訊號） | **風險最高** —Grok 的 `exit: 0` 會讓它靜默判成功，等於用新寫法重現同一個 bug |

**建議 B，但先補 Grok 樣本**確認 `exit: 0` 語意。若不願擴大 #470 範圍，**A 是可接受的** —
它至少不騙人，而「誠實地不適用」正是 `sigCacheHealth` 已經建立的模式。

**C 不建議**：它看起來最完整，但會把一個已知的解析歧義變成靜默的錯誤判定。

## 未驗證（明確標註，不假裝涵蓋）

- **WebSocket 路徑未測**。本次兩者都是非互動模式（`codex exec` / `grok -p`）→ HTTP。
  `CLAUDE.md` 記載互動式 codex 的主流量會 upgrade 成 WebSocket（`POST /v1/responses`
  帶 `openai-beta: responses_websockets=*`），其 input 結構可能不同。**只修 HTTP 路徑
  可能只修一半。**
- **latency baseline 樣本不足**。codex 2 筆（elapsed 3.0s / 4.8s）、grok 3 筆。遠不足以
  定 p75。`weather.js` 的 `MODEL_BASELINES` 缺 OpenAI/Grok 鍵這件事需要獨立收集樣本，
  **不應照抄 `BASELINE_FALLBACK` 的 20000**。
- **Grok 的 `exit: 0` 語意未確定**（見發現 3）。
- **只測了一種失敗型態**（檔案不存在）。權限錯誤、timeout、被 sandbox 拒絕等其他失敗
  的 output 格式可能不同。

## 對 #470 的影響

1. **主張成立** —`toolFail` 恆 false 已由實測證實，不再是推論。
2. **範圍比 body 描述的大**：多一個 Codex 專屬的 `toolCalls` 缺口（發現 1）、多一個 Grok
   的解析陷阱（發現 3）。
3. **需要 owner 選 A / B / C 才能派工實作** —這是設計決策，不是實作細節。

## 連結

- issue: #470
- 相關 ADR: `docs/decisions/0018-turn-tool-calls-null-vs-empty.md`（OpenAI entry 的
  `toolCalls` 已是 per-turn；新增 `toolFail` 解析不得改動該契約）
- 正確模式範本: `public/weather.js:137` `sigCacheHealth` 的 provider guard —
  「誠實地不適用」對比 `openai.js:334` 的「靜默假裝正常」
