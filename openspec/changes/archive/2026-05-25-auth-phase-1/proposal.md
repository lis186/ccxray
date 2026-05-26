## Why

ccxray 以 localhost HTTP proxy 運行，沒有任何認證機制。同機器上的其他 UID 程序可以：(1) 透過 proxy 用別人的 API quota，(2) 讀取 dashboard 上的對話記錄，(3) 注入假的 API 回應。需要一個 phased auth migration，Phase 1 先建立基礎設施但不擋任何既有流量（warn-only）。

## What Changes

- HKDF-SHA256 key derivation module (`K_upstream`, `K_session`, `K_bootstrap` 三把鑰匙，全從同一個 root secret 衍生)
- Two-domain dispatcher：把 request 分成 upstream (`/v1/*`) 和 dashboard（其他路徑），各自有獨立 verifier
- Cookie-based browser auth：`/_auth/redeem` endpoint + `ccxray open` CLI command 產生 one-time bootstrap token，browser 用 fragment (`#k=`) 傳遞後兌換成 HttpOnly cookie
- Launcher header injection：Claude Code 用 `ANTHROPIC_CUSTOM_HEADERS`，Codex API-key 用 `model_providers.ccxray`，ChatGPT-OAuth 走舊路徑
- WS upgrade warn-only gate：`classifyUpstreamAuth()` 分類（authed / chatgpt-oauth / warn）
- Internal header stripping：`X-Ccxray-Auth` 和 `X-Ccxray-Bootstrap` 在 forward 到 upstream 前移除

## Capabilities

### New Capabilities

- `two-domain-auth-scheme`: HKDF key derivation, two-domain dispatcher, stateless HMAC cookie, bootstrap flow, launcher injection, WS gate, header stripping

### Modified Capabilities

- `hub-lifecycle`: hub.js 加入 `/_api/hub/bootstrap-token` route（loopback-only）
- `server-request-handling`: index.js 用 `dispatch()` 取代直接 `authMiddleware()` 呼叫

## Impact

- `server/auth.js`: +410 LOC（從 ~12 LOC 擴展為完整 auth module）
- `server/routes/auth.js`: +37 LOC（新檔：`/_auth/redeem`, `/_auth/status`）
- `server/providers.js`: +43/-5 LOC（header injection logic）
- `server/ws-proxy.js`: +24 LOC（classifyUpstreamAuth, header stripping）
- `server/index.js`: +71 LOC（dispatch integration, buildForwardHeaders stripping）
- `server/hub.js`: +20 LOC（bootstrap-token route）
- `public/index.html`: +43 LOC（bootstrap inline script）
- 7 new test files, 17 new tests (589 total)
