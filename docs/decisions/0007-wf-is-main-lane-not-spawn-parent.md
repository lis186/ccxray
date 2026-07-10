# 0007 — `_wfIsMainLane(lane)`, never `!lane.spawnParent`

- Status: Accepted
- Date: 2026-07-10
- Related: PR #224

## Context

`lane.spawnParent` looks like it should mean "this lane was spawned by
another lane, i.e. it's a subagent" — so `!lane.spawnParent` reads as "this
is the main lane." It isn't: every lane object created in
`workflow-timeline.js` (`wfInferLanes`, `wfAddEntry`, child-session lanes,
sub-agent lanes) sets `spawnParent: null` unconditionally. Nothing in the
current codebase ever assigns it a truthy value. `!lane.spawnParent` is
`true` for every lane, main and subagent alike.

This trap was hit twice in the same feature (PR #224):

1. During implementation, an early version of the Main/Subagent cost split
   used `!lane.spawnParent` to detect the main lane, misattributing 100% of
   subagent cost as main in verification testing (caught before merge, fixed
   with `_wfIsMainLane(lane)`, an already-existing helper from the #91
   swimlane feature).
2. `wfRenderAgentCard`'s meta line (`'N turns · Xm · ' +
   (lane.spawnParent ? 'subagent' : 'orchestrator')`) — pre-existing code,
   not touched by PR #224's diff — has the same bug: it always renders
   "orchestrator," even on subagent lanes, confirmed live in a 10-lane
   session during PR #224's browser verification pass. Fixed alongside this
   ADR since it's the exact trap being documented, not a new finding.

## Decision

`_wfIsMainLane(lane)` — `lane.key === 'main' || lane.name === 'main'` — is
the only correct test for "is this the main/orchestrator lane" anywhere in
`workflow-timeline.js`. `lane.spawnParent` is not a live signal; treat any
code that branches on its truthiness as a bug.

## Consequences

**Good**: one canonical helper, already used by `wfComputeLaneStyles`,
`wfLaneColor`, `wfLaneShape`, and (as of PR #224) `wfRenderAgentCard`'s
rollup gate and meta-line label.

**Bad — the field itself invites the mistake**: `spawnParent` reads as
meaningful even though it's dead. Anyone skimming lane-object construction
for "how do I tell main from subagent" will reach for it first, because it's
right there and its name suggests exactly that.

**Mitigation**: an `INVARIANT` guard comment at `_wfIsMainLane`'s
definition and at each call site that gates main-lane-only behavior names
this ADR.

## Alternatives considered

**Remove the dead `spawnParent` field entirely**: rejected for this PR —
it's assigned at 5 lane-construction sites, and removing it is an unrelated
cleanup outside PR #224's scope. Worth doing as a follow-up: if the field
never becomes live, deleting it removes the trap at the source instead of
just guarding against it.

**Make `spawnParent` actually track the parent lane**: rejected as
out of scope here — no current feature needs "which lane spawned this
one" as data; `_wfIsMainLane` is the only distinction anything currently
reads.
