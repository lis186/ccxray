## Why

ccxray 已記錄所有流過 proxy 的請求，但兩個對 AI 行為診斷關鍵的信號——system prompt 核心版本、thinking blocks 是否被清除——從未被提取或顯示。Anthropic April 23 postmortem 揭露的兩個靜默行為變更可以在 proxy 層用這些信號立即偵測，但目前用戶必須手動 grep JSON 才能確認。

> **Note**: 原本第三個信號 `thinkingBudget` 已從 scope 中移除。Claude Code 不送 `thinking.budget_tokens`（Anthropic 在 server-side 自行決定 budget），主流用戶看不到任何 badge，UI 等同 dead code。詳細決策見 conversation log（v1.7.0 release pre-mortem）。未來若 Anthropic API response 暴露 server-side reasoning effort metadata，再重新評估。

## What Changes

- 每個 entry 新增兩個欄位：`coreHash`（system prompt 核心指令 hash，去掉動態內容）、`thinkingStripped`（前一個 turn 有 thinking 但本次 messages 裡消失了）
- turn card 的 risk line 新增 `sys-changed` badge（coreHash 改變時）和 `thinking-stripped` badge
- 修復 `miller-columns.js` 裡 cc_version regex 的靜默 bug（`S+?` → `\S+?`）
- 兩個新欄位同步寫入 index.ndjson，確保 restart 後 restore 可用

## Capabilities

### New Capabilities

- `turn-card-observability-signals`：turn card 在 risk line 顯示 sys-changed 和 thinking-stripped badges，並提取對應的 server-side fields 存入 entry 和 index

### Modified Capabilities

- `turn-card-display`：risk line 新增兩個 badge 類型（`sys-changed`、`thinking-stripped`）

## Impact

- `server/forward.js`：SSE path 和 non-SSE path 各新增兩個欄位到 entry 物件和 index line
- `server/index.js`：將已計算的 `coreHash` 加入 ctx 傳遞給 forward
- `server/sse-broadcast.js`：`summarizeEntry` 同步暴露兩個新欄位給 client
- `public/entry-rendering.js`：turn card 渲染邏輯新增兩個 badge
- `public/miller-columns.js`：修 cc_version regex bug
- index.ndjson schema 新增兩個可選欄位（向後相容，舊 entries 為 undefined）
