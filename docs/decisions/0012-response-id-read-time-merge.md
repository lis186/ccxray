# 0012 — Response-id read-time merge for multi-instance duplicates

- Status: **Accepted** (owner sign-off 2026-07-23; implemented on
  `fix/333-response-id-merge`; supersedes the reverted in-memory suppress
  approach `d4fab16`)
- Date: 2026-07-22
- Related: #333 (multi-instance double-write) / #329 (importer×proxy dedup) /
  ADR 0003 (parallel index maps)

## Context

When multiple ccxray server processes observe the same traffic and write to a
shared `~/.ccxray` — the documented case is a *chained* proxy (a dev proxy
whose upstream is a prod proxy whose upstream is Anthropic) — each process
independently logs the same logical response. A single dashboard restored from
that shared log then shows each turn 2–8 times. The duplicate copies carry
**complementary partial metadata** (one copy has `agentKey`, another has a real
`msgCount`, another `elapsed`); the metadata-poor copies fall back into the
main lane with stale context and produce the sawtooth context bars and ghost
"Fork/Teammate" lanes reported in #333 (evidence: session `40633ce5`, 1802
entries, copies-per-turn `{2:26,3:221,4:232,5:19,6:7,7:2,8:1}`).

### Why the committed approach (`d4fab16`) is the wrong layer

`d4fab16` added an in-memory `Map<sessionId, Set<responseId>>` per process and
**suppressed** (dropped) an entry whose response id was already seen. A four-
expert panel (Helland, Kleppmann, Kreps, Bailis — independent assessments,
2026-07-22) was unanimous on two points:

1. **The per-process map solves a non-problem.** Within one process each
   response is logged exactly once (the SSE and non-SSE code paths are mutually
   exclusive per request — `forward.js:507`; the retry path is gated on
   `!clientRes.headersSent`, `forward.js:519`). There is no within-process
   double log to suppress, and the map cannot see another process's state, so
   it does nothing for the actual cross-process bug. (codex flagged this across
   two review rounds; the panel confirmed it.)
2. **Suppress destroys information.** The duplicates are *partial replicas of
   one immutable fact*. Dropping the second-seen copy can discard exactly the
   fields (e.g. `agentKey`) that the kept copy lacks — the opposite of fixing
   the corruption.

The correct framing (Bailis, I-confluence): the dedup key `msg_01…` is
**assigned by Anthropic, not minted by any writer**. This is not a uniqueness
constraint (which would need write coordination) — it is a *set union keyed by
a fact no process invented*. The invariant "each logical response renders once"
is therefore **I-confluent** and maintainable **coordination-free** by a
deterministic merge that is a pure function of the log. The end-to-end argument
(Kleppmann) says the same: only the process that reads the merged log has the
global view needed to dedup correctly; any middle-box scheme is at best an
optimization.

## Where duplicates actually reach the screen (verified 2026-07-22)

This is the correction that reshaped the mechanism. The symptom does **not**
surface through the normal `store.entries` push path for the sessions that
exhibit it:

- Sessions larger than `SESSION_ENTRY_CAP` (default 500, `store.js:11`) are
  **not** fully loaded into `store` on restore. `restore.js:189` flags them
  oversized and `restore.js:200-204` pushes only the **first** entry
  (`sessionLoadedFirst`, `truncated=true`). The 1802-entry evidence session is
  oversized — so a merge at the `restore.js:259` push site would not touch its
  1801 rendered rows.
- Those rows are served on demand by **cold-load**:
  `routes/api.js:69 loadSessionEntriesFromIndex` re-reads `index.ndjson` on
  every request (`readIndex()`, `:70`) and returns entries **straight to the
  client** via `normalizeIndexEntry`→`summarizeEntry` (`:53,64,85`) — they
  never enter `store.entries` / `entryIndex`. So "the client renders what the
  store holds" is false for cold sessions.
- Because cold-load re-reads the file each time, a second process's freshly
  appended duplicate lines appear in the **view** immediately — even though the
  live *store* of any one process never sees a cross-process duplicate (each
  process only SSE-broadcasts its own entries).

