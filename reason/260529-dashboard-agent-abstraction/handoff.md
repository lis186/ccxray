# Dashboard Agent Abstraction — Handoff

**目的**：把 ccxray 從「只懂 Claude」抽象到「per-provider strategy registry」，讓 codex（與未來 Gemini 等）都能在 dashboard 上完整呈現，而不是各處 `if (provider === ...)` 散落分支。

**現況**：brainstorming 進行中（superpowers:brainstorming skill flow），已在第 §1/5 design section 等使用者批准。新對話應該接著從 §2 開始。

---

## Locked decisions（不要再回頭翻）

### D1：三個獨立 server-side registry + 一個 client-side registry

對應 launcher pattern（已驗證有效）：

| Registry | 位置 | 已有？ | 職責 |
|---|---|---|---|
| `UPSTREAMS` | `server/config.js` | ✓ | where to forward（routing target per provider） |
| `AGENT_PROVIDERS` | `server/providers.js` | ✓ | how to spawn the CLI per agent |
| `WIRE_PARSERS` | `server/wire-parsers/` | **新增** | how to read disk + dedup + emit normalized + classify noise per provider |
| `RENDERERS` | `public/renderers/` | **新增** | how to render detail timeline per provider |

新增 provider = 對應 registry 各加一筆，0 個 `if-else` 散落分支。

---

### D2：β' — disk 留 provider-native + 保留 dedup，read 時 normalize

關鍵 framing：**「省 disk（dedup）」與「render 統一」是兩件不同的事**。前者必須在 write 時做（hash + delta-log，省 85-90% disk per CLAUDE.md），後者可在 read 時做且更乾淨。

- Disk：每個 provider 保留它原本的 wire shape，但**大型 shared 部分按 hash 抽出去**（Anthropic 的 `sys_${hash}.json` / OpenAI 的 `openai_instructions_${hash}.json` 等已存在；OpenAI 端可能要再補 `tools` 等其他可 dedup 的部分）+ delta-log 跨 turn（如 Anthropic 已有）
- Read：`WIRE_PARSERS[provider].normalize(rawEntry)` 處理 dedup 還原 + 提取 thin canonical metadata + 把 detail data 餵給對應 renderer

---

### D3：per-provider hash space

`sys_${hash}.json` 跟 `openai_instructions_${hash}.json` 各自 namespace，**不**跨 provider 共享。維持現狀。

---

### D4：選項 e — thin canonical + per-provider detail renderers

對應 UX 的真實雙層：

- **List layer**（Miller columns 的 Projects / Sessions / Turns 列表）：純 cross-provider 的薄殼 metadata — `{sessionId, model, msgCount, toolCount, usage, agentType, agentLabel, provider, ...}`。已存在於 `index.ndjson`，只需要 formalize 成正式合約
- **Detail layer**（Timeline 右側 turn 內容）：per-provider，`RENDERERS[session.provider].renderTimeline(entries)`

**為什麼不選 a（強推 Anthropic shape canonical）**：因為強迫 codex 的 `function_call_output` 等塞進 Anthropic 4 種 block 是 lossy 假抽象；e 對齊 UX 真實分層、最大化 fidelity。

---

### D5：兩條獨立 dispatch axis — `provider` vs `agent`

之前混用、結果靠 launcher 與 carve-out 設計才意識到要拆：

| 軸 | 由什麼決定 | 誰用 | 存哪 |
|---|---|---|---|
| **`provider`**（wire format） | `config.getUpstreamForRequestAndHeaders(req.url, req.headers).provider` | `WIRE_PARSERS`、`RENDERERS`、cost-worker、restore 都用此 dispatch | `entry.provider`（每筆）+ `sessionMeta[sid].provider`（每 session，immutable from first entry） |
| **`agent`**（CLI / persona） | system prompt 分類（Claude 走 B2 → KNOWN_AGENTS、OpenAI 走 header / B2） | UI label / Sessions 列名稱 / System Prompt panel | `sessionMeta[sid].agentType` + `agentLabel`（已有，formalize） |

今天的對應：Claude Code agent ↔ Anthropic provider；Codex CLI agent ↔ OpenAI provider。未來不一定（codex on gemini？claude SDK 自寫 CLI？），這個拆法讓兩軸獨立演化。

---

