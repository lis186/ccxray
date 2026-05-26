## Context

每個 turn 的 `_req.json` 存入完整 `messages` 陣列，造成 O(N²) 儲存成長（17GB / 14 天，req files 佔 94%）。`system` 與 `tools` 已透過 `shared/{hash}.json` 去重，但 `messages` 沒有。

Claude Code 的對話歷史是 append-only：每個 turn 的 `messages` 是上一個 turn 的嚴格前綴 + 1-N 條新訊息。利用此性質，每個 turn 只需要存「自上一個 turn 以來新增的 messages」+ 一個指向前一個 turn 的 pointer，讀取時遞迴重建即可，將儲存從 O(N²) 降到 O(N)。

## Goals / Non-Goals

**Goals:**

- `_req.json` 儲存從 O(N²) 降到 O(N)，長 session 每 turn 節省 95-99%。
- 新舊格式 `_req.json` 共存，lazy-load 自動辨別，無需 migration 即可上線。
- 一次性 migration 工具能轉換歷史資料，crash-safe、可中斷恢復、預設 dry-run。
- Subagent 與 inferred session 不污染 chain（避免錯誤 anchor 連鎖）。
- S3 等 multi-writer 後端 graceful degrade 成 FULL，無新行為差異。

**Non-Goals:**

- 改變 `_res.json` 的格式。
- 改變 `index.ndjson` 的 schema（delta 元資料只存在 `_req.json`，index 不需要新欄位）。
- 引入新的外部 binary format（Parquet、Arrow）。
- Per-session NDJSON file with byteOffset seek（早期草案，最終捨棄，理由見 D1）。
- Background gzip compaction（marginal benefit，race condition 風險高於收益）。

## Decisions

### D1：Per-turn delta chain，而非 per-session NDJSON

**選擇：** 每個 turn 仍各自一個 `_req.json`。Delta 儲存方式是在 `_req.json` 中加入 `prevId` + `msgOffset` 欄位，`messages` 只存 slice from `msgOffset`。

**替代方案（草案，已捨棄）：** `sessions/{sid}_gen{N}.ndjson` per-session append-only file + `logByteEnd` 在 `_req.json` 記錄 byte offset，O(1) seek。

**為什麼選 chain：**
- **不需 storage adapter 新 method**：interface 維持 `read/write/list/stat/deleteFile`，無 `appendSessionLog`、`readSessionLog`。
- **不需 per-session write queue**：每個 turn 自己一個 file，並發寫不衝突。Subagent / parent 同時寫 fan-out 也不需要序列化。
- **S3 graceful degrade**：`supportsDelta: false` 直接走 FULL，無新 capability gate 邏輯散佈各處。
- **Crash safety 簡單**：每個 file write 是 atomic（fs.rename in migration / single write in live），不需 lazy truncation。
- **沒有 generation 概念**：`/compact` 自動透過 `findSharedPrefix == 0` 觸發 anchor，不需 `_gen{N}.ndjson` 命名與 generation 推導。

**chain 的代價：** 讀取 turn N 需要遞迴讀 N → N-1 → ... → anchor。Mitigation：
1. `CCXRAY_DELTA_SNAPSHOT_N` 上限 chain depth（live server 預設 0 = 無上限，因為 anchor 條件 2「no shared prefix」自然把 chain 切短；S3 setup 建議設 5）。
2. Lazy-load 已有 `_loadingPromise` dedup，UI 點開 turn 時只 fan-out 一次。
3. Anchor 條件 2（`/compact`、retry）自然產生 anchor，現實中 chain 很少超過 20。

### D2：cache_control 正規化是正確性核心

**問題：** Claude Code 每個 turn 把 `cache_control: { type: 'ephemeral' }` 標記輪轉到最新訊息上。即使對話歷史邏輯上完全相同，前一 turn 的最後一個訊息 vs 當前 turn 對應位置的同一個訊息 raw bytes 不同。直接 `JSON.stringify` 比對會誤判為「無共享前綴」，所有 turn 都被迫寫 FULL。

**解法：** `msgNorm(msg)` 在比對前 strip `cache_control` 欄位（其餘 content block 欄位完整保留）：

```js
function msgNorm(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return { ...msg, content: msg.content.map(b => {
    if (!b || typeof b !== 'object' || !('cache_control' in b)) return b;
    const { cache_control, ...rest } = b;
    return rest;
  }) };
}
```

**正確性保證：** 只比對最後一個共享訊息（O(1) hash），因為對話歷史的 append-only 性質保證若最後一個 prev 訊息匹配，前面所有訊息也匹配。strip cache_control 只影響「比對」，**不影響寫入**：delta 存入磁碟的 `messages.slice(sharedCount)` 仍是原始物件（含當前 turn 的 cache_control 配置），lazy-load 重建後完全等價於 FULL。

