# Delta Log Storage Specification

## Purpose

每個 turn 的 `_req.json` 採 delta 格式儲存（prevId chain），只存自上一個 turn 以來新增的 messages。Lazy-load 時遞迴重建完整 messages 陣列，per-turn 節省 95-99%。涵蓋 cache_control 正規化、anchor 條件、subagent / inferred session 排除規則、storage adapter `supportsDelta` capability、chain reconstruction graceful degrade。

## Requirements

### Requirement: Per-turn delta `_req.json` with prevId chain

每個 turn 的 `_req.json` 仍是獨立檔案。當條件允許時，它 SHALL 以 delta 格式儲存：包含 `prevId`（指向前一個同 session turn 的 entry id）、`msgOffset`（與 prev 共享的前綴長度）、`messages` 只包含 `currMessages.slice(msgOffset)`。當條件不允許時，它 SHALL 以 anchor（FULL）格式儲存：完整 `messages` 陣列，無 `prevId` / `msgOffset`。

#### Scenario: First turn of a session writes anchor

- **WHEN** a turn arrives with explicit `session_id` X
- **AND** `sessionLastReq` has no entry for X
- **THEN** the system SHALL write `_req.json` containing `{ model, max_tokens, messages: <full>, sysHash, toolsHash }` (no `prevId`, no `msgOffset`)
- **AND** SHALL update `sessionLastReq.set(X, { id, messages: currMessages, deltaCount: 0 })`

#### Scenario: Continuation turn with shared prefix writes delta

- **WHEN** a turn arrives with explicit `session_id` X and `messages.length = N+3`
- **AND** `sessionLastReq.get(X)` exists with `messages.length = N` and `findSharedPrefix` returns `N`
- **AND** `DELTA_SNAPSHOT_N === 0` OR previous `deltaCount < DELTA_SNAPSHOT_N`
- **THEN** the system SHALL write `_req.json` containing `{ model, max_tokens, prevId: <prev id>, msgOffset: N, messages: <last 3>, sysHash, toolsHash }`
- **AND** SHALL update `sessionLastReq.set(X, { id, messages: currMessages, deltaCount: prev.deltaCount + 1 })`

#### Scenario: No shared prefix forces anchor

- **WHEN** a turn arrives where `findSharedPrefix(prev.messages, currMessages)` returns 0 or 1
- **THEN** the system SHALL write `_req.json` in FULL format
- **AND** SHALL reset `deltaCount = 0` in `sessionLastReq`

#### Scenario: Snapshot cap forces anchor

- **WHEN** `DELTA_SNAPSHOT_N > 0` (e.g. 5)
- **AND** the previous `sessionLastReq` entry's `deltaCount === 5`
- **THEN** the next turn SHALL be written as FULL even if `findSharedPrefix` returns ≥ 2
- **AND** the new `deltaCount` SHALL be 0

### Requirement: cache_control normalization for prefix comparison

`findSharedPrefix` SHALL strip `cache_control` from each content block before comparing the last shared message between prev and curr. The stripping SHALL only affect the comparison; the bytes written to disk SHALL contain the original (un-normalized) `messages.slice(msgOffset)`.

#### Scenario: cache_control rotation does not break chain

- **WHEN** prev's last message has `cache_control: { type: 'ephemeral' }` on a content block
- **AND** curr's corresponding message has the same content but with `cache_control` removed (rotated to a later message)
- **THEN** `findSharedPrefix` SHALL return `prev.length` (treating the messages as identical)
- **AND** the chain SHALL continue with a delta write

#### Scenario: Genuine content drift breaks chain

- **WHEN** prev's last message text content differs from curr's corresponding message
- **AND** the difference is not solely in `cache_control`
- **THEN** `findSharedPrefix` SHALL return 0
- **AND** the system SHALL write FULL

#### Scenario: Empty prev returns 0

- **WHEN** `findSharedPrefix` is called with `prevMsgs = []` or `prevMsgs = null`
- **THEN** it SHALL return 0

#### Scenario: Compaction (prev.length >= curr.length) returns 0

- **WHEN** `prevMsgs.length >= currMsgs.length`
- **THEN** `findSharedPrefix` SHALL return 0
- **AND** the system SHALL write FULL (this catches `/compact` and `/clear`)

### Requirement: Subagent and inferred sessions never write delta

Delta eligibility SHALL be gated on `peekSid = store.extractSessionId(parsedBody)` being non-null. `extractSessionId` reads only the explicit `session_id` field from the request body; subagent requests (no explicit `session_id`) SHALL receive `peekSid = null` and SHALL bypass delta logic entirely.

#### Scenario: Subagent request bypasses delta logic

- **WHEN** a subagent request arrives whose body has no `session_id` field (parent session inferred via `detectSession()` inflight tracking)
- **THEN** `peekSid` SHALL be `null`
- **AND** the system SHALL write FULL `_req.json`
- **AND** the parent session's `sessionLastReq` entry SHALL NOT be updated

