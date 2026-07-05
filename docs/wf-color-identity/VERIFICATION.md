# Verification — #142 + #144 (branch fix/wf-color-thresholds)

Base `main` = 603cae9. Commits: `233a007` (#142), `f98e6ee` (#144).

## Automated tests
- New contract tests, TDD red→green:
  - `test/ctx-color.test.js` — `ctxColor`/`ctxBarColor` band boundaries **39→safe, 40→yellow, 80→yellow, 81→red** (both client and server).
  - `test/workflow-timeline.test.js` (#144 block) — `wfLaneColor` stable per `lane.key`, `main` pinned & distinct from hashed, `wfComputeLaneColors` gives 6 distinct colors for main+5 concurrent lanes (open-addressing), lane/card share one resolver.
- Full suite against an empty home: **1027 pass / 0 fail** (`CCXRAY_HOME=$(mktemp -d) node --test test/*.test.js`).

## Browser smoke (isolated: port 5607, throwaway CCXRAY_HOME, upstream forced to api.anthropic.com)
Real traffic: `claude -p` launching **three parallel Explore subagents** → 1 session, main (fable-5) + 3 Explore agents (all haiku-4-5), 9 turns.

### #144 — verified live via rendered DOM (SVG fills)
| lane | model | identity color |
|---|---|---|
| main (orchestrator) | fable-5 | `#42a3fd` (pinned) |
| Explore A | haiku-4-5 | `#a1a716` |
| Explore B | haiku-4-5 | `#45f8ef` |
| Explore C | haiku-4-5 | `#d1d843` |

- **Three same-model agents got three distinct colors** — the exact bug option B fixes (old model-color would paint all three the same orange). ✅
- **main pinned** to `#42a3fd` = `WF_LANE_COLORS.main`. ✅
- **lane == card**: selected lane (main) card border = `rgb(66,163,253)` = `#42a3fd`, same as its gutter. ✅

Screenshot: `smoke-workflow-lanes.png`.

### #142 — verified live + unit-locked
- Injected HUD rendered as `Context: 16.8% (...)` — **emoji 📊/⚠️/⚡ removed**; 16.8% < 40 so no advice line (correct band). ✅
- The >40 (yellow) / >80 (red) band cutoffs are locked by `test/ctx-color.test.js` at the 39/40/80/81 boundaries (the smoke session sat in the low/safe band, so higher bands are covered by unit tests, not the screenshot).

## Manual test checklist (for reviewer)
- [ ] Open a session with ≥2 parallel subagents on the same model → each lane a different color; each lane's gutter color matches its agent-card border/chip.
- [ ] The orchestrator ("main") lane is always the same blue `#42a3fd`.
- [ ] Per-turn model dot in the step list still reflects the model (kept intentionally).
- [ ] A turn detail with context >80% shows a red bar/label; 40–80% yellow; <40% the category/accent color.
- [ ] Terminal `printContextBar` and the injected HUD advice flip at 80 (consider /clear) and 40 (getting full), no emoji.

## Out of scope (noted, not changed)
- `workflow-timeline.js` `wfCtxZoneColor` already uses the 80/40 scheme (boundary `>=80` vs the new `>80`; 1-unit cosmetic diff at exactly 80.0).
- `miller-columns.js` `ctx-alert-*` (compactPct ~83.5/75) is a distinct "near auto-compaction" predictor, not a display band.
- Shape/glyph second channel for #144 (CVD/fan-out hardening) — planned fast-follow.

## Codex second-review gate
- Round 1: **1 blocking** — `wfCtxZoneColor` + tooltip zone still used `pct >= 80`, so exactly 80.0% rendered red in the minimap/step-list/tooltip while every other site flipped at `>80`. Fixed in `2a3281b` (3 sites → `> 80`; the `ctx80` event trigger stays `>=80`), plus a workflow boundary test.
- Round 2 (after fix): **LGTM — 0 blocking.** ✅
