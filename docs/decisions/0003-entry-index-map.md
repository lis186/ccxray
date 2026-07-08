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
| Live push (HTTP) | `server/forward.js` (×3 sites) | `.set(entry.id, entry)` |
| Live push (WS) | `server/ws-proxy.js` (×1 site) | `.set(entry.id, entry)` |
| Restore on startup | `server/restore.js` | `.set(entry.id, entry)` |
| Trim (eviction) | `server/store.js` `trimEntries()` | `.delete(entry.id)` |
| API read | `server/routes/api.js` | `.get(id)` (read-only) |

## Consequences

**Good**: delta-chain lookup is O(1) regardless of store size.

**Bad — consistency contract**: adding a new push site (e.g., a future
provider transport) without a corresponding `.set()` silently degrades to
the fallback `entries.find()` path, hiding the O(n) regression until the
store is large enough to notice.

**Mitigation**: Layer 1 guard comments at every push/trim site name this
ADR. `getEntryById()` in `store.js` has a fallback `.find()` — if
the fallback path ever fires in production, a push site was missed.

## Alternatives considered

**Replace `entries[]` with a Map entirely**: rejected because insertion
order matters (the array is the timeline), and many consumers iterate
sequentially. A Map preserves insertion order but loses array methods
(`slice`, `splice`, index access) used throughout the codebase.
