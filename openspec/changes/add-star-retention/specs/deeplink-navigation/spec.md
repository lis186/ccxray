## Capability: deeplink-navigation

Canonical TargetRef navigation system used by deep links, star-popover navigation, and URL breadcrumb sync. Any selection in the Miller-column UI is expressible as a URL; pasting that URL into a new tab navigates directly to the same view.

---

### Requirement: TargetRef is the canonical navigation unit

A TargetRef is a plain object with a `kind` discriminant and kind-specific fields:

| kind | Fields |
|---|---|
| `'project'` | `project: string` |
| `'session'` | `sessionId: string` |
| `'turn'` | `entryId: string`, `section?: string` |
| `'step'` | `entryId: string`, `stepIdx: number`, `sub: string\|number\|null`, `section?: 'timeline'` |

All navigation functions — `navigateTarget`, star-popover row click, keyboard shortcuts — accept a TargetRef. TargetRef is never stored on disk; it is an in-memory shape produced by the codec functions and consumed by the navigator.

#### Scenario: targetFromStar produces a TargetRef for each star kind

- **WHEN** `targetFromStar('turn', entryId)` is called
- **THEN** it returns `{ kind: 'turn', entryId }`

- **WHEN** `targetFromStar('step', stepStarId)` is called with a valid `<entryId>::<stepIdx>[:<sub>]` string
- **THEN** it returns `{ kind: 'step', entryId, stepIdx, sub }`

- **WHEN** `targetFromStar('step', malformedId)` is called
- **THEN** it returns `null`

---

### Requirement: Canonical URL parameter encoding

`writeTargetToUrlParams(target, params)` encodes a TargetRef into a `URLSearchParams` object:

| kind | Parameters written |
|---|---|
| project | `target=project`, `p=<name>` |
| session | `target=session`, `s=<sid.slice(0,8)>` |
| turn | `target=turn`, `e=<entryId>`, `p=<proj>`, `s=<sid8>`, `t=<displayNum>`, `sec=<section>` (if set) |
| step | `target=step`, `e=<entryId>`, `p=<proj>`, `s=<sid8>`, `t=<displayNum>`, `sec=timeline`, `step=<stepIdx>[:<sub>]` |

Step path encoding: `sub === 'thinking'` → `<idx>:thinking`; `typeof sub === 'number'` → `<idx>:<sub>`; `sub == null` → `<idx>`.

#### Scenario: Round-trip encode → decode preserves step identity

- **GIVEN** a TargetRef `{ kind: 'step', entryId: 'X', stepIdx: 5, sub: 'thinking' }`
- **WHEN** encoded via `writeTargetToUrlParams`, then decoded via `targetFromDeepLinkParams`
- **THEN** the decoded target has `kind='step'`, `entryId='X'`, `stepIdx=5`, `sub='thinking'`

---

### Requirement: URL parameter decoding with legacy support

`targetFromDeepLinkParams(params)` returns `{ target: TargetRef|null, failures: string[] }`.

**Canonical formats** (resolved first):

| `target=` | Required params | Resolved kind |
|---|---|---|
| `step` | `e=<entryId>`, `step=<path>` | step |
| `turn` | `e=<entryId>` | turn |
| `session` | `s=<sid>` | session |
| `project` | `p=<name>` | project |

**Legacy formats** (resolved when `target=` is absent):

| Present params | Resolved kind |
|---|---|
| `s=` + `msg=` | step (via `_decodeLegacyMsgSelection`) |
| `s=` + `t=` | turn |
| `s=` alone | session |
| `p=` alone | project |

`_decodeLegacyMsgSelection(msg)` decodes an integer of the form `stepIdx * 1000 + subIdx`:
- `subIdx === 999` → `sub = 'thinking'`
- `subIdx === 0` → `sub = null`
- other → `sub = subIdx`

Short session IDs are resolved via prefix match in `sessionsMap` (first match wins).

#### Scenario: Invalid step path in canonical step link

