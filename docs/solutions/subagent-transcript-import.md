# Subagent / workflow transcript import — evidence and design options

TL;DR：subagent token/cost **並非「counted nowhere」**——`cost-worker.js` 的遞迴掃描早就把它們算進 Usage tab 且按各自 model 計價；真正的缺口只在 `importer.js`（index → dashboard）。而 issue 指定的「roll up 成 parent index line 的聚合欄位」會**打破**它援引的 count-once invariant，因為聚合值沒有 `responseId`，無法與 proxy 已錄的同一筆 subagent turn 去重。

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

抽樣 400 檔：`sessionId == 上兩層目錄名`（＝parent session id）**400/400**，`isSidechain: true` **400/400**，mismatch 0，missing 0。

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
- 觸及的 parent session：**798**
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

---

## 5. 修法選項

### Option A — 當普通 entry 匯入，歸屬 transcript 自報的 parent sessionId

- `collectJsonlFiles` 對 Claude 端改為遞迴（或加一個 subagents pass）
- `parseSessionFile` 的 sessionId 改取行內 `obj.sessionId`（fallback 才用檔名）
- `isSubagent: true` 由 `isSidechain` 直接得到（不需推論）
- `agentKey` / `agentLabel` 由 `.meta.json` 的 `agentType` 映射到 `agent-classification.js` 的鍵空間
- 每筆自帶 `responseId = message.id` → 去重與 merge 免費

**優點**：count-once 沿用現成機制；session 歸屬正確（不產生 13K 假 session）；lane / weather / cost confidence fold 全部沿用；per-model 計價天然正確。
**成本**：index 淨增（§4）；agentType→agentKey 映射需定義，且 28% 檔案無 meta；與 #507（`tsToId` 10ms 桶）交互——subagent 行密度高，碰撞風險需一併評估。

### Option B — issue 現在寫的 roll-up 聚合欄位

**優點**：index 行數不變。
**成本**：對 proxied session 雙計（§3）；新增聚合欄位必須併進 ADR 0017 的 confidence fold；dashboard 只多一個數字，subagent 仍不可見；未來要改成 A 時是破壞性 migration。

### Option C — 不動 importer，只修 Usage tab 的標示

cost 已正確計入，只是 `sid=agent-<id>` 這種 session id 對人無意義。若目標只是「帳對」，C 的成本近乎零。

**建議：A。** 它是唯一與 ADR 0012 相容的選項，且 §2 的實測顯示 issue 假設「必須 roll-up 才能避免開新 session」本身不成立。

---

## 6. 未量測的部分（誠實邊界）

- **與 proxy 已錄副本的重疊率未量測**——需讀真實 `~/.ccxray/logs/index.ndjson`，本輪依環境安全規則未讀。這個數字決定 §4 的淨增與「本 issue 到底補回多少可見度」，是 owner 決策前**最該補**的一格。owner 可自行跑：把 subagent transcript 的 `message.id` 集合與 index 的 `responseId` 集合取交集。
- Option A 的 index 淨增只有上界估計，無實測。
- `agentType` → `agent-classification.js` 鍵空間的映射完整性未逐一比對。
- 未評估 subagent entry 進 index 後對 swimlane lane 數（ADR 0008/0010）與 weather 的實際影響——798 個 session 的 lane 結構會改變。

---

## 7. 待 owner 決策

1. **A / B / C 三選一**（建議 A）。
2. **範圍與 #546 的邊界**——#546 是 multi-provider cost attribution data model；本 issue 若走 A，是否應併入其資料模型而非獨立實作？
3. **無 `.meta.json` 的 3,739 檔（28%）**：`agentKey` 用什麼？`unknown`（走 ADR 0005 的 `AGENT_KEY_UNRELIABLE` fallback）還是從 parent 的 `tool_use` 反查 `toolUseId`？
4. **issue body 需重寫**——`issue-lint.sh 565` 目前 `RESULT|fail`（缺 `Blocked-by:`、無可驗收訊號），且 Problem statement 的事實前提須依 §1 更正後才可派工。

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
