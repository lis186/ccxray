## Context

Phase 1 merged (PR #36, 589 tests)。Auth 基礎設施完整但 warn-only。Hub IPC 仍走 HTTP-over-TCP（hub.js 533 LOC）。errata §5 定義了 reordered Phase 2 順序。depandabot audit (`docs/depandabot/2026-05-26-phase2-implementation-readiness.md`) 產出了完整 HTTP hub route caller inventory。

## Goals / Non-Goals

**Goals:**
- Hub IPC 搬到 Unix socket，用 fs 權限取代 IP loopback check
- Upstream auth 從 warn 翻成 enforce（semver-major）
- Dashboard auth 從 allow-all 翻成 cookie-required
- Ephemeral mode 成為預設（無 AUTH_TOKEN 也需要認證）

**Non-Goals:**
- Windows Named Pipes（延遲，hub mode 在 Windows 退回 standalone）
- 移除 `?token=` 在 `/` 的 redirect（Phase 3）
- Peer-UID socket 驗證（errata §1.2 已排除，用 fs 權限）

## Decisions

### 決策 1：HTTP hub route caller inventory + migration strategy

Per depandabot reviewer (O1+O3)，必須先列舉所有 HTTP hub route caller 再動 code：

| # | Caller | HTTP route | Migration |
|---|--------|-----------|-----------|
| 1 | `discoverHub` → `checkHubHealth(port)` | GET `/_api/health` | 改為 socket connect probe（嘗試 `sockPath`，成功 = alive） |
| 2 | `registerClient(port, pid, cwd)` | POST `/_api/hub/register` | 改為 socket `{"cmd":"register",...}` |
| 3 | `unregisterClient(port, pid)` | POST `/_api/hub/unregister` | 改為 socket `{"cmd":"unregister",...}` |
| 4 | `ccxray open` | POST `/_api/hub/bootstrap-token` | 改為 socket `{"cmd":"bootstrap-token"}` |
| 5 | `ccxray status` | GET `/_api/health` + GET `/_api/hub/status` | 改為 socket `{"cmd":"status"}` |
| 6 | Dashboard SSE reconnect | GET `/_api/health` | **保留 HTTP**（browser 不能用 socket） |
| 7 | `probeHubStatus` (orphan port detection) | GET `/_api/health` | **保留 HTTP**（probes arbitrary ports） |

**結論**：`/_api/health` 保留在 HTTP。所有其他 `/_api/hub/*` routes → 410。

### 決策 2：Newline-delimited JSON framing

Protocol：每條訊息是一個 JSON object + `\n`。Client 送 `{"cmd":"register","pid":123,"cwd":"/path"}\n`，Server 回 `{"ok":true}\n`。

理由：
- 所有 hub messages <1KB，無 binary，無 streaming
- 實作簡單：socket `data` event buffer，split on `\n`，JSON.parse each
- 比 length-prefix 更容易 debug（`socat` 可讀）

### 決策 3：Socket lifecycle

- Hub 啟動時 `net.createServer().listen(sockPath)` — 若 stale file exists，unlink 先
- `hub.json` 加 `sockPath` field：`{"port":5577, "pid":123, "sockPath":"/Users/x/.ccxray/hub.sock", ...}`
- Hub 正常關閉：`server.close()` auto-unlinks socket file
- Hub crash：下次啟動時 unlink stale socket（`fs.existsSync` + `connect` probe → timeout = stale）

### 決策 4：verifyUpstream 辨識 X-Ccxray-Auth（2.2）

```js
function verifyUpstream(req, res) {
  // Phase 2: X-Ccxray-Auth is the primary credential
  const { K_upstream } = getSecrets();
  const headerVal = req.headers['x-ccxray-auth'];
  if (headerVal && compareSecret(Buffer.from(headerVal, 'base64url'), K_upstream)) return true;
  // ChatGPT-OAuth carve-out
  if (classifyUpstreamAuth(req.headers) === 'chatgpt-oauth') return true;
  // Legacy fallback removed — reject
  res.writeHead(401, ...);
  return false;
}
```

### 決策 5：Version bump timing（per reviewer O5）

- 2.1 (socket) = version 1.x（non-breaking for external callers；hub IPC is internal）
- 2.2 (enforcement) = version **2.0.0**（breaking：reject unauthenticated upstream）
- 2.3 (ephemeral) = version 2.1.0（additive enforcement on dashboard side）

### 決策 6：Windows fallback（per reviewer O4）

PR description + CHANGELOG note：「Hub mode requires Unix socket (macOS/Linux). On Windows, ccxray runs in standalone mode (no multi-project hub sharing). Named Pipes support is a future enhancement.」

## Risks / Trade-offs

- **2.2 是 breaking change**：現有 `curl http://localhost:5577/v1/messages` without auth 會 401。Mitigation: CHANGELOG + version bump + `CCXRAY_LOOPBACK_NO_AUTH=1` escape hatch。
- **Socket stale file detection**：Hub crash 留下 `hub.sock` 但無 process。Mitigation: startup probe (connect attempt with 1s timeout → ECONNREFUSED or timeout = stale → unlink)。
- **Node.js `chmod` on socket fd**：Some BSDs reject `fchmod` on socket fd。Mitigation: `chmod` on path after `listen()` completes。
- **authMiddleware / _isDashboardAuthenticated 重複**：Phase 2.2 extract shared `_matchesLegacyToken(req)` helper（per Phase 1 review O1）。

## Migration Plan

- Phase 2.1 (socket): 非 breaking，但 hub.json format 加 `sockPath`。老版 client 讀不到 → 自然 fall back to HTTP → 但 HTTP hub routes 已 410。**因此 2.1 必須同時更新 client 端。** Single commit 完成（不拆）。
- Phase 2.2 (enforcement): semver-major��CHANGELOG 列出遷移步驟：「如果你的腳本直接 curl /v1，加上 `-H 'X-Ccxray-Auth: $(ccxray secret upstream)'`」。
- Phase 2.3 (ephemeral): 無 AUTH_TOKEN 的使用者首次升級後需跑 `ccxray open` 才能看 dashboard。Startup banner 提示。
