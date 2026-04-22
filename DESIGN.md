---
version: "alpha"
name: ccxray
description: >
  Design tokens for the ccxray dashboard. Extracted from public/style.css.
  Tokens are source-of-truth; when in doubt, reference a token instead of
  introducing a new literal.

colors:
  # ── Surfaces ─────────────────────────────────────────────
  bg:              { dark: "#0d1117", light: "#ffffff" }
  surface:         { dark: "#161b22", light: "#f6f8fa" }
  surface-hover:   { dark: "#1c2129", light: "#eaeef2" }
  surface-active:  { dark: "#1a2535", light: "#ddf4ff" }
  border:          { dark: "#30363d", light: "#d0d7de" }

  # ── Text ─────────────────────────────────────────────────
  text:            { dark: "#e6edf3", light: "#1f2328" }
  dim:             { dark: "#8b949e", light: "#656d76" }
  accent:          { dark: "#58a6ff", light: "#0969da" }

  # ── Semantic ─────────────────────────────────────────────
  green:           { dark: "#3fb950", light: "#1a7f37" }   # OK, streaming, approve, assistant
  yellow:          { dark: "#d29922", light: "#9a6700" }   # cost, warning, intercept armed
  red:             { dark: "#f85149", light: "#d1242f" }   # error, critical, over-compact
  purple:          { dark: "#bc8cff", light: "#8250df" }   # session identity, thinking
  orange:          { dark: "#f0883e", light: "#bc4c00" }   # subagent, sensitive, warning risk

  # ── Context bar segments (must be visually distinct) ────
  color-cache-read:   { dark: "#4dd0e1", light: "#0891b2" }
  color-cache-write:  { dark: "#ff8a65", light: "#c2410c" }
  color-input:        { dark: "#ce93d8", light: "#9333ea" }

  # ── Diff ────────────────────────────────────────────────
  color-diff-add:  { dark: "#56d364", light: "#1a7f37" }
  color-diff-del:  { dark: "#f85149", light: "#d1242f" }

typography:
  family: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace"
  size:
    xs:  "9px"     # micro-labels, meta rows, tool chips
    sm:  "10px"    # secondary metadata, cmd-bar
    md:  "11px"    # default secondary (turn title, session preview)
    base: "12px"   # body text, section content
    lg:  "13px"    # body (applied to <body>)
    xl:  "14px"    # fullscreen page title
    xxl: "15px"    # topbar h1
  weight:
    normal: 400
    semibold: 600
    bold: 700
  letter-spacing:
    label:  "0.05em"   # uppercase labels
    strong: "0.08em"   # col-title
  line-height:
    tight:  1.25
    base:   1.5
    relaxed: 1.6

spacing:
  # 4-step grid; avoid introducing odd intermediate values
  0:  "0"
  1:  "2px"
  2:  "3px"
  3:  "4px"
  4:  "6px"
  5:  "8px"
  6:  "10px"
  7:  "12px"
  8:  "14px"
  9:  "16px"
  10: "20px"

rounded:
  xs:   "2px"   # inline chips, tags
  sm:   "3px"   # buttons, small badges
  md:   "4px"   # msg, inputs, toast
  lg:   "6px"   # scorecard tooltip
  xl:   "8px"   # cost-card
  pill: "10px" # quota roi, topbar-held
  full: "50%"  # status dots

layout:
  column-width:
    projects: "220px"
    sessions: "220px"
    turns:    "220px"
    sections: "220px"
    # detail fills remaining space
  minimap-width: "36px"
  selection-border:
    projects: "3px"
    sessions: "3px"
    sections: "3px"
    turns:    "2px"   # narrower — turn list is denser
  scrollbar-width: "4px"
  breakpoints:
    phone:  "599px"
    tablet: "767px"
    ipad:   "1024px"

elevation:
  tooltip:   "0 4px 12px rgba(0,0,0,0.4)"
  pill:      "0 2px 8px rgba(0,0,0,0.3)"

landmarks:
  compact-threshold: "83.5%"
  # Auto-compact tick rendered at this position across L1 (minimap),
  # L2 (turn ctx bar), and L3 (big ctx bar). All three levels MUST
  # use the same CSS variable (--compact-threshold) so they move
  # together. Overridden at runtime by public/settings.js from
  # /_api/settings.autoCompactPct.

components:
  # Miller-column item (projects, sessions, turns, sections)
  list-item:
    padding: "7px 10px"       # turn/project; sessions use 8px 10px
    border-bottom: "1px solid {colors.border}"
    border-left: "{layout.selection-border.*} solid transparent"
    hover-bg: "{colors.surface-hover}"
    selected-bg: "{colors.surface-active}"
    selected-border-left: "{colors.accent}"    # except session → purple

  msg-badge:
    padding: "0 4px"
    radius: "{rounded.sm}"
    size: "{typography.size.xs}"
    weight: "{typography.weight.bold}"
    variants:
      human:        { bg: "{colors.accent}", fg: "{colors.bg}" }
      tool_results: { bg: "{colors.border}", fg: "{colors.dim}" }
      system:       { bg: "{colors.yellow}", fg: "{colors.bg}" }
      call:         { bg: "{colors.green}",  fg: "{colors.bg}" }
      think:        { bg: "{colors.purple}", fg: "{colors.bg}" }

  status-dot:
    size: "7px"
    shape: "{rounded.full}"
    variants:
      stream: "{colors.green}"
      idle:   "{colors.yellow}"
      off:    "transparent + 1px border {colors.border}"
      armed:  "3px glow rgba(210,153,34,0.5)"

  toast:
    border-left: "3px solid {colors.yellow}"
    radius: "{rounded.md}"
    max-width: "400px"
