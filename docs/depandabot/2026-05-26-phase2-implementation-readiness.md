# depandabot audit — Phase 2 Implementation Readiness

## §1 Current State

1. **Phase 1 merged to main** (PR #36, commit `5931bfa`). 589 tests, CI green. `feat/auth-phase-1` branch deleted. Current `main` has the full Phase 1 auth scheme (warn-only). (`gh pr view 36`)

2. **Errata §5 documents the reordered Phase 2 plan**: 2.1 = Unix socket hub IPC, 2.2 = upstream enforcement, 2.3 = dashboard enforcement + ephemeral mode. (`reason/260525-0055-ccxray-auth-design/errata.md:L144-170`)

3. **Hub IPC surface (HTTP, 533 LOC)**: `handleHubRoutes` serves 5 routes (`health`, `register`, `unregister`, `bootstrap-token`, `status`). `registerClient`/`unregisterClient` are HTTP POST callers. `discoverHub` reads `hub.json` for `{port, pid}`. `forkHub` spawns detached hub process. `startHubMonitor` polls hub pid for crash recovery. 118 test references to hub module. (`server/hub.js`, `server/index.js:194,612,636,643`)

4. **Socket path feasibility**: `~/.ccxray/hub.sock` = 33 bytes (macOS limit ~103 bytes). No path-length risk. (`node -e` check)

5. **No `feat/auth-phase-2` branch exists yet** — work hasn't started.

## §2 Intended Goal

Should we proceed with implementing Phase 2 as specified in `errata.md` §5 (reordered: 2.1 Unix socket → 2.2 enforcement → 2.3 ephemeral)?

## §3 Current Plan

1. Create `feat/auth-phase-2` branch from `main`
2. **Commit 2.1** (single commit): Add Unix socket hub IPC
   - `net.createServer` listening on `~/.ccxray/hub.sock` (mode `0600`, parent dir `0700`)
   - Newline-delimited JSON framing protocol for: `register`, `unregister`, `health`, `bootstrap-token`, `status`
   - `hub.json` adds `sockPath` field alongside existing `port`/`pid`
   - Client-side: `registerClient`/`unregisterClient` prefer socket when `sockPath` present, fall back to HTTP
   - `handleHubRoutes` HTTP paths return 410 Gone (except `/_api/health` which stays for dashboard liveness)
   - Cleanup: `server.close()` unlinks socket; crash leaves stale file → check-and-unlink on startup
   - Tests: unit (framing, socket lifecycle) + integration (client register/unregister via socket)
3. **Commit 2.2**: Upstream enforcement
   - `verifyUpstream` rejects when `X-Ccxray-Auth` absent (instead of warn)
   - Add `X-Ccxray-Auth` recognition: compare against `K_upstream` from `deriveSecrets(getRootSecret())`
   - `isAuthorized` (ws-proxy.js) also accepts `X-Ccxray-Auth`
   - ChatGPT-OAuth carve-out: `classifyUpstreamAuth` returning `chatgpt-oauth` → allow without `X-Ccxray-Auth` (existing logic from Phase 1.4b, just don't reject)
   - Extract shared `_matchesLegacyToken(req)` helper (per Phase 1 review O1)
   - Test matrix: with/without `AUTH_TOKEN`, with/without `X-Ccxray-Auth`, ChatGPT-OAuth path, WS upgrade enforcement
4. **Commit 2.3**: Dashboard enforcement + ephemeral mode
   - `verifyDashboard` rejects when neither cookie nor `X-Ccxray-Auth` present
   - Ephemeral mode (`AUTH_TOKEN` unset) becomes default-deny; `CCXRAY_LOOPBACK_NO_AUTH=1` re-opens old behavior
   - Startup banner warns if `CCXRAY_LOOPBACK_NO_AUTH=1` is set
5. Open PR, codex review gate, merge

## §4 Missing Directional Confirmations

1. **[risk]** `handleHubRoutes` returning 410 breaks the `startHubMonitor` crash-recovery flow — the monitor uses `checkHubHealth` which calls `/_api/health`. If we 410 that route, crash recovery fails. Must keep `/_api/health` alive or switch the health check to use the socket.
2. **[unknown]** Whether the `bootstrap-token` route (currently HTTP-only, loopback-gated) should move to socket-only or stay on HTTP. `ccxray open` currently calls `POST /_api/hub/bootstrap-token` — if that goes 410, `ccxray open` needs updating.
3. **[assumption]** Newline-delimited JSON is sufficient framing. Hub messages are small (<1KB). No binary payloads. No streaming responses.
4. **[risk]** The 2.2 enforcement commit is a semver-major change. Existing users who set `AUTH_TOKEN` and launch agents via `ccxray claude` will suddenly have working auth (good) but users who `curl` the proxy without `X-Ccxray-Auth` will be rejected. Need CHANGELOG + version bump.
5. **[unknown]** Whether Windows Named Pipes need consideration now or can be deferred. Current user base is macOS/Linux developers.

## §5 Evidence & Arguments

1. **[Node.js net documentation](https://nodejs.org/api/net.html)** — `net.createServer().listen(path)` creates UDS. `server.close()` unlinks the socket file. Path limit is 107 (Linux) / 103 (macOS). ccxray's path is 33 bytes. → §3.2, §4.3

2. **[IPC example gist (Xaekai)](https://gist.github.com/Xaekai/e1f711cb0ad865deafc11185641c632a)** — Real-world Node.js UDS IPC pattern. Confirms stream-oriented nature requires explicit framing (comments highlight the partial-message issue). Validates choice of newline-delimited JSON. → §3.2, §4.3

3. **[Node.js file permissions (w3tutorials)](https://www.w3tutorials.net/blog/nodejs-restrict-permission-on-file/)** — Confirms `fs.chmodSync(path, 0o600)` is the standard Node.js approach. Platform caveat: some BSDs reject `fchmod` on socket fd, but `chmod` on the path works everywhere. → §3.2

4. **[Dissent: hub crash-recovery depends on HTTP health check]** — `startHubMonitor` (hub.js:445) checks `isPidAlive(hubPid)` and on failure, calls `forkHub`. But `discoverHub` (hub.js:99) calls `checkHubHealth(lock.port)` which issues `GET http://localhost:${port}/_api/health`. If 2.1 kills this route, the discovery path breaks for clients that haven't updated. The socket migration must either: (a) keep `/_api/health` alive (but then HTTP isn't fully removed), or (b) rewrite `discoverHub`/`checkHubHealth` to use the socket in the same commit. Option (b) is a larger change but cleaner. → §4.1

5. **[Microsoft phased MFA (Learn)](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mandatory-multifactor-authentication)** — Industry precedent: semver-major auth enforcement ships with advance notice + opt-out flag. ccxray's `CCXRAY_LOOPBACK_NO_AUTH=1` is the equivalent. → §4.4

## §6 Second Opinion

### Round 1 — Reviewer verdict: AGREE

| ID | Severity | Category | Summary |
|----|----------|----------|---------|
| O1 | high | implementation | `ccxray open` and `ccxray status` use HTTP hub routes — 2.1 must migrate both or they break |
| O2 | medium | implementation | `discoverHub` + `startHubMonitor` both rely on HTTP — explicitly state which approach |
| O3 | medium | conceptual | Plan underspecifies HTTP-to-socket migration boundary — need complete caller inventory |
| O4 | low | conceptual | Windows deferral should be documented in PR |
| O5 | low | implementation | Semver-major bump should be at 2.2 (enforcement), not 2.1 (socket) |

### Claude's response (all accept-and-amend):

- **re: O1** — Accept. Amend §3.2: enumerate `ccxray open` (POST bootstrap-token) and `ccxray status` (GET health + GET hub/status) as callers that must migrate to socket in the same commit.
- **re: O2** — Accept. Amend §3.2: `discoverHub` will probe via socket (connect attempt to `sockPath`), falling back to HTTP `/_api/health` only for version-mismatch clients. `/_api/health` stays alive (not 410) as the only HTTP hub route retained.
- **re: O3** — Re-tag as **implementation**: creating a caller inventory is execution diligence within the already-agreed Unix socket approach, not a directional choice. Accept. Amend: produce caller inventory as step 0 before coding.
- **re: O4** — Re-tag as **implementation**: Windows Named Pipes deferral was explicitly designed in spec (candidate-AB.md §3.7); documenting it in the PR is a writing task. Accept. Amend: add "Windows: hub mode unsupported, standalone fallback" note to PR description.
- **re: O5** — Accept. Amend: version stays 1.x through 2.1 (socket, non-breaking). Bump to 2.0.0 accompanies 2.2 (enforcement, breaking).

### Amended plan additions:

**Pre-coding step**: Produce complete HTTP hub route caller inventory:
1. `discoverHub` → `checkHubHealth(port)` → GET `/_api/health` — **migrate to socket probe**
2. `registerClient(port, pid, cwd)` → POST `/_api/hub/register` — **migrate to socket**
3. `unregisterClient(port, pid)` → POST `/_api/hub/unregister` — **migrate to socket**
4. `ccxray open` (index.js) → POST `/_api/hub/bootstrap-token` — **migrate to socket**
5. `ccxray status` (index.js) → GET `/_api/health` + GET `/_api/hub/status` — **migrate to socket**
6. Dashboard SSE reconnect → GET `/_api/health` — **keep on HTTP** (browser can't use socket)
7. `probeHubStatus` (orphan port detection) → GET `/_api/health` — **keep on HTTP** (probes arbitrary ports)

**Route retention**: `/_api/health` stays alive on HTTP (for dashboard + orphan probe). All other `/_api/hub/*` routes → 410.

**Version bump**: 1.x for 2.1 (socket). 2.0.0 for 2.2 (enforcement).

**Windows**: PR description notes hub mode requires Unix socket; Windows falls back to standalone mode (no hub sharing).

PROCEED_AMENDED
