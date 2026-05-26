## Context

ccxray 的每個 proxy request 已包含所有診斷所需的原始數據，但兩個關鍵欄位從未被提取：
- `coreHash`：system prompt 核心指令的 MD5 hash（`index.js` 已計算但只存在 `versionIndex`，未存進 entry）
- thinking blocks 是否從前一個 turn 的 assistant message 消失

`forward.js` 有兩條 entry 建構路徑（SSE streaming、non-SSE JSON），必須同步修改。

> **Removed from scope (v1.7.0 pre-mortem)**: `parsedBody.thinking.budget_tokens` 提取與 `budget:high|med|low` UI 渲染原本是第三個信號。Pre-mortem 發現 Claude Code 不送這個欄位（Anthropic server-side 自動分配），主流用戶看到的永遠是 null，UI 是 dead code。同時拒絕用 `thinkingDuration` drop 當替代信號（false-positive 過高、actionable 性低）。詳細決策見 v1.7.0 conversation log。

## Goals / Non-Goals

**Goals:**
- 兩個新欄位存入 entry 物件和 index.ndjson（restart 後 restore 可用）
- turn card 顯示兩個對應 risk badge（sys-changed、thinking-stripped）
- 修復 `miller-columns.js` 的 cc_version regex 靜默 bug

**Non-Goals:**
- `thinkingBudget` 提取與顯示（pre-mortem 否決，見 Context note）
- statistical baseline / anomaly score（P2 範圍）
- query UI 或 filter by field（P3 範圍）
- 非 Claude Code requests 的 coreHash（架構不支援，靜默跳過）

## Decisions

### D1：用 `coreHash` 而非 `sysHash` 比較系統提示變化

**選擇**：新增 `coreHash` 欄位，hash 只涵蓋 `coreInstructions`（`splitB2IntoBlocks()` 的輸出），不包含 git status、working dir 等動態內容。

**捨棄**：直接比較 `sysHash`——sysHash 包含動態環境內容，每個 turn 都可能不同，badge 會在每次 turn 出現，毫無信號價值。

**做法**：`index.js` 已在版本偵測邏輯中計算 `coreHash`（line ~189）。重構為：先計算 coreHash，再判斷是否為新版本；coreHash 通過 `ctx` 傳遞給 `forward.js`。

### D2：`thinkingStripped` 在 server 端計算

**選擇**：在 `forward.js` 建構 entry 時計算，存為布林欄位。

**捨棄**：client 端計算——turn card 渲染時 `entry.req` 已被 release（lazy-load 前為 null），無法讀取 messages[]。

**邊界條件**：compaction 時 thinking 合法消失。用 `currMsgCount < prevMsgCount - 4` 作為 compaction proxy，避免誤報。只比對同 session、non-subagent、最近一個有 `thinkingDuration > 0` 的 entry。

## Risks / Trade-offs

**[R1] 兩條 forward.js 路徑不同步** → 每個新欄位修改後，立刻 grep 確認 non-SSE path 同步更新。

**[R2] 舊 index entries 無新欄位** → UI 所有新欄位使用 `!= null` 判斷，undefined 靜默視同 null，不顯示 badge。向後相容。

**[R3] thinking strip 誤報（compaction 邊界）** → msgCount drop 閾值（4）是粗略估計。偏保守（寧可漏報不誤報）。如果用戶反映 badge 太少，可降低閾值。

**[R4] coreHash 只對 Claude Code 請求有值** → 非 CC 請求 coreHash 為 null，badge 不顯示。不影響功能，但需確保 null 比較不拋錯。

**[R5] `summarizeEntry` whitelist 漏洞**（事後發現）→ `server/sse-broadcast.js` 用白名單列出要傳給 client 的欄位，新增 entry 欄位時必須同步加，否則 client 永遠收不到。已加入 checklist。
