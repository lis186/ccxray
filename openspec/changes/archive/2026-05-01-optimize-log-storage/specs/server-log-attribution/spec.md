## MODIFIED Requirements

### Requirement: REQUEST line attribution prefix

The server SHALL emit every logged REQUEST line with an attribution prefix that identifies the originating project, session, dashboard request number, logical turn, and step within that turn. The prefix format SHALL be `[<project>/<session8> · #<sessNum> R<turn>.<step>]`, where `<project>` is the basename of the session's recorded cwd, `<session8>` is the first 8 hex characters of the session id, `<sessNum>` is the per-session 1-based request sequence number that the dashboard uses for its `data-entry-idx`, `<turn>` is the logical turn number (count of human-text user messages in `messages[]`), and `<step>` is the request count within the current logical turn.

The attribution prefix computation SHALL use `parsedBody.messages` (the in-memory full messages array available at request time), not the messages stored in `_req.json` on disk. This requirement is unchanged; the note clarifies that even though `_req.json` may now be in delta format (containing only `messages.slice(msgOffset)`), the in-memory `parsedBody.messages` always holds the full array because it is parsed from the live HTTP request body before any delta-write logic runs.

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

## ADDED Requirements

### Requirement: `_req.json` schema permits delta fields

The `_req.json` file written to disk for each turn MAY contain delta-format fields (`prevId: string`, `msgOffset: integer`) in addition to the existing fields (`model`, `max_tokens`, `messages`, `sysHash`, `toolsHash`). When `prevId` and `msgOffset` are both present, the `messages` field SHALL contain only the slice of messages added since the previous turn (`currMessages.slice(msgOffset)`). When either field is absent, the file SHALL be in legacy/anchor format and `messages` SHALL contain the full conversation history.

#### Scenario: Anchor (FULL) format

- **WHEN** an anchor turn is written
- **THEN** the resulting `_req.json` SHALL contain `model`, `max_tokens`, `messages` (full array), `sysHash`, `toolsHash`
- **AND** SHALL NOT contain `prevId` or `msgOffset`

#### Scenario: Delta format

- **WHEN** a delta turn is written
- **THEN** the resulting `_req.json` SHALL contain `model`, `max_tokens`, `prevId`, `msgOffset`, `messages` (slice from msgOffset), `sysHash`, `toolsHash`
- **AND** the `messages.length` SHALL equal `currMessages.length - msgOffset`

#### Scenario: Legacy `_req.json` remains readable

- **WHEN** lazy-load encounters a `_req.json` written by a pre-1.8.0 ccxray version (no `prevId`, no `msgOffset`, full `messages`)
- **THEN** the system SHALL treat it as an anchor and use the inline `messages` directly
- **AND** SHALL NOT attempt to walk a chain

### Requirement: Attribution prefix unaffected by delta format

The attribution prefix logic (project, session8, sessNum, turn, step) SHALL operate on `parsedBody.messages` from the in-memory request, never reading `_req.json` from disk. Whether the on-disk format is FULL or delta is irrelevant to attribution.

#### Scenario: Prefix computation reads in-memory messages

- **WHEN** a request arrives and the attribution prefix is being computed
- **THEN** the computation SHALL use `parsedBody.messages` directly
- **AND** SHALL NOT depend on the format the entry will be persisted in