**Single source of truth：** `server/delta-helpers.js` 同時被 live server 與 migration script require。早期實作兩處各有一份 inline copy，註解標示「must stay in sync」—— 抽出共用後 drift 風險消失。

### D3：Anchor 條件三選一

**寫 FULL（anchor）的條件：**
1. `!prev`：session 第一個 turn，`sessionLastReq` 沒有此 sessionId entry。
2. `sharedCount < 2`：找不到共享前綴（`/compact`、`/clear`、retry、cache rotation 異動、content drift）。`< 2` 而非 `< 1` 是因為單訊息匹配不足以證明 chain 有意義（cost 大於 benefit）。
3. `DELTA_SNAPSHOT_N > 0 && prev.deltaCount >= DELTA_SNAPSHOT_N`：chain depth cap。

**寫 delta 的條件：** `peekSid && storage.supportsDelta && prev && sharedCount >= 2 && deltaCount < DELTA_SNAPSHOT_N`。

`peekSid` 取自 `store.extractSessionId(parsedBody)`，**只看 explicit `session_id`**（不是 `detectSession()` 推論結果）。

### D4：Subagent / inferred session 不參與 delta

**問題：** Subagent 透過 `detectSession()` 的 inflight 推論共用 parent sessionId，但其 `messages` 是 msgCount=1 的 one-shot prompt，與 parent 的對話內容完全不同。若把 subagent 也納入 chain：
1. Subagent entry 進入時 `sharedCount=0`（無共享），自己變 anchor。
2. 下一個 main turn 進入時，`sessionLastReq` 指向 subagent，`sharedCount=0`（subagent 內容不是 main 的前綴），main turn 又變 anchor。
3. 結果：每個 subagent 把 main thread 的 chain 打斷兩次，delta 率劇降。

**解法（live server）：** 用 `extractSessionId(parsedBody)`（只看 explicit `session_id`）取代 `detectSession()`。Subagent body 沒有 explicit session_id，`peekSid=null`，`!peekSid` 判斷直接跳過 delta 邏輯走 FULL。`sessionLastReq` 完全不更新，main thread 的 chain 不受干擾。

**解法（migration script）：** 從 `index.ndjson` 讀 entry 時過濾 `isSubagent === true || sessionInferred === true`。**`=== true` 的精確比對**：legacy entries 沒有此欄位（undefined），不應被排除（這些是早期 explicit session 的 entries）。

### D5：lazy-load 用遞迴而非展開重建

**選擇：** `loadEntryReqRes` 偵測 delta 後遞迴 `await loadEntryReqRes(prevEntry)`，splice `prevEntry.req.messages.slice(0, msgOffset)` + 自身 delta 重建 entry.req.messages。

```js
let messages = stripped.messages || [];
if (stripped.prevId != null && stripped.msgOffset != null) {
  const prevEntry = store.entries.find(e => e.id === stripped.prevId);
  if (prevEntry) {
    await loadEntryReqRes(prevEntry);
    if (Array.isArray(prevEntry.req?.messages)) {
      messages = [...prevEntry.req.messages.slice(0, stripped.msgOffset), ...messages];
    }
  }
}
```

**為什麼遞迴：** Promise dedup（`_loadingPromise`）天然處理 chain 中段被另一個 click 同時觸發的情況；展開實作（while loop）需要手動管理 visited set 與並發 token，複雜度更高。

**Pruned prev 的處理：** `prevEntry` 找不到（已超過 `LOG_RETENTION_DAYS`，被 pruneLogs 刪除）→ 直接用 delta portion 顯示。UI 看到的 messages 不完整，但不拋錯、不阻塞，是可接受的 graceful degrade（畫面上會明顯看出對話從中段開始）。

**內部欄位剝離：** `entry.req` 公開給 UI 之前 delete `prevId`、`msgOffset`、`sysHash`、`toolsHash`。UI 不需要也不應該看到 chain 內部結構。

### D6：Migration script 的 atomic write

**選擇：** `scripts/migrate-to-delta.js` 寫 `{id}_req.json.tmp` → `fs.rename` 取代原檔。

**為什麼 tmp + rename：** Node `fs.rename` 在 POSIX 是 atomic（同一 filesystem）。即使 SIGKILL 在 rename 前，原檔完整保留，tmp 檔孤兒；若 SIGKILL 在 rename 後，原檔已是 delta 格式。**永遠不會出現「半寫的 `_req.json`」狀態**。

**Tmp orphan cleanup：** server 啟動時掃 `_req.json.tmp` 殘留並刪除。Migration crash 後重跑會直接覆蓋 tmp 檔，但若用戶不重跑，server 啟動清理是 fallback。

**為什麼 dry-run by default：** 第一次 migration 9994 / 15493 eligible 檔案，預估節省 5.3GB，使用者應先看 dry-run 結果確認 anchor breakdown（`first-in-session` / `snapshot-cap` / `no-shared-prefix`）合理才 `--write`。

