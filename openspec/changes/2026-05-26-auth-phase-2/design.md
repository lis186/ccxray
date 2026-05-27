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

- Hub 啟動時 `cleanupStaleSocket()` → `createHubSocket()`（`createHubSocket` 不做 blind unlink，依賴前置清理）
- `hub.json` 加 `sockPath` field（explicit 4th param to `writeHubLock`；orphan recovery 走 socket 時帶 `SOCK_PATH`，走 HTTP 時不帶）
- Hub 正常關閉：`shutdownHub()` closes socket + explicit `unlinkSync` fallback
- Hub crash：下次啟動時 `cleanupStaleSocket()`（pid cross-check + connect probe；lockfile absent → 直接 unlink）

### 決策 3a：bootstrap-token endpoint 搬遷（codex review R1 finding）

`bootstrap-token` 從 `/_api/hub/bootstrap-token` 搬到 `/_auth/bootstrap-token`。原因：standalone mode（`--port`，無 hub socket）也需要 `ccxray open` 能 mint token，但 `/_api/hub/*` 現在一律 410。新 endpoint 在 `server/routes/auth.js`，loopback-restricted。

Phase 2.3 的 dashboard enforcement 需要把 `/_auth/bootstrap-token` 也納入 auth gate（codex R3 P1 deferred）。

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

### 決策 5：Version bump timing（revised 2026-05-27 — bundle 2.2 + 2.3）

- 2.1 (socket) = non-breaking（hub IPC is internal；no standalone version bump）
- **2.2 + 2.3 ship together as a single `2.0.0` breaking release.** Rationale: 2.2 alone (upstream enforce) is pure restriction with no user-visible benefit; the felt value — dashboard now requires `ccxray open`, protecting recorded conversations (which on a `0.0.0.0`-bound proxy are currently LAN-readable) — lands in 2.3. Requiring `ccxray open` is itself a breaking UX change, so it belongs in the major bump, not an "additive 2.1.0". Bundling spends the upgrade-friction budget once.
- (superseded) ~~2.3 = version 2.1.0~~

### 決策 6：Windows fallback（per reviewer O4）

PR description + CHANGELOG note：「Hub mode requires Unix socket (macOS/Linux). On Windows, ccxray runs in standalone mode (no multi-project hub sharing). Named Pipes support is a future enhancement.」

### 決策 7：CCXRAY_LOOPBACK_NO_AUTH escape hatch — loopback-guarded（2026-05-27）

ccxray binds `0.0.0.0` (all interfaces — `lsof` shows `*:5577`, `srv.listen(port)` has no host arg), so a **blunt** bypass would expose `/v1/*` + dashboard to the entire LAN the moment the flag is set. Decision: the escape hatch is **loopback-guarded** — it bypasses auth only when `req.socket.remoteAddress` is loopback; a non-loopback request still requires a credential even with the flag set (tasks 4.10). This moves the check from `verifyUpstreamCredential(headers)` (header-only, as shipped blunt in 2.2) up to the gate functions (`verifyUpstream` / WS `isAuthorized` / `verifyDashboard`, which have `req.socket`).

errata §5's "theater" caveat still applies to the **same-host reverse-proxy** case (proxied external traffic presents `remoteAddress = 127.0.0.1`, defeating the guard) — but that requires the operator to both front ccxray with a same-host proxy AND set the flag (double opt-in), and the startup banner warns regardless. The guard is meaningful for the default direct-`0.0.0.0` case; the reverse-proxy gap is documented, not closed. The spec's "Explicit loopback opt-in" scenario already assumes loopback-scoped, so this brings the implementation back in line with the spec (2.2 shipped blunt; 2.3 reworks to guarded).

## Risks / Trade-offs

- **2.2 是 breaking change**：現有 `curl http://localhost:5577/v1/messages` without auth 會 401。Mitigation: CHANGELOG + version bump + `CCXRAY_LOOPBACK_NO_AUTH=1` escape hatch。
- **Socket stale file detection**：Hub crash 留下 `hub.sock` 但無 process。Mitigation: startup probe (connect attempt with 1s timeout → ECONNREFUSED or timeout = stale → unlink)。額外防禦：lockfile pid dead + socket file exists → 直接 unlink（不 probe）。Lockfile 不存在但 socket file 存在 → orphan file，直接 unlink。
- **Node.js `chmod` on socket fd**：Some BSDs reject `fchmod` on socket fd。Mitigation: `chmod` on path after `listen()` completes。
- **authMiddleware / _isDashboardAuthenticated 重複**：Phase 2.2 extract shared `_matchesLegacyToken(req)` helper（per Phase 1 review O1）。
- **Socket framing partial read**：TCP stream 不保證一次 `data` event = 一個完整 JSON line。Server 和 client 都必須 buffer until `\n`。
- **`ensureHubDir` 權限不修正**：`mkdirSync({recursive:true, mode:0o700})` 不改既有目錄權限。Mitigation: hub startup 時 `chmodSync(HUB_DIR, 0o700)` 強制修正。
- **Socket listen timing vs lockfile**：`writeHubLock` 必須在 socket listen 成功之後才寫，否則 client 讀到 lockfile 但 socket 還沒 ready → ECONNREFUSED。
- **Windows hub mode**：`net.createServer().listen(unixPath)` 在 Windows 走 Named Pipe 語法，`chmod` 無效。Hub mode 在 Windows 必須整個 fallback to standalone（不能只跳 socket）。
- **410 UX for old clients**：舊版 ccxray 不認 `sockPath`，fallback HTTP → 410。Response body 應含 migration hint。
- **registerClient signature change**：所有 caller（含 `startHubMonitor` recovery callback）必須傳 lock object，不能傳 port number。Recovery callback 在 `.catch(() => {})` 裡，silent failure 不會被測試抓到。

## Migration Plan

- Phase 2.1 (socket): 非 breaking，但 hub.json format 加 `sockPath`。老版 client 讀不到 → 自然 fall back to HTTP → 但 HTTP hub routes 已 410。**因此 2.1 必須同時更新 client 端。** Single commit 完成（不拆）。
- Phase 2.2 (enforcement): semver-major��CHANGELOG 列出遷移步驟：「如果你的腳本直接 curl /v1，加上 `-H 'X-Ccxray-Auth: $(ccxray secret upstream)'`」。
- Phase 2.3 (ephemeral): 無 AUTH_TOKEN 的使用者首次升級後需跑 `ccxray open` 才能看 dashboard。Startup banner 提示。
