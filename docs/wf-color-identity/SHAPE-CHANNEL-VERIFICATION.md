# #149 Shape/Glyph Channel — Verification Report

Date: 2026-07-06
Branch: `feat/wf-lane-shape-channel`

## What shipped

A redundant non-color identity channel (SVG-drawn glyphs) for workflow lanes. Each lane now carries a `(color, glyph)` pair; the combined pool is 5 colors × 8 glyphs = 40 unique pairs before repeat, vs 5 unique colors alone.

## Glyph pool

| slot | name | shape | context |
|------|------|-------|---------|
| — | circle (pinned) | filled circle | `main` orchestrator |
| 0 | square | filled square | hashed |
| 1 | triangleUp | filled triangle ▲ | hashed |
| 2 | diamond | filled diamond ◆ | hashed |
| 3 | plus | cross/plus ✚ | hashed |
| 4 | hollowCircle | hollow circle ○ | hashed |
| 5 | hollowSquare | hollow square □ | hashed |
| 6 | triangleDown | filled triangle ▼ | hashed |
| 7 | star | 5-pointed star ★ | hashed |

## Unit tests (TDD red→green)

| test | status |
|------|--------|
| `wfLaneShape` + `wfComputeLaneStyles` + `WF_LANE_GLYPHS` exposed | ✓ |
| main pinned glyph = circle | ✓ |
| same lane.key → same glyph (stable identity) | ✓ |
| `wfComputeLaneStyles` returns `{color, glyph}` | ✓ |
| 9 concurrent lanes (1 main + 8 hashed) → 9 distinct (color,glyph) pairs | ✓ |
| lane and card resolve same glyph (single resolver) | ✓ |
| `wfGlyphSvg` renders SVG for all 9 glyphs | ✓ |
| `wfGlyphHtml` returns inline `<svg>` | ✓ |

Full suite: **1044/1044 pass**, `CCXRAY_HOME=$(mktemp -d) node --test test/*.test.js`

## Browser smoke (isolated server :5607)

- Dashboard loads without JS errors
- 8 parallel haiku sessions generated via `claude -p` through proxy
- Live browser DOM verification:
  - **Gutter (SVG)**: `<circle>` elements present in `#wf-timeline`
  - **Agent card (HTML)**: `<svg>` present inside `.wf-ac-name`
  - **Steps header (HTML)**: `<svg>` with `<circle>` inside `.wf-steps-header` (after `wfRenderSteps()`)
- `wfComputeLaneStyles` called in browser with 9 simulated lanes → 9 unique pairs confirmed
- All 8 hashed glyphs render valid SVG (`length > 10`)

## Limitation

Browser smoke used independent sessions (each `claude -p` is its own session), not a single multi-subagent session. Multi-lane visual distinctness is verified by unit tests (the `wfComputeLaneStyles` uniqueness guarantee) and the browser-side JS validation, not by a rendered multi-lane screenshot.

## Codex second review

**BLOCKING (fixed)**:
1. `wfComputeLaneStyles` glyph probe was glyph-only within one color — with 13 lanes hashing to the same color bucket, pair collided (`#ffdbaa:triangleUp` repeated). **Fix**: two-level Cartesian probe (glyph first, bump color on glyph wrap) + `h>>>16` to decorrelate glyph hash from color hash. New adversarial 13-lane + 40-lane capacity tests confirm full 5×8=40 unique pairs.
2. `mc = wfModelColor(t.model)` unused in `wfRenderSteps` — pre-existing dead code, not introduced by this PR. Deferred to separate cleanup.

**ADVISORY (addressed)**:
- Removed double-compute: `wfRenderTimeline` now sets `laneStyles` only; `wfLaneColor` reads from `laneStyles` directly.
- `wfComputeLaneColors` shim kept for backward compat (existing #144 contract tests reference it).
