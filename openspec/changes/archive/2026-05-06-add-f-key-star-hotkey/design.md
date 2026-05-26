## Context

`keyboard-nav.js` 已有完整的鍵盤導航框架（`focusedCol`、`isFocusedMode`、`selectedSection` 狀態）以及 `getCmdBarState()` / `renderCmdBar()` cmd bar 渲染管線。

`miller-columns.js` 已有 `targetFromCurrentSelection()` window-exposed adapter（line 281），覆蓋 project / session / turn / step 5 種 context；`toggleStar(level, id, starred)` 已可從任何 JS 呼叫；`xrayStars.projects/.sessions/.turns/.steps` Set 提供即時 star 狀態；`showToast(msg, duration)` 在 line 9 可用（duration 預設 5000ms）。

約束：
- 不能在 `isFocusedMode` block 底部 `return; // swallow` 之後插入 handler（永遠不會執行）
- `toggleStar` 第三個參數是目標狀態，不是 toggle flag
- sentinel: session `'direct-api'`、project `'(unknown)'`/`'(quota-check)'` 禁止 star

## Goals / Non-Goals

**Goals:**
- 單一 `f` 鍵在所有 dashboard context（5 種）star/unstar 目前選中項目
- cmd bar 顯示動態 `f ★ star` / `f ☆ unstar` 提示，且可點擊
- star toggle 後 toast 確認（2s）
- cmd bar label 隨 star 狀態即時同步（`rerenderColumnsAfterStar` 後 re-render）

**Non-Goals:**
- 修改 star 的持久化、server API 或 UI 視覺樣式
- 為 `f` 以外的鍵加入 star 功能
- 支援多選或批次 star

## Decisions

### 決策 1：Handler 插入在 tab-switching 之後、`isFocusedMode` block 之前

**理由**：`isFocusedMode` block 底部有 `return; // swallow`，所有不認識的鍵都被吞掉。唯一能讓 `f` 在兩個 mode 下共用邏輯的位置是這個 block 之前。若在 block 內加分支，則 main mode 需重複同樣的 handler，違反 DRY。

**替代方案**：在 `isFocusedMode` block 內加 `if (key === 'f') {...}` — 需要兩處插入，future-proof 差，已排除。

### 決策 2：`getStarTargetFromSelection()` thin adapter 包裝現有 API

**理由**：`targetFromCurrentSelection()` 已完整處理 5 種 context（step / turn / session / project / 無選擇），且已 window-exposed。新 adapter 只做：格式轉換成 `{ level, id, starred }` + sentinel guard + xrayStars null guard。不重新實作 context detection 邏輯。

**替代方案**：直接在 handler 裡讀取 `focusedCol`/`isFocusedMode` 等全域狀態 — 邏輯分散，與 `targetFromCurrentSelection` 重複，已排除。

### 決策 3：Step ID 格式與 `getTimelineStepStarId()` 保持一致

**理由**：messages.js line 377 `getTimelineStepStarId` 定義格式為 `entry.id + '::' + stepIdx + (sub==null?'':':'+sub)`。`xrayStars.steps` 用此格式做 lookup。adapter 必須完全複製此格式，否則 has() 永遠返回 false。

### 決策 4：`_fStarLabel()` 每次呼叫 live read xrayStars

**理由**：star 後 `rerenderColumnsAfterStar` 會呼叫 `renderCmdBar()`，此時重新呼叫 `getCmdBarState()` → `_fStarLabel()` → `getStarTargetFromSelection()?.starred`，讀到最新狀態。不需要額外事件或訂閱。

### 決策 5：`rerenderColumnsAfterStar()` 末尾追加 `renderCmdBar()`

**理由**：star toggle 後 card 重新渲染，但 cmd bar label（`★ star` vs `☆ unstar`）不會自動同步。最小侵入性：在現有 re-render 函式末尾加一行 guard call。

## Risks / Trade-offs

- **`targetFromCurrentSelection()` 回傳格式變動** → Mitigation: adapter 加 defensive null checks，任何意外格式直接 return null（`f` 靜默無效）。
- **`xrayStars` 在 star API 回應前短暫 stale** → Mitigation: `toggleStar` 是 optimistic update，UI 先更新，API 確認後同步。現行行為已是如此，`f` 鍵繼承相同語義。
- **sentinel guard 漏判** → Mitigation: adapter null return → handler `if (target)` guard → `e.preventDefault()` 不執行 → 只有 `return` 靜默跳過，不影響其他鍵。

## Migration Plan

兩個文件各自修改，無 server 變動，無 API 變更，無 migration 必要。Rollback = revert 兩個文件的 diff。

## Open Questions

無。所有設計決策已在 adversarial autoresearch 流程中驗證，實作可直接開始。
