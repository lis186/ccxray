## Context

ccxray writes one `_req.json` and one `_res.json` per Claude Code API call to `~/.ccxray/logs/`. `pruneLogs()` (`server/restore.js:188`) deletes files older than `LOG_RETENTION_DAYS` (default 14) at startup; the only existing protection is "files referenced by entries currently in memory."

The dashboard already has a UI concept of "pin" stored in `localStorage` (`public/miller-columns.js:140`), but that state never reaches the server. A pinned project's logs prune all the same. The pin code path also includes `expireSessionPins()` (`miller-columns.js:162`), a 7-day pin expiry — incompatible with "permanent retention" intent.

There are also two tiers of pseudo-entities the design must handle:

- **Sentinel session**: `'direct-api'` — assigned to every request that arrives without `session_id` metadata. Acts as a catch-all bucket and grows unbounded.
- **Sentinel project**: `'(unknown)'` (cwd missing) and `'(quota-check)'` (heartbeat ping). Both `isSystemProject()` returns true at `miller-columns.js:196`.

A separate concern is `RESTORE_DAYS` (default 3): the startup index scan only loads entries newer than the cutoff, so a starred entry older than 3 days disappears from the dashboard after restart even though its files are still on disk.

The four-expert review (Norman / Hickey / Majors / Tufte) converged on one architectural decision: store stars per-level, derive retention by query. This document records that decision and its corollaries.

## Goals / Non-Goals

**Goals:**

- A single source of truth for "starred" lives on the server (`~/.ccxray/settings.json`), so prune and restore can both honor it.
- Adding a star is one storage write at one level — no cascade-write to parent levels.
- Removing a star is symmetric to adding one: same single-level write, no surprise downstream effects.
- `pruneLogs()` and `restoreFromLogs()` apply the same protection rule, computed once per run.
- Starring a turn inside a real session retains the entire session (so delta chains stay intact). Starring a turn inside a sentinel session retains only that turn's files.
- The dashboard tri-state badge on parent columns ("directly starred" vs. "retained because N descendants" vs. "unprotected") is a literal read of the same data the server uses for retention — no separate "is retained" flag is stored or synced.

**Non-Goals:**

- No `index.ndjson` compaction or trimming. The index file growth is unrelated to this change.
- No change to in-memory `MAX_ENTRIES=5000` FIFO trim. Disk protection is the sole user-facing guarantee.
- No augmentation of `indexLine` with `prevId`. The earlier sketch needed it to walk delta chains under a cascade-write design; the derived-retention rule covers chains automatically because starring any turn protects all sibling turns in the same (non-sentinel) session.
- No multi-user / shared-server scenarios. ccxray is single-user; the settings file is local.
- No "pinned tab" or "favorites" sidebar — stars do not change navigation, only retention and a small visual marker.

## Decisions

### Decision 1: Store stars per-level; derive retention as a query

Three flat arrays in `~/.ccxray/settings.json`:

```json
{
  "starredProjects": ["myapp"],
  "starredSessions": ["uuid-..."],
  "starredTurns":    ["2026-05-02T..."]
}
```

`POST /_api/stars { kind, id, starred }` mutates exactly one array.

At prune / restore time, an entry's files are protected when **any** of these is true:

1. `entry.id ∈ starredTurns`
2. `entry.sessionId ∈ starredSessions`
3. `getProjectName(entry.cwd) ∈ starredProjects`
4. Some other entry in the same `sessionId` has `id ∈ starredTurns` (and `sessionId` is not a sentinel)
5. Some other entry in the same project has its session or turn starred (and project is not a sentinel)

Implemented in one pass over `index.ndjson`:

```
retainedSessions = starredSessions
                 ∪ { e.sessionId : e.id ∈ starredTurns AND e.sessionId ∉ SENTINEL_SESSIONS }

retainedProjects = starredProjects
                 ∪ { projectName(e.cwd) :
                     ( e.sessionId ∈ retainedSessions OR e.id ∈ starredTurns )
                     AND projectName(e.cwd) ∉ SENTINEL_PROJECTS }

protect(e) = e.id ∈ starredTurns
          OR e.sessionId ∈ retainedSessions
          OR projectName(e.cwd) ∈ retainedProjects
```

**Alternatives considered:**

- **Cascade-on-add storage**: starring a turn writes three entries (turn + session + project all marked starred). Rejected because the inverse (cascade-on-remove) is destructive (silently unstars descendants the user previously marked) — and *not* cascading on remove creates the asymmetry that confused the original mental model. Hickey's frame: storing the cascade complects "user annotation" with "system retention guarantee." The derived rule keeps them as separate concerns.
- **Single starred-set with hierarchical IDs**: encode level in the id (e.g., `proj:myapp`). Rejected — same retention semantics need the same query, and it complicates type-checking on the API surface.

### Decision 2: Sentinel buckets exclude upward derivation

