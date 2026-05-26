## Context

ccxray 是透明 HTTP proxy，captures 每個 Claude API request/response 並透過 SSE 推送到 dashboard。Entry 的生命週期分兩條路：

1. **Live path**：`forward.js` 捕捉 SSE response → `sse-broadcast.js` 組成 summary → 透過 SSE 推到 client → `addEntry()` 渲染
2. **Restore path**：啟動時 `restore.js` 從 `~/.ccxray/logs/` 讀取 JSONL → 同樣推到 client → `addEntry()` 渲染

SSE summary 是輕量摘要，不含完整 messages。Client 用 `prefetchEntry()` lazy-load 完整 req/res。因此 turns column 的 badge 資料必須在 server 端預算並放入 summary，否則 client 在 `addEntry()` 時沒有資料可渲染。

現有類似機制：`duplicateToolCalls` 也是在 `sse-broadcast.js` 預算後隨 summary 傳出，turns column 直接用。

## Goals / Non-Goals

**Goals:**
- 讓開發者在 turns column 一眼看出哪個 turn 含有 credential
- 在 detail view 裡 inline highlight 具體的 credential 字串
- 涵蓋 live 和 restore 兩條路徑
- 不影響 proxy 流程，不改寫任何送往 Anthropic 的內容

**Non-Goals:**
- 自動 block 或 redact credential
- 跨 session 的統計彙總（獨立功能）
- LLM-as-judge 語意掃描
- 掃描 system prompt 或 user message（非 assistant output）

## Decisions

### 掃描位置：server 預算 vs client lazy

**決定：server 預算（`sse-broadcast.js` + `restore.js`）**

替代方案：client lazy scan（prefetch 後才掃）。

拒絕理由：
- SSE summary 不含完整 messages，client 在 `addEntry()` 時沒有資料
- Lazy scan 意味著 badge 要等用戶 hover 或點擊才出現，違反 visibility 原則
- Restore path 的 entry 需要和 live entry 行為一致

### 掃描範圍：assistant text + tool_result

**決定：掃 assistant text blocks 和 tool_result content**

理由：
- assistant text：Claude 說出口的 credential，是洩漏的直接證據
- tool_result：Claude 讀取的內容（如 `.env`），credential 流進上下文是風險前驅

不掃 user message 和 system prompt：這些是用戶主動輸入的，不屬於「AI session 裡意外出現 credential」的情境。

### Credential patterns

初始實作涵蓋高 precision 的 pattern，避免誤報：

| Pattern | 範例 |
|---------|------|
| `sk-ant-[a-zA-Z0-9]{20,}` | Anthropic API key |
| `sk-[a-zA-Z0-9]{20,}` | OpenAI-style API key |
| `ghp_[a-zA-Z0-9]{36}` | GitHub Personal Access Token |
| `AKIA[0-9A-Z]{16}` | AWS Access Key ID |
| `-----BEGIN (RSA\|EC\|OPENSSH) PRIVATE KEY-----` | SSH private key |

不用通用 pattern（如 `password=`、`secret=`），因為誤報率高，會降低信噪比。

### 資料結構：boolean flag vs rich metadata

**決定：boolean `hasCredential` 用於 badge，不在 summary 裡存 match 詳情**

Detail view 的 highlight 在 render time 用同一組 regex 掃 step.text，不依賴 summary 的 match 位置。理由：
- Match 位置在完整 req/res 載入後才有意義
- Summary 保持輕量，不膨脹 SSE payload

### 共用掃描邏輯

`scanCredentials(text)` 抽成獨立函式，在 `sse-broadcast.js` 和 `restore.js` 各呼叫一次，確保兩條路徑行為一致。放在 `server/helpers.js` 或新增 `server/credential-scanner.js`。

## Risks / Trade-offs

- **誤報** → 使用高 precision pattern，初期寧可漏報也不誤報，可後續迭代擴充
- **效能** → Regex 掃描是 O(n) 字串操作，在 SSE capture 之後執行，影響可忽略
- **Restore 路徑缺失** → 如果只改 sse-broadcast 忘記 restore.js，歷史資料沒有 badge；tasks 需明確列出兩個改動點