### D6：Session-immutable provider

一個 session 的 provider 由首個 entry 決定，後續 entries 強制同 provider。中途切換（user 在 codex 裡 `/model` 換 Anthropic 之類）**延後討論**，spec 寫進 open question / future considerations 即可，當下實作假設不會發生。

---

## §1 已經 present（等使用者批准）

Architecture 鳥瞰圖（4 registry + disk + dispatch keys 對照表）。要在新對話再 present 一次然後拿 approval 才往下。

---

## 待討論的 design sections（§2 - §5 + spec writing）

### §2 Components — 每個 registry/interface 的細節
- `WIRE_PARSERS[provider]` interface 該有哪些方法？候選：
  - `dedupExtract(parsedBody) → { sysHash?, instructionsHash?, toolsHash?, ... }`
  - `extractDeltaSlice(prev, curr) → { prevId?, msgOffset?, deltaSlice? }`
  - `normalizeListMeta(rawReq, rawRes) → { sessionId, model, msgCount, toolCount, usage, agentType, ... }`（thin canonical for list layer）
  - `isNoiseRequest(req, headers, body) → boolean`（取代散在 config.js 的 `isCodexPlatformNoisePath`、補 codex MCP RPC noise 過濾）
  - `parseStreamingResponse() → stateful parser`（feed chunks, emit events）
  - `extractAgentType(systemBlob) → { key, label }`（取代散在 system-prompt.js 的 if-else）
- `RENDERERS[provider]` interface：怎麼拆？一個大 function 還是組合小 block-type components（`<TextBlock>`/`<ToolCall>`/...）？
- 取 thin canonical 出來的方法是放 `WIRE_PARSERS` 還是另外抽？

### §3 Data flow — 從 wire 到 dashboard 的完整路徑
- 流程順序：proxy 接 request → `getUpstream...` → `WIRE_PARSERS[p].dedupExtract` + `extractDeltaSlice` → 寫 `_req.json` → forward → 收 response → `WIRE_PARSERS[p].parseStreamingResponse` → 寫 `_res.json` + 更新 `index.ndjson` row → SSE broadcast list-level metadata → client list refresh
- 詳情點擊時：client `GET /_api/entries/<id>` → server 走 `WIRE_PARSERS[p].normalize(...)` → 回傳 provider-native data + thin canonical → client 看 `provider` 選 `RENDERERS[p].renderTimeline(...)`
- 邊界討論：是 server 還 client 拿原始 data 比較好？

### §4 Error handling
- WIRE_PARSERS 對「形狀不符預期」的 graceful degrade（e.g. 新版 codex 改變 response event shape）
- index.ndjson 缺 `provider` 欄位的舊資料（1.9.x 寫的）怎麼處理 → infer 還是標 `unknown`？
- RENDERERS 對 `RENDERERS[provider]` 不存在（未來 provider 還沒做完）的 fallback

### §5 Testing strategy
- Fixture-driven：每個 WIRE_PARSER 都有對應的真實 wire dump fixture（從 `~/.ccxray/logs/` 拿、或專門錄）
- normalize 的 unit test 對 fixture 斷言
- e2e：跑真的 `ccxray <agent>`，比對 dashboard 拿到的 list/detail 跟預期
- 不能 mock 掉的部分：dedup correctness 對 disk 大小、跨 turn delta-log 正確性

---

## 之後的流程（brainstorming skill 規定）

| Step | 動作 | 狀態 |
|---|---|---|
| B5 §1 | Architecture 已 present | **等批准** |
| B5 §2-§5 | 逐段 present + 拿 approval | 待做 |
| B6 | Write design doc → `openspec/changes/2026-05-29-dashboard-agent-abstraction/{proposal,design,tasks}.md` | 待做 |
| B7 | Spec self-review（placeholder / consistency / scope / ambiguity） | 待做 |
| B8 | User 看 spec、approve 才能往下 | 待做 |
| B9 | Invoke `superpowers:writing-plans` 寫 implementation plan | 待做 |

**B9 之前完全不能寫 production code。** 這是 brainstorming skill 的 HARD-GATE。

---

## Broader project context（給新 session 接 context）

