## 1. keyboard-nav.js — adapter & handler

- [x] 1.1 在 `isEnabled()` 加入 `case 'f-star': return getStarTargetFromSelection() !== null;`
- [x] 1.2 新增 `_fStarLabel()` helper：讀取 `getStarTargetFromSelection()?.starred` 回傳 `'★ star'` / `'☆ unstar'`
- [x] 1.3 新增 `getStarTargetFromSelection()` adapter function（在 keydown listener 之前）
- [x] 1.4 在 keydown listener 中、tab-switching `return` 之後、`if (isFocusedMode)` 之前，插入 `f` key handler

## 2. keyboard-nav.js — cmd bar 整合

- [x] 2.1 `focusedCol === 'projects'` 的 row1 加入 `{ key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' }`
- [x] 2.2 `focusedCol === 'sessions'` 的 row1 加入同上條目
- [x] 2.3 `focusedCol === 'turns'` 的 row1 加入同上條目
- [x] 2.4 `focusedCol === 'sections'` 的 row1 加入同上條目
- [x] 2.5 `isFocusedMode` 非 timeline 的 row1 加入同上條目
- [x] 2.6 `isFocusedMode` timeline 的 row1 加入同上條目

## 3. miller-columns.js — cmd bar 同步

- [x] 3.1 在 `rerenderColumnsAfterStar()` 末尾加入 `if (typeof renderCmdBar === 'function') renderCmdBar();`

## 4. 驗證

- [x] 4.1 在各 column context 按 `f` 驗證 star toggle 與 toast（Turn / Session / Project）
- [x] 4.2 在 timeline focused mode 按 `f` 驗證 step star toggle 與 toast
- [x] 4.3 選中 `direct-api` session 或 sentinel project 時按 `f` 確認靜默無效
- [x] 4.4 確認 star toggle 後 cmd bar label 即時由 `★ star` 切換為 `☆ unstar`（或反向）
- [x] 4.5 確認 cmd bar 的 `f ★ star` 按鈕點擊有效（觸發 synthetic KeyboardEvent）
