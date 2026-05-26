> **Status**: Shipped in 1.8.0 (commit `bef2fa4`). All tasks below describe the actual implementation; checkboxes reflect what landed in the merged PR.

## 1. Shared delta helpers

- [x] 1.1 新增 `server/delta-helpers.js`，匯出 `msgNorm`、`findSharedPrefix`、`findSharedPrefixFromLast`。`msgNorm` 對每個 content block strip `cache_control`（其餘欄位保留），處理 Claude Code 每 turn 把 cache marker 輪轉到最新訊息的行為。
- [x] 1.2 `findSharedPrefix(prevMsgs, currMsgs)`：若 prev 為空、prev 長度 ≥ curr 長度（compaction）、最後一個 prev 訊息正規化後不等於 curr 對應位置 → 回傳 0；否則回傳 `prevMsgs.length`。
- [x] 1.3 `findSharedPrefixFromLast(prevLastMsg, prevCount, currMsgs)`：memory-minimal 變體，只接受最後一個訊息與 count，邏輯與 1.2 等價。

## 2. Storage adapter capability flag

- [x] 2.1 `server/storage/interface.js` 新增 `supportsDelta: boolean` JSDoc 欄位定義。
- [x] 2.2 `server/storage/local.js` 設 `supportsDelta: true`。
- [x] 2.3 `server/storage/s3.js` 設 `supportsDelta: false`（高 latency + multi-writer 不適合 chain traversal）。

## 3. Live server delta write path

- [x] 3.1 `server/index.js` 模組層宣告 `sessionLastReq = new Map()`（sessionId → `{id, messages, deltaCount}`）。
- [x] 3.2 每個 turn 進入時，若 `parsedBody.messages` 存在：
  - 取 `peekSid = store.extractSessionId(parsedBody)`（**只看 explicit `session_id`**，subagent 因 `peekSid=null` 自動走 FULL，不需額外 guard）。
  - 若 `peekSid && storage.supportsDelta`：取 `prev = sessionLastReq.get(peekSid)`，計算 `sharedCount = findSharedPrefix(prev?.messages, currMessages)`。
  - `forceFull = !prev || (DELTA_SNAPSHOT_N > 0 && prev.deltaCount >= DELTA_SNAPSHOT_N)`。
  - 條件 `!forceFull && sharedCount >= 2` 成立時寫 delta，否則寫 FULL。
- [x] 3.3 Delta `stripped` 欄位：`{ model, max_tokens, prevId: prev.id, msgOffset: sharedCount, messages: currMessages.slice(sharedCount), sysHash, toolsHash }`。
- [x] 3.4 FULL `stripped` 欄位：`{ model, max_tokens, messages: currMessages, sysHash, toolsHash }`。
- [x] 3.5 寫完後更新 `sessionLastReq.set(peekSid, { id, messages: currMessages, deltaCount: prev.deltaCount + 1 })`（delta 路徑）或 `deltaCount: 0`（FULL 路徑）。
- [x] 3.6 `reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(stripped)).catch(...)` —— 寫入時機與舊版相同（請求進入時即寫，不延遲到 response 結束）。

## 4. Config

- [x] 4.1 `server/config.js` 新增 `DELTA_SNAPSHOT_N = parseInt(process.env.CCXRAY_DELTA_SNAPSHOT_N || '0', 10)` 並從 module exports 公開。
- [x] 4.2 `0` = 永不強制 snapshot（只在 anchor 條件 1/2 觸發時寫 FULL）。S3 setup 建議設 `5` 縮短 chain。

## 5. Lazy-load chain reconstruction

- [x] 5.1 `server/restore.js` 的 `loadEntryReqRes`：parse `_req.json` 後，若 `stripped.prevId != null && stripped.msgOffset != null` → 從 `store.entries` 找 prev entry → 遞迴 `await loadEntryReqRes(prevEntry)` → splice `prevEntry.req.messages.slice(0, stripped.msgOffset)` + 自身 delta。
- [x] 5.2 Pruned prev（找不到 / 載入失敗）gracefully degrade：保留 delta portion 直接顯示，不拋錯。
- [x] 5.3 公開的 `entry.req` 移除 `prevId`、`msgOffset`、`sysHash`、`toolsHash` 內部欄位（UI 不應看到）。
- [x] 5.4 Per-entry promise dedup：`_loadingPromise` 確保 concurrent load 同一 entry 時只執行一次 I/O。

## 6. Migration script

- [x] 6.1 新增 `scripts/migrate-to-delta.js`，dry-run by default，`--write` 套用。
- [x] 6.2 CLI flags：`--snapshot-n N`（chain depth 上限，預設 20，與 live server 的 `0` 不同因為 migration 不知未來會延伸多遠）、`--logs-dir PATH`（覆寫 `~/.ccxray/logs`）。
- [x] 6.3 從 `index.ndjson` 讀所有 entries，過濾 `isSubagent === true` 與 `sessionInferred === true`，按 timestamp 排序逐 session 處理。
- [x] 6.4 Per-session 處理：維護 `prevState = { id, lastMsg, count, deltaCount }`，逐 entry 用 `findSharedPrefixFromLast`（alias `canDelta`）判斷是否可寫 delta。
- [x] 6.5 已是 delta 的 entry 不重寫，但用 `probeChainDepth()` 走 prevId 鏈計算實際 depth 後更新 prevState（讓鏈跨已轉換的 delta entries 延續）。
- [x] 6.6 寫入採 atomic 模式：寫 `{id}_req.json.tmp` → `fs.rename` → 覆寫原檔。
- [x] 6.7 `safeParseFirst`：處理 legacy 雙 JSON concatenation（早期版本 server crash 重送時遺留的格式異常）。
- [x] 6.8 Output summary：Files converted、Anchor breakdown（`first-in-session` / `snapshot-cap` / `no-shared-prefix`）、Skipped (subagent)、Skipped (inferred)、Existing deltas、Estimated bytes saved。三個 anchor 計數加總 = 未轉換的 eligible files，作為 self-check。
- [x] 6.9 Startup `.tmp` orphan cleanup：server 啟動時掃 `_req.json.tmp` 殘留並刪除（migration crash 後的孤兒檔案）。

## 7. Documentation

- [x] 7.1 `CLAUDE.md` 新增 "Delta Log Storage" 章節：格式範例（delta vs anchor）、規則（explicit session、anchor on first/compaction、subagent always FULL、`supportsDelta=false` 停用 delta）、env var、read 端 chain reconstruction、graceful degrade 行為。

## 8. Tests

- [x] 8.1 `test/delta-write.test.js`（18 tests）：`msgNorm` 處理 nulls / plain content / tool_use blocks；`findSharedPrefix` 邊界（empty prev、compaction、strict prefix、cache_control-only divergence、midstream fork）；`findSharedPrefixFromLast` 同矩陣 + retry/compaction shape。
- [x] 8.2 `test/delta-restore.test.js`（7 tests）：single hop、multi-hop chain、pruned-prev fallback、`_loaded` cache、concurrent-load promise dedup、model/max_tokens 從 delta header 取值（不從 prev）、empty-delta full-match shape。
- [x] 8.3 `test/migrate-to-delta.test.js`（19 tests）：`canDelta` unit、`safeParseFirst`（legacy double-JSON、escaped quotes、brace inside strings、nested objects、invalid input）、`probeChainDepth`（anchor-direct、multi-hop、SNAPSHOT_N cap、missing prevId、mid-chain corruption、empty input）、end-to-end subprocess（subagent filter、resume across existing delta、anchor-by-reason 加總）。
- [x] 8.4 全 suite 通過：349 → 393 tests。
