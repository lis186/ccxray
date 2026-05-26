## Context

ccxray 的 Miller Column 儀表板目前在頁面載入後自動選取第一個 Project，但不繼續選取 Session 或 Turn，導致用戶看到一個「有動作但無內容」的半途狀態。

同時，鍵盤導航系統雖然功能完整（方向鍵、Enter/Escape、`/`、`e/E/t/h/]`），但與瀏覽器原生 focus 系統完全解耦，且沒有任何視覺提示告訴用戶快捷鍵存在。

相關程式碼：
- 初始選取邏輯：`entry-rendering.js` 第 617–644 行（排序邏輯）
- Miller Column 選取函數：`miller-columns.js`（`selectProject`、`selectSession`、`selectLatestTurn`）
- 鍵盤導航：`keyboard-nav.js`（`keydown` listener）

## Goals / Non-Goals

**Goals:**
- 頁面載入後用戶立即看到有意義的內容（不需要任何點擊或按鍵）
- 鍵盤快捷鍵對新用戶可發現、對熟練用戶不干擾
- 欄位焦點狀態視覺清晰，一眼知道「鍵盤現在控制哪個欄位」
- Project 排序邏輯只存在一個地方

**Non-Goals:**
- 不改變 Miller Column 的資料流或 SSE 機制
- 不引入 LocalStorage 持久化（例外：cmd-bar timeline 第二排展開偏好，key `kbar-timeline-expanded`，預設 true，隱私模式下靜默失敗不影響功能）
- 不改變 Focused Mode 的現有行為

## Decisions

### D1：條件式級聯，而非無條件全展開

**選擇**：依 Session 數量決定自動選取深度：
- 有 streaming Session → 自動選到最新 Turn
- 只有一個可見 Session → 自動選到最新 Turn
- 有多個 Sessions → 停在 Sessions 欄，`focusedCol = 'sessions'`
- 無 Sessions → 停在 Projects 欄

**為什麼不無條件全展開**：多 Session 時系統不知道用戶想看哪個，強制選取一個會製造「控制感喪失」。唯有答案唯一時才代替用戶決定。

**為什麼不完全不做**：空白欄位製造 Gulf of Evaluation，不如開發者工具（htop、k9s）打開即顯示內容的慣例。

### D2：提取 `getFirstProject()` 共用函數

**選擇**：從 `miller-columns.js` 提取 `getFirstProject()` 函數，`entry-rendering.js` 改為呼叫它。

**為什麼**：目前兩個檔案各自維護一份排序邏輯（pinned → status → lastId），若邏輯分叉會導致視覺第一個與自動選取第一個不一致，產生難以察覺的 bug。

### D3：底部 Contextual Command Bar，取代欄標題 hint

**初始選擇**：每個欄位的快捷鍵提示附在該欄標題列右側（col-hint spans），焦點欄亮起，非焦點欄灰顯。

**最終選擇（實作後修訂）**：將所有快捷鍵提示集中在頁面底部的固定 cmd-bar，依當前 `focusedCol` 和模式即時更新內容；同時移除 topbar 的 hotkeys 按鈕。

**為什麼從 col-hint 改為 cmd-bar**：
- col-hint 的提示被欄位標題文字擠壓，小螢幕容易截斷
- col-hint 只能顯示當前欄的快捷鍵，無法顯示跨模式的全局操作（如 tab 切換）
- cmd-bar 的固定位置符合終端工具（htop、tmux status line）的慣例，用戶眼睛不需要追蹤焦點位置
- Timeline 模式下的第二排快捷鍵（`e/E/t/h/]`）無法以 col-hint 形式合理容納

**Layout 設計**：`#app` 使用 `flex-direction:column; height:100vh`，cmd-bar 為 `flex-shrink:0`（非 position:fixed），確保欄位內容不會被 bar 遮蓋。

### D4：`?` Overlay 不使用 localStorage

**選擇**：`?` Overlay 每次按都顯示，不記憶「已看過」狀態。

**為什麼**：避免隱私模式下 localStorage 失敗；開發者工具的用戶習慣重複查閱快捷鍵參考，記憶「已看過」反而是障礙。

### D5：Streaming Session 偵測用同步方式

**選擇**：偵測 streaming Session 只讀 `store.entries` 中 `status === 'streaming'` 的最新 entry，在 `renderProjectsCol` 完成後同步判斷。

**為什麼**：避免引入新的非同步路徑或計時器，防止初始化 race condition。

## Risks / Trade-offs

- **多 Session 邊界**：若 Project 有 2 個 Sessions 但其中一個是 streaming，應優先選 streaming。需確保偵測順序正確（streaming 優先於「只有一個」的判斷）。→ 在條件分支中明確設定優先順序

- **`getFirstProject()` 提取後的舊代碼**：`entry-rendering.js` 中的舊排序邏輯必須完整刪除（不留殘存分支），否則仍可能分叉。→ Phase 0 清理：先刪後改

- **欄標題 hint 的空間**：部分欄位標題較長（如 `Sessions`），hint 文字可能在小螢幕下被截斷。→ hint 文字使用縮寫符號（`↑↓ · ←`），不用中文字

- **Overlay 的 z-index**：若 overlay 與 intercept UI 或 system-prompt UI 同時開啟，z-index 可能衝突。→ overlay 用 `z-index: 1000`，intercept modal 確認層級

## Open Questions

（無。所有設計決策在分析階段已決定。）
