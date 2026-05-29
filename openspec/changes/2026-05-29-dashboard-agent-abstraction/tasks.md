# Tasks: Dashboard Agent Abstraction

## 0. Fixtures（Phase 0 前置）

- [ ] 0.1 從 `~/.ccxray/logs/` 擷取 Anthropic 真實 wire dump（req + res），存入 `test/fixtures/wire-parsers/anthropic/`
- [ ] 0.2 從 `test/fixtures/codex-sessions/` + `test/fixtures/codex-ws-frames/` 整理 OpenAI fixtures，存入 `test/fixtures/wire-parsers/openai/`

## 1. WIRE_PARSERS scaffold + Anthropic impl（commit 1.x）

- [ ] 1.1 建 `server/wire-parsers/index.js`：registry object + dispatch helper + try-catch wrapper with safe defaults
- [ ] 1.2 建 `server/wire-parsers/anthropic.js`：7 個方法，程式碼從以下搬移（不改邏輯）：
  - `dedupExtract` ← `index.js` L285-301（sysHash/toolsHash/coreHash extraction）
  - `extractDeltaSlice` ← `index.js` L324-357 + `delta-helpers.js`
  - `isNoiseRequest` ← return false（Anthropic 無 noise paths）
  - `normalizeListMeta` ← `sse-broadcast.js` `summarizeEntry` 的 Anthropic 路徑
  - `extractUsage` ← `helpers.js` `extractUsage`
  - `extractAgentType` ← `system-prompt.js` `extractAgentType`
  - `detectSession` ← `store.js` 的 Anthropic session detection 路徑
- [ ] 1.3 Unit tests：每個方法 × Anthropic fixtures 斷言正確

## 2. OpenAI WIRE_PARSER impl（commit 2.x）

- [ ] 2.1 建 `server/wire-parsers/openai.js`：7 個方法，程式碼從以下搬移 + 補正：
  - `dedupExtract` ← `index.js` L302-322（openai_instructions_ hash）
  - `extractDeltaSlice` ← return null
  - `isNoiseRequest` ← `config.js` `isCodexPlatformNoisePath` + 補 MCP RPC noise
  - `normalizeListMeta` ← `sse-broadcast.js` 的 OpenAI 路徑 + 修正 model/tokens/messages 顯示
  - `extractUsage` ← `forward.js` inline OpenAI usage extraction
  - `extractAgentType` ← `system-prompt.js` `extractPromptAgentType` + `openai-session.js` `getOpenAIAgentTypeFromHeaders`
  - `detectSession` ← `openai-session.js` `detectOpenAISession` + `isOpenAISubagent` + `getWorkspaceCwd`
- [ ] 2.2 Unit tests：每個方法 × OpenAI fixtures 斷言正確
- [ ] 2.3 codex 五個問題在 normalizeListMeta + detectSession 中修正（session name、model、tokens、messages、noise）

## 3. index.js wire-up（commit 3.x）

- [ ] 3.1 `index.js` request 處理流程改為 `WIRE_PARSERS[provider].method()` dispatch
- [ ] 3.2 刪除 `index.js` 中已搬走的 Anthropic/OpenAI if-else 分支
- [ ] 3.3 `forward.js` response 處理改用 `WIRE_PARSERS[provider].extractUsage()`
- [ ] 3.4 `sse-broadcast.js` 改用 `WIRE_PARSERS[provider].normalizeListMeta()`
- [ ] 3.5 評估 `openai-session.js` 是否清空 — 清空則刪除，否則保留為 thin re-export
- [ ] 3.6 評估 `config.js` `isCodexPlatformNoisePath` — 搬走後刪除
- [ ] 3.7 Smoke test：`ccxray --port 5578` + `CCXRAY_HOME=/tmp/ccxray-test` 跑 Claude + Codex 各幾 turn

## 4. RENDERERS scaffold + Anthropic renderer（commit 4.x）

- [ ] 4.1 建 `public/renderers/index.js`：registry + dispatch + fallback
- [ ] 4.2 建 `public/renderers/anthropic.js`：從 `messages.js` 搬移 detail timeline rendering（thinking blocks、tool groups、text blocks、minimap）
- [ ] 4.3 建 `public/renderers/fallback.js`：raw JSON pretty-print + "no dedicated renderer" banner
- [ ] 4.4 `messages.js` 保留 list-level 共用邏輯（如果有），搬走的 detail 部分刪除

## 5. OpenAI renderer + client wire-up（commit 5.x）

- [ ] 5.1 建 `public/renderers/openai.js`：codex turn 的 timeline rendering（function_call、function_call_output、reasoning summary 等）
- [ ] 5.2 `entry-rendering.js` 或 `messages.js` 的 detail dispatch 改用 `RENDERERS[provider]`
- [ ] 5.3 手動 E2E：dashboard 點 Anthropic turn → Anthropic renderer；點 Codex turn → OpenAI renderer；點 unknown provider → fallback

## 6. Integration tests（commit 6.x）

- [ ] 6.1 Integration test：寫 3 turn Anthropic session（full → delta → delta），loadEntryReqRes 驗證 chain
- [ ] 6.2 Integration test：寫 3 turn OpenAI session（都 full），loadEntryReqRes 驗證完整
- [ ] 6.3 `restore.js` 舊資料相容：缺 `provider` 欄位的 entry 正確 infer

## 7. Cleanup + release（commit 7.x）

- [ ] 7.1 Archive `openspec/changes/2026-05-28-codex-dashboard-parity/`
- [ ] 7.2 CHANGELOG entry under `## 1.10.0` or next version
- [ ] 7.3 更新 CLAUDE.md Architecture table 加入 `wire-parsers/` 和 `renderers/`
