# Subagent / workflow transcript import — evidence and design options

TL;DR：subagent token/cost **並非「counted nowhere」**——`cost-worker.js` 的遞迴掃描早就把它們算進 Usage tab 且按各自 model 計價；真正的缺口只在 `importer.js`（index → dashboard）。而 issue 指定的「roll up 成 parent index line 的聚合欄位」會**打破**它援引的 count-once invariant，因為聚合值沒有 `responseId`，無法與 proxy 已錄的同一筆 subagent turn 去重。

**Owner 決策（2026-08-20）：採 Option A**（當普通 entry 匯入，歸屬 transcript 自報的
parent sessionId），含 §5a 的兩項修正。Option C 經實測為空（§5），Option D 為明確不補的
對照選項。Owner 已於 #565 簽核（`approve-check.sh` 驗證：`APPROVE-DESIGN by OWNER token=565A`），
修復型 issue = **#570**。

> 簽核 token 為 `565A` 而非 runId `565-diag-2026-08-20`：`approve-check.sh --exclude-run`
> 會略過 body 含該 runId 的任何 comment，若 token 等於 runId 則簽核本身被排除（以 `--input`
> 三組對照驗證）。**sign-off token 不得等於該輪 runId。**

- Issue: [#565](https://github.com/lis186/ccxray/issues/565)
- 相關：[#546](https://github.com/lis186/ccxray/issues/546)（multi-provider cost attribution data model）、[#508](https://github.com/lis186/ccxray/issues/508)（Codex importer 不設 responseId）、[#507](https://github.com/lis186/ccxray/issues/507)（`tsToId` 10ms 桶碰撞）、[#117](https://github.com/lis186/ccxray/issues/117)（subagent identity）
- ADR：[0012](../decisions/0012-response-id-read-time-merge.md)（responseId 去重＝count-once 的實作）、[0005](../decisions/0005-agent-key-unreliable-shared-contract.md) / [0008](../decisions/0008-temporal-overlap-overrides-agent-key.md) / [0010](../decisions/0010-corehash-identity-routing.md)（fork vs teammate 身分推論）、[0017](../decisions/0017-aggregate-cost-confidence.md)（aggregate cost fold）、[0016](../decisions/0016-restore-stream-snapshot-byte-bound.md)（index 規模／restore）

---

## 1. Problem statement 更正：cost 已被計入，缺的是 index

issue 寫「None of these are discovered as sessions — their tokens and cost are counted nowhere」。前半句對（importer），後半句不對（cost-worker）。

差異對照——同一份合成 home（1 個 main session ＋ 1 個 flat subagent ＋ 1 個 workflow subagent），分別跑兩條路徑：

```sh
# 合成 home：
#   $T/.claude/projects/-proj/sess1.jsonl                                    (opus-5)
#   $T/.claude/projects/-proj/sess1/subagents/agent-abc.jsonl                (haiku-4-5)
#   $T/.claude/projects/-proj/sess1/subagents/workflows/wf_1/agent-def.jsonl (sonnet-5)

env -u LOGS_DIR HOME="$T" CCXRAY_HOME="$T/ccxhome" node server/cost-worker.js
env -u LOGS_DIR HOME="$T" CCXRAY_HOME="$T/ccxhome" \
  node -e 'require("./server/importer.js").scanAndImport().then(r=>console.log(r))'
```

| 路徑 | 結果 |
|---|---|
| `cost-worker.js`（Usage tab） | **3 筆**：`sid=sess1/claude-opus-5`、`sid=agent-abc/claude-haiku-4-5-20251001`、`sid=agent-def/claude-sonnet-5` |
| `importer.js`（index.ndjson → dashboard） | **1 筆**：只有 `sid=sess1`，`rid=msg_main1` |

根因是兩個同名函式的遞迴性不同：

| 檔案 | 函式 | 行為 |
|---|---|---|
| `server/cost-worker.js:16-27` | `collectJsonlFiles(dir, results)` | **遞迴**（`if (stat.isDirectory()) await collectJsonlFiles(...)`） |
| `server/importer.js:84-93` | `collectJsonlFiles(dir)` | **只掃一層**（`if (!item.endsWith('.jsonl')) continue`） |

推論：
- issue 的「costing them at the parent's model rate would also be wrong」這個顧慮在 cost-worker 路徑上不存在——每個 subagent 檔案的 model 取自它自己的 assistant line。
- 因此本 issue 的價值**不是**「補回遺失的成本」，而是「讓 subagent turn 出現在 index / dashboard / weather / swimlane」。驗收條件與原 issue 寫的完全不同。

---

## 2. 實際 schema（實測，非取自 issue body）

issue 的 Evidence 段低估了可用訊號。實測 `~/.claude*/projects/<slug>/<sid>/subagents/`：

**subagent jsonl 的每一行都自帶 parent session 身分**

```
fork-context-ref | ['agentId','contextLength','parentLastUuid','parentSessionId','type']
assistant        | ['agentId','cwd','effort','entrypoint','gitBranch','isSidechain',
                    'message','parentUuid','requestId','sessionId','timestamp','type',
                    'userType','uuid','version']
```

抽樣 400 檔（**僅 flat 層** `<sid>/subagents/agent-*.jsonl`，glob 未含 `**`）：
`sessionId == 上兩層目錄名`（＝parent session id）**400/400**，`isSidechain: true`
**400/400**，mismatch 0，missing 0。

> ⚠️ 「上兩層目錄名」只對 flat 層成立。`workflows/wf_*/agent-*.jsonl` 的 parent session
> 在**上三層**（`wf_* → workflows → subagents → <sid>` 之外一層）。實作**不應**用路徑深度
> 推導 parent，而要一律讀行內 `obj.sessionId`——該欄位本身與路徑深度無關。workflow 層的
> `sessionId` 一致性**未單獨抽樣驗證**（1,988 個檔）,列入 §6。

這一點推翻了 issue 的架構前提：**不需要**把 subagent 當「separate sessions」也不需要 roll-up——transcript 自己就宣告了 parent sessionId。目前 `importer.js:121` 的 `const sessionId = path.basename(filePath, '.jsonl')` 是唯一會產生 `agent-<id>` 這種假 session id 的地方；改讀行內 `obj.sessionId` 即自然歸屬 parent。

**`.meta.json` key 普查（9,439 檔）**

```
agentType 9439 · description 6650 · toolUseId 4415 · spawnDepth 4322 · name 3090
isFork 1744 · model 846 · taskKind/teamName/color/planModeRequired/permissionMode 586
parentAgentId 218 · customAgentType 148 · worktreePath 106 · worktreeBranch 94
```

agentType 分佈：`general-purpose` 3613 · `workflow-subagent` 1980 · `fork` 1744 · `Explore` 1157 · `codex:codex-rescue` 116 · `claude` 58 · `Plan` 52 · `adversary` 48 · 其餘長尾。

**覆蓋率缺口**：13,175 個 `agent-*.jsonl` 中 **3,739 檔（28%）沒有對應 `.meta.json`**（全部在 flat 層，workflow 層 0 缺）。這些檔案取不到 agentType，設計必須明訂 fallback（見 §5 待決 3）。

**workflow journal**：74 個 `journal.jsonl`，行型別 `{started, result}`，`result` 行 keys = `['agentId','key','result','type']`——`key` 才是人類可讀標籤，issue 說的「maps agentId to a human label」需靠 `key` 而非 `result`。

**usage 形狀**：帶 `cache_creation.ephemeral_1h_input_tokens`（1h cache tier），與 [#398](https://github.com/lis186/ccxray/issues/398)（long-context / tier 費率未套用）同一面。

---

## 3. 為什麼 issue 指定的 roll-up 會打破 count-once

issue 的 Scope 寫：

> Roll up as delegation metadata on the parent session's index line (not as separate sessions — count-once invariant)

但這個 repo 的 count-once **不是**由「不要開新 session」達成的，而是 ADR 0012 的 **responseId 去重**：

- `importer.js:196-197`：`const responseId = msg.id || null; const dedupKey = responseId || id;`
- `importer.js` 的 import 迴圈以 `existingIds`（來自 `index.ndjson`）去重，並在匯入前 seed `_costByRid` / `_countedRids`。
- subagent 的請求在 proxy 路徑上**本來就是 first-class index entry**——ADR 0005 / 0008 / 0010 整體存在的理由就是替這些 turn 分 lane。

因此：

| 做法 | 與已存在的 proxy 副本的關係 |
|---|---|
| 當普通 entry 匯入（帶自己的 `msg.id`） | 現有去重**自動**擋掉重複；互補欄位還會 merge（ADR 0012） |
| roll-up 成 parent 的聚合欄位 | 聚合值**沒有 key**——既不能去重也不能 merge，對每個「已經過 proxy」的 session 都是**真雙計** |

實測支撐：subagent 的 323,196 筆 usage line **每一筆都有 `message.id`**（無 id 者 0 筆）。去重鍵永遠存在，這是 Option A 幾乎免費的原因。

換句話說，issue 援引 count-once 來排除的選項，才是唯一與 count-once 機制相容的選項。

---

## 4. Blast radius（實測）

- `agent-*.jsonl`：**13,175** 檔（flat 11,187 / `workflows/` 下 1,988）
- usage line：**323,196**；以 `message.id` 聚合後（#428 規則）＝ **70,417 個 turn**
- 帶 subagent turn 的 parent session：**799**（這是語料規模，**不等於**受本改動影響的 session 數——見 §5A 的 ⚠️ 註）
- token 總量（單位：百萬）

| model | input | output | cache read | cache create |
|---|---|---|---|---|
| claude-opus-4-6 | 16.0 | 30.7 | 12,819.0 | 788.0 |
| claude-sonnet-4-6 | 7.2 | 25.9 | 5,211.7 | 338.9 |
| claude-fable-5 | 25.2 | 14.8 | 3,180.1 | 346.7 |
| claude-haiku-4-5-20251001 | 7.7 | 8.3 | 2,945.0 | 374.6 |
| claude-sonnet-5 | 13.4 | 5.7 | 1,755.5 | 161.6 |
| claude-opus-5 | 1.9 | 5.0 | 1,710.7 | 101.4 |
| claude-opus-4-8 | 33.6 | 6.6 | 1,447.5 | 184.2 |
| claude-sonnet-4-5-20250929 | 0.3 | 0.0 | 213.6 | 46.2 |

（另有 `<synthetic>` 與 `claude-opus-4-5-20251101` 微量；`<synthetic>` 是需要明確處理的非真 model 值。）

index 規模影響：70,417 個新 turn，扣掉與 proxy 副本去重後的淨增未知（見 §6）。以每行 ~700B 估計上界 ≈ 49 MB——對 ADR 0016 的 restore streaming 與 #348 residency 是可承受量級，但不是零。

**per-session 分佈**（決定「每個受影響 session 會變多少」——受影響的**是哪些**由 §6 的
未量測交集決定，2026-08-20 補量）：799 個 parent session
帶 subagent turn，每 session 的 subagent turn 數 median **31**、p90 **198**、max **5867**。
其中 **17** 個 session 光 subagent turn 就超過 `SESSION_ENTRY_CAP`（預設 500,
`server/store.js:13`），會被推進 oversized / cold-load 路徑（`restore.js:311`）——該路徑
本身是 ADR 0012 的 merge 路徑，行為已定義，但載入方式與現在不同。

**匯入沒有時間窗**：`server/importer.js` 無 `RESTORE_DAYS` / cutoff / mtime 過濾（搜過
`Date.now|getTime|days|since|cursor`），所以 A 是**一次性全史匯入**，不是漸進式。若要
分批落地，需要另外設計窗口——本 ADR 不預設它存在。

---

## 5. 修法選項

### Option A — 當普通 entry 匯入，歸屬 transcript 自報的 parent sessionId 【採用】

- Claude 端的 `collectJsonlFiles` 改為遞迴（或加一個 subagents pass）
- `parseSessionFile` 的 sessionId 改取行內 `obj.sessionId`（fallback 才用檔名）
- 逐筆自帶 `responseId = message.id` → 去重與 merge 免費

**優點**：符合 P1/P2/P6（見 §5b）——去重、lane、weather、cost confidence fold 全部沿用，
零新機制；per-model 計價天然正確；add-only 可 rebuild；並且**關掉一個跨視圖不一致**——
今天 dashboard 對其中**未經 proxy 記錄**的部分少報，Usage tab 沒有。

> ⚠️ 這裡不能寫成「799 個 session 都少報」。799 是**帶 subagent turn 的 parent session
> 總數**，而 §5D 指出經過 proxy 的 session 其 subagent turn 早已在 index 裡。真正少報的
> 子集 = 799 減去已被 proxy 覆蓋者，其大小正是 §6 明載**未量測**的那一格。同理，A 的
> 「畫面會變的 session 數」也是這個未知子集，不是 799。

**成本**：70,417 turn 一次性進 index（§4）；受影響 session（799 的未量測子集，見上註）的
weather / lane / cost 顯示同時位移；17+ 個 session 跨過 500 cap 改走 cold-load；3,739 檔（28%）無 meta 的 fallback
需明訂。風險集中在**驗收**而非設計：位移是預期的，要證明位移是對的（§9）。

### Option B — roll-up 成 parent index line 的聚合欄位

**優點**：index 行數不變，是唯一不改變既有 session 規模的做法。

**成本**：踩 P2（聚合值無上游 key → proxied session 雙計）、P1（存解讀非事實）、P6（新聚合
流須併進 ADR 0017 的 confidence fold）；dashboard 仍看不到 subagent；日後轉 A 是破壞性
migration。

**收斂性**：B 唯一能正確去重的版本，必須連 subagent 的 responseId 清單一起存——那已經
不是聚合，是 A 的低配版。**B 的 coherent 形態會收斂到 A**，所以這不是真正的二選一。

### Option C — 修 Usage tab 的 session 標示 【經實測為空】

原始評估是「成本近零的修法」。實測後**沒有東西可修**：

- `cost-budget.js:215` 的日聚合確實輸出 `sessionCount: day.sessions.size`，而該值今天
  **是被 subagent 假 session 膨脹的**——`cost-worker.js:95` 用 `path.basename(filePath)`
  當 sessionId，所以每個 `agent-<id>.jsonl` 都算一個 session。
- 但**沒有任何 client 檔案渲染它**。搜過 `public/`、`server/`、`test/`、`docs/` 全部
  `sessionCount` 出現處：唯一的 client 消費者 `public/system-prompt-ui.js:286` 讀的是
  另一個同名欄位（來自 `routes/api.js:266` 的 sysprompt 版本統計），與成本無關。

所以今天 Usage tab 沒有使用者可見的錯誤：金額對、模型對、畫面上沒有 `agent-<id>`。
**唯一受影響者是直接打 `/_api/costs` 的消費者**，它會拿到膨脹的 `sessionCount`。

→ C 不是一個修法選項。`cost-worker.js:95` 應與 A 同樣改讀行內 `obj.sessionId`，列為
**獨立 follow-up**（同一個根因、不同的讀取路徑）。

### Option D — 明確不補，把缺口寫成契約

**優點**：零成本零風險，且理由站得住——subagent 請求與 parent 同進程、同
`ANTHROPIC_BASE_URL`，所以**在 ccxray 底下跑的 session，subagent turn 早就在 index 裡**
（ADR 0005 / 0008 / 0010 整組存在就是在處理它們）。缺口只涵蓋歷史 session 與不經 proxy
的 session。

**成本**：dashboard 與 Usage tab 對上述未經 proxy 覆蓋的子集永久不一致，且不一致是靜默的；§8 的
`isFork` 校準機會一併放掉（雖然校準可用離線腳本讀 transcript 完成，不需進 index）。

**適用條件**：若 importer 被定義為 best-effort backfill 而非完整性保證。

### 5a. Option A 的最終形狀（兩項修正，2026-08-20）

**修正 1：不得覆用 `agentKey` 承載 `meta.agentType`。**
`public/agent-classification.js` 的值空間只有五個：`WF_MAIN_AGENT_KEYS =
{orchestrator, sdk-agent, default}`、`AGENT_KEY_UNRELIABLE = {unknown, agent}`，且
`agentKey` 的契約是**由 system-prompt 內容推導**（ADR 0005）。把 `fork` /
`general-purpose` / `Explore` / `workflow-subagent` 塞進去會踩兩層：

1. 同一欄位混入兩種推導來源，`isMainTurnByAgentKey` 的語意不再成立（P3）；
2. 對 `fork` 尤其錯——fork 跑的**就是** orchestrator prompt，標成 `agentKey='fork'` 會讓
   ADR 0010 的 coreHash 路由整組被繞過，而那正是為 fork 而存在的機制。

→ spawn metadata 走**新的 add-only index 欄位**（ADR 0012 `responseId` 的先例），
`agentKey` 保持 prompt 推導或留空。

**修正 1b：新欄位不得叫 `agentType`／`agentId`／`parentSessionId`——三者都已被佔用。**
這是修正 1 的同一個錯誤降一層：把 spawn metadata 塞進既有欄位的值空間（P3）。實際核對
`server/entry.js` 的 `INDEX_FIELDS`：

| transcript 欄位 | 直覺名稱 | 已被佔用於 | 該用 |
|---|---|---|---|
| `meta.agentType` | `agentType` | **#504 deployment identity**（`CCXRAY_AGENT_TYPE` env，經 `deploymentFields` 展開，且列在 `OMIT_IF_NULL`） | `spawnType` |
| `meta.isFork` | `isFork` | free | `isFork` |
| `meta.spawnDepth` | `spawnDepth` | free | `spawnDepth` |
| line `agentId` | `agentId` | **#504 deployment identity** | `spawnAgentId`（若需要） |
| `fork-context-ref.parentSessionId` | `parentSessionId` | **#531 Herdr-launched agent 的 parent** | 不需要——Option A 之下 parent session 就是 `sessionId` 本身 |

**實作義務（`server/entry.js` 的 INDEX_FIELDS 不變式）**：新欄位若 no-value 狀態是
`null`（而非 `undefined`），必須註冊進 `OMIT_IF_NULL`，否則**每一行 index 都會多出
`"key":null`**。且該不變式明言「只把 entry 餵進 `buildIndexLine` 的測試抓不到 caller
omission」——importer 是一條獨立的 entry 建構路徑，斷言必須跑 importer 那條路徑，不是
只跑 `buildIndexLine`。

**修正 2：`isSubagent` 取自 `isSidechain`，不重新推論。**
transcript 每行都帶 `isSidechain: true`（抽樣 400/400），這是事實而非推論；讓 importer 走
既有的 subagent 推斷啟發式反而引入不必要的不確定性。

### 5b. 選擇原則（出自本 repo 已有的決策傳統）

| # | 原則 | 出處 |
|---|---|---|
| P1 | 存事實，view 用 derive | ADR 0013 |
| P2 | 去重鍵必須由上游指派，writer 不得自鑄 | ADR 0012（I-confluence） |
| P3 | 新來源的值不得塞進既有欄位的值空間 | ADR 0005 / 0018 |
| P4 | classification 讀 raw per-turn，display 才 fold | ADR 0013 |
| P5 | index 欄位 add-only、可由 log 重建 | ADR 0012 / 0013 |
| P6 | 用既存機制，不開第二條平行機制 | ADR 0005 / 0012 |

**P2 是決定性的**：`msg.id` 覆蓋率實測 100%（323,196/323,196），去重鍵已由 Anthropic
指派，A 免費得到 count-once，而 B 必須自鑄一個不存在的鍵。

一個不屬於技術原則、但決定 A vs D 權重的產品問題：**dashboard 要回答「我在 ccxray 底下跑
的工作」，還是「我所有的 agent 工作」？** 前者選 D，後者選 A。Owner 2026-08-20 選 A。

## 6. 未量測的部分（誠實邊界）

- **與 proxy 已錄副本的重疊率未量測**——需讀真實 `~/.ccxray/logs/index.ndjson`，本輪依環境安全規則未讀。這個數字決定 §4 的淨增與「本 issue 到底補回多少可見度」。Owner 已選定 A（§7），所以它現在是**實作前的前提**而非決策前的參考——見 §9.1。做法：把 subagent transcript 的 `message.id` 集合與 index 的 `responseId` 集合取交集。
- Option A 的 index 淨增只有上界估計，無實測。
- ~~`agentType` → `agent-classification.js` 鍵空間的映射完整性~~ — 依 §5a 修正 1，`agentType` **不**進 `agentKey`，此項不再適用（改為：新 add-only 欄位的值空間無須與 `agent-classification.js` 對齊）。
- 未評估 subagent entry 進 index 後對 swimlane lane 數（ADR 0008/0010）與 weather 的實際影響。
  受影響的 session 數本身也未知——上界 799（帶 subagent turn 的 parent session 總數），實際值
  是扣除已被 proxy 覆蓋者後的子集。
- **workflow 層（1,988 檔）的 `sessionId == parent` 未單獨抽樣**：400 檔抽樣只涵蓋 flat 層。
  實作讀行內 `obj.sessionId` 不依賴路徑深度，所以風險是「workflow 檔的該欄位語意可能不同」，
  而非路徑推導錯誤——但這一點沒有證據，需在實作時補驗。
- **語料在量測期間仍在增長**：兩次獨立掃描分別得到 798 與 799 個 parent session（同樣的篩選條件），差異來自量測期間本機仍有 subagent 在寫入。本檔一律採較新的 799；任何重跑得到 ±數個 session 屬正常，不是計算錯誤。

---

## 7. 決策狀態

**已決（owner，2026-08-20）**：採 **Option A**，含 §5a 兩項修正。

**仍待 owner**：

1. **範圍與 #546 的邊界**——#546 是 multi-provider cost attribution data model；A 是否應
   併入其資料模型而非獨立實作？
2. **無 `.meta.json` 的 3,739 檔（28%）的 `agentType` fallback**：留 null（消費端自行處理
   缺值），或從 parent transcript 的 `tool_use`／`meta.toolUseId` 反查？（注意：依 §5a
   修正 1，這裡問的**不是** `agentKey`。）
3. **一次性全史匯入是否可接受**（§4：無時間窗，70,417 turn 一次進），或需先設計分批窗口。
4. ~~修復型 issue 的生成需 owner 簽核~~ — **已完成**：owner 於 #565 留 `APPROVE-DESIGN 565A`，
   `approve-check.sh` 驗證通過（`by OWNER token=565A`，`--exclude-run` 防自簽仍生效），
   修復型 issue = #570。#565 的 body 未改（非經 owner 同意不動 issue body），故其
   `issue-lint` 仍為 fail；#570 另寫合規 body。

**follow-up（獨立於 A）**：
- `cost-worker.js:95` 同樣用檔名當 sessionId → 日聚合的 `sessionCount` 被假 session 膨脹
  （§5 Option C）。同根因、不同讀取路徑。
- `isFork` 離線校準腳本（§8）。

---

## 8. 附帶發現：本地 transcript 帶有 wire 上不存在的 fork 身分訊號

ADR 0008 / 0010 與 [#222](https://github.com/lis186/ccxray/issues/222) 反覆記載：fork 繼承 parent 的完整 system prompt、session_id、cwd、model、conversation prefix，**wire 上沒有任何欄位能區分 fork 與 parent**，因此 lane 歸屬只能靠時間重疊（ADR 0008）與 coreHash 多數投票（ADR 0010）推論，並接受已知誤判。

但本地 transcript 直接寫著：

- `.meta.json`：`isFork: true`（1,744 檔）、`spawnDepth`（0–3）、`parentAgentId`（218 檔，巢狀 spawn 樹）
- jsonl 第一行 `fork-context-ref`：`parentSessionId` ＋ `parentLastUuid`（fork 點）

這是 ADR 0008/0010 宣告不存在的那個身分訊號的**權威來源**（對已落地的 session 而言）。它不能替代即時分類（proxy 當下讀不到這些檔案），但可以作為：

1. **離線校準集**——用 `isFork` 當 ground truth，量測 ADR 0008 時間重疊與 ADR 0010 coreHash 投票的實際 precision/recall。這兩份 ADR 目前都只有「real-corpus residual 下降」這種相對指標，沒有絕對正確率。
2. **匯入時的直接標註**——走 Option A 時，imported entry 可直接帶 `isFork` / `spawnDepth`，不必經推論。

建議獨立開 issue 追蹤（校準腳本），不要混進本 issue 的匯入範圍。

---

## 9. 驗收條件（Option A）

1. **先量 proxy 副本重疊率**（§6 的未量測格）：subagent `message.id` 集合 ∩ index
   `responseId` 集合。它決定 index 真實淨增，也決定有多少 session 的畫面真的會變。需
   owner 授權讀真實 index。**這一項是其餘驗收的前提，不是可選項。**
2. **差異檢查（fail-on-old）**：合成 home 上舊碼 importer 產 1 行、新碼產 3 行，且三行的
   `responseId` 各自獨立、`sessionId` 皆為 parent。
3. **位移證據**：取 3 個 session（median 31 / p90 198 / max 5867 各一），記錄匯入前後的
   turn 數、cost、weather、lane 數，逐項說明位移為何正確。**這是 A 唯一真正的風險面**——
   受影響的 session（上界 799）顯示會同時改變，沒有 before/after 就無法區分「修好了」與
   「弄壞了」。若前置量測（§9.1）顯示受影響集合遠小於 799，取樣的三個 session 必須從
   **該子集**中取，不是從 799 全體。
4. **28% 無 meta 的 fallback** 需在測試覆蓋（不是只在文件寫）。
5. **`agentKey` 未被污染**：斷言匯入的 entry 其 `agentKey` 不含 `fork` /
   `general-purpose` / `Explore` / `workflow-subagent` 等 spawn-metadata 值（§5a 修正 1
   的機械化）。
