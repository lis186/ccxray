## ADDED Requirements

### Requirement: Unified project sort function
`miller-columns.js` SHALL export a `getFirstProject()` function that encapsulates project sort priority (pinned → streaming → active → lastId descending). All callers—including `entry-rendering.js` initial selection—SHALL use this function exclusively. Duplicate sort logic in `entry-rendering.js` SHALL be removed.

#### Scenario: Sort order consistent between visual and auto-selection
- **WHEN** the dashboard loads
- **THEN** the project highlighted by auto-selection SHALL be the same project rendered first in the Projects column

### Requirement: Conditional cascade on initial load
On page load without a deep-link URL parameter, the system SHALL auto-select the most relevant project and cascade into sessions and turns according to these rules, evaluated in order:

1. **Streaming session present**: if the selected project has a session with `status === 'streaming'`, auto-select that session and its latest turn, set `focusedCol = 'turns'`
2. **Single visible session**: if the selected project has exactly one visible session, auto-select it and its latest turn, set `focusedCol = 'turns'`
3. **Multiple sessions**: auto-select the project only, set `focusedCol = 'sessions'`
4. **No sessions**: auto-select the project only, set `focusedCol = 'projects'`

#### Scenario: Streaming session auto-selected on load
- **WHEN** the page loads without a deep-link
- **AND** the first project has a session with `status === 'streaming'`
- **THEN** that session and its latest turn SHALL be selected automatically
- **AND** `focusedCol` SHALL be `'turns'`

#### Scenario: Single session auto-selected on load
- **WHEN** the page loads without a deep-link
- **AND** the first project has exactly one visible session (non-streaming)
- **THEN** that session and its latest turn SHALL be selected automatically
- **AND** `focusedCol` SHALL be `'turns'`

#### Scenario: Multiple sessions stop at sessions column
- **WHEN** the page loads without a deep-link
- **AND** the first project has more than one visible session
- **THEN** only the project SHALL be selected
- **AND** `focusedCol` SHALL be `'sessions'`

#### Scenario: Deep-link bypasses auto-selection
- **WHEN** the page loads with URL parameters identifying a specific entry
- **THEN** the deep-link restoration logic SHALL run instead
- **AND** the conditional cascade SHALL NOT execute

### Requirement: Empty sessions feedback
When a project has no sessions, the sessions column SHALL display a placeholder message (e.g., "此專案尚無記錄") instead of being blank.

#### Scenario: No sessions placeholder visible
- **WHEN** a project with zero sessions is selected
- **THEN** the sessions column SHALL show a placeholder text
- **AND** the turns column SHALL remain empty
