## ADDED Requirements

### Requirement: Versioned parser schemas per concern and provider

Detection logic for tool / MCP / skill / agent-type SHALL be expressed as JSON schemas under `server/parsers/`. There SHALL be at minimum one schema per (concern, provider) pair:

- `parsers/anthropic-tools.schema.json`
- `parsers/anthropic-skills.schema.json`
- `parsers/anthropic-agent-types.schema.json`
- `parsers/mcp-tools.schema.json` (provider-agnostic MCP naming convention)
- `parsers/codex-tools.schema.json`

Each schema SHALL include a `version` field (semver) and a `last_verified_against` field (ISO 8601 date). Inline string matching in `server/system-prompt.js`, `server/store.js`, or other code paths SHALL be removed in favor of the schema-driven parser.

#### Scenario: Schema referenced at runtime

- **WHEN** ccxray processes an Anthropic response containing a `tool_use` block
- **THEN** the tool name SHALL be classified using `parsers/anthropic-tools.schema.json` and SHALL NOT be matched against any hardcoded list embedded in other files

### Requirement: Snapshot fixtures per provider

Test fixtures under `test/fixtures/parser/` SHALL cover at minimum the following cases per provider:

- Basic tool invocation
- Tool invocation with a skill marker active
- Subagent invocation (Anthropic Task tool)
- MCP server tool invocation
- An intentional unknown tool name

Each fixture SHALL pair an input (request or response JSON) with an expected parser output snapshot. Parser changes SHALL require committing new snapshots and SHALL pass review before merge.

#### Scenario: Snapshot drift fails CI

- **WHEN** parser code is changed in a way that alters fixture output
- **THEN** the test suite SHALL fail with a diff between old and new snapshot until the snapshot is updated and reviewed

### Requirement: Sentinel counters for unknown tokens

When the parser encounters a token, marker, or block that does not match any registered pattern in the relevant schema, it SHALL increment one of:

- `ccxray.parser.unknown_tool_total{provider}`
- `ccxray.parser.unknown_skill_marker_total{provider}`
- `ccxray.parser.unknown_mcp_format_total`
- `ccxray.parser.fallback_used_total{parser,reason}`

The unknown event SHALL also be recorded with a short sample to `~/.ccxray/parser-drift.log` for later inspection via `ccxray parser report`.

#### Scenario: Unknown tool name observed

- **WHEN** ccxray sees a `tool_use` block whose `name` does not match any pattern in `parsers/anthropic-tools.schema.json`
- **THEN** `ccxray.parser.unknown_tool_total{provider="anthropic"}` SHALL increment by 1 and a sample SHALL be appended to `~/.ccxray/parser-drift.log`

### Requirement: Reconciliation invariants

For every processed entry the parser SHALL verify the following invariants:

- Number of `tool_use` blocks in the response equals the number of tool entries extracted by the parser.
- Sum of input/output token counts attributed by the parser equals the corresponding values in the upstream usage block.

When an invariant fails, `ccxray.parser.reconciliation_mismatch_total{type}` SHALL increment by 1 and the entry ID SHALL be appended to `~/.ccxray/parser-drift.log`. The mismatch SHALL NOT alter the entry's local log content.

#### Scenario: Tool count mismatch

- **WHEN** a response contains 3 `tool_use` blocks but the parser extracts only 2 tool entries
- **THEN** `ccxray.parser.reconciliation_mismatch_total{type="tool_count"}` SHALL increment and the entry ID SHALL be recorded in the drift log

### Requirement: Parser error isolation

Parser code SHALL be wrapped in try/catch boundaries. On exception, `ccxray.parser.error_total{parser,error_type}` SHALL increment and the originating entry SHALL still be written to local logs. The OTel span/metric for the affected entry SHALL be tagged `ccxray.parser.degraded=true`. Parser failure SHALL NOT propagate to the proxy path or terminate ccxray.

#### Scenario: Parser throws

- **WHEN** the skill marker parser throws a runtime exception while processing a response
- **THEN** ccxray SHALL log the exception locally, increment `ccxray.parser.error_total{parser="anthropic-skills",error_type="<class>"}`, write the entry to disk as usual, and continue forwarding subsequent requests

### Requirement: `ccxray parser report` command

The `ccxray parser report` command SHALL print the top unknown tokens by frequency from the last 7 days of `~/.ccxray/parser-drift.log`, grouped by category (tool / skill / MCP / fallback). The output SHALL include sample tokens and a GitHub issue body template the user can copy to file a drift report.

#### Scenario: Reporting after seeing unknown markers

- **WHEN** the engineer has accumulated unknown markers and runs `ccxray parser report`
- **THEN** the command SHALL print a categorized summary, the most recent 5 unique samples per category, and a formatted GitHub issue body