- **WHEN** `?target=step&e=X&step=abc` (non-integer step path) is decoded
- **THEN** `target` is `null` and `failures` contains a message about the invalid step

#### Scenario: Session prefix resolves to full ID

- **WHEN** `?s=abc12345` is present and a session `abc12345-xxxx-yyyy` exists in `sessionsMap`
- **THEN** the resolved target uses the full session ID

---

### Requirement: Navigator routes through all Miller columns

`navigateTarget(target, opts)` selects the correct project → session → turn → section → step. It returns a Promise resolving to `{ ok: boolean, reason?: string }`.

Routing rules per kind:

- **project**: `selectProject(target.project)`, focus `'projects'`
- **session**: resolve project from `sess.cwd`, `selectProject`, `selectSessionAndLatestTurn`, apply session filter `'all'` if session is inactive
- **turn**: resolve project, `selectProject`, `selectSession`, `selectTurn`, optionally `selectSection`
- **step**: all turn steps + `_ensureEntryLoadedByIndex(idx)`, then `_applyStepTargetWhenReady`

Each intermediate step checks "already selected" before calling the selection function to avoid redundant re-renders.

#### Scenario: navigateTarget on missing entry returns failure

- **WHEN** `navigateTarget({ kind: 'turn', entryId: 'nonexistent' })` is called
- **THEN** the returned promise resolves with `{ ok: false, reason: 'missing-entry' }`

#### Scenario: navigateTarget clears inactive filter for inactive sessions

- **WHEN** the target session has `getStatusClass === 'sdot-off'` and `sessionFilterMode !== 'all'`
- **THEN** `setSessionFilter('all')` is called before `selectSession`

---

### Requirement: Step target polls until the timeline has rendered

`_applyStepTargetWhenReady(idx, stepIdx, sub, attempts, opts)` defers via `requestAnimationFrame` until all of the following are true, then calls `selectStep` and triggers scroll:

1. `allEntries[idx]` exists and `reqLoaded === true`
2. `prepareTimelineSteps` and `selectStep` are defined
3. `currentSteps[stepIdx]` exists
4. The sub-part exists: for `sub === 'thinking'`, `step.thinking !== null`; for numeric `sub`, `step.calls[sub]` exists; for `sub == null`, always true

Default max attempts is 120 rAF frames. On timeout, resolves with `{ ok: false, reason: 'render-timeout' }`.

#### Scenario: Times out gracefully when step never renders

- **WHEN** the timeline never renders `stepIdx` within 120 rAF frames
- **THEN** the promise resolves with `{ ok: false, reason: 'render-timeout' }` (no thrown error, no infinite loop)

---

### Requirement: URL sync guards prevent address-bar races

`syncUrlFromState()` is called after every column selection to write the current TargetRef to `history.replaceState`.

Two guards prevent incorrect intermediate writes:

1. **`_loading` guard**: `syncUrlFromState` is a no-op while the initial `/_api/entries` fetch is in progress, so chunked `addEntry` calls do not clobber the incoming deep-link params.
2. **`_targetNavigationUrlSyncDepth` counter**: `_runTargetNavigation` increments the counter before running its navigation function and decrements after. `syncUrlFromState` returns early when the counter is `> 0`. A single `syncUrlFromState` call is made after the full navigation resolves.

`syncUrlFromState` clears `step=` and `sec=timeline` params when the selected section is not `'timeline'`.

#### Scenario: Intermediate column renders do not clobber deep-link URL

- **GIVEN** `navigateTarget` is executing and has called `selectProject` (depth counter = 1)
- **WHEN** `selectProject` internally calls `syncUrlFromState`
- **THEN** `syncUrlFromState` returns without writing to `history.replaceState`
- **AND** one final `replaceState` call occurs after `navigateTarget` resolves

---

### Requirement: Keyboard shortcuts jump to step types and sync URL

