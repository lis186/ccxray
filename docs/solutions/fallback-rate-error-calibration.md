# Fallback Rate Error Calibration

Issue: #425
Status: **Guard 1 triggered — n < 3, thresholds unchanged**
Date: 2026-08-06

## Background

ADR 0017 introduced aggregate cost confidence thresholds
(`AGG_FB_MARK_SHARE = 0.10`, `AGG_FB_DEGRADE_SHARE = 0.50` in
`public/format.js:123-124`). These were decision-driven guesses, never
calibrated against real error data.

`LITELLM_LAG_OVERRIDES` (`server/default-rates.js:79`) provides a natural
experiment: when LiteLLM catches up to a hand-set rate, the override
"graduates" and we get `|hand-set − LiteLLM| / LiteLLM` per rate column.

## Graduated Override Error Table

Two entries have graduated as of 2026-08-06. Both retired 2026-07-19 when
LiteLLM listed `xai/grok-4.5` and `xai/grok-4.3`.

| Entry | Rate | Hand-set | LiteLLM | Relative Error |
|-------|------|----------|---------|----------------|
| grok-4.5 | input | 2.00 | 2.00 | 0% |
| grok-4.5 | output | 6.00 | 6.00 | 0% |
| grok-4.5 | cache_read | 0.50 | 0.50 | 0% |
| grok-4.3 | input | 1.25 | 1.25 | 0% |
| grok-4.3 | output | 2.50 | 2.50 | 0% |
| grok-4.3 | cache_read | 0.20 | 0.20 | 0% |

`cache_create` excluded: both entries had `cache_create: 0` (unknown at
time of entry, not an estimate of zero). Current LiteLLM values are 2.00
and 1.25 respectively.

### Why all zeros

Both overrides were transcribed directly from the xAI official pricing
page. LiteLLM's source is the same page. No estimation was involved —
these are copy errors (of which there were none), not forecasting errors.

This means the graduated-override population measures **transcription
accuracy**, not **estimation accuracy**. It does not tell us how wrong
the `fallback` catch-all (claude-sonnet-4 rates for unknown models) is.

## Fallback Catch-All Population

The second population of interest: models priced by the `fallback` path
in `calculateCostSimple` (`server/default-rates.js:177`) — i.e. models
with no rate table entry at all, charged at claude-sonnet-4 rates.

This population **cannot be measured from git history**. It requires
runtime `Unknown model:` log entries cross-referenced against the current
LiteLLM table. No such log archive exists in the repo.

Status: **empty (not measurable)**.

## Decision Rule Application

Pre-registered in #425 (Tetlock panel, pinned before data collection):

- p90 error < 30% → raise `AGG_FB_MARK_SHARE` toward 15%
- p50 error > 3× → lower `AGG_FB_MARK_SHARE` toward 1%
- otherwise → keep 10%/50%

### Guard 1 (small sample)

n = 2 graduated entries < 3 required. **Thresholds must not change.**

### Guard 2 (post-hoc rationalization)

Not applicable — Guard 1 blocks any threshold change.

## Pending Graduation

| Entry | Since | Graduates When |
|-------|-------|----------------|
| grok-build | 2026-07-09 | LiteLLM lists `xai/grok-build` or `xai/grok-build-0.1` |

When grok-build graduates, n = 3 and the decision rule can fire. However,
if grok-build rates were also transcribed from the official pricing page
(they were — source field cites `docs.x.ai/developers/pricing`), the
expected error is again 0%, which tells us nothing about the fallback
population.

## Recommendation

1. Keep #425 open. Re-run when grok-build graduates (n = 3).
2. The graduated-override population is structurally uninformative about
   fallback error because overrides are transcriptions, not estimates.
   To actually calibrate the fallback threshold, we need either:
   - Runtime log archive of `Unknown model` events, or
   - A model that was genuinely estimated (not transcribed) and later
     graduated — which has not happened yet.
3. Current thresholds (10% / 50%) remain. No code change.
