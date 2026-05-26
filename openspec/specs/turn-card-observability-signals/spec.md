# turn-card-observability-signals Specification

## Purpose
Exposes two AI behavior signals—system prompt core version change, and thinking context strip—as first-class fields in the entry model and visible indicators in the turn card.

> **Removed from scope**: A third signal (`thinkingBudget` extracted from `parsedBody.thinking.budget_tokens`) was originally part of this capability. It was removed before v1.7.0 ship: Claude Code does not send `thinking.budget_tokens` (Anthropic decides budget allocation server-side based on model + effort), so the field is null for the dominant ccxray user base and the resulting `budget:high|med|low` UI badge would be permanently dead. Pre-mortem analysis ruled out a `thinkingDuration` drop heuristic as a replacement (high false-positive rate from natural workload variance, no actionable user response, semantic overlap with `thinking-stripped`). Re-evaluate when Anthropic API responses surface server-side reasoning effort metadata.

## Requirements

### Requirement: Entry captures system prompt core hash
Each proxy entry SHALL include a `coreHash` field containing the MD5 hash of the `coreInstructions` block only (excluding dynamic environment content such as git status and working directory).

#### Scenario: Claude Code request with full system prompt
- **WHEN** the proxied request has a Claude Code system prompt (3+ blocks, b2 length ≥ 500)
- **THEN** the entry's `coreHash` is a 12-character hex string derived from `coreInstructions`

#### Scenario: Non-Claude Code request or short system prompt
- **WHEN** the proxied request lacks a qualifying Claude Code system prompt
- **THEN** the entry's `coreHash` is `null`

#### Scenario: Same core instructions, different dynamic content
- **WHEN** two consecutive turns have identical `coreInstructions` but different git status in the system prompt
- **THEN** both entries have the same `coreHash`

#### Scenario: Core instructions change (new Claude Code version)
- **WHEN** Anthropic ships a new Claude Code version with changed `coreInstructions`
- **THEN** entries after the update have a different `coreHash` from entries before

#### Scenario: Field persists through restart
- **WHEN** ccxray restarts and restores entries from index.ndjson
- **THEN** restored entries retain their `coreHash` value

### Requirement: Entry flags thinking context strip
Each proxy entry SHALL include a `thinkingStripped` field that is `true` when the previous turn in the same session produced thinking output but the current request's messages contain no thinking blocks.

#### Scenario: Previous turn had thinking, current messages lack it
- **WHEN** the previous non-subagent entry in the same session has `thinkingDuration > 0` AND the current `parsedBody.messages` contains no `{ type: "thinking" }` blocks in any assistant message AND message count did not drop by more than 4 (no compaction)
- **THEN** the entry's `thinkingStripped` is `true`

#### Scenario: No previous thinking
- **WHEN** no previous non-subagent entry in the same session has `thinkingDuration > 0`
- **THEN** the entry's `thinkingStripped` is `undefined` or `false`

#### Scenario: Compaction suppresses the flag
- **WHEN** the previous entry had `thinkingDuration > 0` BUT the message count dropped by more than 4 (compaction heuristic)
- **THEN** the entry's `thinkingStripped` is NOT set to `true`

#### Scenario: Current messages contain thinking blocks
- **WHEN** the current request's messages include at least one assistant message with a `{ type: "thinking" }` block
- **THEN** the entry's `thinkingStripped` is NOT set to `true`
