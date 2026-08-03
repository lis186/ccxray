# 0003 — Parallel entryIndex Map for O(1) lookups

- Status: Accepted
- Date: 2026-07-08
- Related: #166 / PR #187

## Context

`store.entries[]` is the canonical ordered list of proxy entries, capped at
`MAX_ENTRIES`. Delta-chain reconstruction (`loadEntryReqRes`) and the API
query endpoint both need to find an entry by `id`. Before this change, both
used `entries.find()` — O(n) per lookup, which compounds along delta chains
(O(n·k) for a k-hop chain in an n-entry store).

## Decision

Add `store.entryIndex = new Map()` as a parallel index keyed by `entry.id`.
Every site that mutates `entries[]` must keep `entryIndex` in sync:

| Mutation | File | Operation |
|----------|------|-----------|
| **All push sites** | `server/store.js` `registerEntry()` | `push` + `.set(entry.id, entry)` + alias `.set()` atomically |
| Callers (live HTTP) | `server/forward.js` (×3 sites) | `store.registerEntry(entry)` |
| Callers (live WS) | `server/ws-proxy.js` (×1 site) | `store.registerEntry(entry)` |
| Callers (restore) | `server/restore.js` | `store.registerEntry(entry)` (batch-trim deferred to loop end) |
| Import (startup/rescan) | `server/importer.js` (×1 site) | local `entries[]`, not `store.entries` |
| Trim (eviction) | `server/store.js` `trimEntries()` | `.delete(entry.id)` |
| API read | `server/routes/api.js` | `.get(id)` (read-only) |

## Consequences

**Good**: delta-chain lookup is O(1) regardless of store size.

**Good — encapsulation**: `registerEntry()` makes push + index sync atomic.
Raw `entries.push` / `entryIndex.set` outside `store.js` is blocked by
`test/invariant-encapsulation.test.js` (recursive grep of `server/**/*.js`
+ destructuring bypass guard). Adding a new push site without using
`registerEntry()` fails CI.

**Residual — mutable export**: `entries` is still exported as a plain Array
(17 read-only consumers). A caller could bypass `registerEntry` via
`const { entries } = require('./store'); entries.push(...)`. The audit test
catches the destructuring pattern but not all dynamic access. Accepted:
the grep guard is 95% effective; full encapsulation (getter) deferred.

**Legacy mitigation (superseded)**: ~~Layer 1 guard comments at every
push/trim site~~. Guard comments at the removed call sites have been
deleted; the structural enforcement via `registerEntry` + audit test
replaces them. `getEntryById()` retains its fallback `.find()` as a
defense-in-depth signal.

## Alternatives considered

**Replace `entries[]` with a Map entirely**: rejected because insertion
order matters (the array is the timeline), and many consumers iterate
sequentially. A Map preserves insertion order but loses array methods
(`slice`, `splice`, index access) used throughout the codebase.

## Amended by ADR 0012 (2026-07-23)

The push/trim contract is extended by `docs/decisions/0012-response-id-read-time-merge.md`
(#333): a second parallel map `responseIndex` (responseId → canonical entry)
must be kept in sync alongside `entryIndex`, and merged-away duplicate ids live
in `entryIndex` as **aliases** pointing at their canonical. `trimEntries` must
drop a canonical's aliases and its `responseIndex` slot too. Cold-load and
restore dedup through `store.mergeByResponseId`; the live forward.js sites use
`store.registerOrMerge`. ADR 0012's site table is authoritative for the merged
world.
