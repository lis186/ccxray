## 1. server/index.js — 傳遞 coreHash 給 forward

- [x] 1.1 在版本偵測 block（`if (liveVer && b2.length >= 500)`）之前先計算 `coreHash`，讓 block 內外都能使用
- [x] 1.2 將 `coreHash` 加進 `ctx` 物件（和 `sysHash`、`toolsHash` 並排）

## 2. server/forward.js — SSE path entry 新增兩欄位

- [x] 2.1 在 SSE path entry 物件加入 `coreHash: ctx.coreHash || null`
- [x] 2.2 在 SSE path entry 物件加入 `thinkingStripped` 計算邏輯：找同 session 前一個 non-subagent entry，若其 `thinkingDuration > 0` 且當前 messages 無 thinking blocks 且未發生 compaction（msgCount drop ≤ 4）→ `true`，否則 `undefined`
- [x] 2.3 將兩個欄位同步寫入 SSE path 的 `indexLine`（`coreHash`、`thinkingStripped`）

## 3. server/forward.js — non-SSE path 同步

- [x] 3.1 在 non-SSE path entry 物件同步加入 `coreHash`、`thinkingStripped`（與 Task 2 完全一致）
- [x] 3.2 將兩個欄位同步寫入 non-SSE path 的 `indexLine`
- [x] 3.3 抽出共用 helper `computeThinkingStripped()` 避免兩條路徑 copy-paste

## 4. server/sse-broadcast.js — summarizeEntry 暴露兩個欄位給 client

- [x] 4.1 在 `summarizeEntry()` 加入 `coreHash: entry.coreHash || null`
- [x] 4.2 在 `summarizeEntry()` 加入 `thinkingStripped: entry.thinkingStripped || false`

## 5. public/entry-rendering.js — turn card 顯示兩個信號

- [x] 5.1 在 `allEntries.push(...)` 的物件加入 `coreHash: e.coreHash || null`、`thinkingStripped: e.thinkingStripped || false`
- [x] 5.2 在 risk markers 邏輯加入 `sys-changed`：查找同 session 前一個 non-subagent entry 的 `coreHash`，若不同且兩者都非 null → push `sys-changed`
- [x] 5.3 在 risk markers 邏輯加入 `thinking-stripped`：`e.thinkingStripped === true` → push `thinking-stripped`

## 6. public/miller-columns.js — 修 cc_version regex bug

- [x] 6.1 將 `/cc_version=(S+?)[; ]/` 改為 `/cc_version=(\S+?)[; ]/`（加上反斜線）

## 7. 驗證

- [x] 7.1 啟動兩個連續 session（不同 cc_version），確認第二個 session 的 turn card risk line 出現 `sys-changed`
- [x] 7.2 確認 restart 後 restore 的 entries 仍有兩個新欄位（從 index.ndjson 讀取正確）
- [x] 7.3 確認 non-SSE path 的 entry 也有兩個新欄位（不只 SSE path）
- [x] 7.4 確認 `summarizeEntry` whitelist 同步更新（end-to-end UI 看得到 badge）

## Removed from scope (v1.7.0 pre-mortem)

- ~~`thinkingBudget` 提取自 `parsedBody.thinking.budget_tokens`~~：Claude Code 不送此欄位，主流用戶看到永遠是 null，UI 是 dead code
- ~~Turn card secondary line `budget:high|med|low`~~：同上
- 替代信號（`thinkingDuration` drop heuristic）也被否決：false-positive 過高、actionable 性低、跟 `thinking-stripped` 語意撞車
