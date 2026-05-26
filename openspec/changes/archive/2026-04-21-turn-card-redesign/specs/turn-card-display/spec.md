## ADDED Requirements

### Requirement: Turn card has five-layer visual hierarchy
Turn card SHALL render in five distinct layers with decreasing visual weight: identity, title, context bar, risk badges, secondary info.

#### Scenario: Normal turn renders all layers
- **WHEN** a turn has title, context data, no risk signals
- **THEN** card renders identity line, title line, context bar, secondary line (risk layer absent)

#### Scenario: Turn with risk signals renders risk layer
- **WHEN** a turn has `toolFail`, `hasCredential`, `duplicateToolCalls`, or `max_tokens` stop reason
- **THEN** a risk badges line appears between the context bar and secondary line

#### Scenario: Risk layer absent when no risks
- **WHEN** a turn has no risk signals
- **THEN** no risk row is rendered (no empty line)

### Requirement: Identity line shows turn number, model, status dot, wait indicator
The identity line SHALL show: turn number (`#N` or `sN` for subagent), model short name, a colored dot for success/failure, and a ↵ symbol when stop_reason is `end_turn`.

#### Scenario: Successful main turn
- **WHEN** turn status is 2xx and stop_reason is `end_turn`
- **THEN** identity line shows `#N  model  ● ↵` with green dot

#### Scenario: Failed turn
- **WHEN** turn status is not 2xx
- **THEN** identity line shows red dot, no ↵

#### Scenario: Tool-use turn (not waiting for user)
- **WHEN** stop_reason is `tool_use`
- **THEN** identity line shows status dot but no ↵

#### Scenario: Subagent turn
- **WHEN** `isSubagent` is true
- **THEN** identity line shows `╎ sN  model  ●` with indent marker

### Requirement: Context bar is always shown when context data available
The context bar SHALL remain full-width with colored segments (cache-read / cache-write / input) and percentage label.

#### Scenario: Context above 90%
- **WHEN** context usage exceeds 90% of max
- **THEN** percentage label renders in red

#### Scenario: Context between 70–90%
- **WHEN** context usage is 70–90%
- **THEN** percentage label renders in yellow

### Requirement: Risk badges surface actionable signals
The risk line SHALL show badges for: `⚠ cred` (credential detected), `⚠ tool-fail` (tool result error), `⚠ dupes` (duplicate tool calls), `⚠ max_tokens` (output truncated).

#### Scenario: Tool failure badge
- **WHEN** `toolFail` is true
- **THEN** `⚠ tool-fail` badge appears in risk line

#### Scenario: max_tokens badge
- **WHEN** stop_reason is `max_tokens`
- **THEN** `⚠ max_tokens` badge appears in risk line

#### Scenario: compact and inferred are not shown as badges
- **WHEN** turn is compacted or session is inferred
- **THEN** no visible badge; information available via tooltip on identity line

### Requirement: Secondary line shows timing, tools, cost
The secondary line SHALL show gap→elapsed time, tool names (up to 5 + overflow count), and cost.

#### Scenario: Time format with gap
- **WHEN** a previous turn exists in the same session
- **THEN** secondary line shows `⏸Xs→Ys` where X is gap and Y is elapsed

#### Scenario: Gap color reflects cache warmth
- **WHEN** gap < 5 minutes
- **THEN** gap value renders green

#### Scenario: No previous turn
- **WHEN** this is the first turn in a session
- **THEN** only elapsed time shown, no gap prefix

### Requirement: compact and inferred metadata available via tooltip
The `compact` and `inferred` states SHALL be accessible but not visually prominent.

#### Scenario: Compacted turn tooltip
- **WHEN** turn is compacted
- **THEN** identity line element has a tooltip indicating context was compacted
