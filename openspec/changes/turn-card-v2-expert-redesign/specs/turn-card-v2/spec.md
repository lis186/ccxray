## Turn Card v2 Display Spec

### Requirement: Turn card has five-line layout

A turn card SHALL render at most five lines: identity, title, ctx-bar, secondary, risk. Lines 2, 3, and 5 are conditional and may be omitted entirely.

#### Scenario: Full card with all lines

- **WHEN** a turn has title, usage data, and risk signals of multiple tiers
- **THEN** five lines render in order: identity, title, ctx-bar, secondary, risk

#### Scenario: No title

- **WHEN** `entry.title` is null
- **THEN** line 2 is omitted; no blank line appears between identity and ctx-bar

#### Scenario: No usage data

- **WHEN** `usage` is null or total tokens is zero
- **THEN** line 3 (ctx-bar) is omitted entirely

#### Scenario: No risk signals

- **WHEN** no risk signals of any tier are present
- **THEN** line 5 is omitted entirely; no blank line appears

#### Scenario: Minimum card

- **WHEN** turn has no title, no usage, and no risk signals
- **THEN** only identity line and secondary line render (two lines)

---

### Requirement: Line 1 — identity, critical risk, cost

Line 1 SHALL render: turn number, model name (conditional), status dot, wait indicator (conditional), critical risk marker (conditional, max one), cost (right-aligned).

#### Scenario: Main turn layout

- **WHEN** turn is a main agent turn
- **THEN** line 1 format: `#N  model  ●  [↵]  [!marker]            $0.03`

#### Scenario: Subagent turn layout

- **WHEN** turn is a subagent turn
- **THEN** line 1 format: `↳sN  model  ●  [↵]  [!marker]           $0.01`
- **AND** `↳` prefix replaces `#`; subagent sequence number replaces turn number

#### Scenario: Critical marker present

- **WHEN** a critical-tier risk signal exists
- **THEN** the highest-priority critical marker appears between `●` (or `↵`) and the cost
- **AND** the marker is plain ASCII text, no emoji
- **AND** cost remains right-aligned regardless of marker presence

#### Scenario: Multiple critical signals

- **WHEN** more than one critical-tier signal is present
- **THEN** only the highest-priority marker appears on line 1; remaining critical markers are demoted to line 5

#### Scenario: No critical signal

- **WHEN** no critical-tier signal is present
- **THEN** no marker slot exists on line 1; cost fills the right side without empty gap

#### Scenario: No cost data

- **WHEN** cost is null
- **THEN** cost field is omitted; no placeholder rendered

---

### Requirement: Critical marker vocabulary (line 1)

Critical markers SHALL use plain ASCII text only. No emoji. Priority order (highest first):

| Signal | Marker | Priority |
|--------|--------|----------|
| ctx > 95% | *(left bar + ctx label only, no inline marker)* | 1 |
| HTTP non-2xx | `!http` | 2 |
| `stopReason === 'max_tokens'` | `!max` | 3 |
| `stopReason === 'length'` | `!len` | 4 |
| any other non-`end_turn`/`tool_use` | `!stop` | 5 |
| `stopReason === 'content_filter'` | `!filter` | 6 |

#### Scenario: max_tokens stop

- **WHEN** `stopReason` is `max_tokens`
- **THEN** line 1 shows `!max` between status dot and cost

#### Scenario: HTTP error

- **WHEN** HTTP status is not 2xx
- **THEN** line 1 shows `!http`

---

### Requirement: Line 2 — title

- **WHEN** `entry.title` is non-null and non-empty
- **THEN** line 2 renders the title text, truncated with ellipsis if it overflows the card width

---

### Requirement: Line 3 — full-width ctx bar with dual labels

Line 3 is a full-width color bar representing token composition. The dual labels (`ctx:NN%` and `hit:NN%`) are rendered in small text at the bottom-right corner beneath the bar, right-aligned. The bar itself stretches the full card width.

#### Scenario: Normal cached turn

- **WHEN** usage has cache_read 18000, cache_write 2000, input 1000
- **THEN** line 3 shows: full-width bar with proportional segments; below-right: `ctx:42%  hit:86%`

#### Scenario: ctx% label color

- **WHEN** context percentage ≤ 70%
- **THEN** `ctx:NN%` label is dim gray

- **WHEN** context percentage is 71–95%
- **THEN** `ctx:NN%` label is yellow (warning color)

- **WHEN** context percentage > 95%
- **THEN** `ctx:NN%` label is red (critical color)

#### Scenario: hit% label color

- **WHEN** hit% label is visible
- **THEN** `hit:NN%` label is always cache-read color (cyan), regardless of value

#### Scenario: Bar segment colors

- **THEN** cache-read segment uses `var(--color-cache-read)` (cyan)
- **AND** cache-write segment uses `var(--color-cache-write)` (orange)
- **AND** input segment uses `var(--color-input)` (purple)

#### Scenario: Bar tooltip

- **WHEN** line 3 is visible
- **THEN** hovering the bar shows precise token counts and percentages for each present source; absent sources are not listed

#### Scenario: No usage data

- **WHEN** `usage` is null, or `cache_read + cache_write + input === 0`
- **THEN** line 3 is omitted entirely

#### Scenario: Segment minimum width

- **WHEN** a non-zero segment would render narrower than 2px
- **THEN** that segment renders with `min-width: 2px`

---

### Requirement: Line 4 — time and tools

Line 4 renders elapsed time, optional gap, optional thinking duration, and tool chips.

