# Design: Dashboard Agent Abstraction

## Context

ccxray proxy 支援兩個 upstream provider（Anthropic、OpenAI），對應兩個 agent launcher（Claude Code、Codex）。啟動和路由已有 registry pattern（`UPSTREAMS` in config.js、`AGENT_PROVIDERS` in providers.js），但 **從 wire 到 dashboard 的整條路徑** 仍是 if-else 散落。

現有 provider-specific 邏輯分佈：

| 邏輯 | 散在哪 |
|------|--------|
| session detection | `store.js` (Anthropic) + `openai-session.js` (OpenAI) + `index.js` 切換 |
| dedup/hash | `index.js` L285-322 兩段 if-else |
| delta-log | `index.js` L324-357 Anthropic-only |
| noise filter | `config.js` `isCodexPlatformNoisePath` |
| usage extraction | `helpers.js` `extractUsage` (Anthropic) + `forward.js` inline (OpenAI) |
| agent classification | `system-prompt.js` `extractAgentType` (Anthropic) + `extractPromptAgentType` (OpenAI) |
| detail rendering | `messages.js` Anthropic-only |

## Goals

1. 新增 provider = WIRE_PARSERS + RENDERERS 各加一筆；dedup/delta/version-detection 仍需在 index.js 加對應 provider branch
2. Codex dashboard 五個已知問題（session name, model, tokens, messages, MCP noise）透過 OpenAI registry 實作解決
3. 保持 disk format 向後相容（1.9.x 寫的 log 仍可讀）
4. Proxy forwarding 不因 parser 失敗而中斷

## Non-Goals

- 不做跨 provider 的 canonical wire format（D4 已否決：lossy 假抽象）
- 不做 streaming transport 統一（SSE vs WebSocket lifecycle 差異太大）
- 不處理 session 中途切換 provider（D6：延後）
- 不在此次重構 cost-worker / pricing（provider-agnostic，不需動）

---

## Architecture Decisions

### D1: 4 個獨立 registry

| Registry | 位置 | 狀態 | 職責 |
|----------|------|------|------|
| `UPSTREAMS` | `server/config.js` | 已有 | 路由目標 |
| `AGENT_PROVIDERS` | `server/providers.js` | 已有 | CLI spawn |
| `WIRE_PARSERS` | `server/wire-parsers/` | **新增** | wire → disk + normalize |
| `RENDERERS` | `public/renderers/` | **新增** | detail timeline 渲染 |

### D2: disk 留 provider-native + hash dedup，read 時 normalize

- Disk 每個 provider 保留原始 wire shape
- 大型共享部分按 hash 抽出（`sys_{hash}.json` / `openai_instructions_{hash}.json`）
- Delta-log 跨 turn（Anthropic 已有，OpenAI 不需要）
- Read 時 `WIRE_PARSERS[p].normalizeListMeta()` 產出 thin canonical

### D3: per-provider hash namespace

`sys_` 與 `openai_instructions_` 各自 namespace，不跨 provider 共享。

### D4: thin canonical（list layer）+ per-provider detail（detail layer）

- List layer（Miller columns 列表）：cross-provider thin canonical（ThinCanonical 欄位見下）
- Detail layer（Timeline 右側）：`RENDERERS[provider].renderTimeline(entries, container)`

**ThinCanonical 欄位**（`normalizeListMeta` 回傳值）：

| 欄位 | 型別 | 來源 |
|------|------|------|
| `id` | string | entry id（timestamp-based） |
| `ts` | string | ISO timestamp |
| `sessionId` | string? | per-provider extraction |
| `provider` | string | `'anthropic'` / `'openai'` |
| `model` | string | request body |
| `msgCount` | number | messages/input array length |
| `toolCount` | number | tools array length |
| `toolCalls` | number | response 中 tool_use / function_call 數量 |
| `usage` | object? | `{ input_tokens, output_tokens, cache_*? }` |
| `cost` | object? | `{ cost, rates }` |
| `agentType` | string | `extractAgentType` 結果的 key |
| `agentLabel` | string | `extractAgentType` 結果的 label |
| `isSubagent` | boolean | session detection 結果 |
| `stopReason` | string? | response stop reason |
| `status` | number | HTTP status code |
| `elapsed` | number | request→response ms |

Provider-specific 欄位（附在同一物件，renderer 可讀）：
- Anthropic：`coreHash`, `thinkingDuration`, `thinkingStripped`, `hasCredential`
- OpenAI：`responseMetadata` `{ id, object, model, status, streaming }`

### D5: provider 與 agent 兩條獨立 dispatch axis

| 軸 | 決定者 | 用途 |
|----|--------|------|
| `provider` | `getUpstreamForRequestAndHeaders()` | WIRE_PARSERS / RENDERERS dispatch |
| `agent` | system prompt 分類 | UI label / session 列名稱 |

