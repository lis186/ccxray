## ADDED Requirements

### Requirement: REQUEST line attribution prefix

The server SHALL emit every logged REQUEST line with an attribution prefix that identifies the originating project, session, dashboard request number, logical turn, and step within that turn. The prefix format SHALL be `[<project>/<session8> · #<sessNum> R<turn>.<step>]`, where `<project>` is the basename of the session's recorded cwd, `<session8>` is the first 8 hex characters of the session id, `<sessNum>` is the per-session 1-based request sequence number that the dashboard uses for its `data-entry-idx`, `<turn>` is the logical turn number (count of human-text user messages in `messages[]`), and `<step>` is the request count within the current logical turn.

#### Scenario: First request of a fresh session

- **WHEN** a request arrives whose `messages[]` length is 1 and that single message is a `role: user` text-only message
- **THEN** the prefix SHALL render `R1.1`
- **AND** `<sessNum>` SHALL render `#1`

#### Scenario: Tool-loop continuation within a single human turn

- **WHEN** a request arrives whose final user message contains only `tool_result` blocks (no human-typed text), continuing the same logical turn opened by the previous human-text user message
- **THEN** the `<turn>` value SHALL be the count of all human-text user messages up to and including the most recent one
- **AND** the `<step>` value SHALL be the count of `role: user` messages from the most recent human-text user message inclusive to the end of `messages[]`

#### Scenario: Mixed text + tool_result content blocks

- **WHEN** a user message's `content` array contains both a `tool_result` block and a `text` block whose text matches `INJECTED_TAG_RE` (e.g. a `<system-reminder>` injected alongside tool results)
- **THEN** that message SHALL NOT count as a new logical turn
- **AND** the `<turn>` value SHALL be unchanged from the previous request

### Requirement: RESPONSE line attribution prefix

The server SHALL emit every logged RESPONSE line with the same attribution prefix as its originating REQUEST, followed by a status glyph and HTTP status code. A 2xx response SHALL render `✓ <code>`; any non-2xx response SHALL render `✗ <code>` followed by a short reason string when one is available from the upstream body.

#### Scenario: Successful response

- **WHEN** the upstream returns HTTP 200 to a request whose REQUEST line rendered `[ccxray/3f8a2c1b · #42 R5.3]`
- **THEN** the RESPONSE line SHALL begin with the same `[ccxray/3f8a2c1b · #42 R5.3]` prefix
- **AND** SHALL include `✓ 200`

#### Scenario: Rate-limited response

- **WHEN** the upstream returns HTTP 429 with body containing `rate_limit_exceeded`
- **THEN** the RESPONSE line SHALL include `✗ 429 rate_limit_exceeded`
- **AND** SHALL share the prefix of the originating request

### Requirement: Special-case session display

The server SHALL render four non-standard session conditions with distinct, unambiguous prefix forms instead of slicing the placeholder identifier as if it were a UUID.

- A request classified as `isQuotaCheck` SHALL render the prefix `[quota-check]` with no project, session, or turn fields.
- A request whose tracked session id is the literal `'direct-api'` SHALL render the session id verbatim as `direct-api` (no truncation).
- A request classified as `isLikelySubagent` for which `inferParentSession()` returns null SHALL render `[orphan/<reqId>]` where `<reqId>` is the 12-char request id assigned by the proxy.
- A request whose session was attributed via `inferParentSession()` (i.e. `sessionInferred` is true) SHALL render the session id followed by a trailing `~` character (e.g. `3f8a2c1b~`).

#### Scenario: Quota check

- **WHEN** a request matches `isQuotaCheck` (max_tokens=1, messages=[{role:user, content:'quota'}], no system)
- **THEN** the REQUEST line prefix SHALL render exactly `[quota-check]`

#### Scenario: Inferred subagent attributed to a parent session

- **WHEN** a request lacks `metadata.user_id`, lacks a system prompt, and `inferParentSession()` returns session `3f8a2c1b-...`
- **THEN** the prefix SHALL render `[<parent-project>/3f8a2c1b~ R<n>.<m>]`

#### Scenario: Orphan subagent with no inferable parent

- **WHEN** a request is classified as a likely subagent and `inferParentSession()` returns null
- **THEN** the prefix SHALL render `[orphan/<reqId>]` and SHALL NOT attribute the request to any active session

### Requirement: cwd fallback via hub client registry

When a session has no recorded cwd at the moment a request is logged (the system prompt that carries `Primary working directory` has not yet been seen for that session), the server SHALL attempt to resolve the project name from the hub client registry before falling back to a literal `?`.

#### Scenario: Resolved from hub client registry

- **WHEN** a request arrives for session `S` whose `sessionMeta[S].cwd` is undefined and the hub client registry has exactly one client whose `pid` is associated (directly or by 1:1 inference) with session `S`
- **THEN** the project field SHALL render the basename of that client's registered cwd

#### Scenario: Unresolvable cwd

- **WHEN** a request arrives whose session has no recorded cwd and the hub client registry has no matching or unambiguous client
- **THEN** the project field SHALL render `?`
- **AND** the rest of the prefix (session, turn, step) SHALL still render normally

### Requirement: Shared injected-tag classifier

The server and the dashboard SHALL classify a `text` content block as "injected" (i.e. not a human turn opener) using one shared regular expression and one shared classifier function loaded from a single source-of-truth module. The shared module SHALL be loadable both via Node `require` and via browser `<script src>`.

#### Scenario: Classifier agrees on a system-reminder message

- **WHEN** a user message's first text block begins with `<system-reminder>`
- **THEN** the classifier SHALL return `false` for "is human turn opener" in both server-side and dashboard-side calls
- **AND** both call sites SHALL produce identical classifications for the same input

#### Scenario: New injected tag added in one place

- **WHEN** a maintainer adds a new tag name to the shared module's regex
- **THEN** both server logging and dashboard rendering SHALL reflect the change without further edits in either consumer file

### Requirement: computeTurnStep is a pure function

The turn/step computation SHALL be implemented as a pure function `computeTurnStep(messages)` that takes a Claude API `messages[]` array and returns `{ turn: number, step: number }`. It SHALL NOT read or mutate any module-level state, perform I/O, or depend on request timing.

#### Scenario: Identical inputs produce identical outputs

- **WHEN** `computeTurnStep` is invoked twice with the same `messages` array
- **THEN** both invocations SHALL return identical `{ turn, step }` values

#### Scenario: Empty messages array

- **WHEN** `computeTurnStep` is invoked with `[]`
- **THEN** it SHALL return `{ turn: 0, step: 0 }` and SHALL NOT throw
