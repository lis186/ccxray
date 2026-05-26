## MODIFIED Requirements

### Requirement: Line 2 — title (amended)

- **WHEN** `entry.title` is non-null and passes `cleanTitle()` filtering
- **THEN** line 2 renders the cleaned title text, clamped to 3 lines with ellipsis on overflow

#### Scenario: Title filtering

- **WHEN** `entry.title` contains XML/HTML tags (e.g. `<system-reminder>`) or leading markdown symbols (`**`, `##`, `—`, etc.)
- **THEN** those are stripped before display

- **WHEN** the cleaned title is fewer than 4 characters
- **THEN** line 2 is omitted entirely (treated as null)

#### Scenario: Multi-line title

- **WHEN** cleaned title text exceeds one line width
- **THEN** up to 3 lines render; overflow is truncated with ellipsis

---

### Requirement: Line 3 — ctx bar label layout (amended)

Two small labels sit beneath the bar: `cache:NN%` left-aligned and `ctx:NN%` right-aligned.

`cache:NN%` SHALL always render when `totalUsed > 0`, including when `cache_read` is 0 (displays `cache:0%` in red via the `.hit-cold` class).

> **Label naming note:** Earlier drafts of this spec used `hit:NN%`. The shipped UI renders `cache:NN%` — the word "cache" is more directly recognisable than "hit-rate" for users not steeped in caching jargon. The CSS class name `turn-hit-pct` and the variable name `hitPct` were retained internally for diff-minimal continuity, but the visible label is `cache:`.

#### Scenario: Labels placement

- **WHEN** usage has `cache_read` 18000, `cache_write` 2000, `input` 1000
- **THEN** line 3 shows: full-width bar with proportional segments; beneath: `cache:86%` left, `ctx:42%` right

#### Scenario: cache% label always visible

- **WHEN** total tokens > 0 and `cache_read` is 0
- **THEN** `cache:0%` renders in red (left-aligned beneath bar)

---

### Requirement: Line 4 — tools row + time row (amended)

Line 4 is split into two sub-rows in **this DOM and visual order**: tools row on top, time row beneath. The `.turn-secondary` container uses `flex-direction: column`, so DOM order matches visual order.

> **Order rationale (drift from earlier draft):** Earlier drafts placed time first then tools. The shipped UI inverted this so the user's eye sees the tools chips (most-frequently-scanned signal) before the dimmed timing micro-row. Both rows are dim (`color: var(--dim)`), so the inversion does not create a visual hierarchy problem.

**Time row format:** `dur:{elapsed} [({secondary})]`

Where `{secondary}` is the `' · '`-joined concatenation of (in order) `wait:{gap}` and `think:{thinking}s`, wrapped in a single parenthesised `.turn-elapsed-secondary` span. The secondary span is a sibling of the `.turn-elapsed` span (NOT inside it); both sit inside `.turn-time-row`.

- `dur:` always shows when `elapsedMs > 0`
- `wait:` is included in `{secondary}` only when `gapMs >= 500` and finite
- `think:` is included in `{secondary}` only when `thinkingDuration >= 0.05`
- When neither `wait:` nor `think:` qualifies, the parenthesised span is omitted entirely
- Time row wraps if content exceeds card width (`.turn-time-row { flex-wrap: wrap; }`)

**Tools row:** all tool chips on their own line above the time row, wrapping freely. No truncation. All chips use the same dim style (no special color for any tool name). MCP namespace prefixes (`mcp__<server>__`) are stripped before display.

#### Scenario: First turn in session

- **WHEN** no previous turn in session has `receivedAt`
- **THEN** time row shows only `dur:{elapsed}`; no parenthesised secondary span

#### Scenario: Gap present

- **WHEN** a previous turn exists and `gapMs >= 500` and is finite
- **THEN** the parenthesised secondary span includes `wait:{formatted-gap}`
- **AND** the cache warmth tier is conveyed via the `.turn-elapsed-secondary` span's `title=` attribute (gap < 5min, 5min–1hr, > 1hr)

#### Scenario: Gap suppressed

- **WHEN** `gapMs < 500` or `gapMs` is not finite
- **THEN** the secondary span omits `wait:`

#### Scenario: Thinking duration present

- **WHEN** `thinkingDuration >= 0.05`
- **THEN** the parenthesised secondary span includes `think:{N}s`
- **AND** the secondary span sits as a sibling after `.turn-elapsed`, e.g. `<span class="turn-elapsed">dur:9.6s</span> <span class="turn-elapsed-secondary">(wait:11s · think:4.4s)</span>`

#### Scenario: Both wait and think present

- **WHEN** both `wait:` and `think:` qualify
- **THEN** they are joined by ` · ` (space-dot-space) inside a single parenthesised span: `(wait:11s · think:4.4s)`

#### Scenario: Tool chips

- **WHEN** turn has tool calls
- **THEN** all tool names render as chips on the tools row, wrapping freely; no truncation
- **AND** all chips use the same dim style regardless of tool name
- **AND** the tools row appears above the time row in both DOM and visual order

---

### Requirement: Model name always shown (amended)

Model name SHALL always render on line 1 for all turns (main and subagent). The session-aware omission rule was removed — scanning cost is lower than the confusion caused by missing model names.
