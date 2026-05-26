## Why

Phase 1 建立了 auth 基礎設施（key derivation, cookie, launcher injection, WS gate）但所有 gate 都是 warn-only。ccxray 仍然對未認證流量完全開放。Phase 2 翻轉為 enforce — 讓認證真正生效。

順序經 depandabot audit 修正：先關閉攻擊面（Unix socket），再開啟認證強制（enforcement），最後翻��預設值���ephemeral mode）。這避免了靠 IP 地址做安全判斷的 broken pattern（OpenClaw CVE GHSA-xc7w-v5x6-cc87）。

## What Changes

- **2.1 Unix socket hub IPC**：hub 的 register/unregister/health/bootstrap-token/status 從 HTTP `/_api/hub/*` 移到 `~/.ccxray/hub.sock`（mode `0600`）。Filesystem 權限取代 IP-based loopback check。`/_api/health` 保留給 dashboard liveness + orphan probe。
- **2.2 Upstream enforcement**：`verifyUpstream` 從 warn→reject。`isAuthorized`（WS）也 enforce。`X-Ccxray-Auth` 辨識加入 auth gate。ChatGPT-OAuth carve-out 正式化。semver-major bump (2.0.0)。
- **2.3 Dashboard enforcement + ephemeral mode**：`verifyDashboard` reject 無 cookie 請求。`AUTH_TOKEN` unset 時預設 deny（ephemeral mode）。`CCXRAY_LOOPBACK_NO_AUTH=1` opt-in 重開舊行為。

## Capabilities

### New Capabilities

- `unix-socket-hub-ipc`: hub IPC over `~/.ccxray/hub.sock` with newline-delimited JSON framing
- `upstream-enforcement`: reject unauthenticated upstream traffic
- `ephemeral-mode-default`: default-deny without AUTH_TOKEN

### Modified Capabilities

- `hub-lifecycle`: client discovery prefers socket, HTTP hub routes → 410 (except `/_api/health`)
- `two-domain-auth-scheme`: verifiers flip from warn to reject

## Impact

- `server/hub.js`: 重寫 IPC 路徑（~150 LOC 改動估計）
- `server/auth.js`: verifyUpstream + verifyDashboard 翻轉 (~30 LOC)
- `server/ws-proxy.js`: isAuthorized 加 X-Ccxray-Auth 辨識 (~10 LOC)
- `server/index.js`: 移除/調整 buildForwardHeaders 中的 legacy path
- `bin/ccxray` (或 index.js CLI section): `ccxray open` / `ccxray status` 改用 socket
- `package.json`: version bump to 2.0.0
- CHANGELOG: breaking change documentation