#### Scenario: Migration excludes subagent and inferred entries

- **WHEN** the migration script reads `index.ndjson` entries
- **AND** an entry has `isSubagent === true` or `sessionInferred === true`
- **THEN** the script SHALL skip the entry from chain reconstruction
- **AND** SHALL increment `Skipped (subagent)` or `Skipped (inferred)` counter

#### Scenario: Legacy entries without isSubagent field default to non-subagent

- **WHEN** a legacy index entry has no `isSubagent` or `sessionInferred` field (undefined)
- **THEN** the strict `=== true` check SHALL evaluate false
- **AND** the entry SHALL be eligible for chain reconstruction

### Requirement: Storage adapter `supportsDelta` capability gates delta writes

Each storage adapter SHALL declare a boolean `supportsDelta` capability. When `supportsDelta` is false, the live server SHALL write all turns as FULL regardless of `findSharedPrefix` result.

#### Scenario: Local adapter declares supportsDelta=true

- **WHEN** the local filesystem adapter (`server/storage/local.js`) is loaded
- **THEN** its capabilities SHALL include `supportsDelta: true`
- **AND** delta writes SHALL be enabled

#### Scenario: S3 adapter declares supportsDelta=false

- **WHEN** the S3 adapter (`server/storage/s3.js`) is loaded
- **THEN** its capabilities SHALL include `supportsDelta: false`
- **AND** every turn SHALL be written as FULL

#### Scenario: supportsDelta=false bypasses delta logic at write time

- **WHEN** `storage.supportsDelta === false`
- **THEN** the live server SHALL write FULL even when `peekSid` is non-null and `findSharedPrefix >= 2`
- **AND** `sessionLastReq` SHALL NOT be consulted

### Requirement: Lazy-load reconstructs chain via recursive prevId follow

`loadEntryReqRes` SHALL detect delta format by presence of `prevId` and `msgOffset` fields in the parsed `_req.json`. When detected, it SHALL recursively load the previous entry, splice `prevEntry.req.messages.slice(0, msgOffset)` with the delta's own messages, and return the reconstructed full messages array.

#### Scenario: Single-hop delta reconstruction

- **WHEN** `loadEntryReqRes` reads a `_req.json` with `prevId = X` and `msgOffset = 10`
- **AND** entry X exists in `store.entries` with FULL `messages` of length 12
- **THEN** the loader SHALL `await loadEntryReqRes(prevEntry)` first
- **AND** SHALL set `entry.req.messages = [...prevEntry.req.messages.slice(0, 10), ...stripped.messages]`

#### Scenario: Multi-hop chain reconstruction

- **WHEN** the chain is `entry C (delta) → entry B (delta) → entry A (anchor)`
- **AND** `loadEntryReqRes(C)` is called
- **THEN** the loader SHALL recurse into B, which recurses into A
- **AND** A SHALL be loaded as FULL
- **AND** B SHALL be reconstructed as `A.messages.slice(0, B.msgOffset) + B.delta`
- **AND** C SHALL be reconstructed as `B.messages.slice(0, C.msgOffset) + C.delta`

#### Scenario: Pruned prev gracefully degrades

- **WHEN** `loadEntryReqRes` reads a delta `_req.json` with `prevId = X`
- **AND** entry X is not in `store.entries` (pruned by `LOG_RETENTION_DAYS`)
- **THEN** the loader SHALL set `entry.req.messages = stripped.messages` (delta portion only)
- **AND** SHALL NOT throw

#### Scenario: Concurrent loads dedup via _loadingPromise

- **WHEN** two callers invoke `loadEntryReqRes(entry)` simultaneously
- **AND** `entry._loaded` is false
- **THEN** the second caller SHALL receive the same Promise as the first (`entry._loadingPromise`)
- **AND** the I/O SHALL execute exactly once

#### Scenario: Internal fields are stripped from public entry.req

- **WHEN** `loadEntryReqRes` completes
- **THEN** `entry.req` SHALL NOT contain `prevId`, `msgOffset`, `sysHash`, or `toolsHash`
- **AND** SHALL contain `model`, `max_tokens`, `messages`, `system`, `tools`

### Requirement: Anchor `messages` returns from delta header, not prev

When reconstructing a delta entry, `model` and `max_tokens` SHALL be taken from the delta's own `_req.json` header, not from `prevEntry.req`. This ensures per-turn metadata reflects the actual turn's parameters.

#### Scenario: Delta entry uses its own model and max_tokens

- **WHEN** entry C is delta with `model = 'claude-sonnet-4-6'` and prev entry A is anchor with `model = 'claude-opus-4-7'`
- **THEN** after reconstruction, `entry C.req.model` SHALL be `'claude-sonnet-4-6'`
- **AND** SHALL NOT inherit prev's model