**Therefore the load-bearing merge site is cold-load, not the restore push.**
The precise fix surface is four sites (see Decision), plus a one-time backfill.

## Decision

Replace suppress with **read-time merge keyed by the upstream response id**,
implemented as one shared `store` helper called from every read/ingest site.
The client renders merged results.

### Key + persistence

- `responseId` = `message_start.message.id` (SSE) or top-level `response.id`
  (non-SSE), via `anthropic.extractResponseId` (already exists).
- Add `responseId` to `INDEX_FIELDS` and `buildIndexLine` in **`server/entry.js`**
  (not `index-fields.js` — that file does not exist).
- `rebuild-index.js` already reads `_res.json` events (`readResEvents`, `:141`)
  and rebuilds lines with `buildIndexLine` (`:38`); make it run
  `extractResponseId` so a rebuild backfills `responseId` onto legacy lines.

### Shared merge helper (single definition)

`store.mergeByResponseId(entries)` folds a list of entry-shaped objects that
share a `responseId` into one **canonical** entry by the field rules below, and
returns the deduped list. All four sites call it; the merge logic lives in one
place (the ADR 0005 "one shared object" shape).

**Canonical copy selection (a user-visible decision, pinned here — not deferred):**
1. Prefer a copy with on-disk `_req/_res` written by an anthropic proxy
   observation over an imported copy (imported copies have no `_req/_res`, so
   making them canonical would break lazy-load forever).
2. Among proxy copies, prefer the earliest-`receivedAt` copy (closest to the
   real turn start).
The canonical copy's `id` and `ts` win as a unit (they encode the log
timestamp that lazy-load and date logic depend on: `restore.js:45,103,182,466`).

**Delta-chain safety (pinned):** a merged-away id is kept as an **alias** in
`entryIndex` pointing at the canonical entry, so a later delta turn whose
`prevId` names the dropped copy still resolves (`restore.js:64
getEntryById(prevId)` → canonical; the two copies are the same logical turn so
the reconstructed messages are equivalent and `msgOffset` slicing stays valid).
Without this, merge silently breaks delta chains — the graceful-degrade path at
`restore.js:57-71` would show only delta fragments.

### The four merge sites + exemptions

| Site | File:line | Action |
|------|-----------|--------|
| Cold-load (**load-bearing**) | `routes/api.js:85` | merge the raw `meta` list **before** `normalizeIndexEntry`/`summarizeEntry` (summarize is a whitelist, `sse-broadcast.js:29`, and drops unlisted fields) |
| Restore push | `restore.js:259` | merge on the way into `store.entries` (covers non-oversized sessions + the first-entry-of-oversized) |
| Live SSE push | `forward.js:770` | on a `responseId` hit, merge into the existing entry; see live-enrich note |
| Live non-SSE push | `forward.js:1018` | same, anthropic branch only |
| **Exempt** OpenAI SSE push | `forward.js:873` | no gate — OpenAI ids use a different scheme |
| **Exempt** WS push | `ws-proxy.js:364` | no gate — but chained **codex** proxies have the same bug and OpenAI Responses carry `resp_…` ids; recorded as a follow-up, not solved here |
| **Exempt** importer | `importer.js:290` | does **not** push `store.entries` (only writes index lines); ADR 0003's site table is stale on this. See #329 opportunity below |
| Trim | `store.js:trimEntries` | delete canonical id **and** its aliases from `entryIndex` + `responseIndex` |

