# 0016 — Restore streaming passes share a snapshot byte bound

- Status: Accepted
- Date: 2026-08-02
- Related: #348 / PR #409 / #408 / ADR 0003 / ADR 0012

## Context

PR #409 stream-restored the startup index read (`restoreFromLogs`) to drop
full parsed-array residency. The result is three streaming passes over
`index.ndjson`:

- **Pass A** (main restore loop) — reads the full index, accumulates
  `snapshotBytes`, builds the in-window working set + star-light list.
- **Star pass B** — re-reads the index to pull star-protected out-of-window
  lines back into the working set.
- **`streamAllMetas`** — re-reads the index for the rare session-index
  rebuild/drift path.

Restore runs after the server has called `listen()`, so live appends to
`index.ndjson` can land at any time. Codex R2 review caught two races:

1. **P2-1 — pass B picks up post-pass-A appends**: a line appended after
   pass A's EOF but before pass B's re-read creates a store entry that was
   never seen by the restore loop's merge/dedup. OpenAI/WS entries carry no
   `responseId`, so `mergeByResponseId` cannot fold them — the result is a
   duplicate id in `store.entries`.
2. **P2-2 — async rebuild generator interleaves with live updates**: the
   `streamAllMetas` generator yields between lines; a live
   `updateFromEntry` call at those yield points can process a line the
   generator has not yet reached, and without `responseId` the line's
   count/cost are double-counted.

Both races are silent — no error, no crash — and produce wrong session
counts and costs that persist until the next restart.

## Decision

Three mechanisms, applied together:

### (a) Snapshot byte bound (`snapshotBytes` + `boundedIndexLines`)

Pass A accumulates `snapshotBytes` — the total byte length of lines
consumed during its single read. Every subsequent streaming pass calls
`boundedIndexLines(snapshotBytes)`, which re-opens the index but stops
yielding once the cumulative byte count exceeds the snapshot. Direction of
error is benign: a partial line at the boundary is skipped (under-read),
never included (over-read). Lines appended after pass A's EOF are
structurally excluded from all subsequent passes.

### (b) Id guard at the restore push site

The restore loop checks `store.entryIndex.has(meta.id)` before pushing.
A live turn that completed and was registered via `forward.js` during the
post-`listen()` restore window is already in `entryIndex` (ADR 0003);
skipping it prevents a duplicate push for entries that lack `responseId`
and cannot be folded by `mergeByResponseId` (ADR 0012).

### (c) Restore buffer for the rebuild window

`beginRestoreBuffer()` / `endRestoreBuffer(replay)` in `session-index.js`
bridges the gap between the rebuild's `clear` and its completion. While
the buffer is active, `updateFromEntry` applies live (dashboard stays
current) AND pushes to a side array. `endRestoreBuffer(true)` replays the
buffered entries into the rebuilt state. Replay is idempotent **for entries
that carry a `responseId`**: `_countedRids` / `_costByRid` (ADR 0012) have
already counted them during the rebuild re-stream and block the duplicate.
Entries without `responseId` (OpenAI/WS) have no dedup key — `_upsert`
unconditionally increments count/cost on replay; see the no-`responseId`
replay residual below. The buffer is wrapped in `try/finally` to prevent a
`_restoreBuffer` leak on throw.

### Site table

| Site | File | Role |
|------|------|------|
| Pass A byte accumulation | `server/restore.js` — main restore loop, before star/rebuild | Accumulates `snapshotBytes` from every consumed line |
| Star pass B | `server/restore.js` — `boundedIndexLines(snapshotBytes)` call in the star-pass block | Re-reads index bounded by the snapshot |
| `streamAllMetas(snapshotBytes)` | `server/restore.js` — called by the rebuild path | Re-reads index bounded by the snapshot; heals in-stream |
| `boundedIndexLines` definition | `server/restore.js` — shared generator | Enforces the byte ceiling for all bounded passes |
| Id guard | `server/restore.js` — `store.entryIndex.has(meta.id)` in the restore loop | Skips entries already registered by a live push |
| `beginRestoreBuffer` | `server/session-index.js` | Opens the side buffer before rebuild |
| `endRestoreBuffer` | `server/session-index.js` | Replays buffered entries after rebuild; `try/finally` ensures cleanup |
| Buffer push | `server/session-index.js` — inside `updateFromEntry` | Pushes to `_restoreBuffer` when active |

### Known limitation (R4-P2 stop-loss, owner decision 2026-08-02)

