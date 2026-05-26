## Turn Card Display Amendments — Implementation Tasks

All tasks implemented in main before PR #8 merge (commits b3b64b4 → 033c024).

### 1. cleanTitle() — title 過濾

- [x] 1.1 新增 `cleanTitle(title)` helper：移除 `<...>` XML/HTML 標籤、移除開頭 `**`/`##`/`—` 等 markdown 符號
- [x] 1.2 清理後長度 < 4 字元 → 回傳 null（整行省略）
- [x] 1.3 Line 2 title 改用 CSS `display:-webkit-box; -webkit-line-clamp:3` 最多顯示 3 行

### 2. hit% 永遠顯示 + 0% 紅色警示

- [x] 2.1 `hit:NN%` 無論 cache_read 是否為 0 都渲染
- [x] 2.2 `hit:0%`（cache_read === 0 且 totalUsed > 0）加 `color: var(--red)`

### 3. ctx bar 標籤左右分欄

- [x] 3.1 `.turn-ctx-labels` 改 `justify-content: space-between`
- [x] 3.2 `hit:NN%` DOM 順序在前（左），`ctx:NN%` 在後（右）

### 4. Line 4 拆為兩個 sub-row

- [x] 4.1 時間行格式改為 `[wait:{gap}]  dur:{elapsed} [(think:{N}s)]`（wait 在前）
- [x] 4.2 `wait:` 低於 500ms 或非 finite number 時省略
- [x] 4.3 `think:` 改為 `(think:{N}s)` 括號後綴，附在 `dur:` span 內
- [x] 4.4 工具行獨立渲染為第二 sub-row，tools 自由換行，無最多 3 個限制
- [x] 4.5 所有 tool chip 使用相同 dim 樣式，移除 `chip-agent` 特殊顏色

### 5. Model name 永遠顯示

- [x] 5.1 移除 `shouldOmitModel()` 函數
- [x] 5.2 所有 turn（主 turn 與 subagent）一律顯示 model name
