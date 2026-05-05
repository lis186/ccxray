## ADDED Requirements

### Requirement: Derived-state badge click opens an anchored popover

When the user clicks a parent column's derived `☆` + count badge, the system SHALL open a single floating popover anchored to that badge. Only one popover is open at a time across the dashboard. Clicking the same level+id badge again SHALL close it (toggle).

The popover's identity SHALL be tracked by `(level, id)`, not by DOM reference, so column re-renders that replace the badge element do not break the toggle-close path.

#### Scenario: Click derived badge opens popover

- **WHEN** the user clicks a `☆` badge with count chip on a project card
- **THEN** a popover element is appended to `document.body` and positioned near the badge

#### Scenario: Re-clicking same parent toggles closed

- **WHEN** the popover is open for project `myapp` and the user clicks `myapp`'s badge again
- **THEN** the popover is removed from the DOM
- **AND** outside-click / Esc handlers are unregistered

#### Scenario: Clicking a different parent reuses the popover

- **WHEN** the popover is open for project `myapp` and the user clicks the badge of project `other`
- **THEN** the existing popover closes and a new one opens for `other`

---

### Requirement: Popover positioning clamps to viewport edges

After append, the system SHALL measure the popover's bounding rect and clamp to the viewport on each axis:

- **Bottom overflow**: when `popRect.bottom > window.innerHeight - 8`, flip to anchor by `bottom` (open upward).
- **Left overflow**: when `popRect.left < 8`, switch from `right`-anchor to `left: 8px` (project-column badges are flush left and the default right-anchor would clip).

Right and top overflows are not currently handled — badges live on the right side of cards and below the page header, so default positioning fits.

#### Scenario: Bottom overflow flips upward

- **WHEN** the badge is near the bottom of the viewport and the popover would extend below it
- **THEN** the popover is positioned with `bottom: ...` instead of `top: ...`, opening above the badge

#### Scenario: Left overflow clamps to 8px from viewport left

- **WHEN** the badge is in the project column whose right edge is near `x = 240` and the popover's `min-width` is 240
- **THEN** the popover's `left: 8px` (instead of `right: ...`) so its content stays in the viewport

---

### Requirement: Popover lists starred descendants with toggle and navigation rows

Each row in the popover body SHALL render:

- A leading `★` (yellow) or `☆` (dim) glyph button reflecting the descendant's current starred state
- A label (`turn HH:MM:SS` for turns; `session XXXXXXXX` for sessions; turns under a project also show `· sessXXXX` suffix)
- The whole row is a click target

The row's two affordances SHALL be:

| Click target | Action |
|---|---|
| The `★`/`☆` button | Toggle that descendant's star (in place; row stays visible with new glyph) |
| Anywhere else in the row | Navigate the dashboard to that descendant (close popover, select project + session + turn) |

A footer `★ Star this {level} directly` button SHALL let the user anchor the parent level itself without releasing children.

#### Scenario: Session card popover lists starred turns

- **WHEN** session `s1` has 3 starred turns and the user clicks `s1`'s derived badge
- **THEN** the popover lists 3 rows, each with `★` glyph + `turn HH:MM:SS` label

#### Scenario: Project card popover lists starred sessions and turns

- **WHEN** project `myapp` has 1 starred session `s1` and 2 starred turns under different sessions
- **THEN** the popover lists 3 rows: one for `session s1`, two for the turns

#### Scenario: Sentinel descendants are excluded from the list

- **WHEN** a project's popover would include a starred turn whose `sessionId === 'direct-api'`
- **THEN** that turn does not appear in the popover row list (sentinel exclusion mirrors the retention rule)

---

### Requirement: Glyph button is a synchronous optimistic toggle

Clicking the leading `★`/`☆` glyph SHALL flip the button's `textContent` and `.starred` class **synchronously** before any network call, then fire `toggleStar` without blocking the click handler. After the POST resolves the glyph is re-synced from the (now-server-authoritative) `xrayStars` cache. The row stays in the popover regardless of new state — letting the user undo a release without reopening.

The `:hover` rule on the glyph button MUST NOT override the state color: hover feedback is provided via `transform: scale(...)` and a subtle background tint only. Otherwise the cursor staying on a just-clicked button would mask the ★→☆ flip with a uniform yellow.

#### Scenario: Glyph flips immediately on click

- **WHEN** the user clicks `★` on a row
- **THEN** the textContent becomes `☆` and `.starred` is removed inside the click handler synchronously, before any awaits

#### Scenario: Re-clicking ☆ restars

- **WHEN** the row's glyph is `☆` (just released) and the user clicks it again
- **THEN** the textContent becomes `★`, `.starred` is added, and a `kind` POST with `starred:true` is fired

#### Scenario: Hover does not mask state

- **WHEN** the cursor remains on a glyph button after a click
- **THEN** the post-click state color (yellow for `★`, dim for `☆`) is visible — no `:hover { color: yellow }` override

---

### Requirement: Row body click navigates to the descendant

Clicking a popover row outside its glyph button SHALL navigate the dashboard to that descendant: closing the popover, selecting the descendant's project (re-selecting if currently focused on a different project), selecting its session, and (for turns) selecting the turn by index. Focus moves to the Turns column.

If the descendant entry is not in the currently-restored entry set the navigation is a silent no-op (the file is still server-side protected; the user can release via the glyph instead).

#### Scenario: Turn row click jumps to the turn

- **WHEN** the user clicks the body of a turn row in the popover
- **THEN** the popover closes
- **AND** the project selection updates to the turn's project (if different)
- **AND** the session selection updates to the turn's session
- **AND** that specific turn is selected and visible
- **AND** focus moves to the Turns column

#### Scenario: Cross-project navigation re-selects project

- **WHEN** the user is currently viewing project `A` and clicks a turn row in a popover whose turn lives in project `B`
- **THEN** the project column re-selects `B` so the session column's project filter shows that session

#### Scenario: Glyph button click does not navigate

- **WHEN** the click target is the row's glyph button (or inside it)
- **THEN** the row's navigate handler does NOT fire (handler bails on `closest('.star-popover-glyph-btn')`)

---

### Requirement: Popover dismissal has multiple pathways and does not auto-close on last unstar

The popover SHALL close in response to any of:

- Click on the title-bar `[×]` button
- Press of the Esc key
- Click outside the popover (and not on its anchor badge)
- Re-click of the parent badge whose level+id matches the open popover

The popover SHALL NOT close as a side effect of unstarring the last descendant. The user MUST explicitly close via one of the pathways above so they retain the option to re-star the just-released descendants.

#### Scenario: Last unstar keeps popover open

- **WHEN** the popover lists 1 starred descendant and the user clicks its `★` to unstar
- **THEN** the row's glyph becomes `☆` but the popover stays open
- **AND** the user can re-click `☆` to restar without reopening

#### Scenario: Esc dismisses

- **WHEN** the popover is open and the user presses Esc
- **THEN** the popover closes; outside-click and keydown listeners are removed

#### Scenario: Outside click dismisses

- **WHEN** the popover is open and the user clicks anywhere outside both the popover and the parent badge
- **THEN** the popover closes