### D6: session-immutable provider

一個 session 的 provider 由首筆 entry 決定，不可中途切換。

---

## Components

### `WIRE_PARSERS[provider]` — 5 個方法（4 dispatched + 1 read-path）

```javascript
WIRE_PARSERS[provider] = {
  // ── Dispatched（index.js / forward.js 透過 getParser() 呼叫）──

  isNoiseRequest(url, headers, parsedBody)
    // → boolean
    // index.js 用 Object.values(WIRE_PARSERS).some() 迭代所有 parser

  preprocessBody(parsedBody, headers)
    // → parsedBody (可能注入 header-derived metadata)
    // Optional — 只有 openai parser 實作（注入 session_id, agent_type）

  detectSession(req, headers, parsedBody)
    // → { sessionId, isNewSession, inferred? }
    // 內部委託 store.detectSession()

  extractUsage(parsedResponse)
    // → { input_tokens, output_tokens, cache_*? } | null

  // ── Read path ──

  normalizeListMeta(entry)
    // → ThinCanonical
    // 用於 restore.js 從 disk 重建 list metadata
}
```

Dedup/delta/version-detection 留在 index.js inline（side-effect 過多，dispatch 後 caller 仍需 if-else）。`dedupExtract`、`extractDeltaSlice`、`safeCall`、`SAFE_DEFAULTS` 已從 parser 檔案移除（Phase 3 retro：dead code 誤導讀者）。

**Dispatch 原則**：只 dispatch 乾淨的輸入→輸出、caller 不需再分支處理 return value。直接呼叫，不用 safeCall。

### `RENDERERS[provider]` — event parser for buildMergedSteps

```javascript
RENDERERS[provider] = {
  processEvent(ev, state)
    // 解析一個 SSE/WS event，更新共用 state
    // state = { curThinking, curThinkingStart, curThinkingEnd,
    //           curToolUses, openAIToolUseById, curText, eventIndex }
    // Anthropic: content_block_start/delta/stop
    // OpenAI: response.output_text.delta, response.output_item.added, ...
}
```

Phase 4 發現：`buildMergedSteps` 輸出的 `steps[]` 已經是 provider-agnostic。下游所有渲染（step list, detail, minimap, tool rendering）不需要 per-provider 分支。RENDERERS 的 dispatch 邊界 = event parsing（~80 行 provider-specific code），不是整個 renderTimeline。

`RENDERERS.fallback` 為未知 provider 提供 no-op processEvent。

### `openai-session.js` — 已刪除

ws-proxy.js 和 index.js 直接 import `wire-parsers/openai.js`。不再需要 shim。

---

## Data Flow

### Write path

```
Request → index.js
  1. getUpstreamForRequestAndHeaders() → provider
  2. WIRE_PARSERS.some(p.isNoiseRequest()) → skip?          ← dispatched
  3. parser.preprocessBody?.(body, headers)                  ← dispatched (openai only)
  4. inline: hash computation + writeSharedIfAbsent()        ← NOT dispatched (side-effects)
  5. inline: delta-log (Anthropic) / full write (OpenAI)     ← NOT dispatched (state mgmt)
  6. storage.write({id}_req.json)
  7. parser.detectSession(req, headers, body) → sessionId    ← dispatched
```

### Response path — HTTP SSE

```
Upstream response → forward.js
  8. getParser(provider).extractUsage(parsedResponse)        ← dispatched
  9. pricing.calculateCost(model, usage)  // provider-agnostic
  10. storage.write({id}_res.json)  — events[] array
  11. summarizeEntry() → SSE broadcast → dashboard
```

### Response path — WebSocket (Codex 0.133+)

```
Upstream WS → ws-proxy.js
  u2c onMessage handler:
    8a. if text frame: parse JSON, filter by blacklist, push to ctx.responseEvents
    8b. blacklist = { response.created, response.in_progress, response.completed,
                      response.done, codex.rate_limits }
        — 這些是大型 envelope events（各 35KB），renderer 不需要
        — blacklist 而非 whitelist：新 event type 自動收錄，失敗模式是多存而非漏存
  on close → recordWebSocketEntry:
    9. storage.write({id}_res.json) — ctx.responseEvents[] 或 metadata fallback
    10. summarizeEntry() → SSE broadcast → dashboard
```

Storage 影響：blacklist filter 後每 session ~2KB（vs 完整 frames ~200KB）。跟 HTTP SSE entries 相當。

### Read path (detail)

