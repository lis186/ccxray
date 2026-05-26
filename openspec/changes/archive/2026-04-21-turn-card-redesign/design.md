## Context

Turn card 目前的 HTML 結構是一個扁平的 `div`，把所有資訊擠在兩行：line1（編號 + 模型 + badges）和 line2（status + elapsed + stop_reason + thinking + cost + overhead + risk badges）。使用者的核心需求是「快速掃描判斷每輪是否正常」，但目前的設計沒有視覺層次，所有資訊權重相同。

## Goals / Non-Goals

**Goals:**
- 重構 turn card 為有明確層次的五行結構
- 新增 server 端 title fallback 邏輯，讓每個 turn 都有可讀的描述
- 新增 `tool-fail` 偵測（`is_error: true` in tool_result）
- 合併時間顯示為 `⏸gap→elapsed` 格式

**Non-Goals:**
- 不改動 context bar 的計算邏輯或顏色方案
- 不改動 session / project column 的設計
- 不改動 detail panel（右欄）的呈現

## Decisions

### 1. Title fallback 在 server 端計算

在 `forward.js` 計算 title 時套用 fallback，而非 client 端計算。

**理由**：server 端有完整的 `parsedBody.messages`（request），client 只拿到 summarized entry。在 server 算完後放進 SSE summary，client 零額外邏輯。

**Fallback 優先序**：
1. `extractResponseTitle(res)` — response 有文字（現有）
2. `extractLastUserText(req)` — last user message 有純文字
3. `extractToolResultSummary(req)` — last user message 全是 tool_results → `↩ Read · Bash · Write`
4. Subagent（`isSubagent=true`）跳過步驟 2/3，直接取 `extractFirstUserText(req)`（任務描述）

### 2. Tool-fail 偵測在 server 端

掃描 `parsedBody.messages` 裡的 `tool_result` blocks，找 `is_error: true`。結果作為 `toolFail: true/false` 加入 entry，broadcast 時放入 summary。

**理由**：和 credential scanning 的模式一致，集中在 server，client 只消費布林值。

### 3. Turn card 五行結構

```
[line-identity]   #161  sonnet-4-6  ●  ↵
[line-title]      "title 文字（truncate 到 60 char）"
[line-ctx]        ████████░░░░  80%
[line-risk]       ⚠ cred  ⚠ tool-fail  ⚠ max_tokens
[line-secondary]  ⏸22s→4.3s   Bash +4   $0.05
```

- `line-risk` 只有有風險 badge 才 render（避免空行）
- `compact`/`inferred` 降權至 `line-identity` 的 tooltip（title 屬性），不佔視覺空間
- `stop_reason` 文字移除，改用 ↵ icon 代表 `end_turn`

### 4. 成功/失敗用色彩 dot 而非數字

`● ` 綠（2xx）/ 紅（非 2xx），HTTP 數字移至 detail panel。

**理由**：掃描時眼睛追 shape，不追數字。

## Risks / Trade-offs

- **Restore 路徑**：從磁碟 restore 的舊 entries 可能沒有 `toolFail` 欄位，client 需要 `e.toolFail || false` 防守
- **Title 截斷**：60 char truncate 在某些長句子可能截得很奇怪，但這是 UI 寬度的現實限制
- **Subagent title 品質**：Subagent 第一條 user message 有時是 XML 結構體（system reminder 等），需要過濾純 text block
