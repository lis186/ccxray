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
- [x] Phase 7: Integration tests — done (2 new test files, 7 test cases). WS frame→buildMergedSteps pipeline, 1.9.x provider compat, summarizeEntry fallback. G11-G13 deferred (不 block release).
- [ ] Phase 8: Cleanup + release — **next**

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
- WS entry tokens/perMessage: WS req 是 transport-only → 無法
- 精確 OpenAI token count: 需 tiktoken dependency → 不加，用 Claude tokenizer 近似（±15%）
- extractOpenAIToolCalls: 缺帶 tool call 的 Codex response fixture → defer

### 不可行或 defer

- thinkingDuration: wire format 不暴露 → 留 null
- apply_patch diff 渲染: unified diff 解析脆弱 → defer
- WS entry tokens: WS req 是 transport-only → 無法
- 精確 OpenAI token count: 需 tiktoken dependency → 不加，用 ±15% 近似
- extractOpenAIToolCalls: 缺帶 tool call 的 fixture → defer

## 立刻接續時的第一步

1. `git log --oneline main..HEAD | head` 確認 branch 狀態
2. 讀這份 handoff + `openspec/changes/2026-05-29-dashboard-agent-abstraction/design.md`
3. 繼續下一個未完成的 Phase
4. **用 `--port 5579` + `CCXRAY_HOME=/tmp/test` 做隔離 smoke test**