- **Branch**: `feat/two-domain-auth`（從 `feat/auth-phase-2` 改名、15 commit 過 main、未 push 給外部、版本 `1.10.0`）
- **1.10.0 release blocked**：使用者選 path B（必須做完 codex dashboard 體驗才能 ship）。這個 abstraction 就是「path B 的正確做法」（取代之前 `openspec/changes/2026-05-28-codex-dashboard-parity/` 那條直接補 codex 的路）
- **舊 scaffold 怎麼辦**：`openspec/changes/2026-05-28-codex-dashboard-parity/` 是用「只做 codex」的 framing 寫的。它的 tasks（session detection、body shape、MCP noise 等）都對應到這個新 abstraction 的 WIRE_PARSERS 方法。新 abstraction 落地時，舊 scaffold 可以：
  - 直接用 abstraction 取代（archive 它）
  - 或留著當「codex 那條的具體 instance」、新的 abstraction 是「framework」
  - 等 §B6 寫新 spec 時一起決定
- **Dev hub on port 5577**：使用者的 `npm run dev` 一直在跑、監聽其他 Claude session、PID 88041。**不要動它**，會破壞使用者其他工作流。要試新 provider 用 `ccxray --port 5578` 之類獨立 port
- **`ccxray` 已 npm link**：`/Users/justinlee/.local/share/mise/installs/node/22.22.2/lib/node_modules/ccxray/server/index.js` → `/Users/justinlee/dev/ccxray/server/index.js`，全域 `ccxray` 指這條 branch 的程式碼

---

## 進度

- [x] B5 §1 Architecture — 批准
- [x] B5 §2-§5 — 全部 present + 批准
- [x] B6 Design doc — `openspec/changes/2026-05-29-dashboard-agent-abstraction/` (proposal, design, tasks)
- [x] B7 Spec self-review — 3 issues fixed (phase numbering, ThinCanonical fields, detectSession delegation)
- [x] B8 User approve spec — 批准
- [x] B9 Implementation plan — 批准，存在 `~/.claude-personal/plans/radiant-squishing-lake.md`
- [x] Phase 0: Fixtures — done (commit `docs(wire-parsers): spec + fixtures`)
- [x] Phase 1: WIRE_PARSERS scaffold + Anthropic impl — done (commit `feat(wire-parsers): scaffold registry + anthropic`)
- [x] Phase 2: OpenAI WIRE_PARSER impl — done (commit `feat(wire-parsers): openai implementation + codex 5-issue fix`)
- [x] Phase 3: index.js wire-up — done (4 commits: noise, preprocess+session, usage, cleanup). Conservative approach: only dispatched clean boundaries (noise/session/usage/preprocess), kept dedup+delta inline. First attempt failed (safeCall hiding bugs + dedupExtract return value too complex + detectOpenAISession 2/3 param mismatch), reset and redone.
- [x] Phase 4: RENDERERS scaffold — processEvent() dispatch. Phase 5 (OpenAI renderer) absorbed.
- [x] Phase 4b: Cleanup — 刪 dead code + 刪 openai-session.js。done。
- [x] Phase 5: WS frame capture — 27 行改動。done。
- [x] Phase 6: Codex parity gaps — G1-G10 done (2 commits, 57 行)。HTTP SSE + WS entries 完整 metadata（cost/tokens/maxContext/model）。OpenAI pricing rates。Codex tool aliases。
- [x] Phase 7: Integration tests — done (2 new test files, 7 test cases). WS frame→buildMergedSteps pipeline, 1.9.x provider compat, summarizeEntry fallback.
- [x] Phase 7b: G11 provider badge + G13 perMessage tokens — committed (4788ab9), then user manually reverted G11/G13 + cleaned up setCwdFallback + simplified version index. **6 files with uncommitted cleanup changes.**
- [x] Phase 7c: WS cwd fix — committed (3b0b691), WS sessions inherit cwd from Codex workspaces metadata.
- [x] Phase 8: Comprehensive UI audit — done (see below)
- [x] Phase 8a: WS content capture — **committed** (fea830c). ws-proxy.js +67行, test +95行
- [x] Phase 8b: buildMergedSteps OpenAI support — **committed** (4e83ee8). normalizeOpenAIInput() + miller-columns 4 call sites + 4 TDD tests, 694/694 pass
- [x] Lazy-load fix — **未 commit**。4 個 root causes（見「已修復」段落）。cross-cutting：`addEntry` 存 `provider` 讓後續 8c-8f 的 renderer selection 正確運作
- [ ] Phase 8c: perMessage token breakdown — Minimap per-item bars
- [ ] Phase 8d: extractToolCalls OpenAI — Tool chips
- [ ] Phase 8e: WS_SKIP_EVENTS 修復 — 5 行，獨立可平行
- [ ] Phase 8f: System Prompt UI OpenAI — 版本歷史 + diff

