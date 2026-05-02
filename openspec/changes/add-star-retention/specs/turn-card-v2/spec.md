## MODIFIED Requirements

### Requirement: Turn card has five-line layout

A turn card SHALL render at most six lines: identity, title, cost, ctx-bar, secondary, risk. Lines 2 (title), 3 (cost), 4 (ctx-bar), and 6 (risk) are conditional and may be omitted entirely. Line 5 (secondary) is internally split into two sub-rows in the shipped UI; see "Line 5" requirement below.

> **Six lines, not five (drift from the original spec):** the cost figure was previously rendered on line 1 right-aligned. The `add-star-retention` change moves cost to a dedicated line between title and ctx-bar so the line-1 right edge is freed for the star toggle. The dedicated cost line is conditional — when `cost` is null it is omitted with no trace.

#### Scenario: Full card with all lines

- **WHEN** a turn has title, cost data, usage data, and risk signals of multiple tiers
- **THEN** six lines render in order: identity, title, cost, ctx-bar, secondary, risk

#### Scenario: No title

- **WHEN** `entry.title` is null OR `cleanTitle(entry.title)` returns a string shorter than 4 characters
- **THEN** the title line is omitted; if cost is present, the cost line renders directly after the identity line

#### Scenario: No cost

- **WHEN** cost data is null
- **THEN** the cost line is omitted; ctx-bar renders directly after the title (or directly after identity if title also absent)

#### Scenario: No usage data

- **WHEN** `usage` is null or total tokens is zero
- **THEN** the ctx-bar line is omitted entirely

#### Scenario: No risk signals

- **WHEN** no warning-tier or notice-tier signals are present
- **THEN** the risk line is omitted entirely; no blank line appears

#### Scenario: Minimum card

- **WHEN** turn has no title, no cost, no usage, and no risk signals
- **THEN** only identity line and secondary line render (two lines)

---

### Requirement: Line 1 — identity, critical risk, cost

Line 1 SHALL render in **this DOM order**: status dot, turn number, model name, wait indicator (conditional), critical risk marker (conditional, max one), star toggle (right-aligned via auto margin / flex spacing). Cost SHALL NOT render on line 1; see "Line 3 — cost" requirement.

> **Order rationale (drift from earlier draft):** Earlier drafts placed dot after model. The shipped UI renders the dot first because users scanning a long list anchor on the leftmost glyph for HTTP success/failure. The left-edge color bar conveys aggregated severity; the dot conveys per-turn HTTP status — both are kept, redundantly, because they encode different things.

> **Star replaces cost (drift from previous spec):** Cost previously occupied the right edge of line 1. The `add-star-retention` change places the star toggle there instead. Cost moves to its own line below the title.

Model name SHALL **always** render on line 1 for both main and subagent turns. The session-aware omission rule (skip when same model + ≤5 entries away) was specced in earlier drafts but never shipped.

#### Scenario: Main turn layout

- **WHEN** turn is a main agent turn
- **THEN** line 1 format: `●  #N  model  [↵]  [!marker]            [☆/★]`

#### Scenario: Subagent turn layout

- **WHEN** turn is a subagent turn
- **THEN** line 1 format: `●  ↳sN  model  [↵]  [!marker]           [☆/★]`
- **AND** `↳sN` prefix replaces `#N`; subagent sequence number replaces turn number

#### Scenario: Critical marker present

- **WHEN** a critical-tier risk signal exists
- **THEN** the highest-priority critical marker renders via `.turn-critical-marker` after the wait indicator
- **AND** the marker is plain ASCII text, no emoji
- **AND** the star toggle remains right-aligned regardless of marker presence

#### Scenario: Multiple critical signals

- **WHEN** more than one critical-tier signal is present
- **THEN** only the highest-priority marker appears on line 1; other tiers (warning/notice) appear on the risk line

#### Scenario: No critical signal

- **WHEN** no critical-tier signal is present
- **THEN** no `.turn-critical-marker` element renders; the star toggle fills the right side without empty gap

#### Scenario: Star toggle always renders

- **WHEN** the turn card renders for any turn (including quota-checks, errored turns, or subagents)
- **THEN** the star toggle element is present at the right edge of line 1
- **AND** its filled vs hollow state reflects whether the turn id is in `starredTurns`

## ADDED Requirements

### Requirement: Cost renders on its own line between title and ctx-bar

When `cost` is non-null, the turn card SHALL render the cost on a dedicated line positioned between the title line and the ctx-bar line. The line SHALL contain only the cost figure formatted as `$N.NN` (two decimal places, dollar sign prefix). The visual style SHALL be: dim color (`var(--dim)`), font-size 11px, right-aligned within the card's content padding.

#### Scenario: Cost present, title present

- **WHEN** a turn has both a title and a non-null cost
- **THEN** the layout shows identity, title, cost line, ctx-bar in that order
- **AND** the cost line content is right-aligned `$N.NN`

#### Scenario: Cost present, title absent

- **WHEN** a turn has no title but a non-null cost
- **THEN** the cost line renders directly between identity and ctx-bar

#### Scenario: Cost absent

- **WHEN** `cost` is null
- **THEN** the cost line is omitted from the DOM entirely (no empty container)

#### Scenario: Two-decimal formatting

- **WHEN** the cost numeric value is `0.4`
- **THEN** the rendered text is `$0.40` (not `$0.4` or `$0.400000`)

---

### Requirement: Star toggle on line 1 reflects and mutates `starredTurns`

The star toggle on line 1 SHALL render as filled `★` when the turn's id is in `starredTurns`, otherwise as hollow `☆`. Clicking SHALL invoke `event.stopPropagation()` and issue `POST /_api/stars` with `{kind:'turn', id:<entry.id>, starred:<new state>}`. Visual state SHALL update on the API response, not optimistically before it.

#### Scenario: Toggle off

- **WHEN** the user clicks a filled `★` on a turn card
- **THEN** a POST is issued with `starred:false`
- **AND** on success, the icon transitions to hollow `☆`

#### Scenario: Toggle on

- **WHEN** the user clicks a hollow `☆` on a turn card
- **THEN** a POST is issued with `starred:true`
- **AND** on success, the icon transitions to filled `★`

#### Scenario: Click does not propagate

- **WHEN** the user clicks the star icon
- **THEN** `selectTurn` is not invoked
- **AND** the focused-turn highlight does not change
