## 1. Server — Title Fallback Logic

- [x] 1.1 在 `server/helpers.js` 新增 `extractLastUserText(req)`：從 request messages 找最後一條 user message 的 `type:"text"` block，忽略 `tool_result` 與 XML/system 片段，回傳拼接後的純文字；無文字回傳 null
- [x] 1.2 在 `server/helpers.js` 新增 `extractToolResultSummary(req)`：掃 last user message 的 `tool_result` blocks，收集對應 `tool_use` 的工具名、去重、保留首次出現順序、最多 5 個，超過則附 `+N`，格式 `↩ ToolA · ToolB`；無有效工具回傳 null
- [x] 1.3 在 `server/helpers.js` 新增 `extractFirstUserText(req)`：取第一條 user message 的純 text block 內容，供 subagent 使用；忽略結構化 content
- [x] 1.4 在 `server/forward.js` 實作 Main title cascade：非 subagent 走 response → `extractLastUserText` → `extractToolResultSummary` 三段
- [x] 1.5 在 `server/forward.js` 實作 Subagent title path：`isSubagent=true` 直接用 `extractFirstUserText`，不走 cascade
- [x] 1.6 Title falsy 時統一設為 `null` 存入 entry；確保下游判斷一致

## 2. Server — Risk Signals (toolFail) & Entry Schema

- [x] 2.1 在 `server/helpers.js` 新增 `hasToolFail(req)`：掃 request messages 的 `tool_result` blocks 找 `is_error: true`
- [x] 2.2 在 `server/forward.js` 計算 `toolFail` 並存入 entry（兩條 return path：SSE 與 non-SSE）
- [x] 2.3 在 `server/sse-broadcast.js` 的 `summarizeEntry` 加入 `toolFail`，用 `|| false` 防守舊資料
- [x] 2.4 驗證 `duplicateToolCalls` 已 propagate 到 summary（既有，僅檢查，不需改）
- [x] 2.5 新增 `docs/data-model.md`，完整列出 entry summary 欄位（包含 `toolFail` 在內共 20 欄位）

## 3. Server — Tests

- [x] 3.1 在 `test/helpers.test.js` 加 `extractLastUserText` 測試：純文字、tool_result only、混合 content、空 messages
- [x] 3.2 在 `test/helpers.test.js` 加 `extractToolResultSummary` 測試：單工具、重複去重、超過 5 個 overflow、無工具
- [x] 3.3 在 `test/helpers.test.js` 加 `extractFirstUserText` 測試：純文字、無 text block、多 block 取第一段 text
- [x] 3.4 在 `test/helpers.test.js` 加 `hasToolFail` 測試：`is_error: true` / `false` / `undefined` / 無 tool_result

## 4. Client — Turn Card DOM 結構

- [x] 4.1 在 `public/entry-rendering.js` 將 `el.innerHTML` 字串改為五層 DOM 容器建構：`.turn-identity` / `.turn-title` / `.turn-ctx` / `.turn-risk` / `.turn-secondary`
- [x] 4.2 資料綁定邏輯集中到 render helper：各層負責從 entry 讀取欄位，無資料時該層不 append
- [x] 4.3 Title layer：`entry.title` 為 null/空字串 → 完全不 render `.turn-title`（避免空行）
- [x] 4.4 Identity line：HTTP status 改為 `<span class="status-dot">●</span>`（class 控色），`stopReason === 'end_turn'` 時附 `↵`
- [x] 4.5 Identity line：`compact` 與 `inferred` 改掛原生 `title` 屬性於整個 `.turn-identity` 元素（格式：`compact · inferred`，無則不設），移除既有 `compactBadge` / `inferredBadge` 文字
- [x] 4.6 明確移除既有 UI 元素：`stopReason` 純文字（L344）、`40%♻` overhead（L347）、badge span 字串；用 grep 確認無殘留
- [x] 4.7 Client 舊資料相容：`e.toolFail ?? false`、`e.duplicateToolCalls ?? null`、`e.hasCredential ?? false` 處處以防守值讀取

## 5. Client — Risk Line

- [x] 5.1 Risk line：有任一風險（cred / tool-fail / dupes / max_tokens）才 append `.turn-risk` 層，否則整層不存在
- [x] 5.2 Badges：`⚠ cred`（既有）、`⚠ tool-fail`（新）、`⚠ dupes`（遷移既有 dupeBadge 至此層）、`⚠ max_tokens`（stopReason 判斷，新）
- [x] 5.3 每個 badge 掛對應 `title` tooltip 說明原因與細節（dupes 列出重複工具）

## 6. Client — Secondary Line

- [x] 6.1 Secondary line 格式：`⏸Xs→Ys · ↩ ToolA · ToolB +N · $0.05`，段落以 `·` 分隔
- [x] 6.2 無上一筆 turn → 省略 gap，只顯示 `Ys`
- [x] 6.3 Gap 顏色邏輯保留（< 5m 綠 / 5m–1h 黃 / > 1h 紅）
- [x] 6.4 工具清單從 `entry.toolCalls` 取，最多 5 個，剩餘標 `+N`
- [x] 6.5 無費用或無工具段落自動省略，不留多餘 `·`

## 7. Client — CSS

- [x] 7.1 在 `public/style.css` 定義 `.turn-identity`、`.turn-title`、`.turn-ctx`、`.turn-risk`、`.turn-secondary` 的 layout（flex / gap / font-size）
- [x] 7.2 新增 `.tool-fail-badge`、`.max-tokens-badge`，複用 `.cred-badge` 的色彩 pattern（紅 / 橙系）
- [x] 7.3 `.status-dot` 樣式：`.status-ok`（綠）/ `.status-err`（紅），小圓 ~8px
- [x] 7.4 確認有 / 無 `.turn-risk` 兩種情況下 margin / padding 都正確，不塌陷

## 8. 整合驗證

- [x] 8.1 `npm test` 通過
- [x] 8.2 `node --check server/helpers.js server/forward.js server/sse-broadcast.js` 語法檢查
- [x] 8.3 跑一次完整 session（包含 main turn + subagent + tool error + 切 model + 高 context），確認五層 UI 各 state 正確
- [x] 8.4 對照 screenshot：確認每個 turn 都有 title（含 tool-only turn 顯示觸發訊息）、風險 badge 正確顯示、tooltip 可觸發
