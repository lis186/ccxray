## Why

每個 API turn 的 `_req.json` 都存入完整對話歷史，造成 O(N²) 儲存成長：427-message session 的最後一個 turn 就佔 740KB，14 天累積 17GB（其中 req files 佔 94%）。第一次點開歷史 turn 需要 parse 大型 JSON，延遲明顯。

`system` 和 `tools` 已透過 `shared/{hash}.json` 去重，但 `messages` 沒有。Claude Code 的對話歷史是 append-only：每個 turn 的 `messages` 陣列是上一個 turn 的嚴格前綴 + 1-N 條新訊息。利用這個性質，每個 turn 只需要存「自上一個 turn 以來新增的 messages」+ 一個指向前一個 turn 的 pointer，讀取時遞迴重建即可。

## What Changes

- **Per-turn delta with prevId chain**：`_req.json` 新增 `prevId`（前一個 turn 的 id）+ `msgOffset`（共享前綴長度）欄位。Delta turn 的 `messages` 陣列只存新增訊息（slice from `msgOffset`），其餘從 chain 重建。Anchor turn（無 `prevId`）仍存完整 messages。
- **Cache control 正規化**：Claude Code 每個 turn 把 `cache_control` 標記輪轉到最新訊息，比對共享前綴時必須先 strip cache_control 才能正確判定。`server/delta-helpers.js` 提供 `msgNorm` + `findSharedPrefix` 統一此邏輯，live server 與 migration script 共用。
- **Storage adapter capability flag**：interface 新增 `supportsDelta` boolean。Local: `true`。S3: `false`（多 writer + 高 latency 下 chain traversal 不划算）。`supportsDelta=false` 時所有 turn 強制 FULL，行為與舊版相同。
- **Anchor 條件**：(1) session 第一個 turn、(2) 找不到共享前綴（`/compact`、`/clear`、retry、cache rotation 異動）、(3) `CCXRAY_DELTA_SNAPSHOT_N` env 大於 0 且 chain depth 達上限。預設 `0` = 永不強制 snapshot，僅 session-start 為 anchor。
- **Subagent 永遠 FULL**：Subagent 透過 inflight inference 共用 parent sessionId，但其 msgCount=1 的 one-shot 內容與 main thread 不連續。Live server 用 `extractSessionId()`（只看 explicit `session_id`）做 delta 決策；subagent 的 `peekSid` 為 null，自動走 FULL。
- **Lazy-load 重建 chain**：`loadEntryReqRes` 偵測 `prevId != null` 時遞迴 await 前一 turn 的 lazy-load，splice `prevMessages.slice(0, msgOffset)` + 自身 delta。Per-entry promise dedup（`_loadingPromise`）避免 concurrent load 時重複 I/O。Pruned prev gracefully degrades：保留 delta portion 直接顯示。
- **One-shot migration script**：`scripts/migrate-to-delta.js`（dry-run by default，`--write` 套用）。原子性：tmp file + `fs.rename`。`--snapshot-n N` 上限 chain depth（預設 20）。Subagent 與 inferred-session entries 排除在 chain 外。能跨已轉換的 delta entries 延續 chain。

## Out of Scope

- **Per-session NDJSON file with byteOffset seek**：原始草案考慮過 `sessions/{sid}_gen{N}.ndjson` + `logByteEnd` O(1) seek。最終選 per-turn delta chain，因為 (1) 不需新 storage adapter method，(2) 不需 write queue 序列化（每個 turn 自己一個 file），(3) S3 等 multi-writer 後端可以 graceful degrade 成 FULL，不需要新增 capability gate。
- **Background gzip compaction**：delta 已將儲存從 17GB 降到 ~500MB，壓縮 marginal benefit 不值得引入 race condition 風險。

## Capabilities

### New Capabilities

- `delta-log-storage`：per-turn delta `_req.json` 寫入、prevId chain 重建、cache_control 正規化、anchor 條件偵測、subagent / inferred session 排除規則、storage adapter `supportsDelta` flag。
- `delta-log-migration`：`scripts/migrate-to-delta.js` 一次性轉換現有 FULL `_req.json` 為 delta，dry-run by default、atomic temp-file write、subagent filtering、cross-existing-delta chain probe。

### Modified Capabilities

- `server-log-attribution`：`_req.json` schema 擴增（新增 `prevId`、`msgOffset` 為選用欄位）。Attribution prefix 計算路徑不變（live server 用 in-memory `parsedBody.messages`，不從 `_req.json` 讀）。

## Impact

**server/delta-helpers.js（新檔）**：`msgNorm` strip cache_control、`findSharedPrefix(prevMsgs, currMsgs)` 回傳共享長度（最後共享訊息正規化比對）、`findSharedPrefixFromLast(prevLastMsg, prevCount, currMsgs)` memory-minimal 變體（migration script 用）。

**server/index.js**：模組層 `sessionLastReq Map`（sessionId → `{id, messages, deltaCount}`）追蹤每個 session 最近一次 req。每個 turn 進入時：若 `peekSid && storage.supportsDelta` → 計算 `sharedCount`，符合條件（`sharedCount >= 2` 且未 `forceFull`）寫 delta；否則寫 FULL 並 reset `deltaCount=0`。

**server/restore.js**：`loadEntryReqRes` 偵測 `stripped.prevId != null` 時遞迴 load prev entry，splice `prevEntry.req.messages.slice(0, msgOffset)` + 自身 delta；entry.req 公開欄位刪除 `prevId`、`msgOffset`（reconstruction 細節不外露給 UI）。

**server/storage/{interface,local,s3}.js**：interface 新增 `supportsDelta: boolean` capability。Local 設 `true`，S3 設 `false`。

**server/config.js**：新增 `DELTA_SNAPSHOT_N`（env `CCXRAY_DELTA_SNAPSHOT_N`，預設 `0`）。`0` = 永不強制 snapshot。S3 setup 建議設 `5` 以縮短 chain（因為 S3 chain traversal 多次 GET）。

**scripts/migrate-to-delta.js（新檔）**：CLI flags `--write`、`--snapshot-n N`、`--logs-dir PATH`。Output 包含 `Files converted`、`Anchor breakdown (first-in-session / snapshot-cap / no-shared-prefix)`、`Skipped (subagent)`、`Skipped (inferred)`、`Existing deltas` counters。

**CLAUDE.md**：新增 "Delta Log Storage" 章節說明格式、規則、env vars。

**test/**：`delta-write.test.js`（18 tests）、`delta-restore.test.js`（7 tests）、`migrate-to-delta.test.js`（19 tests）。Suite 349 → 393 tests。