## Phase 8 結果：UI Audit

### 方法

Workflow（37 agents, 2.7M tokens）→ 5 個平行 audit agent 讀取完整 codebase → 30 個 research agent 做方案設計 → adversarial review workflow（10 agents, 1.3M tokens）做二審。

### 發現

| 指標 | 原始 | Adversarial 修正後 |
|------|------|-------------------|
| 資料項目 | 123 | 123 |
| 缺口 | 91 | **44 真實缺口** |
| 假缺口 | — | 31（功能已正常運作） |
| 方案正確 | 94 | **29** |
| 方案有誤 | — | 46（主因：忽略 WS 空殼前提、API 格式搞錯） |

### 6 個根因（佔 80%+ 缺口）

1. **WS 請求內容未捕獲**（critical）— `ws-proxy.js` 不儲存 `response.create` frame 內容 → req 是空殼
2. **buildMergedSteps 只理解 Anthropic**（critical）— `messages.js` Phase 2/3 期望 `type:text/thinking/tool_use/tool_result`
3. **perMessage token 只支援 Anthropic**（critical）— `helpers.js tokenizeRequest()` 對 `body.input` 只算 total
4. **extractToolCalls 只掃 Anthropic blocks**（critical）— 不理解 OpenAI `function_call`
5. **System Prompt UI 假設 Anthropic 格式**（major）— B2 splitting、loadB2、版本追蹤
6. **WS_SKIP_EVENTS 丟棄 response.completed**（major）— 失去完整 usage data

### Adversarial review 三大系統性問題

1. **方案忽略 WS content capture 前置依賴** — 大量方案假設 `req.messages` / `req.input` 存在，但 WS entries 根本沒有
2. **「下游修復 / 0 行改動」的誤判** — 很多「已被上游解決」的說法是錯的
3. **Responses API vs Chat Completions API 混淆** — Codex 用 `type:function_call_output` + `call_id`，不是 `role:tool` + `tool_call_id`

### 依賴鏈（實施順序）

```
Phase 8a ✅ WS content capture
  ├→ Phase 8b ✅ buildMergedSteps OpenAI support
  │    └→ Lazy-load fix ✅ (未commit) ← addEntry 存 provider，解鎖正確 renderer selection
  ├→ Phase 8c: perMessage token breakdown       ← Minimap per-item bars
  ├→ Phase 8d: extractToolCalls OpenAI          ← Tool chips
  └→ Phase 8f: System Prompt UI OpenAI          ← 版本歷史 + diff
Phase 8e: WS_SKIP_EVENTS 修復                   ← 獨立，不依賴 8a
```

### 報告

- HTML: `reason/260531-codex-ui-audit/report.html`（含截圖、完整清單、adversarial review）
- 原始資料: `/tmp/ccxray-audit-results.json`、`/tmp/ccxray-adversarial-reviews.json`

## Phase 8a: WS Content Capture（第一張骨牌）

### 決策

方案 B（structured frame classifier），加修正後的 type-specific guard。

研究過程：3 個 architect agent（Minimal / Structured / Skeptic）做 judge panel，讀完整 ws-proxy.js + fixtures。

### Skeptic 關鍵確認

- `response.completed` **不含 input** → 沒有替代方案，必須 parse `response.create`
- Performance 無風險（1 frame/turn，upstream handler 已用相同 pattern）
- Memory 可接受（與 HTTP entries 相同成本）
- WS library 處理 frame reassembly，`message` event 是完整訊息

### 改動範圍

**單一檔案 `server/ws-proxy.js`，~30 行**

1. ctx 加 `clientRequest: null`
2. `clientWs.on('message')` 加 `JSON.parse` + `parsed.type` dispatch（mirror upstream handler pattern）
   - `response.create`：first-wins capture（model, instructions, input, tools）
   - `session.update`：更新 instructions（Realtime API forward compat，2 行）
