## ADDED Requirements

### Requirement: Project and session columns render a tri-state star badge

Each project card and each session card SHALL render a star badge with one of three states based on the union of `starredProjects`, `starredSessions`, `starredTurns` returned by `GET /_api/stars`:

| State | Visual | Condition |
|---|---|---|
| Direct | filled `★` (yellow, no count) | this level's id is in the corresponding starred array |
| Derived | hollow `☆` + chip-style count badge `[N]` | this level's id is NOT directly starred, but at least one descendant is in `starredSessions` or `starredTurns` (with sentinel exclusion applied) |
| Unprotected | dim hollow `☆` or no badge | neither direct nor derived |

The derived-state count MUST be rendered as a chip — a small rounded background with the number inside (yellow text on dim surface) — and NOT as a superscript. The chip framing communicates "this is a count of items" so users do not misread the digit as a version number, hour count, or other quantity.

#### Scenario: Project directly starred

- **WHEN** `starredProjects` contains `'myapp'`
- **THEN** the project card for `myapp` renders filled `★` with no count chip

#### Scenario: Project derived from starred session

- **WHEN** `starredProjects` does NOT contain `'myapp'` but `starredSessions` contains a session whose project resolves to `'myapp'`
- **THEN** the `myapp` card renders hollow `☆` followed by a count chip (count = number of distinct starred sessions + turns under this project, excluding sentinel buckets)

#### Scenario: Session directly starred

- **WHEN** `starredSessions` contains `'sess-uuid'`
- **THEN** the session card for `sess-uuid` renders filled `★`

#### Scenario: Session derived from starred turn

- **WHEN** `starredSessions` does NOT contain `'sess-uuid'` but `starredTurns` contains a turn whose `sessionId === 'sess-uuid'`
- **THEN** the session card renders hollow `☆` followed by a count chip showing the number of starred turns under that session

#### Scenario: Count chip is a rounded background, not superscript

- **WHEN** the derived state is rendered for any count
- **THEN** the count digit is enclosed in a `<span>` with `border-radius`, distinct background tint, and yellow text — not a `<sup>` element

---

### Requirement: Star toggle uses optimistic UI with single-level POST and revert on failure

Clicking the star badge SHALL flip the local `xrayStars` cache immediately, repaint affected columns, then issue exactly one `POST /_api/stars` with `{kind, id, starred}` matching the badge's level and intended state. The frontend SHALL NOT issue follow-up POSTs to parent or child levels. After the POST resolves the cache is reconciled with the server response (handles multi-tab / migration concurrency). On HTTP failure the optimistic flip SHALL be reverted, the columns repainted, and a toast surfaced ("Star failed: …") so the user knows their click did not take.

#### Scenario: Star a turn updates project and session derived badges

- **WHEN** the user clicks the star button on a turn whose session and project are not directly starred
- **THEN** the turn's button becomes filled `★` immediately (no API wait)
- **AND** the session card immediately shows hollow `☆` + count chip `1`
- **AND** the project card immediately shows hollow `☆` + count chip `1`
- **AND** only one POST was issued (kind=`turn`)

#### Scenario: Unstar a directly starred project preserves descendants

- **WHEN** the user unstars a project that is in `starredProjects` and also has 3 starred sessions inside it
- **THEN** the project card transitions from filled `★` to hollow `☆` + count chip `3`
- **AND** the 3 session cards' filled `★` are unchanged

#### Scenario: Optimistic flip happens before POST resolves

- **WHEN** the user clicks any star badge
- **THEN** the visual state changes synchronously inside the click handler — no `await fetch` blocks the glyph update

#### Scenario: Failure reverts the optimistic flip

- **WHEN** the POST returns a non-2xx status (or rejects)
- **THEN** the local `xrayStars` cache is reverted to its prior state
- **AND** the columns are repainted to reflect the revert
- **AND** a toast appears with text including "Star failed"

---

### Requirement: Sentinel sessions and projects disable the star button at their own level

When the entity is a sentinel (`session.id === 'direct-api'` or `getProjectName(cwd) ∈ {'(unknown)', '(quota-check)'}`), the star button at that level SHALL be visually disabled (opacity reduced, cursor `not-allowed`) and SHALL NOT respond to clicks. Hovering SHALL show a tooltip explaining why ("Catch-all session — star individual turns instead." or "Catch-all project — star sessions or turns instead.").

