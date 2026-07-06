# #144 Option B — Workflow lane/agent identity color (design)

Status: **awaiting sign-off**. No code changed yet. Supersedes the model-color role from `wfModelColor` on identity marks (option A, shipped in `3d124d2`).

## Goal
"Same agent instance → same color; different instances → visibly different." Color must key off **agent identity** (`lane.key`), not model, so a lane's gutter and its detail card share one color, and parallel same-model agents (e.g. two `general-purpose` on sonnet) no longer look identical.

## Process behind this doc
5 simulated domain experts (Ware, Brewer, Wong, Stone, Szafir) independently evaluated the problem with 2026 sources; a design agent + an independent eval agent ran a measured autoresearch loop (real ΔE00 / WCAG / Machado-CVD computation + rendered screenshots). Scripts under `/tmp/ccxray-palette-design/`, visuals in this folder.

## Expert consensus (unanimous)
- **Scheme A**: curated palette + `FNV-1a(lane.key) % N`. Reject golden-angle HSL (not perceptually uniform, no CVD guarantee, collides reserved). Reject jitter (sub-threshold near-collisions at small marks are worse than honest collisions).
- **Pin `main`** outside the hash — the orchestrator is a fixed role, fixed color.
- **"Add a channel, not a hue"** (CatPAW CHI'26, Ware, Szafir, Wong): when hue runs out, disambiguate with **shape**, not more colors. Color here is redundant (label + lane position always present).
- Collision policy: never order-based global assignment (breaks identity stability). Accept bounded collisions; resolve **only among concurrently-visible lanes** via deterministic open-addressing.

## Measured finding — the reserved gamut caps hue at ~5–6
The workflow view already reserves 9 colors (status `#f85149 #d29922 #3fb950`, bar segments `#39c5cf #f0883e #8b5cf6`, events `#bc8cff #2ea043 #b87800`). These occupy exactly the red / orange / green / cyan / violet regions Okabe-Ito uses for CVD-safety. On the dark bg with 10px/2px marks, requiring every identity ≥ΔE00 20 from all 9 reserved **and** ≥12 apart under CVD:

| palette size (incl. main) | min inter ΔE00 (normal) | min inter ΔE00 (CVD) | verdict |
|---|---|---|---|
| 5 | 13.2 | **12.4** | CVD-clean |
| 6 | 13.2 | 9.2 | one pair sub-CVD-floor |
| 7 | 12.1 | 9.2 | + 3-pink glance-fail |
| 8 | 10.0 | 8.7 | fails inter-identity |

Violet is fully blocked (reserved `#bc8cff`+`#8b5cf6`), warm-red blocked (status red) → only ~6 usable hue families, two adjacent pairs (green/lime, cyan/teal). **Pure-hue identity is hard-capped at ~8.5/10** (independent eval); the ≥9 design must couple the palette with a second channel or accept the relaxation below.

## Recommended design

### Palette — pick ONE (this is the decision for you)

**Option S (strict, recommended for CVD): 5 colors** — every identity ≥ΔE00 20 from *all* reserved; CVD-clean (min 12.4).
| slot | role | hex | family |
|---|---|---|---|
| — | **main (pinned)** | `#35a4ff` | blue |
| 0 | hashed | `#f8dfa8` | pale gold |
| 1 | hashed | `#d2849c` | rose |
| 2 | hashed | `#bdc83a` | lime |
| 3 | hashed | `#fbb0d8` | pink |

5 colors ⇒ a 6th concurrent lane collides. Covered by open-addressing (below) + the shape channel.

**Option R (relaxed, more hues): 6 colors** — avoid only status R/Y/G (≥18); bar/event colors treated as soft (≥12) since they render in the bar/event tracks, spatially separate from identity marks in the gutter/card. CVD-clean (min 12.1).
| slot | role | hex | family |
|---|---|---|---|
| — | **main (pinned)** | `#42a3fd` | blue |
| 0–4 | hashed | `#ffdbaa` `#dc7d96` `#a1a716` `#45f8ef` `#d1d843` | peach, rose, olive, cyan, lime |

Trade: covers 6 concurrent lanes by hue alone (smaller implementation, no shape needed for the common case), but identity-cyan `#45f8ef` rhymes with cache-read cyan `#39c5cf` (different track), and olive~lime split only by lightness.

### Assignment + collision (both options)
```
wfLaneColor(lane):
  if lane.key == 'main' (laneIdx 0): return MAIN            # pinned, never hashed
  slot = fnv1a(lane.key) % HASHED.length                    # stable per instance
  return HASHED[slot]
# at render time, for the set of *currently visible* lanes:
#   if two visible lanes map to the same slot, bump the later one to the
#   next free slot (deterministic open-addressing over the live set only).
#   The stable hash is the default; live-set probing guarantees concurrent
#   lanes are never the same color, without global drift.
```
`lane.key` is already stable per instance (`agent-<agentKey>[:convId]`, convId splits parallel same-type agents). Single resolver `wfLaneColor(lane)` used by lane gutter **and** card ⇒ one source of truth.

### Model color — retire from identity
`wfModelColor` / `WF_MODEL_COLORS` are used *only* in `workflow-timeline.js`; removing them from identity marks touches nothing else.
- **Lane subtitle (459), card border+chip (1394), steps header dot (1551)** → `wfLaneColor(lane)`.
- Model stays visible as **text** (`wfShortModel`, already rendered) — not a competing hue.
- **Per-turn model dot (1566)** is genuinely "which model ran this turn" (a lane can switch models); keep it `wfModelColor` — it's per-turn info, not identity. (Confirm: keep, or drop to dim.)

### Second channel (shape glyph) — expert-mandated, recommend as fast-follow
A per-instance glyph (`● ■ ▲ ◆ ★ ✚ …` hashed off `lane.key`) on the lane/card carries CVD residual + collisions beyond palette size. See `coupled-design.png`: with Option S, a 6th blue lane is disambiguated by shape; colour-only (bottom row) it is not.
- **Recommendation:** ship palette + open-addressing first (delivers per-agent color for the realistic 2–6 lanes). Add the shape channel as a small follow-up (it's the CVD/fan-out hardening, YAGNI until >palette-size concurrent or a CVD-critical need). Or include now — your call.

## Decisions needed from you
1. **Palette: Option S (5, CVD-strict) or Option R (6, relaxed)?** (I lean R for the smaller diff + 6-lane hue coverage; S if colorblind-safety vs *all* reserved is a hard requirement.)
2. **Shape channel: now, or fast-follow?** (I lean fast-follow.)
3. **Per-turn dot (1566): keep model-colored, or dim?** (I lean keep.)

## Implementation sites (when approved)
`public/workflow-timeline.js`: add `WF_LANE_COLORS` + `wfLaneColor(lane)` + `fnv1a`; rewire 459, 1394, 1551; keep 1566. Remove `WF_MODEL_COLORS`/`wfModelColor` only if #3 = drop.
Tests (`test/`, node --test): `wfLaneColor` stable per `lane.key`, distinct per key, `main`→pinned, live-set open-addressing yields distinct colors for N≤palette concurrent lanes. Visual left to browser smoke.

## Out of scope
#142 (context-usage thresholds) is a separate, mechanical commit — not part of this design.

## Acceptance
Pure-hue palette scored **8.5/10** (hue ceiling under these reserved constraints). The full design (palette + live-set open-addressing + shape fast-follow) reaches the intent: concurrent lanes always distinct, stable per identity, CVD-clean. Final sign-off = this doc + browser smoke on real multi-lane traffic at 10px/2px on `#0d1117`.