3. `recordWebSocketEntry` reqLog 建構：有 `clientRequest` → 完整 reqLog，沒有 → 現有 fallback
4. entry fields 計算：`tokens = tokenizeRequest(reqLog)`、`msgCount`、`toolCount`
5. 記憶體釋放：`ctx.clientRequest = null`

### 此改動解鎖 / 不解鎖

| ✅ 解鎖 | ❌ 不解鎖（下一步） |
|---------|-------------------|
| `_req.json` 有完整內容 | Timeline 仍 "No messages"（需 8b） |
| `entry.tokens` 有 breakdown | perMessage minimap bars（需 8c） |
| Context bar 有 system/tools/messages 分段 | Tool chips（需 8d） |
| `entry.msgCount` / `toolCount` 正確 | System Prompt 版本追蹤（需 8f） |

### 狀態：DONE，已 commit（fea830c）

3 files changed, +243 -40：
- `server/ws-proxy.js` — frame capture 邏輯（+67 行）
- `test/websocket-proxy.test.js` — 2 個新 e2e test（+95 行）
- `handoff.md` — 更新

測試證據：
- `npm test` 690/690 pass（+2 新測試）
- 新測試 1：`captures response.create frame content` — 驗證 _req.json 有 provider/model/instructions/input/tools、capture 不是 transport-only、msgCount=1、toolCount=2
- 新測試 2：`falls back to transport-only` — 驗證非 JSON frame 仍 fallback 到舊行為
- Backward compat：舊 WS entries（port 5600, /tmp/ccxray-audit）正確 restore，dashboard 無 regression

### Plan 檔案

`~/.claude-personal/plans/sorted-shimmying-river.md`

---

## Phase 8b-8f: 剩餘缺口清單

### 8b: buildMergedSteps OpenAI support — ✅ DONE (4e83ee8)

`normalizeOpenAIInput()` adapter + `req.messages || req.input` fallback（4 call sites）+ 4 TDD tests。

**已知限制**：`codex exec` single-turn session 的 `response.create` frame 裡 `input: []` 是空的（Codex 不在 input 裡放歷史），Timeline 只靠 `res` events（response.output_text.delta）渲染 response text。Multi-turn session 需要進一步驗證 `input` 是否有歷史 messages。

### 8c: perMessage token breakdown（critical，~25 行）

**問題**：`helpers.js tokenizeRequest()` 對 `body.input` 只做 `JSON.stringify` 算 total（line 263-264），不生成 `perMessage` array。Minimap 需要 per-item breakdown。

**解法方向**：在 `body.input` branch 加 per-item iteration，生成 `perMessage` array（同 `body.messages` path 的結構）。
- **Adversarial review 評分**：原始 9 → **修正 7**
- **修正原因**：OpenAI input items 用 `type:input_text`（非 `type:text`）、`type:function_call_output`（非 `type:tool_result`）
- **前置依賴**：Phase 8a（已完成）
- **注意**：OpenAI input item 的 content 可以是 string 或 `[{type:input_text, text}]` array

### 8d: extractToolCalls OpenAI（critical，~30 行）

**問題**：`helpers.js extractToolCalls()` 只掃 `messages[].content` 裡的 `type:tool_use`。OpenAI 用 Responses API format：`function_call` output items（在 response 裡，不在 request 裡）。

**解法方向**：從 response events（`ctx.responseEvents`）提取 `function_call` items，用 `call_id` 配對 `function_call_output`。
- **Adversarial review 評分**：原始 9 → **修正 7**
- **修正原因**：方案描述的是 Chat Completions format（`role:tool` + `tool_call_id`），Codex 實際用 Responses API（`function_call_output` + `call_id`）
- **注意**：`CODEX_TOOL_ALIASES` 在 `public/messages.js:135` 是 client-side only，server-side `extractToolCalls` 需要自己的 alias mapping

### 8e: WS_SKIP_EVENTS 修復（major，~5 行）

**問題**：`ws-proxy.js` line 21-24 的 `WS_SKIP_EVENTS` 過濾掉 `response.completed`，但此事件包含完整 usage data。

