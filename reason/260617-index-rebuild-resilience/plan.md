# `ccxray rebuild-index` — 實作計劃

GitHub issue #48（做法 1：手動 CLI，merge-only / atomic / hub-safe / honest）。
本計劃由兩個獨立 worktree 原型（B=`e077075`、C=`007f5c7`）的對照 + canonical 源碼裁決萃取而成。

## 範圍

實作 `ccxray rebuild-index`：從磁碟上倖存的 `_req.json`/`_res.json` 重建 `index.ndjson`，
走 live pipeline 同一條 canonical 投影（`buildEntryFields` → `buildIndexLine`）。

**拒絕**：啟動自動修復、改動保留/prune 設定、OpenAI/Codex 深度復原（僅 best-effort）。

## 兩原型共識（高信心，直接採用）

- 新檔 `server/rebuild-index.js`，export 內部函式供測試。
- `server/index.js` early dispatch：`process.argv[2] === 'rebuild-index'`，在 server boot 前；加入 unknownCommand allowlist。
- flag `--apply`（預設 dry-run）。
- 刪 `scripts/rebuild-missing-index.js`。
- delta chain：走 `prevId` + splice `prev.messages.slice(0, msgOffset) ++ delta`（鏡像 `loadEntryReqRes`）；斷鏈 → skip 並計入 unrecoverable，**絕不產生降級行**；cycle guard；memo cache。
- system/tools 由 `shared/sys_<hash>.json`、`tools_<hash>.json` 依 hash rehydrate。
- orphan set = 磁碟 `_req.json` ids 減去既有 index ids；排除 `_req.received.json`。
- merge-only：既有行原文照抄在前，復原行接後；永不 shrink、永不覆蓋。
- atomic：寫 `.tmp` → `fs.renameSync`。
- hub-safe：`hub.readHubLock()` + `hub.isPidAlive()`，活著就拒跑。
- 誠實輸出：`recovered N / M turns; K unrecoverable (source pruned)`。
- 可測性：`rebuildIndex({ apply, storage = config.storage, log = console.log })` 注入（採 B 的注入法，優於 C 的 require-前設 CCXRAY_HOME）。

## 欄位投影裁決（源碼驗證後的教訓）

| 欄位 | 決定 | 依據 |
|------|------|------|
| **stopReason** | Anthropic 從 `message_delta` 事件抽；OpenAI 留給其 response 物件 | `buildEntryFields(anthropic)` 是 `ctx.stopReason \|\| ''`，**無事件 fallback**（兩原型都各自發現並處理） |
| **cwd** | `store.extractCwd(parsedBody)`，null 時從同 session 既有 index 行 / 已復原 anchor 回填 | 驗證：`extractCwd` 讀 `req.system` 的「Primary working directory:」；sessionMeta.cwd 源頭就是 system → **可離線復原**（C 對、B 留 null 是錯） |
| **session 歸屬** | 見下方專節 | `store.detectSession` 有狀態、`inferParentSession` 離線失效 |
| **title** | 復原：`resolveTitleGenTitle` → subagent 用 `extractFirstUserText`；否則 `extractResponseTitle(events) \|\| extractLastUserText \|\| extractToolResultSummary` | 鏡像 forward.js:705-711，全吃離線有的 events+parsedBody；**兩原型都漏，是 dashboard turn 標籤** |
| **isSubagent** | `store.isAnthropicSubagent(parsedBody)` | 純函式，安全 |
| **thinkingDuration** | `helpers.computeThinkingDuration(events)` | 低成本，順手復原 |
| **isSSE** | `_res.json` 是事件陣列或 provider=openai → true | 與 live 一致 |
| **status** | 有成功 `_res` → 200，否則 null | 離線無法得知，誠實 |
| **elapsed / receivedAt / responseMetadata / coreHash / hasCredential / toolSources / thinkingStripped** | 留 null/undefined（`buildIndexLine` 自動丟 undefined） | runtime-only 或成本過高；coreHash null = 復原行不進版本史（已知限制，不過度投資） |

## Session 歸屬（最深的教訓，專節）

`store.detectSession()` 有狀態（讀寫 `currentSessionId`/`sessionCounter`）、inferred 分支靠
`inferParentSession()` 的 30 秒時間窗 + inflight 計數 —— 離線全部失效。**不可用於重建**。

確定性離線策略（勝過 C 的「全 → direct-api」與 B 的「null」）：
1. **explicit `metadata.session_id`** → 直接用（純）。
2. **delta turn** → 繼承 chain ancestor 的 session_id（確定性）。
3. **inferred/subagent turn**（無 metadata、無 prevId）→ 用「id 時間戳最近、且在它之前的 explicit-session turn」歸屬。id 本身就是可排序時間戳；「該 subagent 跑的時候哪個 session 在活動」= 它之前最近的 explicit turn。確定性、無時間窗、無順序相依。
   - 來源時間軸 = 既有 index 行裡 `sessionId && !sessionInferred && sessionId !== 'direct-api'` 的 (id, sessionId) ∪ 可復原 orphan 的 explicit turns，依 id 排序。
   - 找不到前驅 → `'direct-api'` sentinel（鏡像 live fallback）。
   - 一律標 `sessionInferred: true`。

