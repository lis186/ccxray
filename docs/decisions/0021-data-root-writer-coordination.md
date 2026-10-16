# 0021 — Coordinate full-file writers at the data root

- Status: Accepted
- Date: 2026-09-02
- Related: ADR 0012 (index lines are the durable record), ADR 0019 (second writers), `server/paths.js:17-22`

## Context

`index.ndjson` is the durable record, but maintenance commands such as
`rebuild-index --apply` and `rebuild-index --reimport` produce a complete
replacement file. A standalone server, an explicit `--port` server, or a
Windows server can append without writing `hub.json`, so `liveHubBlocking()` is
not a correctness guard for those writers.

`CCXRAY_HOME` is not the storage scope key. `server/paths.js:17-22` resolves
`CCXRAY_HOME` to a home directory and then resolves `LOGS_DIR` independently;
the coordination scope is `realpath(config.LOGS_DIR)`. Two processes that
resolve to the same real logs directory share the same durable record even if
their home-directory spelling differs.

## Decision

### Layer A: compare-and-swap

Any full-file rewrite of `index.ndjson` must fingerprint the file before the
read and compare the fingerprint immediately before the commit. The
fingerprint is `dev + ino + size + mtimeMs`. The final stat and commit are
synchronous, with no `await` between them. A changed existing file aborts the
rewrite and preserves the writer's append. If the file was absent, the command
uses a synchronous link-based create-if-absent commit and treats `EEXIST` as a
conflict.

This is Layer A and needs no cooperation from the server that appends. The
recent-mtime refusal is a fast-fail optimization for likely active recording;
CAS remains the correctness boundary.

### Layer B: maintenance coordination

Destructive maintenance commands acquire
`<storage.location>/.index-maintenance.lock` with the `wx` flag. The JSON lock
contains `{pid, token, op, startedAt}`. A lock held by a live pid causes the
command to refuse; a lock is reclaimed only when its recorded pid is dead.
The lock is released in `finally` and serializes `--apply` against
`--reimport`. It does not coordinate ordinary server appends, and no server
launch is ever refused by this design.

A future Layer B registry may improve user experience by identifying active
writers and coordinating them explicitly. That registry is deferred; it is not
required for Layer A correctness.

### ADR 0019 amendment

ADR 0019 permits a second process to append index lines while prohibiting it
from writing a derived view. `--reimport` is the exception that must now be
recorded explicitly: it is a destructive, derived-view second writer because
it removes imported lines, rewrites `index.ndjson`, and flushes `sessions.json`
without `CCXRAY_SESSION_INDEX_NO_FLUSH`. Its maintenance lock and index CAS
protect the destructive phase; its re-import scan remains non-transactional.
The session-index temp file uses a pid suffix so concurrent derived-view
flushers do not share a temporary pathname.

## Consequences

The durable index cannot be silently replaced after a concurrent append. A
failed maintenance operation leaves the source log files and the concurrent
index line intact, so the command can be retried after recording stops.

The residuals are explicit:

- There is a sub-millisecond TOCTOU window between `statSync` and
  `renameSync`.
- `--reimport` is non-transactional: a crash between its index rename and
  `scanAndImport()` can leave imported lines absent until the next import.
- CAS makes `--apply` unusable against a continuously busy writer, by design;
  stopping that writer or choosing a different `CCXRAY_HOME` is required.

