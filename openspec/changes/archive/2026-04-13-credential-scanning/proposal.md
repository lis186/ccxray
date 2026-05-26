## Why

開發者在事後回顧 AI session 時，無法快速識別哪些 turn 涉及敏感資料（API key、SSH key、`.env` 內容）。目前的 dashboard 沒有任何 credential 信號，用戶必須逐一點開每個 turn 才能發現問題。

## What Changes

- **新增 server 端 credential 掃描**：在 `sse-broadcast.js` 的 entry summary 中加入 `hasCredential` flag，掃描 assistant text blocks 與 tool_result 內容
- **新增 turns column badge**：當 `hasCredential` 為 true 時，在 turn row 顯示 `⚠ cred` 橘色 badge
- **新增 detail view highlight**：在 assistant-text step 和 tool-group result 的 detail 渲染中，對符合 pattern 的字串套用橘色 highlight
- **補上 restore 路徑**：`restore.js` 在從磁碟載入歷史 entry 時，同樣計算 `hasCredential`

## Capabilities

### New Capabilities
- `credential-scanning`: 掃描 assistant text blocks 與 tool_result 中的 credential pattern，在 turns column 顯示 badge、在 detail view 顯示 inline highlight

### Modified Capabilities

（無）

## Impact

- **server/sse-broadcast.js**：summarize 時加入 credential 掃描
- **server/restore.js**：restore summary 時加入 credential 掃描
- **public/entry-rendering.js**：`addEntry()` 讀取 `hasCredential` 渲染 badge
- **public/messages.js**：`renderStepDetailHtml()` 中 assistant-text 和 tool-group detail 加入 highlight
- **public/style.css**：新增 `.cred-badge` 和 `.cred-highlight` 樣式
- 不影響 proxy 流程、不改寫任何送往 Anthropic 的內容
