## 1. Server：掃描邏輯

- [x] 1.1 在 `server/helpers.js` 新增 `scanCredentials(text)` 純函式，回傳 `boolean`，涵蓋 5 個 credential pattern
- [x] 1.2 在 `server/helpers.js` 新增 `entryHasCredential(entry)` 函式，遍歷 entry 的 assistant text blocks 和 tool_result content
- [x] 1.3 在 `sse-broadcast.js` 的 entry summary 中加入 `hasCredential: entryHasCredential(entry)`
- [x] 1.4 在 `server/restore.js` 的 restore summary 中加入相同的 `hasCredential` 計算

## 2. Client：Turns column badge

- [x] 2.1 在 `public/style.css` 新增 `.cred-badge` 樣式（橘色底色，與 `.dupe-badge` 風格一致）
- [x] 2.2 在 `public/entry-rendering.js` 的 `addEntry()` 中，依據 `e.hasCredential` 渲染 `credBadge`，插入 `turn-line2`

## 3. Client：Detail view highlight

- [x] 3.1 在 `public/messages.js` 新增 `highlightCredentials(text)` 函式，回傳 HTML string（escapeHtml 後對 match 套用 `<span class="cred-highlight">...</span>`）
- [x] 3.2 在 `public/style.css` 新增 `.cred-highlight` 樣式（橘色底色 inline）
- [x] 3.3 在 `renderStepDetailHtml()` 的 `assistant-text` 分支，將 `escapeHtml(step.text)` 換成 `highlightCredentials(step.text)`
- [x] 3.4 在 `renderToolDetail()` 的 result 區塊，對 result content 套用 `highlightCredentials()`

## 5. Client：Timeline step-level badge

- [x] 5.1 在 `public/messages.js` 新增 `hasCredential(text)` 和 `callHasCredential(c)` 輔助函式（掃描 `c.result` 字串或陣列）
- [x] 5.2 在 `renderStepListHtml()` 的 tool-group call row，於 `✓`/`✗` 後插入 `<span class="cred-badge">⚠ cred</span>`（當 `callHasCredential(c)` 為 true）
- [x] 5.3 在 `renderStepListHtml()` 的 `assistant-text` 分支，於預覽文字後插入同樣的 badge（當 `hasCredential(step.text)` 為 true）

## 4. 驗證

- [x] 4.1 手動測試：讓 Claude 讀一個含有假 API key 的檔案，確認 turns column badge 出現
- [x] 4.2 手動測試：點入 turn，確認 detail view 有 inline highlight
- [x] 4.3 手動測試：重啟 ccxray，確認 restore 後的歷史 entry 也有 badge
- [x] 4.4 確認不含 credential 的 turn 沒有誤報 badge
