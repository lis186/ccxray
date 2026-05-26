## Why

開發者在回顧 AI session 時，看得到工具呼叫的結果，但無法立即判斷這份資料的**來源性質**——來自本地檔案、外部網路、還是用戶輸入。缺乏來源標記，要識別「哪些 turn 引入了不受信任的內容」只能逐一點開細節查看。

## What Changes

- **新增 tool_result 來源分類**：根據 tool_use 的 name 將每個 tool_result 歸類為 `local`、`local:sensitive`、`network`、`user` 四種來源
- **新增 timeline step 來源 badge**：在 timeline 的每個 tool_result step 旁顯示對應的來源標記
- **新增敏感路徑偵測**：當 tool_use input 中的路徑符合已知敏感路徑清單（`~/.ssh/`、`.env`、`/etc/` 等），將 `local` 升級為 `local:sensitive`

## Capabilities

### New Capabilities

- `taint-markers`: 根據 tool_use name 與 input 分類每個 tool_result 的資料來源，在 timeline 顯示來源 badge

### Modified Capabilities

（無）

## Impact

- **server/helpers.js**：新增 `classifyToolSource(toolName, toolInput)` 純函式，回傳 `'local' | 'local:sensitive' | 'network' | 'user'`
- **server/sse-broadcast.js**：entry summary 中加入每個 tool_use 的 source 分類，存入 `toolSources` map（key: tool_use id）
- **server/restore.js**：restore 時同樣計算 `toolSources`
- **public/messages.js**：在 `renderStepListHtml()` 的 tool-group call row 顯示來源 badge
- **public/style.css**：新增四種來源 badge 樣式
- 不影響 proxy 流程、不改寫任何送往 Anthropic 的內容
