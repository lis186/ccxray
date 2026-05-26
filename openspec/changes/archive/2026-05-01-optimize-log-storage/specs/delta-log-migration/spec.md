## ADDED Requirements

### Requirement: scripts/migrate-to-delta.js converts FULL `_req.json` to delta

The repository SHALL ship a one-shot migration script at `scripts/migrate-to-delta.js`. The script SHALL convert eligible FULL `_req.json` files in `~/.ccxray/logs` (or the path supplied via `--logs-dir`) to delta format in place. The script SHALL NOT be wired into the main `ccxray` CLI; users invoke it directly via `node scripts/migrate-to-delta.js`.

#### Scenario: Default invocation is dry-run

- **WHEN** `node scripts/migrate-to-delta.js` is invoked without `--write`
- **THEN** the script SHALL scan and report what would be converted
- **AND** SHALL NOT modify any files on disk
- **AND** SHALL print the summary including anchor breakdown and estimated bytes saved

#### Scenario: --write applies changes

- **WHEN** `node scripts/migrate-to-delta.js --write` is invoked
- **THEN** the script SHALL convert each eligible FULL `_req.json` to delta format
- **AND** SHALL preserve atomicity by writing to `{id}_req.json.tmp` first then renaming via `fs.rename`

### Requirement: Atomic per-file write via tmp + rename

Each `_req.json` rewrite SHALL be atomic with respect to SIGKILL or process crash. The script SHALL write the new delta-format JSON to a `.tmp` companion file and then rename it over the original, relying on POSIX `rename(2)` atomicity within the same filesystem.

#### Scenario: Crash before rename leaves original intact

- **WHEN** the script writes `{id}_req.json.tmp` and is killed before `fs.rename`
- **THEN** `{id}_req.json` SHALL remain in its original FULL format
- **AND** the orphan `.tmp` file SHALL exist on disk
- **AND** a subsequent run SHALL overwrite the orphan and proceed normally

#### Scenario: Server cleans up tmp orphans on startup

- **WHEN** the ccxray server starts
- **AND** `_req.json.tmp` orphan files exist in the logs directory
- **THEN** the server SHALL delete them as part of startup housekeeping

### Requirement: Subagent and inferred entries excluded from chain

The migration script SHALL filter `index.ndjson` entries with `isSubagent === true` or `sessionInferred === true` before chain reconstruction. The strict `=== true` comparison ensures legacy entries (where these fields are undefined) are NOT excluded.

#### Scenario: Subagent entries skipped

- **WHEN** an `index.ndjson` entry has `isSubagent: true`
- **THEN** the script SHALL increment the `Skipped (subagent)` counter
- **AND** SHALL NOT include the entry in chain reconstruction

#### Scenario: Inferred-session entries skipped

- **WHEN** an `index.ndjson` entry has `sessionInferred: true`
- **THEN** the script SHALL increment the `Skipped (inferred)` counter
- **AND** SHALL NOT include the entry in chain reconstruction

#### Scenario: Legacy entries without these fields are eligible

- **WHEN** an `index.ndjson` entry has neither `isSubagent` nor `sessionInferred` field
- **THEN** the entry SHALL be included in chain reconstruction (default treatment matches early ccxray versions where these fields did not exist)

### Requirement: Migration continues chain across already-delta entries

When the script encounters an entry already converted to delta format (by an earlier migration run or by the live server post-1.8.0), it SHALL NOT rewrite the entry but SHALL probe the chain depth via `probeChainDepth()` and update `prevState` so subsequent FULL entries can become deltas without unnecessarily resetting to anchor.

#### Scenario: Existing delta updates prevState

- **WHEN** the script reads entry B (already delta with `prevId = A`, `msgOffset = 5`, 3 delta messages)
- **THEN** `probeChainDepth(B)` SHALL walk `prevId` backwards to anchor or to `--snapshot-n` cap
- **AND** the script SHALL NOT rewrite B
- **AND** SHALL update `prevState = { id: B.id, lastMsg: <last delta message>, count: 8, deltaCount: <probed depth> }`
- **AND** SHALL increment the `Existing deltas` counter

#### Scenario: Subsequent FULL after delta becomes delta

- **WHEN** entry B is existing delta and entry C is FULL
- **AND** `findSharedPrefixFromLast(B.lastMsg, B.count, C.messages) >= 2`
- **THEN** the script SHALL convert C to delta with `prevId = B.id`

#### Scenario: probeChainDepth caps at SNAPSHOT_N

- **WHEN** the chain depth exceeds the `--snapshot-n` cap (default 20)
- **THEN** `probeChainDepth` SHALL return the cap value
- **AND** SHALL NOT continue walking beyond the cap

### Requirement: --snapshot-n caps maximum chain depth

The `--snapshot-n N` flag SHALL bound chain depth during migration. When `prevState.deltaCount` reaches N, the next entry SHALL be written as anchor (FULL) regardless of `canDelta` result. Default is `CCXRAY_DELTA_SNAPSHOT_N` env if > 0, otherwise 20.

#### Scenario: Snapshot cap forces anchor

- **WHEN** `--snapshot-n 5` is set and `prevState.deltaCount === 5`
- **THEN** the next eligible entry SHALL be written as FULL
- **AND** the `snapshot-cap` anchor counter SHALL be incremented
- **AND** `prevState.deltaCount` SHALL reset to 0

### Requirement: Output summary breaks down anchors by reason

The script SHALL print a summary including total files scanned, total converted, and a breakdown of anchor causes into three mutually exclusive categories: `first-in-session`, `snapshot-cap`, `no-shared-prefix`. The three counters SHALL sum to `(totalEligible - totalConverted - skipped)` as a self-check.

#### Scenario: Summary self-check

- **WHEN** the script completes
- **THEN** the printed summary SHALL include `first-in-session`, `snapshot-cap`, and `no-shared-prefix` counters
- **AND** their sum SHALL equal the number of FULL writes (excluding entries that were already delta and entries skipped due to subagent/inferred filters)

#### Scenario: Estimated bytes saved is reported

- **WHEN** the script completes
- **THEN** the summary SHALL report estimated bytes saved (sum of `originalSize - deltaSize` across all conversions)

### Requirement: safeParseFirst handles legacy double-JSON files

The script SHALL parse `_req.json` files using `safeParseFirst`, which extracts the first complete JSON object even when the file contains concatenated JSON (early ccxray versions had a server crash + resend bug that produced files with two appended JSON objects).

#### Scenario: Standard JSON parses normally

- **WHEN** `safeParseFirst` receives valid single-object JSON text
- **THEN** it SHALL return the parsed object

#### Scenario: Concatenated JSON returns first object

- **WHEN** `safeParseFirst` receives text like `{"a":1}{"b":2}`
- **THEN** it SHALL return `{a: 1}` (the first complete object)

#### Scenario: Strings with braces are handled correctly

- **WHEN** `safeParseFirst` receives JSON with brace characters inside string values (e.g. `{"text": "}"}`)
- **THEN** it SHALL correctly track brace depth using `inStr` / `escape` state and return the full object

#### Scenario: Invalid input returns null

- **WHEN** `safeParseFirst` receives malformed text
- **THEN** it SHALL return `null` without throwing

### Requirement: Streaming per-session memory bound

The script SHALL process entries in chronological order without loading all sessions' messages into memory simultaneously. The `prevState` data structure SHALL only retain the last message and count, not the full messages array.

#### Scenario: prevState is memory-minimal

- **WHEN** the script processes a 500-turn session
- **THEN** `prevState` SHALL contain only `{ id, lastMsg, count, deltaCount }`
- **AND** SHALL NOT retain the full messages array of any prior turn
