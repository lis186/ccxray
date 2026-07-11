# 0008 — Temporal overlap overrides agentKey for lane placement

- Status: Accepted
- Date: 2026-07-11
- Related: #221 / #222 / Batch 11 redo (verification-failed evidence on both issues, 2026-07-11)

## Context

`agentKey` is extracted from system-prompt content (`extractAgentType`,
server-side). It is authoritative about **what prompt an agent runs** — but
not about **which agent instance sent the request**. A fork subagent
inherits the parent's full system prompt, session_id, cwd, model, and
conversation prefix, so its requests carry the parent's authoritative
`orchestrator` agentKey on the wire. No request field distinguishes a fork
from its parent (#222's core finding).

The one signal that cannot lie is physics: two turns of the same session
whose time ranges overlap cannot be one serial conversation — a client's
main loop runs one request at a time, so genuine concurrency (two sockets
open simultaneously) proves a parallel agent is in flight.

Batch 11's first attempt (PR #225/#226, merged 2026-07-10) added exactly
this temporal-overlap split, but **exempted turns with an authoritative
agentKey** ("that server-side signal already resolved them definitively").
Forks carry the authoritative `orchestrator` key, so the exemption excluded
precisely the case the fix was written for. Owner acceptance failed;
re-verification on main@9a784dd against real data found 547 overlapping
turn pairs still rendered inside main lanes across 15 sessions (up to 8
concurrent turns drawn as one serial lane).

## Decision

In lane placement, **physical overlap outranks agentKey**. Any turn whose
start falls strictly inside the previous main-chain turn's `(start, end)`
is moved to a parallel lane, regardless of its agentKey. `wfInferLanes`
(batch) rebuilds main as a serial chain via a sorted sweep; overflow turns
go to numbered parallel lanes (`parallel-<model>:<convId>`, `…#2`, `…#3`)
by best-fit (latest-ending lane that stays serial), so a fork's own serial
turns tend to reconstruct as one lane and lane count is bounded by the
session's true max concurrency. `wfAddEntry` (live) mirrors this with the
same predicate and best-fit selection.

The overlap predicate — start **strictly** inside `(start, end)`; equal
starts count as sequential — matches `entry-rendering.js`'s existing
`_recentMainSpans` check, keeping the ADR 0005 contract (turn list and
swimlane must not disagree) intact. ADR 0005's gate still governs where
agentKey itself is trusted for main/subagent classification; this ADR adds
that the overlap check sits **above** that signal and is never gated by it.

## Consequences

**Good**: no lane can contain two temporally-overlapping turns — a
machine-checkable invariant (asserted in `test/workflow-timeline.test.js`)
that cannot green-light the Batch 11 failure mode again. Real-data
re-audit: 547 → 0 overlap findings.

**Bad — identity remains inferred**: without a wire-level identity signal
(#222's upstream ask), numbered parallel lanes are *concurrency tracks*,
not verified per-instance identities. Interleaved fork/parent turns that
never overlap are indistinguishable and stay in main; best-fit can in
principle interleave two forks' turns across lanes. The invariant we
guarantee is "no intra-lane overlap," not "one lane per fork."

**Bad — hung-stream edge**: a stalled stream held open past its client's
retry produces genuine socket concurrency for one logical agent; such a
retry renders as a parallel lane. Accepted as rare and visually honest
(two requests really were in flight).

## Alternatives considered

**Keep the exemption, special-case forks by fan-out signature (same convId
+ same msgCount + near-simultaneous starts)**: rejected — narrower, more
parameters to tune, and misses parallel patterns that don't match the
signature. Overlap is the strictly stronger signal.

**One shared parallel lane per model+convId (the #226 shape)**: rejected —
concurrent forks share model AND convId, so they pile into one lane that
overlaps internally, recreating the bug one level down.