```
Dashboard click → GET /_api/entries/{id}
  Server: loadEntryReqRes() → delta chain + dedup restore
  Response: { provider, req, res }  // res = events[] for both HTTP + WS
  Client:
    resEvents = Array.isArray(e.res) ? e.res : []
    buildMergedSteps(messages, resEvents, provider)
      → RENDERERS[provider].processEvent(ev, state) per event
      → unified steps[]
    renderStepListHtml(steps) + renderMinimapHtml(steps)
```

HTTP SSE 和 WS entries 走同一條 client rendering path — `_res.json` 都是 events array。

---

## Error Handling

### WIRE_PARSERS error handling

Dispatched 方法直接呼叫（`parser.method()` 或 `parser?.method?.()`），不包 safeCall / try-catch fallback。Parser 方法 crash 只影響該筆 entry 的 metadata 品質（usage null、session fallback 等），不阻斷 proxy forwarding — 因為 parser 呼叫都在 entry construction 之前，forward 不依賴 parser 結果。

Phase 3 retro：safeCall + safe defaults 把 bug 變成 silent data corruption（parser 壞了回傳空殼，downstream 拿到錯誤 data 但不 crash）。直接呼叫讓 error 可見、可 debug。

### 舊資料相容

1.9.x 寫的 entry 沒有 `provider` 欄位：
- `restore.js` 載入時 infer：`/v1/messages` → anthropic，`/v1/responses` → openai，其餘 → anthropic
- 不回寫修改舊檔

### RENDERERS fallback

`RENDERERS[provider]` 不存在 → `RENDERERS.fallback.renderTimeline()` 顯示 raw JSON pretty-print + banner。

---

## Risks

| 風險 | 緩解 |
|------|------|
| codex wire shape 隨版本變動 | blacklist filter 自動收錄新 event types；fixture 來自真實 wire dump |
| WS binary frames crash JSON.parse | `if (!isBinary)` guard + try-catch |
| 長時間 codex session 累積 events 吃 RAM | 跟 HTTP SSE 同等風險（也在 response end 前累積），必要時加 cap |
| Multi-turn WS session 顯示為一個 turn card | 可接受 — timeline 正確顯示所有 steps；turn splitting 是後續 UX 優化 |
| 重構期間 dev hub (port 5577) 被破壞 | 用 `--port 5579` + `CCXRAY_HOME=/tmp/test` 隔離測試 |

---

## Migration Plan

### Phase 0-2: Extract（✅ done）

- Phase 0: Fixtures
- Phase 1: WIRE_PARSERS scaffold + Anthropic impl
- Phase 2: OpenAI WIRE_PARSER impl

### Phase 3: Wire-up（✅ done, v2）

index.js/forward.js 的乾淨邊界改為 dispatch（noise, preprocess, session, usage）。Dedup/delta 留 inline。刪除 `isCodexPlatformNoisePath`（config.js）、`extractUsage`（helpers.js）。`openai-session.js` 暫 thin 為 re-export。

### Phase 4: RENDERERS scaffold（✅ done）

建 `public/renderers/{index,anthropic,openai,fallback}.js`。從 `buildMergedSteps` 的 event-parsing loop 提取 per-provider `processEvent(ev, state)` dispatch。Phase 5（原計畫的 OpenAI renderer + client wire-up）已被 Phase 4 吸收。

### Phase 4b: Cleanup — 刪 dead code + openai-session.js

- 刪除 `dedupExtract`、`extractDeltaSlice`、`safeCall`、`SAFE_DEFAULTS` 及對應 tests
- 刪除 `openai-session.js`：ws-proxy.js 和 index.js 改為直接 import `wire-parsers/openai.js`
- 保留 `normalizeListMeta`（restore.js 會用）和 `extractAgentType`（未來 dispatch 候選）

### Phase 5: WS frame capture — Codex timeline

ws-proxy.js 的 `onMessage` handler 累積 u2c text frame events，`recordWebSocketEntry` 時寫入 `_res.json` 為 events array。Blacklist filter 排除大型 envelope events（`response.created` 等 35KB）。Client 零改動 — `Array.isArray(e.res)` → true → 走 existing `buildMergedSteps` + `RENDERERS.openai.processEvent` pipeline。

### Phase 6: Integration tests

### Phase 7: Cleanup + release

### Phase 6: Integration tests + validation

Fixture-driven unit tests for WIRE_PARSERS。Integration test for delta chain。手動 E2E 驗證兩個 provider 的 dashboard 完整體驗。

### Phase 7: Cleanup + release

Archive `openspec/changes/2026-05-28-codex-dashboard-parity/`。CHANGELOG entry。更新 CLAUDE.md Architecture table。

---

## Relationship to 2026-05-28-codex-dashboard-parity

該 scaffold 用「直接補 codex」的 framing，其 tasks（session detection、body shape、MCP noise 等）都對應到此 abstraction 的 WIRE_PARSERS 方法。此 proposal 取代它。完成後 archive 該 scaffold。
