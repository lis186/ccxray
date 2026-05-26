## 1. Server：分類邏輯

- [x] 1.1 在 `server/helpers.js` 新增 `SENSITIVE_PATH_PATTERNS` 常數陣列（參考 design.md 的敏感路徑清單）
- [x] 1.2 在 `server/helpers.js` 新增 `NETWORK_TOOL_NAMES` Set 與 `NETWORK_TOOL_SUFFIXES` 陣列（WebFetch、WebSearch、mcp__*__fetch 等）
- [x] 1.3 在 `server/helpers.js` 新增 `classifyToolSource(toolName, toolInput)` 純函式，回傳 `'local' | 'local:sensitive' | 'network'`
- [x] 1.4 在 `test/helpers.test.js` 新增 `classifyToolSource` 的單元測試（network、local:sensitive、local、unknown tool 四個 case）

## 2. Server：entry summary 整合

- [x] 2.1 在 `server/helpers.js` 新增 `buildToolSources(entry)` 函式，遍歷 messages 中所有 assistant tool_use block，回傳 `{ [id]: source }` map
- [x] 2.2 在 `server/sse-broadcast.js` 的 entry summary 中加入 `toolSources: buildToolSources(entry)`
- [x] 2.3 在 `server/restore.js` 的 restore summary 中加入相同的 `toolSources` 計算

## 3. Client：Badge 樣式

- [x] 3.1 在 `public/style.css` 新增 `.source-badge`、`.source-local`、`.source-local-sensitive`、`.source-network` 樣式（參考 design.md 的顏色規格）

## 4. Client：Timeline 顯示

- [x] 4.1 在 `public/messages.js` 新增 `sourceLabel(source)` 輔助函式，回傳對應 badge HTML
- [x] 4.2 在 `renderStepListHtml()` 的 tool-group call row，從 entry 的 `toolSources` 取得對應來源，插入 badge

## 5. 驗證

- [x] 5.1 手動測試：讓 Claude 呼叫 `WebFetch`，確認 timeline 顯示藍色 `[network]` badge
- [x] 5.2 手動測試：讓 Claude 讀 `.env` 或 `~/.ssh/config`，確認顯示橘色 `[local:sensitive]` badge
- [x] 5.3 手動測試：讓 Claude 讀一般檔案，確認顯示灰色 `[local]`
- [x] 5.4 手動測試：重啟 ccxray，確認 restore 後的歷史 entry 也有正確 badge
