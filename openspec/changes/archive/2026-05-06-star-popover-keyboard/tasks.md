## 1. Badge: render ★[N] when directly starred with descendants

- [x] 1.1 In `miller-columns.js`, remove the `direct ? 0 :` short-circuit — always call `countDescendantStars`; change chip render condition from `derivedCount > 0 && !directStar` to `derivedCount > 0`; `★`/`☆` glyph continues to be driven by `directStar`
- [x] 1.2 For the `direct && derived > 0` (★[N]) state, render a nested span inside the outer `<button class="pin-btn pinned">` carrying the chip onclick; outer button onclick stays `toggleStar(...)`:
  ```
  glyph = '★<span class="pin-btn-count" onclick="event.stopPropagation();openDerivedPopover(&quot;' + level + '&quot;,&quot;' + id + '&quot;,this.closest(&quot;.pin-btn&quot;))">' + derived + '</span>';
  ```
  Event flow: inner span fires + `stopPropagation` → outer `toggleStar` NOT triggered.
- [x] 1.3 Update popover header copy in `openDerivedPopover`: when `directStar === true`, render `N starred items inside`; otherwise keep existing retained-because copy (pass `directStar` into `openDerivedPopover(level, id, anchorEl, directStar)` or read from `xrayStars` inside)
- [x] 1.4 In `miller-columns.js`, window-expose `countDescendantStars`: `window.countDescendantStars = countDescendantStars`
- [x] 1.5 In `miller-columns.js`, window-expose `_navigateToDescendant`: `window.navigateDescendant = _navigateToDescendant`
- [x] 1.6 In `miller-columns.js`, window-expose `_closeStarPopover`: `window.closeStarPopover = _closeStarPopover`
- [x] 1.7 In `miller-columns.js` → `openDerivedPopover`, add `window._onPopoverOpen?.()` as first line (keyboard-nav.js uses this hook to snapshot opener context via `targetFromCurrentSelection`)

## 2. Popover open/close lifecycle

- [x] 2.1 In `keyboard-nav.js`, assign `window._onPopoverOpen = () => { _popoverOpenerTarget = window.targetFromCurrentSelection(); }` at module init. The hook fires when `openDerivedPopover` is called from any code path (mouse or keyboard), capturing the TargetRef of the focused column item before the popover DOM is built.
- [x] 2.2 In `openDerivedPopover` (miller-columns.js), after the hook call, initialize `window._popoverFocusedIdx = -1`. The `p` key handler in keyboard-nav.js overrides to `0` immediately after open.
- [x] 2.3 Add `renderPopoverFocus(idx)` helper in `keyboard-nav.js`: removes `.pop-row-focused` from all `.star-popover-item` rows, adds it to the row at `idx`, calls `el.scrollIntoView({ block: 'nearest' })`
- [x] 2.4 Add `restoreColFocus()` (no args) in `keyboard-nav.js`: calls `window.navigateTarget(window._popoverOpenerTarget, { focus: true })`; if `_popoverOpenerTarget` is null or undefined, no-op

## 3. keyboard-nav.js — `p` key

- [x] 3.1 Add `_hasBadgeDescendants()` helper: call `window.targetFromCurrentSelection()` to get `{ level, id }` of the focused item, then return `(window.countDescendantStars?.(level, id) ?? 0) > 0`
- [x] 3.2 Add `isEnabled('p-popover')` case: `return _hasBadgeDescendants() && !window._openPopover`
- [x] 3.3 Add cmd bar entry `{ key: 'p', label: 'popover', id: 'p-popover', clickKey: 'p' }` to all column-level rows, gated by `isEnabled('p-popover')`
- [x] 3.4 Add `p` key handler: locate the `.pin-btn` element of the focused card, call `openDerivedPopover(level, id, badgeEl)` (same function as chip click), then set `window._popoverFocusedIdx = 0` and call `renderPopoverFocus(0)`

## 4. keyboard-nav.js — ↑/↓/Enter/Esc inside open popover

- [x] 4.1 At the top of the keydown listener, check `window._openPopover`; if set, intercept `↑`/`↓`/`Enter`/`Esc` with `e.preventDefault()` + `e.stopPropagation()` before any column-nav logic
- [x] 4.2 `↑`: decrement `_popoverFocusedIdx`; if was `-1` → set to last row index; otherwise clamp at `0`; call `renderPopoverFocus`
- [x] 4.3 `↓`: increment `_popoverFocusedIdx`; if was `-1` → set to `0`; otherwise clamp at last row; call `renderPopoverFocus`
- [x] 4.4 `Enter`: if `_popoverFocusedIdx >= 0`, read `data-nav-kind` and `data-nav-id` from the `.pop-row-focused` element, call `window.navigateDescendant(kind, id)`, then call `window.closeStarPopover()`; else no-op
- [x] 4.5 `Esc`: call `e.stopImmediatePropagation()` (prevents `_starPopoverEscKey` in miller-columns.js from also firing since keyboard-nav.js listener was registered first), call `window.closeStarPopover()`, then call `restoreColFocus()`

## 5. CSS

- [x] 5.1 Add `.pop-row-focused` style: `background: var(--hover)` (or equivalent theme var) to distinguish keyboard-focused row from mouse hover state

## 6. Verification

- [x] 6.1 Mouse flow unchanged: click `☆[N]` or `★[N]` chip opens popover; click row body navigates; Esc / outside-click closes
- [x] 6.2 `★[N]` renders on a directly starred session/project that has starred descendants; clicking `★` glyph unstars (no popover); clicking `[N]` chip opens popover
- [x] 6.3 `p` key opens popover from keyboard; first row has `.pop-row-focused`; cmd bar shows `p · popover` hint beforehand
- [x] 6.4 `↑`/`↓` moves focus within popover; column behind does NOT scroll or change selection
- [x] 6.5 `Enter` on a focused row navigates to that item and closes popover
- [x] 6.6 `Esc` closes popover and column focus is restored to the originating card
- [x] 6.7 Mouse-opened popover: pressing `↓` focuses row 0; pressing `↑` focuses last row; `Enter` with no row focused (`-1`) does nothing
- [x] 6.8 Popover header reads `N starred items inside` when parent is directly starred; reads retained-because copy when only derived