> 標記 `// ponytail:` —— 此歸屬是離線時序近似，非 live 的 inflight 推斷；若日後證實脆弱可退回 null。

## 實作步驟

1. 清三個原型 worktree，從 `main` 開新 branch `feat/rebuild-index`。
2. 寫 `server/rebuild-index.js`（依上述）。
3. `server/index.js` 加 dispatch + allowlist。
4. 刪 `scripts/rebuild-missing-index.js`。
5. 寫 `test/rebuild-index.test.js`（node:test + assert，比照 repo 風格）。
6. `npm test` 全綠。
7. browser-harness e2e + 蒐證。
8. codex review。
9. 更新 CLAUDE.md（CLI 列表 + rebuild-index 一行）；視需要更新 README。

## 測試

**Unit（`test/rebuild-index.test.js`）** — 注入 storage + 合成 logs：
- orphan 偵測（磁碟有、index 無）
- merge-only：既有 pruned-source 行（無檔案）保留、index 不縮
- delta chain 完整 splice（`msgCount` 對）
- 斷鏈 → skip、不出降級行、計入 unrecoverable
- idempotent（第二次 apply = no-op）
- cwd 從 system 復原；null 時回填
- session：explicit 直用 / delta 繼承 / subagent 歸最近前驅 explicit
- title 復原非 null
- dry-run = byte-for-byte no-op
- 復原行只含 `INDEX_FIELDS` 子集
- atomic：tmp 消失、index 行數正確

**e2e（browser-harness）** — `test/rebuild-index.browser-harness.e2e.sh`，真 browser-harness（CDP/Chrome）跑通：自啟專用 remote-debugging Chrome（`BU_CDP_URL`，繞過 M144 的 Allow 對話框）→ 種 log 無 index → rebuild → 啟 dashboard → 導航斷言「2 turns、project=ccxray、復原標題」→ 截圖 `evidence/browser-harness-after-rebuild.png`。另有等效的 puppeteer headless 版（`test/rebuild-index.e2e.test.js`）進 `npm test` 供 CI。原始流程：
- 合成 `CCXRAY_HOME`（含 anchor + delta + subagent + 一個 pruned-source-only index 行）
- 刪 `index.ndjson` → 跑 `node server/index.js rebuild-index --apply`
- 啟 `ccxray --port 56xx --no-browser`
- browser-harness（CDP/Chrome）載 dashboard，斷言 Projects/Sessions/Turns 欄重現、entry 數 > 0
- 截圖 + DOM/`/api` entry 數存證

## Codex review 結果（已處理）

codex（gpt-5.4）的正確性 review 全集中在 OpenAI/Codex 路徑，據此收斂：

- **blocker #1+#2+#3（OpenAI/WS）** → **改為 Anthropic-only 復原**。OpenAI 原始 body、WS transport-only 記錄、無 messages 的記錄一律跳過（計入 unrecoverable），不產出可能誤標成 Anthropic 的損壞行。Codex 主流量走 WS 即時記錄，transport-only `_req.json` 本就無 payload 可重建 —— 跳過不損失可復原資料，且讓 never-degrade 真正成立。
- **major #4（cwd 取 first-seen）** → 改 timeline 帶 cwd、排序後**最新者勝**，貼近 live 的 `sessionMeta[sid].cwd`。
- **minor #5（append 非 id 序）** → 合併既有+復原後**依 id 排序**寫出，復原 turn 落在正確時序位置（既有行不丟不改，只回到 id 正序）。
- **status 捏造 200** → 改為綁實際成功訊號（有 `stop_reason` 才記 200，否則誠實 null）。
- 同 dir tmp+rename、newline、orphan 過濾、hub-lock 拒絕：codex 確認無誤。

## /simplify 結果（已處理）

4 個清理 agent（reuse/簡化/效率/altitude）。採用：(1) 第 203 行改用 canonical `store.extractSessionId`（取代手寫 `metadata.session_id`，並涵蓋 user_id 內嵌格式）；(2) 刪未用 export。跳過：抽 `spliceDeltaMessages` 共用 helper（要改 live restore.js，超出 diff，列 follow-up）；`!storage.location` 取代 supportsDelta（誤報，S3 location 為 truthy）；效率類（CLA 一次性，不值得）。

## 完成證據

- `npm test` 全綠（含新測試），貼輸出。
- CLI 輸出顯示 `recovered N / M`。
- before：刪 index → dashboard 空（截圖/entry 數 0）。
- after：rebuild → dashboard 有歷史（browser-harness 截圖 + `/api` entry 數）。
- codex review 乾淨或已處理。
