# turn-card-display Delta Spec

## ADDED Requirements

### Requirement: Risk line shows sys-changed badge
The risk line SHALL display a `sys-changed` badge when the entry's `coreHash` differs from the most recent previous non-subagent entry in the same session that also has a non-null `coreHash`.

#### Scenario: Core hash changes between turns
- **WHEN** the current entry has a non-null `coreHash` that differs from the previous non-subagent entry's non-null `coreHash` in the same session
- **THEN** the risk line shows a `sys-changed` badge

#### Scenario: First turn with coreHash in session
- **WHEN** no previous non-subagent entry in the same session has a non-null `coreHash`
- **THEN** no `sys-changed` badge appears (no comparison possible)

#### Scenario: Either hash is null
- **WHEN** either the current or previous `coreHash` is null
- **THEN** no `sys-changed` badge appears

#### Scenario: Same core hash
- **WHEN** current and previous `coreHash` are identical
- **THEN** no `sys-changed` badge appears

### Requirement: Risk line shows thinking-stripped badge
The risk line SHALL display a `thinking-stripped` badge when the entry's `thinkingStripped` field is `true`.

#### Scenario: Thinking stripped flag is set
- **WHEN** `entry.thinkingStripped` is `true`
- **THEN** risk line shows a `thinking-stripped` badge

#### Scenario: Thinking stripped flag is absent
- **WHEN** `entry.thinkingStripped` is `false`, `undefined`, or `null`
- **THEN** no `thinking-stripped` badge appears
