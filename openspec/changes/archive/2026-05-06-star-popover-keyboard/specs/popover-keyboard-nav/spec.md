## ADDED Requirements

### Requirement: New window-exposed functions in `miller-columns.js`

To enable keyboard-nav.js to interact with popover internals without coupling modules via shared state, the following SHALL be exposed on `window`:

| Exposed as | Internal function | Purpose |
|---|---|---|
| `window.countDescendantStars(level, id)` | `countDescendantStars` | Used by `_hasBadgeDescendants()` in keyboard-nav.js |
| `window.navigateDescendant(kind, id)` | `_navigateToDescendant` | Called by `Enter` key handler to navigate to a popover row |
| `window.closeStarPopover()` | `_closeStarPopover` | Called by `Esc` key handler to close the popover |

Additionally, `openDerivedPopover` SHALL call `window._onPopoverOpen?.()` as its first line. This hook is set by keyboard-nav.js to capture the opener context before the popover DOM is built.

---

### Requirement: `p` key opens the starred-descendants popover

When the currently focused column item has a `[N]` chip (i.e. `_hasBadgeDescendants()` returns true), pressing `p` SHALL:

1. Open the popover anchored to the focused item's badge (same as clicking the `[N]` chip)
2. Set `window._popoverFocusedIdx = 0` and apply `.pop-row-focused` to the first row

The cmd bar SHALL show a `p · popover` hint when `_hasBadgeDescendants()` is true; the hint is hidden otherwise.

`_hasBadgeDescendants()` calls `window.targetFromCurrentSelection()` to get `{ level, id }`, then returns `(window.countDescendantStars?.(level, id) ?? 0) > 0`.

`p` is a no-op when the popover is already open.

#### Scenario: p opens popover and focuses first row

- **WHEN** a session card with a `[2]` chip is focused and the user presses `p`
- **THEN** the popover opens and row 0 has the `.pop-row-focused` class

#### Scenario: p is no-op when item has no descendants

- **WHEN** a session card with no `[N]` chip is focused and the user presses `p`
- **THEN** nothing happens (no popover opened, no toast)

#### Scenario: cmd bar shows p hint only when applicable

- **WHEN** the focused session has `derivedCount = 0`
- **THEN** the `p` hint is absent from the cmd bar

---

### Requirement: ↑/↓/Enter/Esc navigate the open popover

While `window._openPopover` is set (popover is open), the following keys SHALL be intercepted **before** column-nav logic runs. Both `e.preventDefault()` and `e.stopPropagation()` are called so the column behind the popover does not scroll or change selection.

| Key | Action |
|---|---|
| `↑` | Decrement `_popoverFocusedIdx` (min: 0 if `≥ 0`; from `-1` → last row). Call `renderPopoverFocus`. |
| `↓` | Increment `_popoverFocusedIdx` (max: last row index; from `-1` → 0). Call `renderPopoverFocus`. |
| `Enter` | Read `data-nav-kind` / `data-nav-id` from `.pop-row-focused`; call `window.navigateDescendant(kind, id)` + `window.closeStarPopover()`. No-op if `_popoverFocusedIdx < 0`. |
| `Esc` | `e.stopImmediatePropagation()` + `window.closeStarPopover()` + `restoreColFocus()`. |

**`Esc` + `stopImmediatePropagation`**: keyboard-nav.js registers its listener statically at page load. `_starPopoverEscKey` in miller-columns.js is registered dynamically when the popover opens — therefore keyboard-nav.js fires first. `stopImmediatePropagation` prevents `_starPopoverEscKey` from also closing (double-close) or triggering any side effects.

`renderPopoverFocus(idx)` adds `.pop-row-focused` to the `.star-popover-item` row at `idx`, removes it from all others, and calls `el.scrollIntoView({ block: 'nearest' })`.

#### Scenario: ↓ clamps at last row

- **GIVEN** the popover has 3 rows and `_popoverFocusedIdx = 2`
- **WHEN** the user presses `↓`
- **THEN** `_popoverFocusedIdx` stays at `2`

#### Scenario: ↑ from −1 wraps to last row

- **GIVEN** the popover was opened via mouse click (`_popoverFocusedIdx = -1`)
- **WHEN** the user presses `↑`
- **THEN** `_popoverFocusedIdx` is set to the last row index and `.pop-row-focused` is applied to that row

#### Scenario: Enter navigates and closes

- **GIVEN** `_popoverFocusedIdx = 1`
- **WHEN** the user presses `Enter`
- **THEN** `window.navigateDescendant` is called with the second row's `data-nav-kind`/`data-nav-id` and the popover is removed from the DOM

#### Scenario: Enter is no-op when no row is focused

- **GIVEN** popover was opened via mouse and `_popoverFocusedIdx = -1`
- **WHEN** the user presses `Enter`
- **THEN** the popover stays open; no navigation occurs

#### Scenario: ↑/↓ do not scroll the column behind the popover

- **WHEN** the user presses `↓` while the popover is open
- **THEN** `e.stopPropagation()` prevents the column's ↑/↓ handler from firing

---

### Requirement: Popover records opener context; Esc restores column focus

When the popover opens (via `p` key or mouse click), `openDerivedPopover` calls `window._onPopoverOpen?.()` as its first line. keyboard-nav.js sets this hook at module init:

```js
window._onPopoverOpen = () => {
  _popoverOpenerTarget = window.targetFromCurrentSelection();
};
```

`restoreColFocus()` calls `window.navigateTarget(window._popoverOpenerTarget, { focus: true })`. If `_popoverOpenerTarget` is null, it is a no-op.

Using a TargetRef (rather than `{ col, idx }`) means focus restoration survives intermediate column re-renders, since `navigateTarget` resolves by content identity, not DOM position.

#### Scenario: Esc returns focus to originating session card

- **GIVEN** the popover was opened from session column row 2 and the user presses `Esc`
- **THEN** the popover closes and `navigateTarget` is called with the TargetRef of that session card

#### Scenario: Focus restores correctly after column re-render

- **GIVEN** the popover is open and a new SSE entry causes a column re-render
- **WHEN** the user presses `Esc`
- **THEN** focus is restored via the TargetRef captured at open time (not via a stale DOM reference or index)
