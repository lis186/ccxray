## Turn Card v2 Display Spec

### Requirement: Turn card has five-line layout

A turn card SHALL render at most five lines: identity, title, ctx-bar, secondary, risk. Lines 2, 3, and 5 are conditional and may be omitted entirely. Line 4 (secondary) is internally split into two sub-rows in the shipped UI; see "Line 4" requirement below.

#### Scenario: Full card with all lines

- **WHEN** a turn has title, usage data, and risk signals of multiple tiers
- **THEN** five lines render in order: identity, title, ctx-bar, secondary, risk

#### Scenario: No title

- **WHEN** `entry.title` is null OR `cleanTitle(entry.title)` returns a string shorter than 4 characters
- **THEN** line 2 is omitted; no blank line appears between identity and ctx-bar

#### Scenario: No usage data

- **WHEN** `usage` is null or total tokens is zero
- **THEN** line 3 (ctx-bar) is omitted entirely

#### Scenario: No risk signals

- **WHEN** no warning-tier or notice-tier signals are present
- **THEN** line 5 is omitted entirely; no blank line appears

#### Scenario: Minimum card

- **WHEN** turn has no title, no usage, and no risk signals
- **THEN** only identity line and secondary line render (two lines)

---

### Requirement: Line 1 — identity, critical risk, cost

Line 1 SHALL render in **this DOM order**: status dot, turn number, model name, wait indicator (conditional), critical risk marker (conditional, max one), cost (right-aligned via auto margin / flex spacing).

> **Order rationale (drift from earlier draft):** Earlier drafts placed dot after model. The shipped UI renders the dot first because users scanning a long list anchor on the leftmost glyph for HTTP success/failure. The left-edge color bar conveys aggregated severity; the dot conveys per-turn HTTP status — both are kept, redundantly, because they encode different things.

Model name SHALL **always** render on line 1 for both main and subagent turns. The session-aware omission rule (skip when same model + ≤5 entries away) was specced in earlier drafts but never shipped.

#### Scenario: Main turn layout

- **WHEN** turn is a main agent turn
- **THEN** line 1 format: `●  #N  model  [↵]  [!marker]            $0.03`

#### Scenario: Subagent turn layout

- **WHEN** turn is a subagent turn
- **THEN** line 1 format: `●  ↳sN  model  [↵]  [!marker]           $0.01`
- **AND** `↳sN` prefix replaces `#N`; subagent sequence number replaces turn number

#### Scenario: Critical marker present

- **WHEN** a critical-tier risk signal exists
- **THEN** the highest-priority critical marker renders via `.turn-critical-marker` after the wait indicator
- **AND** the marker is plain ASCII text, no emoji
- **AND** cost remains right-aligned regardless of marker presence

#### Scenario: Multiple critical signals

- **WHEN** more than one critical-tier signal is present
- **THEN** only the highest-priority marker appears on line 1; other tiers (warning/notice) appear on line 5

#### Scenario: No critical signal

- **WHEN** no critical-tier signal is present
- **THEN** no `.turn-critical-marker` element renders; cost fills the right side without empty gap

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
- **THEN** line 1 shows `!max` after wait indicator and before cost

#### Scenario: HTTP error

- **WHEN** HTTP status is not 2xx
- **THEN** line 1 shows `!http`

---

### Requirement: Line 2 — title

- **WHEN** `entry.title` is non-null and `cleanTitle()` returns a string ≥ 4 characters
- **THEN** line 2 renders the cleaned title text, clamped to 3 lines via `-webkit-line-clamp: 3` with ellipsis on overflow

> `cleanTitle()` strips XML/HTML tags (e.g. `<system-reminder>`) and leading markdown symbols (`**`, `##`, `—`). See `turn-card-display-amendments` for filter details.

---

### Requirement: Line 3 — full-width ctx bar with dual labels

Line 3 is a full-width color bar representing token composition. The dual labels are rendered in a flex row beneath the bar: **`cache:NN%` left-aligned** and **`ctx:NN%` right-aligned**. The bar itself stretches the full card width.

> **Label naming note:** Earlier drafts used `hit:NN%`. The shipped UI renders `cache:NN%` — more directly recognisable than "hit-rate" jargon. The `cache:NN%` label SHALL render whenever `totalUsed > 0`, including `cache:0%` (which renders red via the `.hit-cold` class — the value 0 is a critical signal in itself). The CSS class `turn-hit-pct` and the variable `hitPct` are retained internally for diff-minimal continuity.

#### Scenario: Normal cached turn

- **WHEN** usage has `cache_read` 18000, `cache_write` 2000, `input` 1000
- **THEN** line 3 shows: full-width bar with proportional segments; beneath: `cache:86%` left-aligned, `ctx:42%` right-aligned

#### Scenario: ctx% label color (L2 thresholds, not L1/L3)

- **WHEN** context percentage > 95%
- **THEN** `ctx:NN%` label is red (`.ctx-critical`)

