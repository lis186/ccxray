# 0004 — Skeleton loading lifecycle: ID matching + early-return contract

- Status: Accepted
- Date: 2026-07-08
- Related: #184 / PR #189

## Context

Usage, System Prompt, and the main dashboard show skeleton placeholders
during data loading. The original implementation had two failure modes:

1. **Orphaned skeletons**: skeleton `<div>`s had no `id`, so render
   functions couldn't find them via `getElementById`. They created new
   elements and appended them — leaving skeletons permanently in the DOM.

2. **Early-return leaks**: render functions that received empty data (e.g.,
   `accounts.length === 0`) returned early without clearing the skeleton
   content inside the container.

Both violate the #184 guard: after data loads, `document.querySelectorAll('.skeleton').length` must be 0.

## Decision

Two rules for any skeleton → real-content handoff:

**Rule 1 — ID matching**: skeleton containers must carry the same `id` that
the render function looks up via `getElementById`. This way the render
function finds the existing skeleton div and overwrites its `innerHTML`
in place, rather than appending a sibling.

Current ID mappings:

| Skeleton | Render function | ID |
|----------|----------------|-----|
| Monthly cost | `renderMonthlySummary` | `cp-monthly` |
| Daily heatmap | `renderDailyHeatmap` | `cp-daily` |
| Account card | `renderAccounts` | `cp-accounts-content` |

**Rule 2 — Early-return must clear**: every code path in a render function
that returns without writing real content must first set
`container.innerHTML = ''` (or equivalent). This includes empty-data
branches, error branches, and hide-card branches.

## Consequences

**Good**: skeletons reliably disappear after data loads; no layout shift
between loading and loaded states.

**Bad — implicit contract**: there is no compile-time or test-time
enforcement. A new render function that skips clearing on early-return will
silently leave skeleton nodes. The Puppeteer verification script
(`/tmp/verify-184-skeleton.js` pattern) is not yet in CI.

**Mitigation**: Layer 1 guard comments at `renderCostSkeletons` and each
render function's early-return path name this ADR. Future skeleton pages
should follow the same pattern.

## Affected tabs

- **Usage** (`cost-budget-ui.js`): accounts, monthly, daily
- **System Prompt** (`system-prompt-ui.js`): agent list, version list, content panel
- **Dashboard** (`miller-columns.js`): no skeletons currently; if added, follow Rule 1 + 2
