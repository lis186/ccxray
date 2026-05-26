## Why

The `[N]` chip on project/session/turn badges is the sole UI entry point for navigating to starred descendants. Two gaps exist today:

1. **Badge disappears when parent is directly starred**: when a parent item has `★`, the `[N]` chip is hidden — even if N descendants are also starred. The navigation affordance vanishes at the exact moment the user has explicitly invested in the item.
2. **Popover is mouse-only**: once the popover opens, there is no keyboard path to browse rows, commit a selection, or dismiss without the mouse. This breaks the keyboard-first navigation model the rest of the dashboard follows.

## What Changes

- **Badge logic**: render `★[N]` when a parent is directly starred AND has N > 0 starred descendants. The `[N]` chip is now orthogonal to the `★`/`☆` state — it appears whenever descendants exist.
- **Popover header copy**: when both the parent and descendants are starred, the popover header reads `N starred items inside` (vs. the existing "retained because…" phrasing which implies indirect-only retention).
- **`p` key**: when the focused column item has a `[N]` chip, pressing `p` opens the popover and auto-focuses the first row.
- **Keyboard navigation in popover**: `↑`/`↓` move focus between rows; `Enter` navigates to the focused item and closes the popover; `Esc` closes without navigating and restores keyboard focus to the originating card.
- **Cmd bar**: `p` hint is shown when `_hasBadgeDescendants()` is true for the focused item; hidden otherwise.

## Capabilities

### New Capabilities

- `star-badge-n-count`: badge renders `★[N]` when parent is directly starred with N > 0 starred descendants; popover header copy updated for this combined state.
- `popover-keyboard-nav`: `p` key opens the starred-descendants popover; `↑`/`↓` browse rows; `Enter` navigates + closes; `Esc` closes + restores column focus.

### Modified Capabilities

- `star-popover`: open/close lifecycle tracks whether it was opened via keyboard (to restore column focus on Esc); header copy is now context-sensitive.

## Impact

- `public/miller-columns.js` — badge render condition: `derivedCount > 0 && !directStar` → `derivedCount > 0`; pass `directStar` context into popover; update header copy; record `_popoverOpenerColFocus` on open.
- `public/keyboard-nav.js` — new `p` key handler; `_hasBadgeDescendants()` helper; `isEnabled('p-popover')` case; `↑`/`↓`/`Enter`/`Esc` intercepted while popover is open (before column-nav logic).
- `public/style.css` — `.pop-row-focused` highlight for keyboard-focused popover row.
- No server changes. No new dependencies.
