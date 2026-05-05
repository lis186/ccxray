## ADDED Requirements

### Requirement: Step stars are stored as a flat array in settings

The system SHALL persist a fourth string array `starredSteps` in `~/.ccxray/settings.json`. Each entry is a step ID (see format below) directly starred by the user. The system SHALL NOT write derivative entries upward — starring a step does NOT add its turn id to `starredTurns`, its session to `starredSessions`, or its project to `starredProjects`.

`GET /_api/stars` SHALL include a `steps` field alongside the existing `projects`, `sessions`, and `turns` fields.

#### Scenario: GET returns steps array

- **WHEN** a client issues `GET /_api/stars`
- **THEN** the response body contains a `steps` key whose value is a string array

#### Scenario: First-time step star creates an entry

- **WHEN** a user POSTs `{kind:'step', id:'2026-05-02T10-00-00-000::3:0', starred:true}` and `starredSteps` does not contain that id
- **THEN** the id is appended to `starredSteps`
- **AND** `starredTurns`, `starredSessions`, and `starredProjects` are unchanged

#### Scenario: Unstar step removes only that step id

- **WHEN** a user POSTs `{kind:'step', id:'2026-05-02T10-00-00-000::3:0', starred:false}`
- **THEN** that id is removed from `starredSteps`
- **AND** no other array is modified

#### Scenario: Idempotent set-add

- **WHEN** a step star POST repeats for an id already in `starredSteps`
- **THEN** the array is unchanged and the response is HTTP 200 with the current state

---

### Requirement: Step ID format encodes entry, step index, and optional sub-key

A step ID is a string of the form `<entryId>::<stepIdx>[:<sub>]`:

| Part | Type | Meaning |
|---|---|---|
| `entryId` | string | The turn's `entry.id` (e.g. `2026-05-02T10-00-00-000`) |
| `stepIdx` | integer | Zero-based index into `prepareTimelineSteps()` output |
| `sub` | string \| integer \| omitted | `'thinking'` for a thinking block; integer tool-call index for a tool-call row; omitted for human-text or assistant-text steps |

Examples:
- `2026-05-02T10-00-00-000::2` — assistant-text or human-text step at index 2
- `2026-05-02T10-00-00-000::5:thinking` — thinking block inside step 5
- `2026-05-02T10-00-00-000::5:0` — first tool call inside step 5

The `::` separator is chosen to avoid collision with any character in a valid entry id (ISO-8601 datetime with dashes and no colon past the `T`). Parsing MUST split on the first `::` only.

#### Scenario: Parse turn id from step id

- **WHEN** step id is `2026-05-02T10-00-00-000::5:thinking`
- **THEN** `stepId.split('::')[0]` yields `2026-05-02T10-00-00-000`

#### Scenario: Step without sub-key

- **WHEN** a human-text or assistant-text step at index 2 is starred
- **THEN** the stored id is `<entryId>::2` (no trailing colon or sub)

---

### Requirement: Starring a step protects its parent turn and all upward retention

`computeRetentionSets()` SHALL extract the turn id from each entry in `starredSteps` (by splitting on `::` and taking the first segment) and add it to the `starredTurnIds` working set. From that point forward the turn behaves identically to a directly starred turn: its session is uplifted into `retainedSessions` (unless sentinel), and its project is uplifted into `retainedProjects` (unless sentinel).

This means starring any single step inside a turn protects the entire turn's log files, all sibling turns in the same real session, and all turns in the same non-sentinel project — matching the retention contract of a direct turn star.

#### Scenario: Step star protects parent turn's files

- **WHEN** step id `2026-05-02T10-00-00-000::3:0` is in `starredSteps` and prune runs
- **THEN** `2026-05-02T10-00-00-000_req.json` and `2026-05-02T10-00-00-000_res.json` are protected, even if older than `LOG_RETENTION_DAYS`

#### Scenario: Step star uplifts its real session

- **WHEN** the turn for the starred step belongs to session `sess-uuid` (non-sentinel) and the index contains other turns under `sess-uuid`
- **THEN** all those sibling turns are also protected by the session uplift

#### Scenario: Step star inside sentinel session does not uplift the sentinel bucket

- **WHEN** the turn for the starred step has `sessionId === 'direct-api'`
- **THEN** only that turn's files are protected; other `direct-api` turns are not protected as a result

#### Scenario: Missing entryId in step id is silently skipped

- **WHEN** `starredSteps` contains a malformed entry (e.g. empty string or a string with no `::`)
- **THEN** `computeRetentionSets()` ignores it without throwing; no turn id is added

---

### Requirement: Step-level star has no sentinel guard

The POST handler SHALL NOT reject `kind:'step'` requests based on the step's parent session or project being a sentinel. Users may legitimately star individual steps inside `direct-api` sessions or `(unknown)` projects. The sentinel guard applies only to `kind:'session'` and `kind:'project'` requests.

#### Scenario: Step star inside sentinel session accepted

- **WHEN** a POST arrives with `{kind:'step', id:'<directApiTurnId>::2', starred:true}`
- **THEN** the response is HTTP 200 and `starredSteps` is updated

---

### Requirement: Timeline step rows render a star toggle

Each row in the Timeline step list SHALL include a `★`/`☆` toggle button at the trailing edge of the row. The button SHALL:

- Render `★` (`.starred` class) when the step's id is in `window.xrayStars.steps`
- Render `☆` otherwise
- Call `event.stopPropagation()` on click so the row's `selectStep()` handler does not also fire
- Flip its glyph and `.starred` class **synchronously** before any network call (optimistic)
- Call `toggleStar('step', stepId, newState)` after the synchronous flip
- Revert to prior glyph on POST failure (standard `toggleStar` revert path)

#### Scenario: Clicking star does not select the step

- **WHEN** the user clicks the `★`/`☆` button on a timeline step row
- **THEN** `selectStep()` is NOT invoked
- **AND** the step detail panel does not change

#### Scenario: Toggle on

- **WHEN** the step row's button shows `☆` and the user clicks it
- **THEN** the button textContent becomes `★` synchronously
- **AND** a POST is issued with `{kind:'step', id:<stepId>, starred:true}`

#### Scenario: Toggle off

- **WHEN** the step row's button shows `★` and the user clicks it
- **THEN** the button textContent becomes `☆` synchronously
- **AND** a POST is issued with `{kind:'step', id:<stepId>, starred:false}`

---

### Requirement: Step row includes a sequential row number

Each rendered timeline step row SHALL display a sequential row number (`.tl-step-num`) counting from 1, incrementing across human-text, thinking, tool-call, and assistant-text rows in the order they appear. The count restarts at 1 when a new turn is loaded. The number is informational — it does not map to `stepIdx` directly and is not stored.
