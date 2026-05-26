# sp-agent-columns Specification

## Purpose

Provides a three-column Miller layout for the System Prompt page, enabling users to browse system prompt versions across multiple agent types (claude-code, general-purpose, explore, web-search, title-generator, name-generator, and future unknowns). Replaces the prior hardcoded single-agent view with a data-driven agent selector, version list with relative time and size deltas, and a content/diff panel.

## Requirements

### Requirement: Agent type column
The System Prompt page SHALL display a leftmost column listing all known agent types. Each item SHALL show the agent label, version count, and relative time of the most recent version. The column width SHALL be approximately 140px.

#### Scenario: Agent list populated from API
- **WHEN** the System Prompt page opens
- **THEN** the agent column SHALL display all agent types returned by `/_api/sysprompt/versions` in the `agents` array

#### Scenario: Agent ordering
- **WHEN** agents are displayed
- **THEN** they SHALL be ordered by role hierarchy: claude-code, general-purpose, explore, web-search, title-generator, name-generator. Unknown future agents SHALL appear at the end, sorted alphabetically.

### Requirement: Agent selection filters versions
Selecting an agent type in the agent column SHALL filter the version list to show only versions belonging to that agent. The first agent SHALL be selected by default on page load.

#### Scenario: Select agent
- **WHEN** the user clicks an agent item
- **THEN** the version list SHALL update to show only versions with matching `agentKey`
- **AND** the first version in the filtered list SHALL be auto-selected
- **AND** the content/diff panel SHALL load for that version

#### Scenario: Default selection
- **WHEN** the System Prompt page opens
- **THEN** the first agent in the ordered list (claude-code) SHALL be selected by default

### Requirement: Version list enhancements
Each version item SHALL display relative time (e.g., "2h ago", "3d ago") and size delta compared to the next older version (e.g., "+1.2k", "-0.5k") with green/red coloring.

#### Scenario: Version with size change
- **WHEN** a version has a different `coreLen` than the next older version
- **THEN** the delta SHALL be displayed with a sign prefix and colored green (increase) or red (decrease)

#### Scenario: Version relative time
- **WHEN** a version is displayed
- **THEN** the `firstSeen` date SHALL be shown as relative time (e.g., "2h ago", "1d ago")

### Requirement: Three-column layout
The System Prompt page SHALL use a three-column Miller layout: Agent Types (left) → Versions (center) → Content/Diff (right). The layout SHALL match the visual pattern of the main dashboard's Miller columns.

#### Scenario: Desktop layout
- **WHEN** viewport width is >= 768px
- **THEN** all three columns SHALL be visible simultaneously

#### Scenario: Mobile layout
- **WHEN** viewport width is < 768px
- **THEN** only the currently active column SHALL be visible, with back navigation to return to the previous column

### Requirement: No hardcoded agent filter
The `system-prompt-ui.js` SHALL NOT contain any hardcoded `'claude-code'` string for agent filtering. All agent filtering SHALL be driven by the `spSelectedAgent` state variable.

#### Scenario: Agent parameter in API calls
- **WHEN** a content or diff API call is made
- **THEN** the `agent` query parameter SHALL use the value of `spSelectedAgent`, not a hardcoded string
