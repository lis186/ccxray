## 1. 清理：統一排序邏輯（Step 0 先做）

- [x] 1.1 在 `miller-columns.js` 中提取 `getFirstProject()` 函數，封裝 pinned → streaming → active → lastId 排序邏輯
- [x] 1.2 刪除 `entry-rendering.js` 第 617–644 行的舊排序邏輯，改為呼叫 `getFirstProject()`
- [x] 1.3 確認兩個檔案中不存在任何殘留的重複排序邏輯

## 2. 條件式級聯初始選取

- [x] 2.1 在 `miller-columns.js` 中新增 `getVisibleSessions(projectName)` 輔助函數，回傳該 project 的可見 sessions 列表
- [x] 2.2 實作 `initAutoSelect()` 函數，依照規格中的四個條件分支執行選取邏輯（streaming → 單一 session → 多個 → 無）
- [x] 2.3 在 `entry-rendering.js` 的載入完成後，將 `selectProject(firstProj.name)` 替換為呼叫 `initAutoSelect()`
- [x] 2.4 在 sessions 欄無 session 時顯示「此專案尚無記錄」placeholder

## 3. 欄位焦點視覺強化

- [x] 3.1 在 `style.css` 中新增 `.col-focused` 的 `border-top: 2px solid var(--accent)` 樣式（已存在，確認）
- [x] 3.2 確認非焦點欄無 accent border（`border-top: 2px solid transparent` 已存在）

## 4. 欄標題鍵盤 hint

- [x] 4.1 在 `index.html` 各欄標題列新增 hint span 元素（class: `col-hint`）
- [x] 4.2 在 `style.css` 中設定 `.col-hint` 的樣式：非焦點欄 `opacity: 0.4; color: var(--dim)`，焦點欄 `opacity: 1; color: var(--text)`
- [x] 4.3 在 `miller-columns.js` 的 `setFocus()` 函數中，更新各欄 hint 元素的顯示狀態（隨 focusedCol 同步）
- [x] 4.4 各欄 hint 文字內容：Projects `↑↓ 選取 · →`、Sessions `↑↓ · ← · →`、Turns `↑↓ · ← · →`

## 5. `?` 快捷鍵 Overlay

- [x] 5.1 在 `index.html` 新增 overlay DOM 結構（id: `kbd-overlay`），初始 `display: none`，包含三個群組（導航 / Focused Mode / Timeline）
- [x] 5.2 在 `style.css` 設定 overlay 樣式（置中、`z-index: 1000`、backdrop blur、暗色背景）
- [x] 5.3 在 `keyboard-nav.js` 的 `keydown` listener 中新增 `?` 鍵處理：切換 overlay 顯示/隱藏
- [x] 5.4 在 `keyboard-nav.js` 中新增 overlay 開啟時 `Escape` 優先關閉 overlay 的邏輯

## 6. Escape 往左補全

- [x] 6.1 在 `keyboard-nav.js` 的主模式區塊（非 Focused Mode）中，在現有方向鍵判斷前新增 `Escape` 處理：`setFocus` 往左一欄（`sessions → projects`、`turns → sessions`、`sections → turns`、`projects → no-op`）

## 7. Contextual Command Bar（取代 col-hint + topbar hotkeys 按鈕）

- [x] 7.1 `index.html`：移除 `#hotkeys-btn`、移除 col-hint spans，在 `#columns` 後、`#kbd-overlay` 前新增 `#cmd-bar`（含 `#cmd-bar-row1`、`#cmd-bar-row2`）；為 `#kbd-overlay` 和 `#diff-overlay` 加上 `data-hides-cmdbar`
- [x] 7.2 `style.css`：移除 `hotkeys-btn` 和 `.col-hint` 樣式；`#columns` 加 `min-height:0`；新增 `#cmd-bar`、`#cmd-bar-row1`、`#cmd-bar-row2`、`.cmd-key`、`.cmd-sep`、`.cmd-toggle` 樣式
- [x] 7.3 `keyboard-nav.js`：新增 `_timelineExpanded`（從 localStorage 初始化）、`isEnabled(keyId)`、`getCmdBarState()`、`renderCmdBar()`；在 `openTlFilter`/`closeTlFilter` 末尾呼叫 `renderCmdBar()`；在 keydown handler 最末呼叫
- [x] 7.4 `miller-columns.js`：在 `setFocus()`、`enterFocusedMode()`、`exitFocusedMode()`、`selectSection()` 末尾呼叫 `renderCmdBar()`；移除 `updateColHints()` 及相關 DOM（`hint-projects` 等）
- [x] 7.5 `entry-rendering.js`：由 `setFocus()` 呼叫鏈覆蓋，無需獨立修改；`app.js` `switchTab()` 已加入 `renderCmdBar()` 呼叫
