## Why

頁面載入後自動選取第一個 Project，但 Sessions、Turns 欄空白——「幫了一半」的狀態讓用戶看不到任何有用的內容，也不知道下一步應該做什麼（Gulf of Evaluation）。同時，鍵盤導航功能完整卻完全不可發現，用戶必須猜測或讀 source code 才能知道快捷鍵存在。

## What Changes

- **初始選取邏輯重構**：從「只選 Project」改為條件式級聯——答案唯一時（單一 Session 或 streaming Session）自動選到 Turn 層；有多個 Session 時停在 Sessions 欄等待用戶選擇
- **排序邏輯統一**：將 `entry-rendering.js` 與 `miller-columns.js` 中重複的 Project 排序邏輯提取為共用函數 `getFirstProject()`，確保「視覺第一個」永遠等於「自動選取第一個」
- **Contextual Command Bar**：儀表板底部固定顯示一個 cmd-bar，依當前焦點欄和模式即時更新可用的快捷鍵；Timeline 模式下有第二排可展開／收合（偏好儲存至 localStorage）。取代原計畫的欄標題 hint spans 與 topbar hotkeys 按鈕
- **欄位焦點視覺強化**：焦點欄 `border-top: 2px solid var(--accent)`，非焦點欄無 top border
- **`?` 快捷鍵 Overlay**：按 `?` 顯示完整快捷鍵說明（英文），分三群顯示（Navigation / Focused Mode / Timeline）；開啟時 cmd-bar 淡出（`opacity:0`）以避免版面高度跳動
- **`Escape` 補全**：Miller Column 主模式下 `Escape` 新增「往左退一欄」行為（原本無效果）

## Capabilities

### New Capabilities

- `miller-initial-state`：控制頁面載入後 Miller Column 的初始選取行為，包含條件式級聯邏輯與排序函數統一
- `keyboard-discoverability`：底部 contextual cmd-bar（依焦點狀態即時更新）、`?` 快捷鍵 overlay（全英文）、Escape 補全行為

### Modified Capabilities

（無現有 spec-level 行為變更）

## Impact

- `public/entry-rendering.js`：初始自動選取邏輯（第 617–644 行）改為呼叫 `miller-columns.js` 的共用函數
- `public/miller-columns.js`：新增 `getFirstProject()`、重構 `selectProject` 後的級聯邏輯
- `public/keyboard-nav.js`：新增 `?` 鍵處理、補充 `Escape` 在主模式的行為
- `public/style.css`：新增欄標題焦點樣式、overlay 樣式、cmd-bar 樣式（移除 hotkeys-btn 與 col-hint 樣式）
- `public/index.html`：新增 overlay DOM 結構、`#cmd-bar`（`row1` + `row2`）；移除 hotkeys-btn 與各欄 hint spans