A live turn that completes and appends during pass A — before
`beginRestoreBuffer` — lands outside the snapshot byte bound AND before the
buffer starts. If this startup triggers a rebuild, that turn's
`updateFromEntry` is cleared and absent from both the bounded re-read and
the replay buffer: its session count/cost are lost from `sessions.json`
until the next restart.

**Normally self-healing**: the missing update makes `sessions.json` entry
count diverge from the index line count. The next startup's reconcile tally
detects drift → rebuild re-derives from the full index and restores the
turn. Exception: if the same startup also produces an over-count residual
(cases B–D below) on a different session whose magnitude exactly cancels the
loss, the aggregate totals match and `drift()` does not fire — the
per-session error persists until an explicit rebuild (`ccxray rebuild-index`
or schema migration). Accepted: exact cross-session cancellation requires a
no-`responseId` entry hitting the rebuild window at the same startup that
loses a different entry to the pass-A gap; the probability is negligible,
and the impact is bounded to no-`responseId` count/cost display.

The buffer is deliberately NOT moved before pass A: that would widen the
no-`responseId` (OpenAI/WS) duplicate-count window from sub-ms to seconds —
a worse trade.

### No-`responseId` rebuild-window over-count residual (accepted)

For no-`responseId` entries (OpenAI/WS), `_upsert` unconditionally
increments count/cost — there is no dedup key. A live `updateFromEntry`
during the rebuild window interacts with the rebuild's `clear` →
`streamAllMetas` → `endRestoreBuffer(replay)` sequence differently
depending on timing and snapshot membership. Four cases (verified against
`_rebuildCore` clear at `session-index.js:92-94`, `_upsert` no-rid branch
at `:281,299`, and `endRestoreBuffer` replay at `:241`):

| Case | Snapshot | `updateFromEntry` vs `clear` | Path | Net count |
|------|----------|------------------------------|------|-----------|
| A | outside | before clear | live upsert cleared → not in stream → replay 1 | **1×** (correct — buffer's design intent) |
| B | inside | before clear | live upsert cleared → stream 1 + replay 1 | **2×** |
| C | outside | after clear | live upsert survives + replay 1 | **2×** |
| D | inside | after clear | live upsert survives + stream 1 + replay 1 | **3×** |

All four cases are bounded to the sub-second window between
`beginRestoreBuffer` and the rebuild completing. Direction is rare
over-count (not silent loss). Together with the pass-A loss window above,
these form the R4-P2 residual family. **Normally** both over-count and
under-count are corrected by the next startup's drift detection → rebuild.
**Exception**: `drift()` compares aggregate session count + aggregate entry
count (`session-index.js:208`); if the pass-A loss and the rebuild-window
over-count land on different sessions and their magnitudes cancel, the
aggregates match → no rebuild fires → per-session errors persist until an
explicit rebuild (`ccxray rebuild-index` / schema migration). Accepted:
exact cancellation requires two independent sub-second windows to coincide
across sessions on a single startup; the probability is negligible, and the
impact is bounded to no-`responseId` count/cost display.

## Consequences

**Good**: all three streaming passes observe the same logical snapshot of
the index, regardless of concurrent appends. The id guard and buffer replay
close the remaining live-registration and rebuild-clear gaps. No new data
structures, no locking, no IPC — the byte bound is a single integer
threaded through the existing generator.

**Bad — consistency contract**: adding a fourth streaming pass over the
index (a future consumer in `restoreFromLogs` or elsewhere) that does not
bind to `snapshotBytes` silently re-opens the P2-1/P2-2 races. This is the
reason this ADR exists.

**Mitigation**: INVARIANT guard comments at every site in the table name
this ADR. `boundedIndexLines` is the single shared entry point — a new pass
should call it, not `config.storage.readIndexLines()` directly.

**Adjacent boundary — rebuild residency**: the rebuild's `bySid` weather
grouping still materializes ~1× index in memory (#408). Not in scope for
this ADR; tracked separately.

## Alternatives considered

**Lock the index file during restore**: rejected — filesystem locks are
advisory on most platforms and do not compose with the async generator
pattern. The live append path (`appendIndex`) would need to acquire the
lock on every write, adding latency to every proxied request.

**Buffer ALL live entries (move `beginRestoreBuffer` before pass A)**:
rejected — widens the no-`responseId` duplicate-count window and requires
the buffer to survive the entire restore duration (seconds), not just the
rebuild window (sub-second). See the known limitation above.