**解法方向**：從 skip set 移除 `response.completed`。
- **Adversarial review 評分**：原始 9 → **修正 7**
- **修正原因**：reviewer 發現 usage extraction 在 line 450-452 已在 skip filter 之前執行，所以 usage/cost 已被捕獲。移除 `response.completed` 的主要價值是保留完整 response object 給 timeline rendering，不是修 usage。
- **風險**：`response.completed` ~35KB（含 instructions + tools），增加 log 大小
- **獨立改動**，不依賴其他 phase

### 8f: System Prompt UI OpenAI（major，~60 行）

**問題**：
- `registerPromptVersion()` 需要處理 `body.instructions`（string）而非 `body.system`（array）
- `loadB2()` 讀 `body.system[2].text`（Anthropic-only）
- `splitB2IntoBlocks()` 用 Anthropic cache_control 標記
- 有 server-side copy（`server/system-prompt.js`）+ client-side copy（`public/miller-columns.js:80`）

**解法方向**：各函數加 OpenAI format detection branch。
- **Adversarial review 評分**：8→7（多數 reviewer 認為方向正確但忽略了 client-side copy）
- **前置依賴**：Phase 8a（已完成）

### 其他真實缺口（較低優先）

| # | 缺口 | 嚴重度 | 修正分 | 方案正確？ | 說明 |
|---|------|--------|--------|-----------|------|
| G1 | WS response event persistence | minor | 8 | ✅ | usage 已在 skip filter 前捕獲，此修復的價值是保留完整 response object 給 timeline |
| G2 | usage cache fields | minor | 8 | ✅ | OpenAI 無 cache fields → 顯式設 0（clean data hygiene）|
| G3 | Cache read/write display | minor | 7 | ✅ | Turn-level 已正確隱藏，scorecard hover 需 provider check |
| G4 | Session total tokens | minor | 7 | ✅ | Usage extraction works，真正問題是 per-entry token breakdown（Phase 8c 解決） |
| G5 | Context MCP section | minor | 8 | ⚠️ | Codex 不用 `mcp__` naming。且有 3 個 meta-tool（tool_search/web_search/image_generation）沒有 `.name` → `.name.startsWith` crash。**lazy-load fix 已加 guard（3 處）** |
| G6 | Raw Request section | minor | 9 | ✅ | 純下游 — Phase 8a 完成後自動解決 |
| G7 | OpenAI renderer processEvent | minor | 8 | ✅ | 需 audit 所有 event types，確保 switch/case 覆蓋完整 |
| G8 | WS entry normalize (restore) | major | 8 | ✅ | `loadEntryReqRes` 需處理 WS format，依賴 8a + 8e |
| G9 | Turn cache percentage | minor | 5 | ❌ | 方案說「已被處理」是錯的。`entry-rendering.js:298-301` 需 provider check |
| G10 | Cost analysis page | minor | 7 | ❌ | `cost-worker.js` 只掃 `~/.claude/projects/` JSONL → Codex data 不在那 |
| G11 | Quota ticker | minor | 7 | ❌ | 真正改動在 server-side `ratelimit-log.js`，不只是 `quota-ticker.js` |
| G12 | Events section (Raw) | minor | 8 | ❌ | 需確保 restored WS entries 的 `e.res` 是 array 格式 |
| G13 | delta-log for WS | minor | 6 | ❌ | 目前 WS req ~200B，Phase 8a 後變 35-65KB → 未來考慮 |
| G14 | Intercept UI for WS | minor | 7 | ❌ | WS 攔截架構根本不同 → document limitation |
| G15 | Context Core section | minor | 6 | ❌ | `CODEX_TOOL_ALIASES` 是 client-side only，`categorizeTools` 需自己的 mapping |
| G16 | Cost Efficiency analysis | minor | 7 | ❌ | cache hit rate section 用 Anthropic-specific fields |

### 已確認假缺口（不需要修）

Adversarial review 確認 31 個假缺口，主要類別：
- Session metadata（model、cost、tokens、duration）— 已正常運作
- Agent detection — KNOWN_AGENTS 已有 Codex entries
- Cost display — pricing.js 已有 OpenAI rates
- Cache-related displays — 已正確隱藏/顯示 0

### 已確認不可行 / defer

