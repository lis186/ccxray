# 0019 — A second process may append index lines, but must never write the derived session view

- Status: Accepted
- Date: 2026-08-17
- Related: `ccxray import --once` (Herdr badge freshness) / ADR 0016 (restore streaming passes) / ADR 0012 (index lines are the durable record)

## Context

Until now, exactly one process wrote `~/.ccxray/logs/`: the hub (or a standalone
server). Import-class operations that could collide with it refuse instead —
`reimportEntries` (`server/rebuild-index.js:573-577`) bails out with "A ccxray
hub is running (pid N). Stop it first."

The Herdr sidebar badge can now detect that ccxray has fallen behind on a
session: a completed turn sits in the Claude transcript that the index never
recorded. The action that fixes it is a transcript rescan. Applying the existing
refusal would make that rescan impossible for exactly the users who need it —
a hub is running for most of them, and a running hub does not re-import either,
so they would stay stale forever.

So a second writer became necessary. The question is what it is allowed to touch.

### The specific hazard

`session-index.js` writes `sessions.json` with the tmp+rename idiom, which is
usually shorthand for "atomic". It is not atomic here, because `tmpPath()`
(`server/session-index.js:59`) returns a **fixed** name with no pid in it:

```js
function tmpPath() { return sessionsPath() + '.tmp'; }
```

`writeFile` is not itself atomic, so with two writers the interleaving

```
A: writeFile(tmp)  starts
B: writeFile(tmp)  truncates and writes its own content
A: rename(tmp -> sessions.json)   ← renames B's half-written bytes
```

publishes a corrupt file. The idiom protects against a crash, not against a
concurrent writer. That has been safe purely because there has only ever been
one writer.

## Decision

**A process other than the hub may append to `index.ndjson`, and must not write
any derived view.** Concretely, `ccxray import --once` sets
`CCXRAY_SESSION_INDEX_NO_FLUSH=1` before requiring the importer, and
`session-index.js` `flush()` returns immediately when it is set.

Two properties make this sound rather than merely convenient:

1. **Appends do not need coordination.** `appendIndex` uses `fsp.appendFile`
   (`server/storage/local.js:91-93`), i.e. `O_APPEND`, and index lines are far
   below the atomic-append size on the local filesystem. Two appenders interleave
   at line granularity, which is exactly the granularity of the format.
2. **The derived view is rebuildable, and its staleness is already detected.**
   `loadSessionIndex` rebuilds when `index.ndjson` is newer than `sessions.json`
   (`server/session-index.js:68-72`) — which is precisely the state a
   flush-suppressed append leaves behind — and `reconcile` independently detects
   count drift. Nothing durable is lost; the hub re-derives on its next start.

The consumer that motivated this needs nothing more: the Herdr badge reads
`index.ndjson` directly through `readIndexTailEntries` and never opens
`sessions.json`, so an append alone fully repairs what it renders.

## Consequences

**Good**: the badge's rescan works while a hub is live, without adding locking,
IPC, or a hub endpoint, and without weakening the single-writer property of the
file that actually has the race.

**Accepted — the derived view lags until the hub restarts.** A turn imported by
`import --once` is in `index.ndjson` immediately but absent from `sessions.json`
until a rebuild fires. Anything reading `sessions.json` for a live total (the
session card's cold-load fallback) under-reports that turn in the meantime. This
is a display lag on a rebuildable view, not data loss.

**Bad — the contract is a guard comment, not a mechanism.** Deleting the
`CCXRAY_SESSION_INDEX_NO_FLUSH` check from `flush()` reintroduces the race
silently: nothing fails, no test that does not specifically look for it goes red,
and the corruption is rare and self-healing (a corrupt `sessions.json` is
detected and rebuilt on load), so it would most likely be observed as an
occasional unexplained rebuild rather than as a bug. This is the same
enforcement class as ADR 0002's `sigParts` and ADR 0015's R4.

**Mitigation**: `test/import-once.test.js` asserts both directions — the guard
suppresses the write where it lives (`session-index flush guard`), and a real
`import --once` run leaves neither `sessions.json` nor `sessions.json.tmp`
behind. A new second writer is required to state which of the two categories it
falls into.

## Alternatives considered

**Give `tmpPath()` a pid suffix.** Fixes the interleaving but not the real
question: two writers would then race last-writer-wins over the whole file, so
one process's complete view silently replaces the other's. That is a decision
about *whose* view is authoritative, which this change does not need to make —
and making it badly is worse than not writing at all.

**Have the hub perform the import over an HTTP endpoint.** Correct, and probably
where this goes if more second-writer use cases appear: one writer, no contract
to remember. Rejected for now as disproportionate — it adds a request path, an
in-flight guard, and a no-hub fallback that would still need this command.

**Keep `reimportEntries`' refusal.** Rejected: it is right for a destructive full
rebuild that deletes every imported line before rewriting them, and wrong for an
incremental append. Leaving hub users permanently stale is the failure being
fixed.