- **WHEN** context percentage 86–95%
- **THEN** `ctx:NN%` label is yellow (`.ctx-warning`)

- **WHEN** context percentage ≤ 85%
- **THEN** `ctx:NN%` label is dim gray (no class)

> L2 (turn cards) uses 95/85 thresholds; L1 (project cards) and L3 (minimap) use 83.5/75. This is intentional — see Decision D11 in `remove-prediction-add-countdowns/design.md`. L2 scans turns for spikes, not absolute proximity to auto-compact.

#### Scenario: cache% label color

- **WHEN** `cache:NN%` < 10
- **THEN** label renders red via `.hit-cold` class (overrides default)
- **WHEN** `cache:NN%` ≥ 10
- **THEN** label renders cyan via `.turn-hit-pct` default color (`var(--color-cache-read)`, no extra class)

> Shipped CSS: `.turn-hit-pct` defaults to `var(--color-cache-read)` (cyan); `.turn-hit-pct.hit-cold` overrides to red. Rationale: `<10%` is an actionable warning (cost spike, cache invalidation) so it is colored red; values ≥10% match the cache-read bar segment elsewhere on the card.

#### Scenario: Bar segment colors

- **THEN** cache-read segment uses `var(--color-cache-read)` (cyan)
- **AND** cache-write segment uses `var(--color-cache-write)` (orange)
- **AND** input segment uses `var(--color-input)` (purple)

#### Scenario: Bar tooltip

- **WHEN** line 3 is visible
- **THEN** the bar's `title=` attribute reads `auto-compact at ~83.5%` (or whatever `window.ccxraySettings.autoCompactPct` is set to)

#### Scenario: No usage data

- **WHEN** `usage` is null, or `cache_read + cache_write + input === 0`
- **THEN** line 3 is omitted entirely

#### Scenario: Segment minimum width

- **WHEN** a non-zero segment would render narrower than 1px
- **THEN** that segment renders with `min-width: 1px`

---

### Requirement: Line 4 — secondary (tools row above time row)

Line 4 SHALL render a `.turn-secondary` container with `flex-direction: column` containing two sub-rows in **this DOM and visual order**: tools row on top, time row beneath.

> **Order rationale (drift from earlier draft):** Earlier drafts inlined tools after time on a single row. The shipped UI splits them and inverts the order so the eye reaches tool chips first (most-frequently-scanned signal). Both rows share `color: var(--dim)`, so the inversion does not create visual hierarchy issues.

**Time row format:** `dur:{elapsed} [({secondary})]` where `{secondary}` is the `' · '`-joined concatenation of `wait:{gap}` and `think:{thinking}s`, wrapped in a single parenthesised `.turn-elapsed-secondary` span. The secondary span is a sibling of `.turn-elapsed` (NOT inside it).

- `dur:` always shows when `elapsedMs > 0`
- `wait:` is included only when `gapMs >= 500` and finite
- `think:` is included only when `thinkingDuration >= 0.05`
- When neither qualifies, the parenthesised span is omitted

**Tools row:** all tool chips render with class `.tool-chip` and the same dim style. No truncation. No max-3 cutoff. No special class for `Agent` or other tools. MCP namespace prefixes (`mcp__<server>__`) are stripped before display via regex `^mcp__[^_]+__`.

> **Drift from earlier draft:** Earlier drafts specified "max 3 chips, overflow `+N`" and a distinct `chip-agent` class for Agent. Neither shipped. All chips render uniformly to keep the rendering pipeline single-pass and avoid arbitrary cutoffs.

#### Scenario: First turn in session

- **WHEN** no previous turn in session has `receivedAt`
- **THEN** time row shows only `<span class="turn-elapsed">dur:{elapsed}</span>`; no parenthesised secondary span

#### Scenario: Gap present

- **WHEN** a previous turn exists, `gapMs >= 500`, and finite
- **THEN** the parenthesised secondary span includes `wait:{formatted-gap}`
- **AND** the cache warmth tier is conveyed via the `.turn-elapsed-secondary` span's `title=` attribute

#### Scenario: Gap suppressed

- **WHEN** `gapMs < 500` or not finite
- **THEN** the parenthesised secondary span omits `wait:`

#### Scenario: Thinking duration present

- **WHEN** `thinkingDuration >= 0.05`
- **THEN** the parenthesised secondary span includes `think:{N}s`

#### Scenario: Both wait and think present

- **WHEN** both qualify
- **THEN** they are joined by ` · ` (space-dot-space) inside a single parenthesised span: `(wait:11s · think:4.4s)`
- **AND** rendered as: `<span class="turn-elapsed">dur:9.6s</span> <span class="turn-elapsed-secondary">(wait:11s · think:4.4s)</span>`

#### Scenario: Tool chips

