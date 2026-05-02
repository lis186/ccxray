## ADDED Requirements

### Requirement: Project and session columns render a tri-state star badge

Each project card and each session card SHALL render a star badge with one of three states based on the union of `starredProjects`, `starredSessions`, `starredTurns` returned by `GET /_api/stars`:

| State | Visual | Condition |
|---|---|---|
| Direct | filled `★` (no count) | this level's id is in the corresponding starred array |
| Derived | hollow `☆` + small superscript count | this level's id is NOT directly starred, but at least one descendant is in `starredSessions` or `starredTurns` (with sentinel exclusion applied) |
| Unprotected | dim hollow `☆` (no count) or no badge | neither direct nor derived |

#### Scenario: Project directly starred

- **WHEN** `starredProjects` contains `'myapp'`
- **THEN** the project card for `myapp` renders filled `★` with no superscript count

#### Scenario: Project derived from starred session

- **WHEN** `starredProjects` does NOT contain `'myapp'` but `starredSessions` contains a session whose project resolves to `'myapp'`
- **THEN** the `myapp` card renders hollow `☆¹` (count = number of distinct starred sessions + turns under this project, excluding sentinel buckets)

#### Scenario: Session directly starred

- **WHEN** `starredSessions` contains `'sess-uuid'`
- **THEN** the session card for `sess-uuid` renders filled `★`

#### Scenario: Session derived from starred turn

- **WHEN** `starredSessions` does NOT contain `'sess-uuid'` but `starredTurns` contains a turn whose `sessionId === 'sess-uuid'`
- **THEN** the session card renders hollow `☆N` where N is the count of starred turns under that session

---

### Requirement: Star toggle uses single-level POST with no cascade

Clicking the star badge SHALL issue exactly one `POST /_api/stars` with `{kind, id, starred}` matching the badge's level and current state. The frontend SHALL NOT issue follow-up POSTs to parent or child levels. After the response returns, the frontend SHALL re-render all three columns from the new state so derived badges update consistently.

#### Scenario: Star a turn updates project and session derived badges

- **WHEN** the user clicks the star button on a turn whose session and project are not directly starred
- **THEN** the turn's button becomes filled `★`
- **AND** the session card now shows hollow `☆¹`
- **AND** the project card now shows hollow `☆¹`
- **AND** only one POST was issued (kind=`turn`)

#### Scenario: Unstar a directly starred project preserves descendants

- **WHEN** the user unstars a project that is in `starredProjects` and also has 3 starred sessions inside it
- **THEN** the project card transitions from filled `★` to hollow `☆³`
- **AND** the 3 session cards' filled `★` are unchanged

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

### Requirement: Legacy localStorage pins migrate once on first load

On dashboard load, the frontend SHALL `GET /_api/stars`. If the response arrays are all empty AND `localStorage` contains `xray-pinned-projects` or `xray-pinned-sessions`, the frontend SHALL POST each id to the corresponding kind, then `removeItem` for both legacy keys. After migration the frontend SHALL NOT consult `localStorage` for pin state.

#### Scenario: Migration on first load

- **WHEN** server returns empty stars and `localStorage.xray-pinned-projects` is `["myapp"]` and `localStorage.xray-pinned-sessions` is `[{sid:"u1"}, {sid:"u2"}]`
- **THEN** three POSTs occur: `{kind:'project',id:'myapp',starred:true}`, `{kind:'session',id:'u1',starred:true}`, `{kind:'session',id:'u2',starred:true}`
- **AND** both `localStorage` keys are removed afterward

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

### Requirement: Hover tooltip on derived badges explains the protection cause

When a parent column's badge is in the derived state (hollow `☆N`), hovering SHALL show a tooltip naming the cause: "Retained because N starred descendants — click to star this directly." The tooltip distinguishes derived from direct retention so the user understands why an entry is still being kept after they unstarred at this level.

#### Scenario: Derived tooltip text

- **WHEN** the user hovers a `☆³` badge on a project card
- **THEN** the tooltip text contains both `3` and the phrase "starred descendants"