`SENTINEL_SESSIONS = new Set(['direct-api'])` and `SENTINEL_PROJECTS = new Set(['(unknown)', '(quota-check)'])`. Used to gate steps 4 and 5 of the derivation above.

Rationale: `direct-api` aggregates every un-attributed request across the whole machine; treating it as a coherent unit would silently pin an unbounded firehose because the user starred one anomalous turn. The user's actual intent — "keep this specific turn" — is best served by protecting just the leaf.

This corresponds 1:1 with disabling the star button at session/project level for sentinels. The UI never lets the user assert what the data model would refuse to honor.

**Alternative:** allow but warn. Rejected because the warning would have to repeat on every click and the resulting state would surprise on subsequent visits.

### Decision 3: Lift `RESTORE_DAYS` cutoff for star-protected entries

In `restoreFromLogs()`, the cutoff filter (`server/restore.js:88`) becomes:

```js
if (cutoffStr && meta.id.slice(0, 10) < cutoffStr && !isProtectedByStar(meta, stars)) continue;
```

The exception uses the **same** protection helper as prune so behaviors stay aligned: a star-protected entry never disappears from the dashboard between restarts.

This ships in the same change as Decision 1, not deferred. Without it, the feature has a forensic-trust hole: star an old session today, restart tomorrow, it is no longer visible — even though its files are intact on disk.

### Decision 4: Tri-state visual on parent columns

| Visual | Semantics |
|---|---|
| `★` (filled) | This level is in `starredX`. |
| `☆` + small superscript count | This level is **not** in `starredX`, but at least one descendant is starred → derived retention. |
| `☆` (dim, no count) or no badge | Neither direct nor derived. |

Click on `★` removes the direct star (the level may revert to `☆³` if descendants remain). Click on dim `☆` adds a direct star.

Norman's vocabulary fix is satisfied by the data: the system shows "directly starred" vs. "protected because of descendants" with two different visuals, because the storage model preserves provenance.

### Decision 5: Turn card layout — cost moves to its own line

Final layout (per user direction; Tufte's "merge with line 4" was reviewed and declined):

```
[● #N model ↵ ! ☆/★]        ← line 1: identity, star replaces former cost
[title]                      ← line 2 (conditional)
$0.42                        ← line 2.5: cost (new), dim 11px right-aligned
[█████ ctx:42% cache:80%]    ← line 3 (conditional)
[tools / dur:5.3s]           ← line 4 (conditional sub-rows)
[risk markers]               ← line 5 (conditional)
```

Click handler on the star button must call `event.stopPropagation()` so it does not fire `selectTurn`.

### Decision 6: One-time `localStorage` migration

On dashboard load:

1. `GET /_api/stars`.
2. If response arrays are all empty AND `localStorage` has `xray-pinned-projects` or `xray-pinned-sessions` (legacy keys), POST each id, then `localStorage.removeItem` for both keys.
3. After migration `localStorage` is no longer consulted; `expireSessionPins()` is deleted.

Migration runs at most once per browser. If the server settings already contain stars, migration is skipped (the legacy `localStorage` is treated as stale and cleared without merging).

## Risks / Trade-offs

- **[Risk] Index scan cost on every prune.** The protection set requires walking `index.ndjson` once per prune. For a multi-month log, that is tens of thousands of lines of small JSON. → Prune already runs once per startup (not per request) and the scan is sequential read + JSON.parse. Acceptable. If profiling shows otherwise, cache the per-id project/session map across the prune+restore pair (they are back-to-back at startup).
- **[Risk] Starring a single turn in a busy session keeps thousands of sibling files.** True by construction — the user asked for delta-chain context to be retained, and "session" is the chain unit. → Surfaced in the tooltip on parent column: "Retained because N starred descendants." Users who only want one turn can star at the turn level and accept the chain consequence is implicit, or accept graceful degradation if they manually delete sibling files.
- **[Risk] Settings file corruption silently disables protection.** If `settings.json` is malformed at startup, `readSettings()` falls back to `DEFAULTS` and three star arrays are empty → no protection. → Existing `readSettings()` already swallows JSON errors; we keep that behavior but log a single warning when the file exists and parses to a non-object so silent erasure is at least visible in the terminal.
- **[Trade-off] No history of star/unstar events.** The arrays only encode current state. We cannot answer "when did I star this?" without git-blame on the file. Accepted — a single user, single machine, append-only audit is overkill.
- **[Trade-off] Sentinel exclusion is hard-coded.** If future code adds a new sentinel session id (e.g. `'pre-init'`), the exclusion set must be updated explicitly. → Centralized in `server/helpers.js` so there is one place to change.
- **[Risk] Migration race on multiple open dashboards.** Two tabs both load with empty server stars and both POST migrations. → POSTs are idempotent set-add, duplicates collapse on the server. No corruption.
