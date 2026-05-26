# turn-title-resolution Specification

## Purpose
TBD - created by archiving change turn-card-redesign. Update Purpose after archive.
## Requirements
### Requirement: Turn title resolved via four-step fallback
The server SHALL resolve a turn's display title using the following priority order, stopping at the first non-null result.

#### Scenario: Response has text content
- **WHEN** the Claude response contains at least one text block
- **THEN** title is the first sentence of the response text, truncated to 80 characters

#### Scenario: Response has no text, last user message has text
- **WHEN** response has no text blocks AND the last user message contains a text block
- **THEN** title is that user text, truncated to 80 characters

#### Scenario: Response has no text, last user message is all tool_results
- **WHEN** response has no text blocks AND the last user message contains only tool_result blocks
- **THEN** title is `↩ ToolA · ToolB · ToolC` listing distinct tool names from those results

#### Scenario: Subagent turn
- **WHEN** `isSubagent` is true
- **THEN** fallback steps 2–3 are skipped; title is taken from the FIRST user message in the request (the task description), truncated to 80 characters

#### Scenario: No text anywhere
- **WHEN** all fallback steps return null
- **THEN** title is null and the title line is not rendered

### Requirement: Tool result summary uses distinct tool names
When building the `↩ ToolA · ToolB` summary from tool_results, each tool name SHALL appear at most once regardless of how many times it appears in the batch.

#### Scenario: Multiple results from same tool
- **WHEN** three `tool_result` blocks all correspond to `Bash` calls
- **THEN** summary shows `↩ Bash`, not `↩ Bash · Bash · Bash`

### Requirement: Subagent title filters to pure text blocks only
When extracting the subagent task from the first user message, the server SHALL use only `type: "text"` blocks and ignore `tool_result`, system reminder XML, and other structured content.

#### Scenario: First user message contains mixed content
- **WHEN** first user message has both a text block and tool_result blocks
- **THEN** title uses only the text block content

