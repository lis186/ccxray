## Context

The System Prompt page currently uses a 2-column layout (version list + content/diff panel) hardcoded to filter `claude-code` agent type. The backend API (`/_api/sysprompt/versions`) already returns an `agents` array with all classified types and supports `?agent=` filtering on the diff endpoint. The dashboard's main page uses a Miller-column pattern (Projects → Sessions → Turns → ...) that users are already familiar with.

Relevant files:
- `public/system-prompt-ui.js`: All SP page logic (320 lines)
- `public/style.css`: SP-specific styles (`.sp-*` classes)
- `public/index.html`: SP page HTML structure (`#diff-overlay`)
- `server/routes/api.js`: `/_api/sysprompt/versions` and `/_api/sysprompt/diff` endpoints

## Goals / Non-Goals

**Goals:**
- Add agent type column as leftmost column in the System Prompt page
- Order agents by role hierarchy (main → subagents → utilities)
- Show version count and relative time per agent
- Version items show relative time and size delta vs previous version
- Selecting agent filters the version list; selecting version loads content/diff
- Reuse existing version list + content/diff logic, parameterized by agent key

**Non-Goals:**
- Backend API changes (already sufficient)
- Cross-agent diff comparison (comparing claude-code vs explore prompts)
- Agent type filtering on the main dashboard

## Decisions

### 1. Layout: CSS Grid 3-column within existing `#diff-overlay`

**Choice**: Modify the existing `.sp-changelog-body` flex layout to accommodate a third column on the left.

**Rationale**: The SP page already uses a sidebar + main panel pattern. Adding a narrow left column (140px) for agents fits naturally. The existing `.sp-version-list` (200px) and `.diff-text-panel` (flex:1) remain as columns 2 and 3.

**Alternative considered**: Separate page/tab per agent — rejected because it breaks the comparison workflow (users want to quickly switch between agents).

### 2. Agent ordering: Hardcoded priority array

**Choice**: Define `AGENT_ORDER` array in system-prompt-ui.js:
```
['claude-code', 'general-purpose', 'explore', 'web-search', 'title-generator', 'name-generator']
```
Unknown agents appended alphabetically at the end.

**Rationale**: The hierarchy is stable and semantic (main → subagents → utilities). Dynamic sorting by version count or recency would lose the conceptual grouping.

### 3. State management: Single `spSelectedAgent` variable

**Choice**: Add `spSelectedAgent` (defaults to first agent in list). `spVersions` already exists — just filter by selected agent instead of hardcoded `'claude-code'`.

**Rationale**: Minimal state change. The version list and content/diff logic remain identical — only the data source changes.

### 4. Version list enhancements

**Choice**: Add relative time (e.g., "2h ago") and `+/-` size delta per version item, matching the session list pattern from the main dashboard.

**Rationale**: User explicitly requested parity with session list information density. The `firstSeen` and `coreLen` fields are already available from the API.

## Risks / Trade-offs

- **[Risk] Agent column on mobile**: The 3-column layout may not fit on narrow screens.
  → **Mitigation**: Use same mobile pattern as main dashboard — agent column hidden on mobile, accessible via back navigation.

- **[Risk] Empty agent types**: Some agents may have only 1 version with no diff to show.
  → **Mitigation**: Show "(no previous version)" as already handled by the diff loader.

- **[Risk] Version badge notification**: Currently only tracks `claude-code` for the "new version" badge.
  → **Mitigation**: Extend badge logic to check latest version across ALL agent types. Low priority — can be a follow-up.
