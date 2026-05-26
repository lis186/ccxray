## 1. Agent column HTML + CSS

- [x] 1.1 Add agent list container (`#sp-agent-list`) to `index.html` inside `#diff-overlay`, before the existing version list
- [x] 1.2 Add `.sp-agent-list` CSS styles: 140px width, flex-shrink:0, border-right, overflow-y auto, matching `.sp-version-list` visual pattern
- [x] 1.3 Add `.sp-agent-item` CSS styles: active state, hover, version count badge, relative time display

## 2. Agent state + rendering

- [x] 2.1 Add `AGENT_ORDER` array and `spSelectedAgent` state variable to `system-prompt-ui.js`
- [x] 2.2 Create `renderAgentList(agents)` function: renders agent items sorted by `AGENT_ORDER`, shows label, version count, and relative time of latest version
- [x] 2.3 Create `selectAgent(agentKey)` function: updates `spSelectedAgent`, re-renders agent list active state, calls existing version list refresh

## 3. Remove hardcoded agent filter

- [x] 3.1 Replace `filter(v => v.agentKey === 'claude-code')` with `filter(v => v.agentKey === spSelectedAgent)` in `openSystemPromptPanel` and `updateSysPromptBadge`
- [x] 3.2 Replace hardcoded `agent=claude-code` in `loadContentForVersion` and `loadDiffForVersion` API calls with `agent=${spSelectedAgent}`

## 4. Version list enhancements

- [x] 4.1 Add relative time display to version items in `renderVersionList()` using `firstSeen` field
- [x] 4.2 Add size delta (`+1.2k` / `-0.5k`) with green/red coloring to version items, comparing `coreLen` with next older version

## 5. Layout integration

- [x] 5.1 Update `.sp-changelog-body` CSS to accommodate 3-column layout (agent + version + content)
- [x] 5.2 Handle mobile layout: hide agent column on narrow screens, add back navigation
- [x] 5.3 Wire up keyboard navigation: left/right arrow to switch columns, up/down to navigate within column

## 6. Verification

- [x] 6.1 Verify all 6 agent types appear in correct order with accurate version counts
- [x] 6.2 Verify switching agents correctly filters versions and loads content/diff
- [x] 6.3 Verify no hardcoded `'claude-code'` remains in `system-prompt-ui.js`
