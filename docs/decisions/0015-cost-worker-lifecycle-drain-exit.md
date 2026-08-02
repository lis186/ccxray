# 0015 — cost-worker lifecycle: drain-exit completion over a stdout pipe (IPC result channel rejected)

- Status: Accepted
- Date: 2026-08-02
- Related: #395 / #396 / #400 / #401 / #402 / #407

## Context

`server/cost-worker.js` is forked by `server/cost-budget.js` to scan
`~/.claude*/`, `~/.codex*/`, and the ccxray index for usage data. The worker
writes a single JSON array to stdout and exits by event-loop drain. Four
patches in a week (#395 → #396 → #402 → #407) each fixed one lifecycle seam
and introduced another, because the cross-file contract was implicit. This
ADR makes it explicit.

The file also exports pure functions (`calculateCostSimple`,
`processGrokIndexEntry`, `processGrokIndexFile`, `scanGrokFromCcxrayIndex`)
for unit testing via `require()`. Before this ADR, importing the module
installed a `process.on('disconnect')` handler and called
`process.channel?.unref()` on the importing process — a side effect that
hijacked the importer's lifecycle (#407 class).

## Decision

cost-worker is a **pure batch process**. Its contract:

- **Input surface**: environment variables only (enumerated in R4 below).
- **Result channel**: a single JSON array written to stdout.
- **Successful termination**: event-loop drain after the final `stdout.write`.
- **Two execution modes**: *executed* (`require.main === module` — forked by
  cost-budget.js or run standalone) and *imported* (pure function exports
  only — side-effect free after this ADR).

### R1 — no handle may ref the loop past the final stdout write

The `'disconnect'` listener refs the child-side IPC channel, keeping the
event loop alive forever (the #396 regression). `process.channel?.unref()`
drops the channel as a keep-alive reason without removing the listener.
Both the listener and the unref belong to **executed mode only** — importing
this file must not install handlers or unref channels on the importer.

### R2 — no `process.exit()` on the success path

With `silent:true` stdout is a pipe. An explicit `process.exit(0)` abandons
whatever has not been flushed, so the payload is cut off at one pipe buffer
(65,536 bytes as measured on macOS + Node 22 — the capacity is
platform-specific, the truncation is not). That converts a loud hang into
silent cost-data corruption.

### R3 — one result protocol shared by every execution entry point

Introducing a second channel (e.g. IPC via `process.send`) is a protocol
change that must land with the parent (`cost-budget.js`) and every
stdout-reading test in the same PR. See Rejected below.

### R4 — the input surface is an enumerable list of roots

The worker reads from these env-derived roots:

| Root | Source | Scanned by |
|------|--------|------------|
| `$HOME/.claude*` | `os.homedir()` | `discoverHomes('.claude')` |
| `$HOME/.config/claude/projects` | `os.homedir()` | XDG fallback |
| `$HOME/.codex*` | `os.homedir()` | `discoverHomes('.codex')` |
| ccxray index | `LOGS_DIR` or `CCXRAY_HOME/logs` or `~/.ccxray/logs` | `scanGrokFromCcxrayIndex()` |

Adding an env-derived root obliges updating the isolated env in every test
that starts a worker. The #407 bug class: `test/cost-worker-exit.test.js`
set `HOME` but not `LOGS_DIR`/`CCXRAY_HOME`, so the worker read the
developer's real index. `test/cost-worker-grok.test.js` had the same hole
(fixed alongside this ADR).

### Execution modes

| Mode | Entry | Lifecycle setup | Exports |
|------|-------|-----------------|---------|
| Executed (forked) | `require.main === module` | `process.on('disconnect', …)` + `process.channel?.unref()` + `run()` | n/a |
| Executed (standalone) | `node cost-worker.js` | identical — the contract is shared | n/a |
| Imported | `require('./cost-worker')` | **none** — side-effect free | `{ calculateCostSimple, processGrokIndexEntry, processGrokIndexFile, scanGrokFromCcxrayIndex }` |

## Mutation sites

| Site | File | Contract rule |
|------|------|---------------|
| Lifecycle setup (disconnect + unref) | `server/cost-worker.js` `if (require.main === module)` block | R1, imported-mode purity |
| `run()` call + error handler | `server/cost-worker.js` same block | R2 (no explicit exit on success) |
| `module.exports = {…}` | `server/cost-worker.js` (unconditional, before `require.main` guard) | Imported-mode purity |
| Fork + stdout parse | `server/cost-budget.js` `streamUsageEntries()` | R3 (reads stdout) |
| Env isolation | `test/cost-worker-exit.test.js` `isolatedEnv()` | R4 (HOME + CCXRAY_HOME + delete LOGS_DIR) |
| Env isolation | `test/cost-worker-grok.test.js` integration test | R4 (CCXRAY_HOME + HOME + LOGS_DIR:undefined) |

## Rejected alternative — IPC result channel

Branch `exp/c-parent-contract` (frozen at `9759179`, not maintained)
explored replacing stdout with `process.send({type:'result', entries})` as
the result channel. Rejected for three reasons:

1. **Main benefit is redundant.** Its selling point was "get results even
   when the worker hangs." After #402's `process.channel?.unref()`, the
   worker does not hang — this path is almost never walked.
2. **Real cost.** 11MB of results over IPC serializes/deserializes on the
   proxy's main thread message handler, blocking the event loop and
   foreclosing a future streaming/chunked approach.
3. **Weakens the failure signal.** IPC result + graceful reap makes
   "worker can't drain but can be killed" regressions zero-symptom in
   production — exactly the #396 shape. The in-scope SIGKILL log (#401
   item 1) is the deliberately preserved alternative signal.

Revival hazards documented in #401's Deferred section.

## Consequences

**Good**: the two-mode contract (executed vs. imported) is explicit and
regression-guarded — `test/cost-worker-exit.test.js` test I asserts
`require('cost-worker')` does not install a disconnect listener
(differential evidence: 0→0 after require, vs. 0→1 before this ADR).
The R4 root enumeration prevents future #407-class test-isolation holes.

**Bad — manual maintenance**: R4's root table must be updated when a new
env-derived scan root is added. A missing entry silently leaks the
developer's real data into the test, which may still pass (the #407 shape:
it passed because the real index had zero grok rows).

**Mitigation**: guard comments at every mutation site name this ADR. The
`isolatedEnv()` helper in `test/cost-worker-exit.test.js` is the canonical
pattern for new tests that fork the worker.