- thinkingDuration: OpenAI 不暴露 reasoning timestamp → 留 null，UI 顯示 N/A
- apply_patch diff: unified diff 解析脆弱 → defer
- Intercept UI for WS: frame-level interception 根本架構不同 → defer，先 document limitation
- delta-log for WS: 目前 1-conn=1-entry，delta 無意義 → 等 per-turn splitting（Phase 2 concern）
- 精確 OpenAI token count: 需 tiktoken → 不加，用 ±15% 近似

---

## Phase 6 完成明細

G1-G9（呼叫已有函數）+ G10（tool aliases）已 commit。

### Deferred to Phase 7 (polish, 不 block release)

| # | 項目 | 行數 | 說明 |
|---|------|------|------|
| G11 | system prompt UI provider badge | ~30 | backend 已在運作，只缺 UI filter/badge |
| G12 | analyzeContext enrichment | ~20 | context breakdown bar for OpenAI（目前只有 byte count） |
| G13 | perMessage tokens for minimap | ~30 | 解析 input[] per-item（minimap 目前對 Codex 空的）|

### 不可行 / 已確認 defer

- thinkingDuration: OpenAI wire format 不暴露 reasoning timestamp → 留 null
- apply_patch diff 渲染: unified diff 解析脆弱 → defer
- ~~WS entry tokens/perMessage: WS req 是 transport-only → 無法~~ → **Phase 8a 解決**（capture response.create frame）
- 精確 OpenAI token count: 需 tiktoken dependency → 不加，用 Claude tokenizer 近似（±15%）
- extractOpenAIToolCalls: Phase 8d 處理（Responses API format：`function_call_output` + `call_id`，非 Chat Completions format）

## 進度（2026-06-02 更新）

```
8a ✅ → 8b ✅ → lazy-load fix ✅ → 8e ✅ → 8d ✅ → 8c ✅ → 8f ✅
全部 Phase 8 完成 + Codex review 3 rounds + regression tests + dual-provider e2e 驗證
```

### 已完成（2026-06-01 ~ 06-02）

- **Phase 8e**: `WS_SKIP_EVENTS` 調整（response.completed/done 回到 skip set — usage/model 在 filter 前提取）
- **Phase 8d**: `extractOpenAIToolCalls()` + server-side `OPENAI_TOOL_ALIASES`，tool chips 在 dashboard 顯示
- **Phase 8c**: `tokenizeRequest` OpenAI input branch — perMessage breakdown（含 string content + no-type items 支援）
- **Phase 8f**: System section fallback `req.system || req.instructions`
- **CWD fix**: `getWorkspaceCwd()` 支援 Codex workspaces key-is-path 格式
- **generate:false fix**: warm-up frame 搶先設定 `ctx.clientRequest` 導致 `input=[]`。1 行 guard 修復
- **function_call normalization**: `normalizeOpenAIInput` 支援 `function_call` items → assistant `tool_use` blocks + `isOpenAIInput()` detection
- **HTTP OpenAI toolCalls**: SSE path 用 `events`（非 `ctx.resData`），non-SSE path 用 `openAIEvents || response.output`
- **Resume button**: `sess.agent`（`'claude'`/`'codex'`）驅動 resume 指令，codex-raw 隱藏 copy button
- **Wire Protocol Reference**: `docs/wire-protocol-reference.md` Part 1 完成（186 行，6 sections，confidence tags）
- **Regression tests**: `extractOpenAIToolCalls` unit tests + forward-path e2e tests（SSE text/event-stream + non-SSE JSON）— Codex reviewer 3 rounds 確認覆蓋
- **Dual-provider e2e 驗證**：同一 smoke server 同時跑 Claude + Codex 流量，browser-harness 截圖確認兩個 session 都正確顯示，無 regression

### 教訓

- **generate:false warm-up bug**: 觀察到 `input=[]` 就假設是協議限制，寫了 backfill workaround。Workflow review 發現真因是 warm-up frame 覆蓋。1 行 fix 取代 34 行 workaround。**教訓：異常值先驗證 root cause，不要直接寫 workaround。**
- **forward.js variable naming**: SSE path 用了不存在的 `ctx.resData`，non-SSE path 傳 `[]`。Reviewer 抓到。**教訓：integration test 比 unit test 重要 — unit test 不測 wiring。**
- **mock Content-Type**: SSE regression test 用 `application/json` 不走 `handleOpenAISSE`。Reviewer 抓到。**教訓：mock 的 header 必須匹配真實 dispatch 條件。**

