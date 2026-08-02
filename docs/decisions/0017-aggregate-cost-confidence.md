# 0017 — Aggregate cost confidence: threshold-gated `~`, precision degradation, directional `+`

- Status: Accepted (expert-panel design 2026-08-03; owner sign-off same day)
- Date: 2026-08-03
- Related: #420 Phase 3 / #421 (engine confidence) / #422 (per-turn UI) / ADR 0002 (sigParts) / ADR 0013 (persist-fact-derive-view precedent)

## Context

Phase 2 (#422) made per-turn cost confidence visible: `exact`/`prefix` render `$X`,
`fallback` renders `~$X` + tooltip, `unknown` renders `—`. Aggregate totals
(session card, project card, swimlane lane summary, Usage tab daily/monthly/account
cards) sum turns of **mixed** confidence and today render an unmarked `$X.XX`.

Two distinct failure classes hide in an aggregate:

1. **Fabrication** — fallback-priced components. Error is multiplicative and
   bidirectional (a default rate can be off by a large factor). The motivating
   case: a 390-turn all-fallback agent rendering `$19.58`, a number that is
   entirely fabricated.
2. **Under-count** — `unknown` turns contribute *nothing* to the sum (cost is
   null, skipped). Error direction is **known**: the total is always too low.
   Nothing marks this today.

### Real-data measurement (2026-08-03, this corpus)

- Usage-tab path (177,688 cost-worker entries): fallback exists in exactly one
  model (`codex-auto-review`, 349 entries, $17.32); monthly fallback cost share
  peaks at **0.11%**; zero days in the last 30 reach 5%. `unknown` = 0.
- Proxy-index path (256,726 lines): fallback = 0; 42 sessions contain
  unknown-cost turns, 7 sessions are entirely unknown; 88% of lines are legacy
  (pre-#421, no confidence field).
- Distribution is **bimodal**: an aggregate's fallback share is ≈0% or (within
  one lane/model) ≈100%. The threshold's exact value is therefore low-stakes.

### Expert panel (independent assessments, 2026-08-03)

Tufte, Tetlock, Kahneman — each ran the option set independently; full analyses
in the #420 Phase 3 PR. Convergence (reached via three different mechanisms —
inverted Lie Factor, Brier resolution, habituation):

- **Worst-of (any fallback → `~` on the whole total) fails** (scores 3/3/3): on
  a 0.28%-contaminated total the marker overstates by ~357×; imports make it
  near-permanent on project/monthly cards; a marker that always fires carries no
  information and its devaluation back-contaminates the shipped per-turn `~`.
- **Tooltip-only fails standalone** (a wholly fabricated `$19.58` renders
  pixel-identical to an exact one) but is **mandatory as substrate** — a binary
  marker cannot convey magnitude.
- **Split display (`$351.66 + ~$0.98`) fails**: double ink for a bimodal
  distribution where one term is almost always ≈0, and the reader must do
  arithmetic to recover the number they came for.
- **`unknown` is a different error class and must not share the `~` glyph** —
  its direction is known, so the honest encoding is a lower bound.
- **The clean case must stay clean**: marking a 0.28% contamination is itself a
  proportionality lie and spends the marker's scarcity.

Divergence, resolved by owner sign-off:
- *Precision degradation* (`~$20`, not `~$19.58`, for mostly-fabricated totals):
  Kahneman + Tufte for, Tetlock keeps digits. Adopted — the digits are the
  anchor; a prefix habituates away, but a display that never contained four
  significant figures leaves an honest residue ("about twenty") even after the
  marker is no longer consciously seen. Displayed digits must not exceed known
  digits (Graphical Integrity P5).
- *Share denominator*: cost share alone is circular — its numerator is priced by
  the very rates declared untrustworthy (a 10×-under-priced fallback hides its
  own share). Adopted Tufte's `max(costShare, countShare)`: count is a fact and
  is the honest floor; max errs toward marking.

## Decision

One shared pair of helpers in `public/format.js` — `formatAggCost` (HTML span +
tooltip) and `formatAggCostText` (plain text) — is the **only** way an aggregate
cost reaches the screen. Inputs: the summed cost plus a fold
`{ fallbackCost, fallbackCount, unknownCount, count }`.

