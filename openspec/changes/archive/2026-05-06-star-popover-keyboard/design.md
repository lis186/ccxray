## Context

`miller-columns.js` renders badge chips with this logic today:

```js
const directStar = xrayStars.sessions.has(sid);
const derivedCount = /* count of starred turns under sid */;
if (directStar)       badge = '★';
if (derivedCount > 0 && !directStar) badge = `☆[${derivedCount}]`;
```

`openStarPopover(level, id, badgeEl)` is called on chip click, appends a `<div class="star-popover">` to `document.body`, registers outside-click and Esc listeners, and sets `window._openPopover = { level, id }`. The popover header today always reads the retained-because copy regardless of the parent's own star state.

The keyboard-nav handler in `keyboard-nav.js` has no awareness of an open popover — `↑`/`↓`/`Esc` all fall through to column navigation while the popover is visible.

## Goals / Non-Goals

**Goals:**
- `★[N]` always visible when N > 0, regardless of direct-star state
- Full keyboard path into/out of the popover (open, browse, commit, dismiss)
- No breaking change to existing mouse flow
- Focus restores to the originating column card after Esc, surviving intermediate column re-renders

**Non-Goals:**
- No change to popover row layout or in-popover star-toggle behavior
- No multi-select within the popover
- No server API or settings changes

## Decisions

### 決策 1：Badge 渲染條件從 `derivedCount > 0 && !directStar` 改為 `derivedCount > 0`

`★`/`☆` glyph 仍由 `directStar` 決定。`[N]` chip 存在與否完全由 `derivedCount > 0` 決定。兩個維度完全正交，渲染函式不需要額外 branch。

### 決策 2：Esc focus 回歸 column index，不回歸 badge DOM element

Popover 開啟時記錄 `_popoverOpenerColFocus = { col: focusedCol, idx: <current-row-idx> }`。Esc 關閉後呼叫 `restoreColFocus(_popoverOpenerColFocus)`，而非 `badgeEl.focus()`。理由：column re-render（新 SSE entry 進來）會替換 badge element，直接存 DOM ref 必然 stale。存 `{ col, idx }` 讓 `restoreColFocus` 直接呼叫現有的 `select*` 函式，index 不存在時 fallback 到 first item。

### 決策 3：Popover row focus 用 `_popoverFocusedIdx` + CSS class，不用 tabindex

Popover row 是 `<div>`，不是天然 focusable element。加 `tabindex="-1"` 會汙染 Tab 順序；用 `.pop-row-focused` class + `scrollIntoView` 實作等價效果，且完全不影響瀏覽器的 Tab 行為。

### 決策 4：Mouse 開啟的 popover 從 `_popoverFocusedIdx = -1` 開始，第一次 `↓` 才選中 row 0

Mouse 使用者不一定有鍵盤操作意圖，不自動 highlight 第一列。`↓` 從 -1 → 0，`↑` 從 -1 → last row。`p` key 開啟則從 0 開始（明確的鍵盤意圖）。
