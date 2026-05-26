## Context

ccxray 在 API layer 能看到每個 `tool_use` 的 `name` 和 `input`，以及對應的 `tool_result`。目前這些資訊只用於計算 tool call 數量與顯示結果內容，沒有做任何來源分類。

`classifyToolSource` 的核心邏輯是：用 tool name 做第一層分類（網路 vs 本地），再用 tool input 做第二層升級（本地 → 敏感）。分類規則需要明確的清單，不能依賴 LLM 判斷。

## Goals / Non-Goals

**Goals:**
- 純展示層功能，不影響 proxy 流程
- 單一純函式 `classifyToolSource` 負責所有分類邏輯，測試友好
- Badge 顯示在 timeline step 旁，不破壞現有 layout
- 敏感路徑清單直接參考 MCP Defender 的 `file-path-validator.js`

**Non-Goals:**
- 不自動 block 任何請求
- 不分析 tool_result 的內容（只看 tool_use 的 name 和 input）
- 不做跨 turn 資料流追蹤（那是 capability-profile 的工作）
- 不支援動態新增分類規則

## Decisions

### 1. 分類依據：tool name 而非 tool result 內容

**選擇**：依 tool_use 的 `name` 分類，而非分析 tool_result 的文字內容。

**理由**：tool name 是結構化資料，分類規則穩定、可測試。分析 result 內容需要語意判斷，誤報率高且難以維護。

**Alternatives**：分析 result 裡的 URL pattern 或路徑 → 複雜且不可靠。

---

### 2. 四種來源類型

```
local           — 本地檔案、git、shell（Read, Edit, Bash, Glob, Grep, Write...）
local:sensitive — local + input 含敏感路徑（~/.ssh/, .env, /etc/ 等）
network         — 外部 HTTP/網路（WebFetch, WebSearch, mcp__*__fetch...）
user            — 用戶直接輸入（無對應 tool，標記在 user message 層）
```

`user` 類型在此 change 暫不實作（需要不同的顯示位置），留給 capability-profile。

---

### 3. 敏感路徑清單的維護方式

在 `helpers.js` 定義為靜態陣列常數 `SENSITIVE_PATH_PATTERNS`，與 `CREDENTIAL_PATTERNS` 並列。不做動態載入，不支援用戶自訂（避免複雜度）。

初始清單（參考 MCP Defender）：
- `~/.ssh/`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `authorized_keys`, `known_hosts`
- `.env`, `/.env`
- `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`

---

### 4. toolSources 的儲存位置

entry summary（`sse-broadcast.js` 計算後送往 client）中加入 `toolSources` 物件：

```js
toolSources: {
  [toolUseId]: 'local' | 'local:sensitive' | 'network'
}
```

key 為 tool_use 的 `id`（已存在於 messages），client 端在 render tool-group 時對照此 map 取得 badge 類型。

**Alternatives**：在 client 端重新計算 → 需要 client 也維護分類規則，邏輯分散。

---

### 5. Badge 視覺設計

沿用 credential-scanning 的 badge 風格，在 tool call row 的右側加小標籤：

```
✓ Read          [local]
✓ WebFetch      [network]
✓ Read          [local:sensitive]
```

`local` 無特殊顏色（中性）；`local:sensitive` 橘色（與 cred-badge 一致）；`network` 藍色。

## Risks / Trade-offs

**Tool name 清單需要維護** → 新的 MCP tool 出現時，預設歸類為 `local`（保守）。`network` 必須明確列出，避免誤判。

**MCP tool name 格式多樣** → `mcp__server__tool` 格式的 network tool 用前綴匹配（`WebFetch`, `WebSearch`, `mcp__*__fetch`, `mcp__*__search` 等），需要定期審視。

**tool_use id 在 messages 中的可靠性** → Claude API 保證每個 tool_use 有唯一 id，tool_result 的 `tool_use_id` 對應之，這個 mapping 是穩定的。
