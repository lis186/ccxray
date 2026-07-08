# 0002 — Signature-based dirty check for renderProjectsCol

- Status: Accepted (stop-gap; superseded when #157 lands)
- Date: 2026-07-08
- Related: #167 / PR #192, #157

## Context

Every SSE entry arrival calls `renderProjectsCol()`. On main before this
change, each call walks `projectsMap`, sorts, and does a full `innerHTML`
rebuild of the Projects column. During active sessions this means ~100 full
DOM rebuilds per 100 entries, most of which produce identical output.

#157 (subscription-based rendering) is the structural fix, but it's a large
refactor. #167 is a stop-gap.

## Decision

Guard `renderProjectsCol` with a **signature string** — a `\x00`-joined
concatenation of every field that affects the rendered output. If the
signature equals the previous one, skip. If changed, schedule the real
render via `requestAnimationFrame` to coalesce multiple changes per frame.

Signature fields (as of PR #192):

```
projectFilterMode, selectedProjectName, _entriesLoading, _entriesLoadingText,
[per project]: name, totalCost, sessionIds.size, firstId, lastId,
               statusClass, directStar, starCount, idleBucket
```

## Consequences

**Good**: 99% reduction in DOM rebuilds (100 → 1 per 100 SSE entries).

**Bad — manual maintenance**: any new field that affects the rendered project
row must be added to `sigParts`. Forgetting a field = stale render that only
surfaces when that field changes in isolation. There is no compile-time or
test-time guard — only code review catches omissions.

**Mitigation**: Layer 1 guard comment at the signature site in
`miller-columns.js` names this ADR. Reviewers adding rendered fields should
grep for `sigParts`.

## Exit condition

When #157 (subscription-based rendering) lands and replaces the signature
mechanism, delete the dirty-check code, remove the guard comments, and mark
this ADR as Superseded.