Format: `{elapsed}  [wait:{gap}]  [think:{thinking}]  {tools}`

#### Scenario: First turn in session

- **WHEN** no previous turn in session has `receivedAt`
- **THEN** only `elapsed` shows; no `wait:` field

#### Scenario: Gap present

- **WHEN** a previous turn exists and gap is computable
- **THEN** `wait:{formatted-gap}` appears after elapsed, colored by cache warmth tier:
  - gap < 5 minutes → green
  - gap 5 minutes to 1 hour → yellow
  - gap > 1 hour → red

#### Scenario: Thinking duration present

- **WHEN** `thinkingDuration` is non-null
- **THEN** `think:{N}s` appears after gap (or after elapsed if no gap)

#### Scenario: Tool chips

- **WHEN** turn has tool calls
- **THEN** tool names render as chips, max 3; overflow collapses to `+N`
- **AND** `Agent` tool chip uses distinct visual style (e.g. `chip-agent` class)

#### Scenario: No tools

- **WHEN** turn has no tool calls
- **THEN** no tools section; elapsed (and optional wait/think) fills line 4

---

### Requirement: Line 5 — warning and notice risk signals

Line 5 shows warning-tier and notice-tier risk signals as plain text labels. Critical-tier signals are on line 1, not line 5.

#### Scenario: Warning signals

- **WHEN** `hasCredential` is true
- **THEN** line 5 includes `cred`

- **WHEN** `toolFail` is true
- **THEN** line 5 includes `tool-fail`

#### Scenario: Notice signals

- **WHEN** `duplicateToolCalls` has any entry with count ≥ 2
- **THEN** line 5 includes `dupes×N` where N is the highest total call count among duplicated tools

#### Scenario: No warning or notice signals

- **WHEN** no warning-tier or notice-tier signals are present
- **THEN** line 5 is omitted entirely

#### Scenario: Multiple signals ordering

- **WHEN** multiple warning/notice signals are present
- **THEN** order is: `cred` → `tool-fail` → `dupes×N`; space-separated, no other separators

#### Scenario: Overflow

- **WHEN** more than 5 signals would render on line 5
- **THEN** first 5 render in severity order, remainder collapses to `+N`

#### Scenario: No emoji

- **WHEN** any risk signal renders
- **THEN** no emoji character appears anywhere on the card; all markers are plain ASCII

---

### Requirement: Left-edge color bar encodes highest severity

Each turn card SHALL have a 2px-wide left border whose color encodes the highest severity signal across all tiers.

#### Scenario: No issues

- **WHEN** no risk signals present
- **THEN** left border is invisible (background color)

#### Scenario: Critical

- **WHEN** any critical-tier signal is present
- **THEN** left border is red

#### Scenario: Warning only

- **WHEN** warning-tier signal present, no critical
- **THEN** left border is orange

#### Scenario: Notice only

- **WHEN** notice-tier signal present, no critical or warning
- **THEN** left border is yellow

#### Scenario: Severity precedence

- **THEN** precedence: critical > warning > notice

---

### Requirement: Subagent visual distinction

#### Scenario: Subagent prefix

- **WHEN** turn is a subagent
- **THEN** line 1 starts with `↳sN` (e.g. `↳s1`, `↳s2`)
- **AND** `↳` is never used for main turns

#### Scenario: Main turn prefix

- **WHEN** turn is a main agent turn
- **THEN** line 1 starts with `#N`

#### Scenario: Subagent always shows model

- **WHEN** turn is subagent
- **THEN** model name is always rendered, regardless of session-aware omission rules

---

### Requirement: Model name omitted only when safe (main turns only)

For main turns, model name SHALL be omitted only when it matches the immediately previous main turn in the same session AND no more than 5 entries have passed since that previous main turn.

#### Scenario: First main turn in session

- **WHEN** session has no previous main turn
- **THEN** model name renders

#### Scenario: Same model, close previous main turn

- **WHEN** previous main turn used same model AND ≤ 5 entries have passed
- **THEN** model name is NOT rendered

#### Scenario: Distant or changed model

- **WHEN** > 5 entries have passed, or model changed
- **THEN** model name IS rendered

---

### Requirement: Wait indicator on line 1

#### Scenario: end_turn stop reason

- **WHEN** `stopReason === 'end_turn'`
- **THEN** `↵` appears on line 1 between `●` and any critical marker (or cost if no marker)

#### Scenario: tool_use or other

- **WHEN** `stopReason` is not `end_turn`
- **THEN** no `↵` indicator

---

### Requirement: Compact and inferred in tooltip only

#### Scenario: Compacted or inferred session

- **WHEN** turn is compacted or session is inferred
- **THEN** no visible text on card; information accessible only via `title` tooltip on line 1 element

---

### Requirement: Combined scenarios

#### Scenario: Critical + warning + no title

- **WHEN** `stopReason === 'max_tokens'`, `toolFail === true`, no title
- **THEN** line 1: `#65  sonnet-4-6  ●  !max  $0.03`; line 2 omitted; line 3: ctx bar; line 4: time + tools; line 5: `tool-fail`

#### Scenario: No risk, no title, no usage

- **WHEN** all three absent
- **THEN** only line 1 (identity + cost) and line 4 (time) render

#### Scenario: Subagent with critical

- **WHEN** subagent turn has HTTP error
- **THEN** line 1: `↳s2  sonnet-4-6  ●  !http  $0.00`; left bar red
