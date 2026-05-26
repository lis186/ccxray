## ADDED Requirements

### Requirement: f-key star adapter
`getStarTargetFromSelection()` SHALL wrap `window.targetFromCurrentSelection()` and return `{ level, id, starred }` or `null`.

- SHALL return `null` if `window.xrayStars` is falsy
- SHALL return `null` if `targetFromCurrentSelection()` returns null or kind is unknown
- For `kind === 'step'`: `id = t.entryId + '::' + t.stepIdx + (t.sub == null ? '' : ':' + t.sub)`, `level = 'step'`, `starred = xrayStars.steps.has(id)`
- For `kind === 'turn'`: `level = 'turn'`, `id = t.entryId`, `starred = xrayStars.turns.has(id)`
- For `kind === 'session'`: SHALL return `null` if `t.sessionId === 'direct-api'`; otherwise `level = 'session'`, `id = t.sessionId`, `starred = xrayStars.sessions.has(id)`
- For `kind === 'project'`: SHALL return `null` if `t.project === '(unknown)'` or `t.project === '(quota-check)'`; otherwise `level = 'project'`, `id = t.project`, `starred = xrayStars.projects.has(id)`

#### Scenario: Step context returns step target
- **WHEN** a timeline step is selected and `xrayStars` is available
- **THEN** adapter returns `{ level: 'step', id: '<entryId>::<stepIdx>', starred: <boolean> }`

#### Scenario: Turn context returns turn target
- **WHEN** `focusedCol === 'turns'` and a turn is selected
- **THEN** adapter returns `{ level: 'turn', id: '<entryId>', starred: <boolean> }`

#### Scenario: Session sentinel blocked
- **WHEN** selected session is `'direct-api'`
- **THEN** adapter returns `null`

#### Scenario: Project sentinel blocked
- **WHEN** selected project is `'(unknown)'` or `'(quota-check)'`
- **THEN** adapter returns `null`

#### Scenario: No selection returns null
- **WHEN** nothing is selected in any column
- **THEN** adapter returns `null`

---

### Requirement: f key handler
The `keydown` listener SHALL handle `key === 'f'` at a position that executes in both `isFocusedMode` and main mode — after tab-switching and before the `isFocusedMode` block.

- SHALL call `getStarTargetFromSelection()`
- If result is non-null: call `e.preventDefault()`, call `window.toggleStar(target.level, target.id, !target.starred)`, then show toast
- If result is null: SHALL still `return` (silently, no side effects)
- Toast format: `(willStar ? '★' : '☆') + ' ' + levelLabel + ' ' + (willStar ? 'starred' : 'unstarred')`, duration 2000ms
- Level labels: `{ turn: 'Turn', session: 'Session', project: 'Project', step: 'Step' }`

#### Scenario: Star a turn via f key
- **WHEN** a turn is selected and `f` is pressed and turn is not starred
- **THEN** `toggleStar('turn', id, true)` is called and toast shows `★ Turn starred`

#### Scenario: Unstar a session via f key
- **WHEN** a session is selected and `f` is pressed and session is starred
- **THEN** `toggleStar('session', id, false)` is called and toast shows `☆ Session unstarred`

#### Scenario: f key works in focused mode timeline
- **WHEN** `isFocusedMode === true` and `selectedSection === 'timeline'` and a step is selected and `f` is pressed
- **THEN** `toggleStar('step', id, !starred)` is called and toast confirms

#### Scenario: f key no-op on sentinel
- **WHEN** selected session is `'direct-api'` and `f` is pressed
- **THEN** no star toggle occurs and no toast is shown

#### Scenario: f key no-op in input
- **WHEN** cursor is inside `INPUT` or `TEXTAREA` and `f` is pressed
- **THEN** no star toggle occurs (input guard at top of keydown listener)