### Wire Protocol Doc — ✅ Done（38 findings fixed）

Workflow-driven audit（6 parallel agents）cross-checked every doc claim against codebase。找到 38 個 findings（13 major + 25 minor），全部修正。Codex reviewer 2 rounds 通過。

詳見 `docs/wire-protocol-reference.md` changelog（2026-06-02 entry）。

### Codex Cache Display Bug — ✅ Fixed

驗證 dashboard 時發現 Codex session cache 顯示 0% 但實際 hit rate 99%。

**Root cause**：
1. `wire-parsers/openai.js:extractUsage` 只提取 `input_tokens` / `output_tokens` / `total_tokens`，丟掉 `input_tokens_details.cached_tokens`
2. `ws-proxy.js` 直接存 raw usage 繞過 `extractUsage`

**Fix（provider pattern — option B: thin canonical）**：
- `extractUsage` 輸出 canonical `cache_read_input_tokens`（同 Anthropic 欄位名）+ 保留 native `input_tokens_details`
- `ws-proxy.js` WS usage 通過 `extractOpenAIUsage` normalize

**驗證**：browser-harness 確認 Codex turn card 從 `cache:0%` 變為 `cache:17%`。

### 下一步

1. 1.10.0 release blocker 確認
2. Part 2: ccxray Normalization Map
3. Part 3: Explanation & War Stories

### 驗證方式（所有 phase 通用）

```bash
# 1. 啟動隔離 server
CCXRAY_HOME=/tmp/ccxray-smoke-$$ CCXRAY_LOOPBACK_NO_AUTH=1 \
  node server/index.js --port 5602 --no-browser

# 2. 產生真實 Codex 流量（不要用 JS 注入假資料）
codex exec -c 'openai_base_url="http://localhost:5602/v1"' "Say hello"

# 3. browser-harness 開 dashboard 驗證
browser-harness -c 'new_tab("http://localhost:5602/"); ...'
```

### 已修復：Lazy-load timing → Timeline 卡 "Loading..."

Phase 8b e2e 驗證時發現：選中 Codex turn 後 Timeline 永久卡在 "⏳ Loading…"。

**Root cause（4 個問題，用真實 `codex exec` 流量驗證）：**

1. **`renderSectionsCol` crash（直接原因）**：Codex 的 `tool_search` / `web_search` / `image_generation` 沒有 `.name` 屬性 → `t.name.startsWith('mcp__')` throws TypeError → 整個 RAF callback abort → `renderDetailCol()` 永遠不被呼叫。RAF 裡的 uncaught error 不會出現在 console。
2. **`addEntry` 沒存 `provider`**：SSE broadcast 有送 `provider: 'openai'`，但 `addEntry` 的 `allEntries.push({...})` 漏存 → `e.provider` 永遠 `undefined` → fallback 到 `'anthropic'` renderer → 不認得 `response.output_text.delta` events → 0 steps。
3. **`scheduleRender` coalesce guard race**（防禦性修復）：`if (_renderDirty) return` 可能吃掉 prefetch 完成的 render 請求。改為 cancel-and-requeue。
4. **`renderSectionsCol` preview badge** 沒用 `req.input` fallback → OpenAI entries 的 Timeline badge 永遠空白。

**修復（未 commit，等確認）：**
- `public/miller-columns.js`：`t.name &&` guard（3 處）、`scheduleRender` cancel-and-requeue、`getCachedSteps` 加 `req.input` fallback + `provider` 參數
- `public/entry-rendering.js`：`addEntry` 存 `provider`

**驗證方式：**
用 `codex exec -c 'openai_base_url="http://localhost:5602/v1"' "Say hello"` 產生真實流量，browser-harness 開 dashboard 確認 Timeline 從 "⏳ Loading…" 變成正確顯示 response text。

**教訓：**
- 「函式沒被呼叫」→ 先在 caller 加 try-catch，不要理論推導 scheduling race（5 分鐘 vs 30 輪）
- Smoke test 必須用真實 provider 流量，不要 JS 注入假 entry（假資料不暴露格式不符）
- Codex 有 3 個 meta-tool 沒有 `.name`（tool_search、web_search、image_generation）→ 所有遍歷 `req.tools` 的地方都要 `t.name &&` guard
