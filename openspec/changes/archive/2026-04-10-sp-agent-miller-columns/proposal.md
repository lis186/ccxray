## Why

The System Prompt page hardcodes `claude-code` as the only visible agent type, ignoring 5 other agent types (general-purpose, explore, web-search, title-generator, name-generator) that the backend already correctly classifies. Users cannot inspect how subagent prompts differ or track their version history — this was the root cause of the "agent identity conflation" confusion reported when the Explore subagent received the main agent's identity description.

## What Changes

- Add a left-most **Agent Types** column to the System Prompt page, converting it from a 2-column layout (versions + content/diff) to a 3-column Miller layout (agents → versions → content/diff).
- Agent list is ordered by role hierarchy: main agent first, then subagents, then utilities.
- Each agent item shows name, version count, and latest version date.
- Selecting an agent filters the version list to that agent's versions only.
- Remove all hardcoded `'claude-code'` filters in `system-prompt-ui.js`.
- Version list items show relative time and size delta vs previous version (matching the session list pattern).
- API already supports `?agent=` parameter — no backend changes needed.

## Capabilities

### New Capabilities
- `sp-agent-columns`: Three-column Miller layout for the System Prompt page with agent type filtering, version history per agent, and content/diff viewing.

### Modified Capabilities

(none — no existing spec-level behavior changes)

## Impact

- `public/system-prompt-ui.js`: Major refactor — replace 2-column layout with 3-column, remove hardcoded agent filter, add agent selection state.
- `public/style.css`: Add agent column styles, adjust existing SP layout grid.
- `public/index.html`: May need minor HTML structure changes for the new column.
- `server/routes/api.js`: No changes needed — already returns `agents` array and supports `?agent=` filter.