---

# ccxray design system

Guidance for humans and AI agents modifying the dashboard. Tokens live in
the YAML front matter above — this prose explains **why** they exist.

## Overview

ccxray's dashboard is a **keyboard-first, information-dense** inspection tool
for Claude Code traffic. Every visual decision favours legibility of dense
data over aesthetic whitespace. It imitates a Miller-column file browser
(Projects → Sessions → Turns → Sections → Detail) because that maps onto the
natural hierarchy of Claude traffic and lets power users navigate with arrow
keys alone.

Two non-negotiables:

1. **Monospace everywhere.** Numbers align, diffs line up, token counts read
   as data. Do not introduce proportional fonts.
2. **The auto-compact landmark crosses all three ctx-bar levels.** It is a
   single CSS variable (`--compact-threshold`), and all bars must render the
   tick at the same position. Breaking this alignment breaks the mental model.

## Colors

The palette is derived from GitHub Primer dark/light, adjusted for traffic
inspection context. Colors carry **semantic** meaning — do not reuse a
semantic color for decoration:

| Token   | Meaning                                                 |
|---------|---------------------------------------------------------|
| accent  | Selection, focus, interactive element, user role        |
| purple  | Session identity, thinking content, sessions column     |
| green   | OK / streaming / approve / assistant role               |
| yellow  | Cost, warning, intercept (armed), pending human action  |
| red     | Error, critical risk, over-compact threshold            |
| orange  | Subagent (inferred), sensitive-local source, warning    |
| dim     | Secondary text, metadata, disabled                      |

Both dark and light variants are defined for every token. Never introduce a
color that only works in one theme — check the `[data-theme="light"]` block
in `public/style.css:26` before picking a new literal.

**Context bar segments** (`cache-read`, `cache-write`, `input`) are chosen to
be distinguishable even for users with red-green deficiency; keep that
constraint if you add segments.

## Typography

One font stack (SF Mono → Cascadia Code → Fira Code → monospace), seven
sizes. The small end (9–11px) carries most metadata; 12–13px is body;
14–15px is reserved for page-level titles. Do not introduce sizes outside
this scale without a strong reason — odd sizes break the visual rhythm of
dense lists.

Tabular numerals (`font-variant-numeric: tabular-nums`) are required wherever
numbers need to align across rows — cache timers, token counts, costs.

## Layout

Miller columns are fixed-width (220px) for Projects / Sessions / Turns /
Sections so that horizontal scanning stays predictable. Detail fills the
rest. The focused-column indicator is a 2px top border in `accent` —
reserved for this purpose; do not use `border-top: accent` elsewhere.

Responsive behaviour is only applied to fullscreen pages (cost analysis,
sysprompt changelog). The main Miller layout is desktop-only by design.

## Elevation & Depth

Elevation is minimal and reserved for **floating** elements:

- Scorecard tooltip (hover card over a session)
- New-turn pill (appears when new activity arrives)
- Toast notifications

Do not add shadows to Miller-column items, bars, or detail content.
Separation comes from `border` color, not from shadow.

## Shapes

Radii follow a small scale (2 / 3 / 4 / 6 / 8 / 10 / 50%). Pills
(`rounded.pill = 10px`) are reserved for badges communicating status
(quota ROI, held indicator). Circles (`rounded.full`) are reserved for
status dots.

## Components

The most important component pattern is the **list item with a colored
left border** (`.project-item`, `.session-item`, `.turn-item`,
`.section-item`). Each uses:

- 3px (or 2px for turns) transparent left border by default
- `surface-hover` background on hover
- `surface-active` background + colored left border when selected
- Color of selected border encodes meaning:
  - `accent` for most columns
  - `purple` for sessions (matches session identity color)
  - `red` / `orange` / `yellow` for turns with elevated risk

If you add a new list column, follow this pattern exactly. Do not invent
a new selection style.

**Status dots** (`.sdot`) are 7×7 circles. Six variants exist; do not
introduce a seventh without updating the keyboard-nav legend in
`public/keyboard-nav.js`.

**Message badges** (`.msg-badge-*`) label timeline entries by role.
The five variants are exhaustive — new role types should either map to
an existing badge or trigger a discussion about adding one.

## Do's and Don'ts

### Do

- Reference tokens (`var(--accent)`, `{colors.accent}`) instead of literals.
- Check both dark and light themes before committing a color change.
- Reuse the list-item + left-border pattern for any new column.
- Use monospace numbers with `tabular-nums` where columns of numbers appear.
- Keep the auto-compact tick aligned across all three ctx-bar levels.

### Don't

- Don't add shadows to inline (non-floating) elements.
- Don't introduce new semantic colors. If red/yellow/green/orange/purple
  don't cover the meaning, propose a token change instead of a one-off.
- Don't add sizes outside the typography scale. 11.5px is not a size.
- Don't use `accent` for a border-top unless it's a focused-column marker.
- Don't add proportional fonts anywhere, including tooltips and badges.
- Don't style `.minimap` landmarks with literal percentages — use
  `var(--compact-threshold)`.

## Scope

This document covers tokens and patterns only. It does **not** prescribe:

- Component APIs (ccxray has no component framework — it's plain DOM)
- Animation curves beyond the few already in `public/style.css`
- Tooling (no lint, no contrast validator, no token export — yet)

If you want those, propose them as a separate change.
