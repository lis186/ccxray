## Why

Turn-card-v2 實作期間，幾個顯示決策在 coding 過程中做了調整，但未同步回 spec。本次補正涵蓋五個面向：`cleanTitle()` 過濾雜訊標題、`hit:0%` 標籤永遠顯示、標籤左右分欄、時間行 + 工具行拆為兩個 sub-row、以及 model 名稱改為永遠顯示。

## What Changes

- **Title 過濾（cleanTitle）**：`entry.title` 在渲染前先套用 `cleanTitle()` 過濾，剔除 XML/HTML 標籤與 markdown 前綴字符；清理後不足 4 字元的 title 整行省略；title 支援最多 3 行換行（非 1 行截斷）
- **hit% 標籤永遠顯示**：`hit:NN%` 無論 cache_read 是否為 0 都顯示；`hit:0%` 紅色警示，提醒用戶快取未命中
- **ctx bar 標籤左右分欄**：`hit:NN%` 改左對齊，`ctx:NN%` 改右對齊（原本兩者均為右對齊）
- **Line 4 拆為兩個 sub-row**：時間行（`[wait:{gap}]  dur:{elapsed} [(think:{N}s)]`）與工具行分開渲染；順序改為 `wait:` 先、`dur:` 後；`wait:` 低於 500ms 或非 finite 時省略；`think:` 改為 `dur:` 的括號後綴；工具行不截斷，所有 chips 自由換行，無特殊顏色差異
- **Model name 永遠顯示**：移除 session-aware 省略規則（連續同 model ≤5 entries 省略）；所有 turn 一律顯示 model name

## Capabilities

### Modified Capabilities

- `turn-card-v2`：補正 Line 2 title 渲染、Line 3 標籤配置、Line 4 時間/工具分行格式、model 省略規則

## Impact

- `public/entry-rendering.js`：`cleanTitle()`、`hit:0%` 紅色、標籤排列、time row 前綴格式、工具行不截斷、`shouldOmitModel` 移除
- `public/style.css`：`hit:0%` 紅色樣式、`turn-ctx-labels` 改 `justify-content:space-between`