**Crash recovery：** Migration 是冪等的——重跑時 already-delta 的 entry 透過 `probeChainDepth` 計算實際 depth 後更新 prevState，不重寫；FULL entry 仍走標準轉換邏輯。沒有「跳過已處理 session」的概念，所有 entry 每次都評估，但已是 delta 的不會被改動。

### D7：跨已轉換 delta 延續 chain

**問題：** 早期版本 server 已經寫了一些 delta entries（live delta deployment 後的 turn）。Migration script 若把每個遇到的 delta entry 視為 chain 斷點（reset prevState），緊接其後的 FULL entry 會被當作 first-in-session 變 anchor，`SNAPSHOT_N` 就不再是真正的 global cap。

**解法：** Migration 遇到 delta entry 時不重寫，但用 `probeChainDepth(deltaParsed)` 走 `prevId` 鏈直到 anchor（或達 cap），把 prev state 更新成 `{ id: deltaId, lastMsg: <最後訊息>, count: deltaParsed.msgOffset + deltaParsed.messages.length, deltaCount: probedDepth }`。

**為什麼可以從 delta 繼續：** Delta 的 `prevId` + `msgOffset` + `messages` 已能唯一確定該 turn 的「最後一個訊息」（即 `messages[messages.length - 1]`，因為 delta 永遠是末尾的新訊息）。下一個 FULL entry 比對時用 `findSharedPrefixFromLast(lastMsg, count, currMessages)`，與從 FULL 延續完全等價。

**Anchor breakdown counters：** Output 把 anchor 拆成三個互斥原因（first-in-session / snapshot-cap / no-shared-prefix），加總 = totalEligible - totalConverted - skipped。讓使用者一眼看出哪類 anchor 最多，哪類可優化。

## Risks / Trade-offs

**[Risk] Chain 中段 entry 被 pruneLogs 刪除導致後段 entry 重建不完整**
→ Mitigation：lazy-load graceful degrade（顯示 delta portion），UI 不崩。`LOG_RETENTION_DAYS=14` 上界限制這種情況的暴露窗。Anchor 條件 2 自然把長 chain 切短，實務上中段 entry 與 chain 末端通常在同一週內 prune，影響範圍小。

**[Risk] cache_control 正規化漏掉某些變化形式**
→ Mitigation：`msgNorm` 只 strip `cache_control` 欄位本身，content block 其餘欄位（`type`, `text`, `tool_use_id`, ...）完整保留並參與比對。若 Claude Code 未來引入新的「per-turn 輪轉欄位」，會看到 delta 率突降，可加新欄位到 strip 清單。Test suite 包含 cache_control rotation scenario 防止 regression。

**[Trade-off] `SNAPSHOT_N=0`（live server 預設）讓理論上 chain depth 無上限**
→ Acceptable：實務上 anchor 條件 2 會自然切短（每次 retry / `/compact` / cache invalidation 都產生 anchor）。最長觀察到的 chain 在數十 turns 範圍內。S3 setup 建議手動設 `5`，因為 chain traversal 走網路 GET。

**[Risk] Migration script 處理大量檔案時 memory 過大**
→ Mitigation：per-session prevState 只保留 last message + count（不保留完整 messages 陣列）。掃描所有 entries 是 streaming（`readdir` + 逐個 read + parse），peak memory 是單一 `_req.json` 大小。

## Migration Plan

```
Phase 1（部署 1.8.0）：
  → live server 自動寫 delta（local backend）或 FULL（S3 backend）
  → 舊 FULL `_req.json` 仍能 lazy-load（無 prevId → 直接用 messages）
  → 不需立即 migration

Phase 2（一次性轉換歷史資料，可選）：
  → user 手動 `node scripts/migrate-to-delta.js` 看 dry-run summary
  → 確認 anchor breakdown 合理後 `--write`
  → atomic temp-file write，crash-safe，可重跑

Phase 3（自然消失）：
  → LOG_RETENTION_DAYS=14 後，未轉換的 FULL `_req.json` 被 pruneLogs 自然刪除
```

**Rollback：**

| 情境 | 受影響範圍 | 資料狀態 | 恢復方式 |
|------|----------|---------|---------|
| Phase 1 rollback（降級到 1.7.x） | 1.8.0 寫的 delta entries | 舊版讀不到 `prevId` 欄位，當作普通 FULL 處理 → `messages` 只剩 delta portion，畫面上 messages 從中段開始 | re-upgrade 到 1.8.0+ |
| Phase 2 rollback（migration 後降級） | 全部已轉換 entries | 同上 | re-upgrade 到 1.8.0+ |

降級不是 data loss—— delta 檔案保留所有重建所需資訊，只是舊版沒有 chain reconstruction 程式碼。Re-upgrade 即恢復。

## Open Questions

無。Shipped in 1.8.0，dogfood 驗證 99.4% per-turn 節省（125 KB FULL anchor → 724 B delta on 46-message session），suite 393 tests 全綠。
