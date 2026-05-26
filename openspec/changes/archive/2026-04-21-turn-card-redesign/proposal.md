## Why

Turn card 目前把六個不同維度的資訊壓在同一行，使用者無法快速判斷「這輪是否正常」、「是誰觸發的」、「在做什麼」。最高優先的資訊（成功/失敗、context 壓力）和次要資訊（費用、stop reason 文字）視覺權重相同，造成認知負擔。

## What Changes

- **Turn title fallback 邏輯**：新增 server 端 `extractRequestTitle`，當 Claude response 無文字時，從 request 提取 user 訊息或 tool result 摘要，subagent 則取第一條 user message（任務描述）
- **Turn card 視覺層次**：重構 `entry-rendering.js` 的 HTML 結構，分為主要行 / title 行 / context bar / 風險行 / 次要行
- **風險 badges 整合**：新增 `⚠ tool-fail`（`is_error: true`）與 `⚠ max_tokens`；移除 `stop_reason` 純文字顯示；`compact`/`inferred` 降權至 tooltip
- **時間顯示合併**：gap timing 與 elapsed 合併為 `⏸22s→4.3s` 格式
- **成功/失敗視覺化**：HTTP status 數字改為色彩 dot（● 綠/紅），等待使用者回應以 ↵ 標示
- **Server 端 tool-fail 偵測**：`forward.js` 掃描 tool_result `is_error` 欄位

## Capabilities

### New Capabilities

- `turn-card-display`: Turn card 的視覺層次、資訊優先序、所有顯示元素的規格
- `turn-title-resolution`: Turn title 的來源優先序規則（response text → user msg → tool summary → subagent task）

### Modified Capabilities

（無現有 spec 需要更新）

## Impact

- `server/helpers.js`：新增 `extractRequestTitle`、`hasTooFailInRequest`
- `server/forward.js`：title fallback 邏輯、tool-fail 偵測
- `server/sse-broadcast.js`：新增 `toolFail` 欄位至 summary
- `public/entry-rendering.js`：Turn card HTML 結構重構
- `public/style.css`：新增對應 CSS classes
