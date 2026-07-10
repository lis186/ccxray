# 0006 — Lane-focus geometry must match what's actually rendered

- Status: Accepted
- Date: 2026-07-10
- Related: PR #224

## Context

Lane-focus mode (`wfState.laneFocusMode`) collapses the swimlane overview so
the sub-lane SVG draws only the currently-selected lane, instead of every
subagent lane stacked — added because a real session with 473 `Agent` tool
calls (many spawned subagents) overflowed the fixed-height lane list with no
scroll affordance.

Three separate places in `workflow-timeline.js` each computes lane geometry
independently:

- `_wfRenderSvgContent()` — the actual draw: builds `subIndices` as either
  `[focusLi]` (focus mode) or all lanes `1..N` (normal), and lays them out
  top to bottom.
- `_wfTotalLanesHeight()` — used to size the SVG container so it doesn't
  reserve empty space for lanes that aren't drawn.
- `_wfLaneIdxAtY(svgEl, my)` — hit-testing: given a mouse Y coordinate,
  which lane is under the cursor? Used by both hover (`_wfHoverMove`) and
  the chart click-to-lock handler.

Codex review (round 4, PR #224) caught `_wfLaneIdxAtY()` walking
`wfState.lanes[1..N]` and accumulating heights as if every sub-lane were
stacked — the pre-focus-mode behavior — even when `laneFocusMode` was on and
only one lane was actually drawn at `y = WF_PAD`. Hovering or clicking
anywhere in the (single, real) rendered lane could resolve to whatever
*unfocused* lane happened to occupy that Y range under the old sequential
math, selecting or locking the wrong turn. The label-area click handler
(a separate code path, same file) already had the correct focus-mode branch
— `_wfLaneIdxAtY()` was the one site that drifted.

## Decision

Any function that computes "which lane is at this position" in the sub-lane
SVG must branch on `wfState.laneFocusMode` the same way
`_wfRenderSvgContent()` does: focus mode → only `_wfFocusLaneIdx()`'s lane
exists, drawn at `y = WF_PAD`; normal mode → walk `lanes[1..N]` accumulating
`_wfLaneHeight(i)`.

| Site | Role | Focus-mode branch |
|------|------|--------------------|
| `_wfRenderSvgContent()` | draws the lanes (ground truth) | `subIndices = focusLi > 0 ? [focusLi] : []` |
| `_wfTotalLanesHeight()` | sizes the container | already correct — see inline comment |
| `_wfLaneIdxAtY()` | hover + chart click hit-test | fixed in PR #224 (round 4) |
| Label-area click handler (inline, `wfRenderTimeline`) | click-in-label-column hit-test | already correct — has its own focus branch |

## Consequences

**Good**: hover, chart-click, and label-click all agree on which lane is
under the cursor in every mode, matching what's actually drawn.

**Bad — consistency contract**: a fourth geometry consumer added later
(e.g. a new interaction mode) that doesn't special-case `laneFocusMode` will
silently hit-test against the pre-collapse layout again, exactly like the
round-4 bug.

**Mitigation**: `INVARIANT` guard comments at each site above name this
ADR. The label-area click handler's existing focus-mode branch was the
reference implementation `_wfLaneIdxAtY()` was brought in line with — future
geometry consumers should copy that same `focusLi > 0 && my >= WF_PAD`
shape rather than re-deriving it.

## Alternatives considered

**Single shared geometry-lookup table, rebuilt on every render, all three
sites read from it**: rejected as disproportionate for three call sites —
would trade "three places must agree" for "one more cache that must be
invalidated correctly," a different but not obviously smaller consistency
burden. Revisit if a fourth or fifth geometry consumer appears.
