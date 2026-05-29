# Dashboard Agent Abstraction

## Why

ccxray 已支援 Claude Code（Anthropic API）和 Codex（OpenAI API）兩個 provider，但 provider-specific 邏輯散落在 10+ 個檔案裡的 `if (provider === ...)` 分支：

- **session detection**：Anthropic 從 `parsedBody.metadata.session_id`；OpenAI 從 headers + turn-metadata JSON（`openai-session.js` 4 個 function）
- **dedup/hash**：Anthropic hash `system[]` + `tools`；OpenAI hash `instructions` + `tools`，file naming 不同（`sys_` vs `openai_instructions_`）
- **usage extraction**：Anthropic 掃 SSE events；OpenAI 讀 response object
- **agent classification**：Anthropic 用 system prompt B2 prefix；OpenAI 用 headers + instructions regex
- **noise filtering**：只有 Codex 有（`isCodexPlatformNoisePath`）
- **dashboard rendering**：`messages.js` 只懂 Anthropic content block shape

新增 provider 需要改太多地方。codex dashboard 五個已知問題（session name "Codex Raw"、model "?"、tokens "?"、messages "No messages"、MCP noise 污染）如果直接逐個修，只會增加更多 if-else。

之前的 `openspec/changes/2026-05-28-codex-dashboard-parity/` 用「直接補 codex」的 framing 寫，此 proposal 取代它：先建 abstraction，codex 修復作為第一個 client 自然落地。

## What Changes

- 新增 `WIRE_PARSERS` registry（`server/wire-parsers/`）：per-provider strategy，7 個方法涵蓋 session detection、dedup、delta-log、noise filter、usage extraction、agent classification、list metadata normalization
- 新增 `RENDERERS` registry（`public/renderers/`）：per-provider detail timeline 渲染，取代 `messages.js` 的 Anthropic-only rendering
- 將散落在 `index.js`、`forward.js`、`store.js`、`system-prompt.js`、`openai-session.js`、`config.js` 的 provider-specific 邏輯搬進對應 registry
- `index.js` 主流程改為 dispatch `WIRE_PARSERS[provider].method()` — 零 provider if-else
- Dashboard list layer 使用 thin canonical metadata（provider-agnostic），detail layer dispatch `RENDERERS[provider]`
- Disk 保留 provider-native wire shape + hash dedup；normalize 只在 read 時做

## Capabilities

### New Capabilities

- `provider-strategy-registry`：per-provider strategy pattern（WIRE_PARSERS + RENDERERS），新增 provider = 各 registry 加一筆

### Modified Capabilities

- `codex-observation`：codex session/model/tokens/messages/noise 五個問題，透過 OpenAI WIRE_PARSER + RENDERER 實作解決

## Impact

| 模組 | 變動 |
|------|------|
| `server/wire-parsers/` | **新增** — `index.js`（registry）, `anthropic.js`, `openai.js` |
| `public/renderers/` | **新增** — `index.js`（registry）, `anthropic.js`, `openai.js`, `fallback.js` |
| `server/index.js` | 重構 — provider if-else → `WIRE_PARSERS[p]` dispatch |
| `server/forward.js` | 重構 — usage extraction 搬入 WIRE_PARSERS |
| `server/store.js` | 重構 — session detection / addEntry 改用 WIRE_PARSERS |
| `server/system-prompt.js` | 重構 — agent classification 搬入 WIRE_PARSERS |
| `server/openai-session.js` | 重構 — 內容搬入 `wire-parsers/openai.js`，可能刪除或保留為 thin re-export |
| `server/config.js` | 重構 — `isCodexPlatformNoisePath` 搬入 WIRE_PARSERS |
| `public/messages.js` | 重構 — Anthropic rendering 搬入 `renderers/anthropic.js` |
| `public/entry-rendering.js` | 重構 — detail dispatch 改用 `RENDERERS[p]` |
