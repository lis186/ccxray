# session weather score — original design vs shipped implementation (#320)

> **This file is a design record, not a spec.** The authority for current
> behaviour is `public/weather.js`. The design below was settled in an owner
> conversation on 2026-07-20; the implementation that shipped in #371 / #372 /
> #373 (2026-07-29) diverges from it substantially. Read the divergence table
> before trusting any threshold quoted here.

Kept because it holds the *external* rationale the code comments do not: why the
Jenkins metaphor, why a compaction scar was treated as permanent, and where the
40% / 80% context boundaries originally came from. The shipped thresholds were
later re-derived empirically (see the `ponytail:` comments in `weather.js`,
which cite experiment numbers — `exp2`, `exp9` — not this document).

## Why weather at all

ccxray already computed per-turn quality signals (context pressure, compaction,
truncation, stuck detection) but they existed only as visual cues scattered
across the dashboard. No single scalar answered "is this session healthy?".
Jenkins solved the equivalent problem for CI with a 5-level weather icon
aggregated from recent build results; the metaphor transfers to LLM sessions
because both are "a series of attempts, some of which degrade the next one".

## Divergence table (design 2026-07-20 → shipped 2026-07-29)

| Aspect | Original design | Shipped (`public/weather.js`) |
|---|---|---|
| Aggregation | Priority-ordered escalation: `level = Math.max(level, N)`, integer 0–4 | **Weighted score**: 7 signals each return severity 0..1; `score = max + 0.3 × second-max`; mapped to 5 levels by ceilings 0.35 / 0.55 / 0.75 / 0.95 |
| Level 0 key | `clear` | **`sunny`** |
| Return shape | `{ weather, level, factors }`, `factors` = string array | `{ level, emoji, score, factors, stats, tooltip }` — no `weather` field (renamed `emoji`); `factors` = objects carrying `severity`, `detail`, and `entryId` |
| Signal count | 5 | **7** — added `latency_drift` (p75 turn duration vs per-model baseline) and `error_cumulative` (chronic errors across long sessions); `tool_error_elevated` became `error_cluster` (5-turn sliding window) |
| Context pressure | Hard steps: >80% → L2, ≥40% → L1 | **Continuous ramp**: `(pct − 0.4) / 0.6`, clamped 0..1 |
| Context denominator | `computeCtxUsed(usage)` (which **includes** `output_tokens`, `format.js:20`), fallback `maxContext` 200000 | Inline `input + cache_read + cache_creation` — **excludes `output_tokens`**; returns severity 0 when `maxContext < 1000`, no 200000 fallback |
| Stuck detector | ≥10 consecutive `tool_use` turns **with >25% error rate** | ≥10 consecutive turns that are `tool_use` **and** `toolFail` — a consecutive-failure streak, a materially narrower definition |
| Compaction | Hard cap: 1 → at most ⛅, 2+ → at most 🌧️ | Soft weight: severity 0.4 / 0.6, **can be outweighed by other signals** |
| File scope | "Phase 1 = pure function + tests, does not touch dashboard rendering" | Same file also contains overlay DOM construction, tooltip HTML, turn-link `onclick`, and an `_ACTION_TABLE` of prescriptive advice |
| Agent interface | `GET /api/sessions/:id/weather`, CLI `ccxray health`, skill `/session-health` | **None of the three exist.** Weather is computed client-side (`entry-rendering.js:813`, `workflow-timeline.js`) and server-side for cold sessions (`server/restore.js:386` → `sessionIdx.setWeather`) |
| Descriptive vs prescriptive | "Dashboard descriptive, API prescriptive — deliberately separate" | **Reversed**: the dashboard overlay emits prescriptive advice directly (`_ACTION_TABLE`, `weather.js:212`) |
| Threshold provenance | Owner conversation, 2026-07-20 | Empirically tuned — `K=0.5` chosen because `K=2` saturated on normal sessions; error-cluster denominator 2.0 because 0.6 flagged 247/346 sessions (exp2); `error_cumulative` added after ~30 false negatives (exp9) |

### Note on the context denominator

The two ctx numbers a user sees are **not** the same quantity: the dashboard's
context % uses `computeCtxUsed` (input + cache + **output**, deliberate since
#253), while weather's `ctxPct` is input-only. Weather therefore already does
what #267 proposes for the breakdown renderers. If #267 lands, keep them
aligned — or document why they differ.

## What still holds

These parts of the original design survived and are worth not re-litigating:

- **Scope-dependence.** Same function, different `turns` input — session card
  gets all turns, a swimlane lane gets its own turns, a turn card gets `[turn]`.
  Shipped as designed (`workflow-timeline.js:1558`, `:2581`, `:2800`, `:2917`).
- **Zero dependencies, isomorphic.** `weather.js` still imports nothing and runs
  in both the browser (script tag) and Node (`server/restore.js` requires it).
- **Truncation definition.** `stopReason === 'max_tokens'` **and**
  `output_tokens ≥ 16000` — the 16000 floor filters low-risk subagent kicks
  (definition from #306). Unchanged in the shipped code.
- **Deferred, still deferred.** Security signals (needs request-body inspection,
  different magnitude), customizable thresholds (YAGNI), weather trend sparkline.

## Original threshold rationale (superseded, kept for provenance)

| Threshold | Stated source at design time |
|---|---|
| 40% / 80% context zones | existing `ctxZone()`; practitioner consensus — Anthropic team recommends compacting at 50–60%, Hermes dual-layer at 50% + 85% |
| 16000 `output_tokens` for truncation | #306 definition |
| 10-turn streak + 25% error | #306 stuck-detector definition |
| 15% tool error rate | owner decision 2026-07-20 — below the stuck threshold, above the noise floor |

Only the 16000 floor survived unchanged. The context boundaries became a ramp
anchored at 0.4; the stuck rule was redefined; the 15% rate was replaced by two
separate error signals with empirically-set denominators.

### Superseded algorithm

The original priority-escalation implementation is preserved in PR #323
(branch `fix/320-session-weather`, `public/weather.js`, 56 lines). It is **not**
reproduced here — pasting a dead algorithm next to a live one invites reading the
wrong one. Recover it from the PR if the escalation approach ever needs revisiting.

## Related

- #320 — the feature issue (closed by #371)
- #323 — the Phase-1 PR this design document came from; superseded by #371
- #336 — remove the canned `_ACTION_TABLE` advice; the evidence-drill half of
  that issue already shipped in #373 (clickable turn links from factor details)
- #306 — source of the truncation and stuck-detector definitions
- #267 — context breakdown denominator; see the note above