- **WHEN** turn has tool calls
- **THEN** all tool names render as chips on the tools row, wrapping freely, no truncation
- **AND** all chips use `.tool-chip` class (no per-tool variant)
- **AND** the tools row appears above the time row

#### Scenario: No tools

- **WHEN** turn has no tool calls
- **THEN** the `.turn-tools-row` element is omitted entirely; only `.turn-time-row` renders inside `.turn-secondary`

---

### Requirement: Line 5 — warning and notice risk signals

Line 5 shows warning-tier and notice-tier risk signals as plain text labels. Critical-tier signals are on line 1 (via `.turn-critical-marker`), not line 5.

#### Scenario: Warning signals

- **WHEN** `hasCredential` is true
- **THEN** line 5 includes `cred`

- **WHEN** `toolFail` is true
- **THEN** line 5 includes `tool-fail`

#### Scenario: Notice signals

- **WHEN** `duplicateToolCalls` has any entry with count ≥ 2
- **THEN** line 5 includes `dupes×N` where N is the highest count among duplicated tools

#### Scenario: thinking-stripped notice

- **WHEN** `entry.thinkingStripped === true`
- **THEN** line 5 includes `thinking-stripped`

#### Scenario: sys-changed notice

- **WHEN** `entry.coreHash` differs from the previous non-subagent entry's `coreHash` in the same session (both non-null)
- **THEN** line 5 includes `sys-changed`

> `thinking-stripped` and `sys-changed` were added by the `p0-observability-signals` change after this v2 redesign. They render on line 5 alongside other warning/notice signals.

#### Scenario: No warning or notice signals

- **WHEN** no warning-tier or notice-tier signals are present
- **THEN** line 5 is omitted entirely

#### Scenario: Multiple signals ordering

- **WHEN** multiple warning/notice signals are present
- **THEN** they are space-separated on line 5

#### Scenario: No emoji

- **WHEN** any risk signal renders
- **THEN** no emoji character appears anywhere on the card; all markers are plain ASCII

---

### Requirement: Left-edge color bar encodes highest severity

Each turn card SHALL have a 2px-wide left border whose color encodes the highest severity signal across all tiers. The bar coexists with the line-1 status dot — they encode different things (bar = aggregated severity; dot = HTTP status of this turn).

#### Scenario: No issues

- **WHEN** no risk signals present
- **THEN** left border uses default surface color (no severity class on `.turn-item`)

#### Scenario: Critical

- **WHEN** any critical-tier signal is present
- **THEN** `.turn-item` carries `.risk-critical`; left border red

#### Scenario: Warning only

- **WHEN** warning-tier signal present, no critical
- **THEN** `.turn-item` carries `.risk-warning`; left border orange

#### Scenario: Notice only

- **WHEN** notice-tier signal present, no critical or warning
- **THEN** `.turn-item` carries `.risk-notice`; left border yellow

#### Scenario: Severity precedence

- **THEN** precedence: critical > warning > notice

---

### Requirement: Subagent visual distinction

#### Scenario: Subagent prefix

- **WHEN** turn is a subagent
- **THEN** line 1's `.turn-num` element renders `↳sN` (e.g. `↳s1`, `↳s2`)
- **AND** `↳` is never used for main turns

#### Scenario: Main turn prefix

- **WHEN** turn is a main agent turn
- **THEN** line 1's `.turn-num` element renders `#N`

#### Scenario: Subagent shows model

- **WHEN** turn is subagent
- **THEN** model name is rendered (same as for main turns — no per-type omission rule exists)

---

### Requirement: Wait indicator on line 1

#### Scenario: end_turn stop reason

- **WHEN** `stopReason === 'end_turn'`
- **THEN** `<span class="turn-wait" title="Waiting for user">↵</span>` renders after model name and before any critical marker

#### Scenario: tool_use or other

- **WHEN** `stopReason` is not `end_turn`
- **THEN** no `↵` indicator

---

### Requirement: Compact and inferred metadata via tooltip

#### Scenario: Compacted or inferred session

- **WHEN** turn `isCompacted` is true OR `entry.sessionInferred` is true
- **THEN** no visible text on the card identifies these states; the information is accessible only via the `.turn-identity` element's `title=` attribute

---

### Requirement: Combined scenarios

#### Scenario: Critical + warning + no title

- **WHEN** `stopReason === 'max_tokens'`, `toolFail === true`, no title
- **THEN** line 1: `●  #65  sonnet-4-6  !max  $0.03`; line 2 omitted; line 3: ctx bar with `cache:` + `ctx:` labels; line 4: tools row + time row sub-rows; line 5: `tool-fail`

#### Scenario: No risk, no title, no usage

- **WHEN** all three absent
- **THEN** only line 1 (identity + cost) and line 4 (secondary) render

#### Scenario: Subagent with critical

- **WHEN** subagent turn has HTTP error
- **THEN** line 1: `●  ↳s2  sonnet-4-6  !http  $0.00`; left bar red (`.risk-critical`)
