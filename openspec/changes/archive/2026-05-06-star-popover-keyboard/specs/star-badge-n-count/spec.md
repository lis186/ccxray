## ADDED Requirements

### Requirement: Badge renders `★[N]` when directly starred with N > 0 descendants

The `[N]` chip and the `★`/`☆` glyph are orthogonal. The system SHALL render:

| `directStar` | `derivedCount` | Badge |
|---|---|---|
| true | 0 | `★` |
| true | N > 0 | `★[N]` |
| false | N > 0 | `☆[N]` |
| false | 0 | `☆` (dim) |

This applies uniformly to project, session, and turn column cards.

**Implementation note — derived count calculation**: The `direct ? 0 : countDescendantStars(...)` short-circuit SHALL be removed. `countDescendantStars` is always called regardless of `directStar`.

**Implementation note — ★[N] onclick split**: The `[N]` chip in the `★[N]` state is a `<span class="pin-btn-count">` nested inside the outer `<button class="pin-btn pinned">`. The span carries its own `onclick` that calls `openDerivedPopover` + `event.stopPropagation()`, preventing the outer button's `toggleStar` from firing. The outer button onclick remains `toggleStar`. This is the only state where the chip and the glyph have independent click handlers.

The `[N]` chip in all states SHALL be clickable and open the starred-descendants popover.

#### Scenario: Directly starred session with two starred turns shows ★[2]

- **GIVEN** `starredSessions` contains `sess-abc` AND `starredTurns` contains two entry IDs belonging to `sess-abc`
- **WHEN** the session card for `sess-abc` is rendered
- **THEN** the badge shows `★` with a `[2]` chip

#### Scenario: Directly starred session with no starred turns shows ★ only

- **GIVEN** `starredSessions` contains `sess-abc` AND no `starredTurns` entries belong to `sess-abc`
- **WHEN** the session card is rendered
- **THEN** the badge shows `★` with no chip (unchanged behavior)

#### Scenario: Clicking [N] chip on ★[N] badge opens popover (not unstar)

- **WHEN** the user clicks the `[2]` chip on a `★[2]` badge
- **THEN** the popover opens listing the two starred descendants; the item is NOT unstarred

#### Scenario: Clicking ★ glyph on ★[N] badge unstars (no popover)

- **WHEN** the user clicks the `★` glyph area on a `★[2]` badge (outside the `[2]` chip)
- **THEN** the item is unstarred; no popover opens

---

### Requirement: Popover header copy is context-sensitive

When the popover is opened from a `★[N]` badge (parent is directly starred), the header SHALL read:

> `N starred items inside`

When opened from a `☆[N]` badge (parent is NOT directly starred), the header continues to read the existing retained-because copy.

`openDerivedPopover(level, id, anchorEl, directStar)` receives `directStar` to determine which header copy to use (or reads it from `xrayStars` internally).

#### Scenario: ★[N] popover header says "N starred items inside"

- **GIVEN** a directly starred session (`★`) with 3 starred turns
- **WHEN** the popover opens from the `[3]` chip
- **THEN** the header reads `3 starred items inside`

#### Scenario: ☆[N] popover header is unchanged

- **GIVEN** a non-starred project with 2 starred descendants
- **WHEN** the popover opens from the `[2]` chip
- **THEN** the header reads the existing retained-because copy
