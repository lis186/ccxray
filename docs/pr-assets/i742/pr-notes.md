# Prepared PR notes

Evidence production commit: `eb7c546f6ac3075650360d02969dab530e0e840e`.

The v1 usage query contract delivers acceptance scenarios 1–5. Proposal item 3
in [issue #742](https://github.com/lis186/ccxray/issues/742), a hub start/stop or
gap coverage hint, remains open: `coverage` is still `unknown` because there is
no durable recording ledger. Do not use a closing keyword for #742 until that
scope is explicitly resolved.

Follow-up issue draft: **Persist recording intervals and expose usage coverage hints**.
Persist hub start/stop intervals and crash/restart gaps without query-time writes;
define retention and migration semantics; distinguish recorded intervals from
source observations; test graceful stop, crash, restart, missing history and
retention gaps. Link the created follow-up issue here before publishing the PR.
No remote issue was created during this local-only unattended run.

Review fixes deliberately update selector fixtures with dummy model/usage data:
v1 excludes cost-only marker rows. Marker exclusion remains separately tested.
The empty JSON selector test now actually passes `--json`; exact shape tests
and both references include `sourceCoverage`. Aggregate counters remain safe
for prototype-like names internally and return ordinary objects to callers.

The unit runner remains serial because the owner explicitly requires serial
tests for this task. This also bounds resource usage in unattended runs; it
may increase CI duration. Changing CI concurrency is deferred to separate work.
The purity test now traps filesystem metadata changes and child-process creation;
the runner consequently classifies that file as heavy. Grouped text renders
missing reasoning as `unknown`; JSON retains `null`.

No UI changed. Browser screenshots are not applicable to this CLI/report fix.
