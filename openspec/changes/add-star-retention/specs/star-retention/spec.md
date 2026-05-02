## ADDED Requirements

### Requirement: Stars are stored as three flat per-level arrays in settings

The system SHALL persist three string arrays in `~/.ccxray/settings.json`: `starredProjects` (project names), `starredSessions` (session ids), `starredTurns` (entry ids). Each array contains only ids that the user has directly starred at that level. The system SHALL NOT write derivative entries (e.g. starring a turn does NOT add the turn's session to `starredSessions`).

#### Scenario: First-time star creates an array entry

- **WHEN** a user POSTs `{kind:'turn', id:'2026-05-02T10-00-00-000', starred:true}` and `starredTurns` does not contain that id
- **THEN** the id is appended to `starredTurns`
- **AND** `starredSessions` and `starredProjects` are unchanged

#### Scenario: Unstar removes only the targeted level

- **WHEN** a user POSTs `{kind:'session', id:'sess-uuid', starred:false}` against a session whose turns are still in `starredTurns`
- **THEN** `sess-uuid` is removed from `starredSessions`
- **AND** `starredTurns` is unchanged

#### Scenario: Idempotent set-add

- **WHEN** a star POST repeats for an id already in the target array
- **THEN** the array is unchanged and the response is HTTP 200 with the current state

---

### Requirement: REST API exposes stars as a single endpoint

The system SHALL expose `GET /_api/stars` returning `{projects: string[], sessions: string[], turns: string[]}` and `POST /_api/stars` accepting `{kind: 'project'|'session'|'turn', id: string, starred: boolean}`. The POST handler SHALL update only the array corresponding to `kind` and SHALL respond with the full updated state.

#### Scenario: GET returns full snapshot

- **WHEN** a client issues `GET /_api/stars`
- **THEN** the response body is a JSON object with exactly three keys: `projects`, `sessions`, `turns`, each an array of strings

#### Scenario: POST validates kind

- **WHEN** a POST arrives with `kind` not in `{project, session, turn}`
- **THEN** the response is HTTP 400 and no settings change is written

#### Scenario: POST validates starred boolean

- **WHEN** a POST arrives with `starred` missing or non-boolean
- **THEN** the response is HTTP 400 and no settings change is written

---

### Requirement: Retention is derived from stars at prune time

`pruneLogs()` SHALL compute a protected-id set from the union of: directly starred turn ids, all entries in starred sessions, all entries under starred projects, all entries sharing a non-sentinel session with any starred turn, and all entries under a non-sentinel project containing any starred session or turn. Files referenced by entries currently restored in memory SHALL also remain protected (existing behavior).

#### Scenario: Direct turn star protects the turn's files

- **WHEN** entry id `2026-05-02T10-00-00-000` is in `starredTurns` and prune runs
- **THEN** `2026-05-02T10-00-00-000_req.json` and `2026-05-02T10-00-00-000_res.json` are not deleted, even if older than `LOG_RETENTION_DAYS`

#### Scenario: Starring a turn protects all sibling turns in the same real session

- **WHEN** turn `T1` is starred and `T1.sessionId === 'sess-uuid'` (a real, non-sentinel session) and the index also contains `T2` and `T3` with the same `sessionId`
- **THEN** files for `T1`, `T2`, and `T3` are all protected

#### Scenario: Starring a turn does not protect siblings in a sentinel session

- **WHEN** turn `T1` is starred and `T1.sessionId === 'direct-api'` and the index contains `T2` also under `direct-api`
- **THEN** only `T1` is protected; `T2` is pruned if it falls outside the retention window

#### Scenario: Starring a session protects all its entries

- **WHEN** `'sess-uuid'` is in `starredSessions`
- **THEN** every entry whose `sessionId === 'sess-uuid'` has its files protected

#### Scenario: Starring a project protects all entries under it

- **WHEN** `'myapp'` is in `starredProjects` and entry `E` has `projectName(E.cwd) === 'myapp'`
- **THEN** `E`'s files are protected, regardless of session

---

### Requirement: Sentinel sessions and projects are excluded from upward derivation

The system SHALL define `SENTINEL_SESSIONS = {'direct-api'}` and `SENTINEL_PROJECTS = {'(unknown)', '(quota-check)'}`. When deriving "retained sessions" from starred turns, entries whose `sessionId` is sentinel SHALL NOT contribute. When deriving "retained projects" from starred sessions or turns, entries whose `projectName(cwd)` is sentinel SHALL NOT contribute.

#### Scenario: direct-api session is not retained as a unit

- **WHEN** turn `T1` with `sessionId === 'direct-api'` is in `starredTurns`
- **THEN** `direct-api` is not added to the retained-session set
- **AND** other turns with `sessionId === 'direct-api'` are not protected by this star alone

#### Scenario: (unknown) project is not retained as a unit

- **WHEN** turn `T1` with `projectName(T1.cwd) === '(unknown)'` is in `starredTurns`
- **THEN** `(unknown)` is not added to the retained-project set

---

### Requirement: Star-protected entries bypass `RESTORE_DAYS` cutoff at startup

`restoreFromLogs()` SHALL load every index entry whose star-protection check is true, even when `meta.id.slice(0, 10) < cutoffStr`. The same protection helper used by `pruneLogs()` SHALL be reused so the two paths agree.

#### Scenario: Old starred turn is restored

- **WHEN** `RESTORE_DAYS=3`, today is `2026-05-02`, and the index contains an entry from `2026-04-20` whose id is in `starredTurns`
- **THEN** the entry is restored to memory and visible in the dashboard after startup

#### Scenario: Old non-starred turn is not restored

- **WHEN** the same conditions hold but the entry's id is not starred and its session and project are not starred
- **THEN** the entry is skipped during restore (existing behavior unchanged)

---

### Requirement: Project name extraction is shared between server and client

The server SHALL expose a `getProjectName(cwd)` helper in `server/helpers.js` matching the existing client behavior in `public/miller-columns.js`: returns `(unknown)` for null/undefined cwd, returns the input verbatim if it starts with `(`, and returns the last non-empty path segment otherwise. The frontend may keep its own copy of this small helper.

#### Scenario: Standard cwd

- **WHEN** `getProjectName('/Users/justin/dev/ccxray')` is called
- **THEN** the result is `'ccxray'`

#### Scenario: Sentinel passthrough

- **WHEN** `getProjectName('(quota-check)')` is called
- **THEN** the result is `'(quota-check)'`

#### Scenario: Null cwd

- **WHEN** `getProjectName(null)` is called
- **THEN** the result is `'(unknown)'`

---

### Requirement: Settings load is robust to missing or malformed file

`readSettings()` SHALL initialize the three star arrays to empty when `settings.json` is missing, unparseable, or contains non-array values for these keys. The system SHALL log a single warning to stderr when the file exists and parses to a non-object, so silent erasure is observable.

#### Scenario: Fresh install

- **WHEN** `settings.json` does not exist
- **THEN** `starredProjects`, `starredSessions`, `starredTurns` are all `[]` in memory
- **AND** no warning is logged (this is the normal first-run path)

#### Scenario: Malformed file logs warning

- **WHEN** `settings.json` exists but parses to a string or array (not object)
- **THEN** the in-memory state falls back to defaults (all arrays empty)
- **AND** a single warning is logged to stderr identifying the file path