`store.responseIndex = Map<responseId, entry>` is kept in sync at the push and
trim sites exactly like `entryIndex` (this ADR extends ADR 0003's contract; the
updated site table above replaces 0003's).

### Merge field rules (pinned; final shape validated against the entry object at implementation)

Excluded — **never copied across copies**: `req`, `res`, `_loaded`,
`_loadingPromise`, `_writePromise` (the live gate runs before req/res are
nulled, `forward.js:756`; a naive `Object.assign` would resurrect a released
body). The old `_dedupId` is removed with the superseded mechanism.

| Field | Rule |
|-------|------|
| `id`, `ts` | canonical copy's values as a unit (see selection) — not per-field |
| `sessionId` | prefer a copy with `sessionInferred=false` and `sessionId !== 'direct-api'`; else the supplied-`agentKey` copy |
| `agentKey`, `agentLabel`, `coreHash`, `convId`, `cwd` | prefer non-null / non-empty |
| `sysHash`, `toolsHash` | canonical copy's value; on conflict (an intercept-edit hop changed the bytes) keep canonical and set `edited` |
| `msgCount`, `toolCount`, `toolCalls`, `skillCalls` | prefer non-null; on conflict take max (same response ⇒ equal in practice; rewind/compaction is a *different* responseId so it never lands in one group) |
| `receivedAt`, `elapsed` (+ the `ts` pairing above) | take the earliest-`receivedAt` copy's `(receivedAt, elapsed)` **as a unit** — never mix one copy's start with another's duration |
| `usage`, `cost`, `maxContext`, `responseMetadata` | prefer the copy with `usage.output_tokens > 0` / richest usage tuple; **cost counted once** — dedup `sessionCosts` (`restore.js:281`); `sessionIdx` turn count is deduped the same way (see the count section in Consequences) |
| `isSubagent`, `sessionInferred` | value from the supplied-`agentKey` copy |
| `status`, `stopReason` | prefer a terminal/success value over null |
| `title`, `thinkingDuration`, `thinkingStripped`, `duplicateToolCalls`, `toolFail`, `hasCredential`, `toolSources` | prefer non-null / non-empty; on conflict canonical |
| `edited`, `editSummary` | OR semantics — edited if any hop edited; keep that copy's summary |
| `imported`, `importSource` | cleared when merging a proxy copy in (a real observation supersedes an import reconstruction) |
| `truncated`, `totalEntryCount` | recomputed from post-merge counts, not carried |

### Live-enrich honesty (pinned)

The client **drops** an SSE entry whose id it already has
(`entry-rendering.js:371 …has(e.id)) return;`) — it does not update in place,
and `broadcast()` has no update event (`sse-broadcast.js:75`). So a live merge
that re-broadcasts the canonical entry would be silently ignored by the client.
**This ADR chooses (a): make live enrich reflect immediately** via a dedicated
update event (owner decision, 2026-07-22):
 - Add an `entry_update` SSE event: after a live merge folds a duplicate into
   the canonical entry, broadcast the canonical entry under this event type
   (a `summarizeEntry` payload, same shape as the `entry` event) rather than
   the normal single-`entry` event.
 - Client handler: on `entry_update`, look up the row by `id` in
   `window.entryById` and **patch it in place** (re-render the affected
   turn/lane) instead of the `…has(e.id)) return;` drop. The drop guard at
   `entry-rendering.js:371` stays for the plain `entry` event (dedup of the
   same broadcast); `entry_update` is the explicit "I know this id, update it"
   channel. Keep it minimal — this is the one sanctioned in-place mutation of
   an already-rendered entry (respect the ADR 0003 / single-source-of-truth
   discipline: the server store's canonical entry remains authoritative; the
   event just carries its post-merge state).
Regardless, the live path **still `appendIndex`** the raw line — restore /
cold-load re-merge from the file, so nothing enrich-worthy is lost on disk even
if a client missed the event.

### #329 opportunity (pinned: fold in, don't just relate)

The importer already parses `obj.message` (`importer.js:156,168`), which
carries the assistant `msg_01…` id. Writing that into the index line's
`responseId` lets the **same** merge collapse importer-vs-proxy duplicates
(#329) with no extra machinery. In scope for this work: importer sets
`responseId`; canonical-selection already prefers the proxy copy so the
importer copy enriches rather than shadows.

### Layer B — write-amplification optimization (optional, may fail safely)

Later, a relay header (#333 Layer 2): when one ccxray forwards to a localhost
ccxray, inject `x-ccxray-relay`; the outer process writes a thin pointer / sets
`skipEntry` so the same bytes aren't stored 2–8×. **The header is never the
correctness boundary** — if missing, stripped, or a non-ccxray hop intervenes,
the read-time merge still holds. Out of scope for the first PR.

### Supersede cleanup (must land in the same PR)

Remove the `d4fab16` mechanism so old and new don't coexist: `seenResponseIds`
+ `isDuplicateResponse` (`store.js`), the trim-time prune of that Map, the two
`forward.js` suppress gates, the `_dedupId` field, and rewrite
`test/dedup.test.js` (it currently tests the superseded mechanism).

## Consequences

**Good**
- Fixes the rendered symptom, not just the count: field-merge reconstructs the
  richest single record, so metadata-poor copies stop polluting lanes.
- Coordination-free: no shared mutable dedup file, no locks, no hot-path
  serialization. Robust to processes starting/stopping independently.
- Covers any cross-process duplication source, and folds in #329 for free.

**Good with a caveat — healing existing data.** New lines dedup immediately.
**Data already on disk is only healed after a one-time `ccxray rebuild-index`
backfill** (legacy lines have no `responseId`; by the fallback rule they are
rendered as-is until backfilled). This is the honest scope, not "heals on disk
automatically."

**Accepted — disk amplification.** Layer A does not save disk; duplicate
`_req/_res` files still land on disk until Layer B.

**Session-card turn count is deduped by responseId (owner decision 2026-07-23,
fixed before merge — supersedes the earlier "count reconciliation lag: best-effort"
stance).** `session-index.js` `_upsert` bumps `s.count` once per responseId via a
persistent `_countedRids` set that parallels `_costByRid`, so the sidebar card
shows merged turns (e.g. 15), matching the Turns column — not the raw duplicate
line total (45). This needs three **paired** changes, none safe alone:
1. `_upsert` dedups `s.count` by responseId (a line without responseId — legacy/
   exempt — has no dedup key and always counts).
2. `reconcile`'s index-side tally is deduped the SAME way: a merged `s.count` (15)
   would otherwise never equal a raw line tally (45), so every reconcile would
   detect false drift and rebuild.
3. `seedDedupState` (renamed from `seedCostRids`) seeds `_countedRids` alongside
   `_costByRid` before the importer runs, so an imported duplicate of an already-
   logged turn re-adds neither cost nor count across a restart — the count-side
   twin of the cost fix (fable round-4 M1). The fast-load path reads `s.count`
   straight from `sessions.json` with an empty in-memory set, so without the seed
   the importer would re-inflate count on every restart.

Cost remains mandatory-once; count now matches it rather than lagging.

**Scope — same-session dups only (cross-session credited to first-seen,
matching cost).** The card-matches-Turns-column guarantee above holds for
duplicates that share a `sessionId` — the common case and the ADR's stated
premise (cross-session copies are #222 territory). Both `_countedRids` and
`_costByRid` credit the **first-seen copy's session**; the read-time merge
(`store._identityScore`) instead assigns the rendered turn to the
highest-identity copy's session. When a response id appears under two
different sessions — e.g. a proxy copy logged `direct-api`/inferred while the
importer supplies the real `session_id` for the same `msg_01…` (#329 path) —
the count/cost land on the first-seen session while the turn renders under the
merge-chosen one, so those two cards disagree with their Turns columns.
`reconcile` compares only global totals (not per-session identity), so it does
not detect or heal this. Aligning session-index attribution with the merge's
`_identityScore` would require `reconcile` to compute identity per response id
too — defeating its intentional cheap single-regex pass — so this is left as a
known limitation, **consistent with the pre-existing cost behavior** and rare
under the shared-sessionId premise (codex review of the count fix, 2026-07-23).

**Live cross-process enrich reflects immediately (option a).** A new
`entry_update` SSE event + client in-place patch handler carries the post-merge
canonical state to open dashboards without a reload. Cost: one new event type,
one client handler branch, and a test that a merge fires `entry_update` (not a
second `entry`). A client that misses the event still converges on next load
(the line is on disk). This is the one sanctioned in-place mutation of a
rendered entry; the server store stays the single source of truth.

**New consistency contract (ADR 0003 extension).** A push/trim site that
updates `entryIndex` but not `responseIndex` (or forgets alias handling)
silently reintroduces duplicates or breaks a delta chain. Mitigation: INVARIANT
guard comments at every site in the table naming this ADR; the merge is one
`store` helper both cold-load, restore, and live call.

**Bounded risk — trim evicts a canonical copy.** If eviction removes a merged
entry while a poorer future copy of the same id arrives post-eviction, the view
degrades for that turn. Bounded to the post-`MAX_ENTRIES` window; accepted.

## Alternatives considered

- **In-memory per-process suppress (committed `d4fab16`)** — panel mean 1.5/10.
  Solves a non-problem, wrong layer, destroys information. Superseded.
- **Shared persistent dedup state (file/sqlite)** — panel mean 2.5/10.
  Hand-builds a non-I-confluent uniqueness constraint on a coordinator-less
  filesystem: dual-write atomicity, check-then-act races, stale locks. Rejected.
- **Relay header as the correctness mechanism** — Kreps 9, but the other three
  rate it 5–8 as an *optimization* only: topology-fragile (breaks on a
  non-ccxray hop or stripped header) and it picks one observer's copy, so it
  cannot merge complementary metadata. Kept as optional Layer B, not the fix.

## Panel record

Independent assessments 2026-07-22 (each researched the expert's 2025–26 public
work, then applied their model): scoreboard —
suppress(1) 1.5 · shared-state(2) 2.5 · relay(3) 7.25 · read-time-merge(4) 8.25.
The "merge, don't suppress" insight was reached independently by Helland
(reconcile partial replicas), Kleppmann (materialized view, enrich not
suppress), and Bailis (CRDT map of `id → most-informative register`).
Mechanism section reworked after a code-level review (2026-07-22) found the
symptom surfaces through cold-load, not the restore push; that review's
blockers (cold-load bypass, delta-chain breakage, healing-needs-backfill,
client-drops-known-id) were verified against source and are folded in above.

## Implementation notes (2026-07-23)

Deltas from the proposal, discovered during implementation:

- **`extractResponseId` did not exist** — the proposal said "already exists".
  It was added to `server/wire-parsers/anthropic.js` (SSE `message_start.message.id`
  / non-SSE top-level `.id`) and set on the entry at the two forward.js anthropic
  literals (not inside `buildEntryFields`, which the non-SSE path doesn't feed
  `resData`).
- **Restore uses a batch post-pass, not per-push merge**: the loop collects
  built entries, then one `mergeByResponseId` folds + pushes them, so cost is
  counted once and aliases registered together. Oversized sessions contribute
  only their first entry (unchanged), so they pass through unmerged and stay
  served by the cold-load merge.
- **Live merge = `store.registerOrMerge`** (incremental): no canonical swap —
  an existing imported canonical is not replaced by a live proxy copy (would
  require splicing an already-broadcast row); the rare cost is degraded lazy-load
  for that one turn, accepted.
- **Client `entry_update` handler** patches `allEntries` + `entryById` then
  rebuilds the workflow view via `wfBuildState` (the authoritative `wfInferLanes`
  batch pass) rather than ad-hoc per-row surgery — lane reclassification is
  therefore correct, not hand-rolled.
- **Legacy healing is add-only, gated on surviving `_res.json`** (Phase 6b):
  `rebuild-index` appends `responseId` to legacy lines whose `_res` is still on
  disk, all other fields byte-identical. This extends #48's merge-only guarantee
  to "merge-only + add-only enrichment, never degrade"; ~85% of lines whose
  `_res` aged out are left untouched (honest scope).
- **Test-fixture fix**: `test/orphan-socket-affinity.e2e.test.js`'s mock upstream
  reused a constant message id across logically-distinct turns; the merge
  correctly collapsed them, so the mock now assigns unique ids (real Anthropic
  behaviour).
- **Session-card count deduped before merge (owner decision 2026-07-23)**: the
  first implementation left `s.count` raw (best-effort lag). Owner judged the
  raw card number (45 for 15 merged turns) more visible than "lag" implied and
  chose to fix it before shipping. `seedCostRids` was renamed `seedDedupState`
  and now seeds `_countedRids` (the count-side of the persistent dedup state)
  alongside `_costByRid`; `_upsert` and `reconcile` dedup count by responseId in
  lockstep. See the "Session-card turn count is deduped" consequence for why all
  three sites must change together.