| Key | Action |
|---|---|
| `e` | Jump to next error step in timeline |
| `E` | Jump to previous error step |
| `s` | Jump to next Skill tool call |
| `S` | Jump to previous Skill tool call |
| `a` | Jump to next Agent/Task (subagent) call |
| `A` | Jump to previous Agent/Task (subagent) call |
| `m` | Jump to next MCP tool call (`mcp__` prefix) |
| `M` | Jump to previous MCP tool call |

Each jump is **position-aware**: when the current step is not a matching type, the nearest candidate forward (next) or backward (prev) from the current DOM position is selected. Wraps around when no candidate exists beyond the current position.

Tool call step rows carry a `data-tool="<toolName>"` attribute written at render time, enabling O(1) DOM attribute queries without reading text content.

After each jump, `syncUrlFromState()` is called so the URL reflects the new step selection.

#### Scenario: URL updates after keyboard jump

- **WHEN** the user presses `e` and a next error step exists
- **THEN** the address bar URL contains `?target=step&e=<entryId>&step=<idx>` within one rAF

#### Scenario: Position-aware navigation skips past non-matching steps

- **GIVEN** the user is on step #50 (a Bash call) and Skill calls exist at steps #10 and #80
- **WHEN** the user presses `s`
- **THEN** the selection jumps to step #80, not step #10

---

### Requirement: Loading UX during initial entry fetch

Before `fetch('/_api/entries')` resolves, the Projects column MUST show a visible loading state:

- `window._entriesLoading = true` is set immediately before the fetch
- `window._entriesLoadingText` is `'Resolving link…'` if a deep-link param is present, otherwise `'Loading…'`
- `renderProjectsCol()` renders a `<div class="col-empty loading-state">` placeholder (with spinner) when the flag is set and no projects exist yet
- The flag is cleared after all `addEntry` calls complete

During batch load, `addEntry` is processed in chunks of 60 entries with `requestAnimationFrame` yields between chunks. Progress text updates to `'Restoring… K / N'` after each chunk, where K is entries processed so far and N is the total count.

After all chunks complete, a single sort pass and single `renderProjectsCol()` call run (not once per entry).

#### Scenario: Projects column shows Loading… before first entry

- **WHEN** the page loads with `window._entriesLoading = true` and `projectsMap` is empty
- **THEN** `renderProjectsCol()` renders a spinner and loading text, not an empty state

#### Scenario: Progress text updates per chunk

- **WHEN** 847 entries are processed in 14 chunks of 60
- **THEN** text transitions through `'Restoring… 60 / 847'`, `'Restoring… 120 / 847'`, …, `'Restoring… 847 / 847'`

---

### Requirement: Server starts HTTP listener before log restore

`startServer()` calls `server.listen()` and resolves its public promise before invoking restore, prune, pricing warm-up, or cost worker. The sequence is:

1. `server.listen()` → HTTP becomes available
2. `runPostListenStartupTasks()` begins asynchronously:
   - Sets `store.restoreState` to `{ phase: 'restoring', restoring: true, complete: false }`
   - Runs `restoreFromLogs()`; on success sets `{ phase: 'ready', complete: true }`; on error sets `{ phase: 'error', error: message }`
   - Then runs `pruneLogs()` and `warmUpCosts()` (only on success)

`GET /_api/entries` response includes `restore: { ...store.restoreState, entryCount }` so the client can display restore status.

All static asset responses (`text/html`, `text/css`, `application/javascript`) include `Cache-Control: no-store` so browsers never serve a stale build after a restart.

#### Scenario: Dashboard loads immediately, then entries appear

- **WHEN** `ccxray` starts and restore takes 3 seconds
- **THEN** the dashboard HTML is served within ~100ms of process start
- **AND** entries stream in during the 3-second restore window (via chunked addEntry + SSE)

#### Scenario: Restore failure does not block dashboard

- **WHEN** `restoreFromLogs()` throws
- **THEN** `store.restoreState.phase === 'error'` and `prune` + `warmUpCosts` are skipped
- **AND** the dashboard is still usable (zero entries, no crash)