#### Scenario: direct-api session star disabled

- **WHEN** the user hovers the star on the `direct-api` session card
- **THEN** the cursor shows `not-allowed`
- **AND** the tooltip contains the words "Catch-all session"

#### Scenario: Turn-level star inside a sentinel still works

- **WHEN** a turn belongs to the `direct-api` session
- **THEN** the turn card's star button is enabled
- **AND** clicking it issues `POST /_api/stars` with `kind='turn'`

---

### Requirement: Star button click does not select the turn

Clicking the star toggle on a turn card SHALL invoke `event.stopPropagation()` so the parent click handler that sets the focused turn does not also fire.

#### Scenario: Click on star

- **WHEN** the user clicks the star icon on a turn card
- **THEN** the focused turn does not change
- **AND** the star toggle POST is issued

#### Scenario: Click on rest of the card

- **WHEN** the user clicks anywhere on the turn card outside the star icon
- **THEN** the focused turn changes (existing `selectTurn` behavior unchanged)

---

### Requirement: Legacy localStorage pins migrate once on first load (sentinels skipped)

On dashboard load, the frontend SHALL `GET /_api/stars`. If the response arrays are all empty AND `localStorage` contains `xray-pinned-projects` or `xray-pinned-sessions`, the frontend SHALL POST each id to the corresponding kind, then `removeItem` for both legacy keys. Sentinel ids (`'direct-api'` for sessions; `'(unknown)'`, `'(quota-check)'` for projects) MUST be filtered out before POSTing — the API would reject them as 400 and a partial migration would leave non-sentinel stars half-migrated. After migration the frontend SHALL NOT consult `localStorage` for pin state.

#### Scenario: Migration on first load

- **WHEN** server returns empty stars and `localStorage.xray-pinned-projects` is `["myapp"]` and `localStorage.xray-pinned-sessions` is `[{sid:"u1"}, {sid:"u2"}]`
- **THEN** three POSTs occur: `{kind:'project',id:'myapp',starred:true}`, `{kind:'session',id:'u1',starred:true}`, `{kind:'session',id:'u2',starred:true}`
- **AND** both `localStorage` keys are removed afterward

#### Scenario: Migration skips sentinel ids

- **WHEN** legacy `xray-pinned-projects` contains `["myapp", "(quota-check)"]` and `xray-pinned-sessions` contains `[{sid:"direct-api"}, {sid:"u1"}]`
- **THEN** only the non-sentinel POSTs are sent: `{kind:'project',id:'myapp',starred:true}` and `{kind:'session',id:'u1',starred:true}`
- **AND** both `localStorage` keys are still cleared afterward (sentinel entries are silently dropped)

#### Scenario: Already migrated, no re-merge

- **WHEN** server returns non-empty stars
- **THEN** `localStorage` legacy keys, if present, are removed without POSTing
- **AND** future toggles route only to the API

---

### Requirement: Pin expiration logic is removed

The frontend SHALL NOT auto-expire stars. The previous `expireSessionPins()` 7-day-since-last-activity expiration SHALL be removed from `public/miller-columns.js` along with all call sites.

#### Scenario: Old session star persists indefinitely

- **WHEN** a session was starred 30 days ago and has no activity since
- **THEN** the session remains starred and protected from prune
- **AND** no client-side timer removes it

---

### Requirement: Derived badge click opens the descendant popover

When a parent column's badge is in the derived state (hollow `☆` + count chip), clicking SHALL open the star descendant popover (see `star-popover` capability). The badge's hover tooltip SHALL name the cause: "Retained because N starred descendants below — click to view." The tooltip distinguishes derived from direct retention so the user understands why an entry is still being kept after they unstarred at this level. Direct (filled `★`) and unprotected (dim `☆`) badges retain the simple toggle behavior — only derived state opens the popover.

#### Scenario: Derived badge tooltip text

- **WHEN** the user hovers a derived badge with count chip showing `3` on a project card
- **THEN** the tooltip text contains both `3` and the phrase "starred descendants"

#### Scenario: Derived badge click opens popover

- **WHEN** the user clicks a derived badge
- **THEN** the popover opens (no immediate toggle of star state)

#### Scenario: Direct badge click toggles directly

- **WHEN** the user clicks a filled `★` badge
- **THEN** that level's star is removed via `toggleStar` (no popover)