| Condition (evaluated in order) | Render |
|---|---|
| `cost == null`, or `count > 0` and priced turns (`count − unknownCount`) = 0 | `—` |
| `fallbackCost/cost ≥ 0.50` | `~` + cost rounded to **2 significant figures** (e.g. `~$20`) |
| `max(fallbackCost/cost, fallbackCount/count) ≥ 0.10` | `~$X.XX` (site's normal precision) |
| otherwise | clean `$X.XX` |
| `unknownCount ≥ 1` (no threshold — "at least" is exactly what is true) | append `+` suffix to any of the above except `—` |

Tooltip (the substrate) whenever `fallbackCount > 0` or `unknownCount > 0`:
fallback share in words (`N/M 筆使用預設費率（佔 X%），可能不準確`) and/or the
excluded count (`K 筆無費率資料，未計入總額`). Thresholds are named constants in
`format.js` (`AGG_FB_MARK_SHARE = 0.10`, `AGG_FB_DEGRADE_SHARE = 0.50`).

Legacy entries (no confidence field) contribute nothing to the fold — an
all-legacy aggregate renders clean, matching pre-#420 behavior.

### The fold is a fact; the marker is a view (ADR 0013 shape)

Persisted/accumulated state is only monotone sums and counts
(`fallbackCost`, `fallbackCount`, `unknownCount`) — rebuildable at every layer.
The rendered marker is derived at render time and never stored.

### Site table

| Site | File | Fold source |
|------|------|-------------|
| Session card total | `public/miller-columns.js` `renderSessionItem` | `sess.fallbackCost/…` (live accumulation + cold merge) |
| Project card total | `public/miller-columns.js` `renderProjectsCol` | sum of member sessions' folds |
| sigParts | `public/miller-columns.js` | **one** scalar — the rendered cost string (ADR 0002) |
| Lane agent card / hover `lane $X` / cost table Total | `public/workflow-timeline.js` `wfLaneSummary` consumers | fold added to `wfLaneSummary` return (turns + `overlapEntries`) |
| Usage daily/monthly/account cards | `public/cost-budget-ui.js` | per-group sums added in `server/cost-budget.js` |
| Session-index persistence | `server/session-index.js` `_upsert` | 3 new fields on `s`, responseId-deduped alongside `_costByRid`/`_countedRids`; #368 field-probe migration |

Per-turn sites are **not** touched — they keep `formatCost`/`formatCostText`
(#422 INVARIANT).

## Consequences

**Good**: marker prominence tracks contamination magnitude; the habituated
residue of every marked state is still a true belief; the under-count that
exists today on 42 real sessions becomes visible; all folds are rebuildable.

**Accepted limits**:
- The 10%/50% thresholds are decision-based, not error-calibrated — the actual
  error distribution of fallback rates has never been measured. Bimodality makes
  this low-stakes today. Follow-up: measure `LITELLM_LAG_OVERRIDES` graduation
  cases (`|fallback − true| / true`) when enough have accumulated.
- Duplicate-copy confidence classification rides the first-seen responseId slot
  (same bounded imprecision as ADR 0012's first-seen cost attribution).
- A threshold is a step function: 9.9% renders clean, 10.1% renders `~`. The
  always-on tooltip carries the continuous value, so a confused user can resolve
  the discontinuity by hovering.

**New consistency contract**: an aggregate cost display site must call
`formatAggCost`/`formatAggCostText` with a complete fold — rendering
`'$' + total.toFixed(2)` directly, or omitting a component stream from the fold
(e.g. forgetting `overlapEntries`), silently reverts that site to unmarked
fabrication. Guard comments at every site in the table name this ADR.

## Alternatives considered

- **A worst-of** — rejected, scores 3/3/3 (habituation, inverted Lie Factor
  ≈357, back-contamination of the per-turn marker).
- **B bare ratio threshold** (no degradation, no `+`) — rejected 6-8/10: right
  axis, but keeps the false-precision anchor and throws away the known
  direction of the unknown error.
- **C split display** — rejected 4/2/4: double ink for a bimodal constant,
  reader-side arithmetic, breaks column scanning.
- **D tooltip-only** — rejected standalone 2-4/10; adopted as the substrate
  layer of the accepted design.
- **Count-share-only or cost-share-only gate** — rejected: count-share
  overstates 17× on the cheap-fallback case; cost-share is circular on the
  under-priced-fallback case. `max` of both is strictly safer than either.
