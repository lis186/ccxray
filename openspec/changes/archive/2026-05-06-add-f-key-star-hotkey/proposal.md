## Why

使用者在 focused mode 瀏覽 session 內容時，若想標記一個 turn 為永久保留（star），必須離開鍵盤操作去點擊 ★ 圖示，打斷鍵盤導覽流程。`f` 鍵讓星號操作融入現有的鍵盤優先體驗，與 `e/s/a/m` 等跳步快捷鍵一致。

## What Changes

- 新增 `f` 鍵：在 dashboard 的所有 context（project 欄、session 欄、turn 欄、sections 欄、focused mode 非 timeline、focused mode timeline）star/unstar 目前選中的項目
- cmd bar 加入動態 `f ★ star` / `f ☆ unstar` 提示，隨目前項目的 star 狀態切換
- `f` 按下後顯示 2 秒 toast 確認（`★ Turn starred` / `☆ Session unstarred` 等），所有層級皆有
- cmd bar label 在 star toggle 後即時同步（`rerenderColumnsAfterStar` 觸發 `renderCmdBar`）
- cmd bar 的 `f ★` 提示可點擊（與現有 `cmd-key-btn` 模式一致）

## Capabilities

### New Capabilities

- `f-key-star-hotkey`: `f` 鍵 star/unstar 熱鍵，包含 adapter 邏輯、cmd bar 提示、toast 確認、cmd bar 即時同步

### Modified Capabilities

- `keyboard-discoverability`: cmd bar 在各 context 加入 `f ★ star` / `f ☆ unstar` 動態提示

## Impact

- `public/keyboard-nav.js`：新增 `getStarTargetFromSelection()` adapter、`_fStarLabel()` helper、`f` key handler、`isEnabled('f-star')` case、各 context 的 cmd bar 條目
- `public/miller-columns.js`：`rerenderColumnsAfterStar()` 末尾加一行 `renderCmdBar()` 呼叫
