## 1. Unix socket hub IPC (commit 2.1)

- [ ] 1.1 Add `SOCK_PATH` constant to hub.js (`path.join(HUB_DIR, 'hub.sock')`)
- [ ] 1.2 Implement `createHubSocket()`: `net.createServer` + newline-JSON framing + stale file unlink
- [ ] 1.3 Socket chmod `0600` after `listen()` completes (cross-platform safe)
- [ ] 1.4 Add `sockPath` to `hub.json` lockfile (written after socket listen succeeds)
- [ ] 1.5 Implement socket command handlers: `register`, `unregister`, `health`, `bootstrap-token`, `status`
- [ ] 1.6 Rewrite `registerClient(lockInfo)` to connect via socket (read `sockPath` from hub.json)
- [ ] 1.7 Rewrite `unregisterClient(lockInfo)` to connect via socket
- [ ] 1.8 Rewrite `discoverHub` health check: socket connect probe (try `sockPath`, 1s timeout)
- [ ] 1.9 Rewrite `ccxray open` bootstrap-token request to use socket
- [ ] 1.10 Rewrite `ccxray status` to use socket for hub status query
- [ ] 1.11 HTTP `/_api/hub/register`, `/_api/hub/unregister`, `/_api/hub/bootstrap-token`, `/_api/hub/status` → 410 Gone
- [ ] 1.12 HTTP `/_api/health` remains alive (dashboard + orphan probe need it)
- [ ] 1.13 Graceful shutdown: `server.close()` unlinks socket file
- [ ] 1.14 Crash recovery: startup probe (connect attempt → ECONNREFUSED/timeout = stale → unlink + proceed)
- [ ] 1.15 TDD: socket lifecycle (create, connect, stale cleanup)
- [ ] 1.16 TDD: framing protocol (register/unregister/health/bootstrap-token/status via socket)
- [ ] 1.17 TDD: 410 responses on deprecated HTTP hub routes
- [ ] 1.18 Integration: existing hub tests (`test/hub*.test.js`) adapted or replaced
- [ ] 1.19 Smoke test: isolated CCXRAY_HOME, spawn 2 clients, verify socket-based registration

## 2. `ccxray secret upstream` CLI command (commit 2.1 附帶)

- [ ] 2.0 Add `secret upstream` subcommand to CLI section in `server/index.js` (~10 LOC wrapping `getUpstreamToken()`)
- [ ] 2.0.1 TDD: `ccxray secret upstream` prints base64url token to stdout and exits 0

## 3. Upstream enforcement (commit 2.2, semver-major → 2.0.0)

- [ ] 3.1 Extract `_matchesLegacyToken(req)` shared helper from `authMiddleware` logic
- [ ] 3.2 `verifyUpstream`: accept `X-Ccxray-Auth` (compare against K_upstream via `compareSecret`)
- [ ] 3.3 `verifyUpstream`: reject if neither X-Ccxray-Auth nor ChatGPT-OAuth carve-out matches
- [ ] 3.4 `isAuthorized` (ws-proxy.js): accept `X-Ccxray-Auth` in addition to legacy Bearer/token
- [ ] 3.5 `isAuthorized`: reject WS upgrade if `classifyUpstreamAuth` returns `'warn'` (no longer warn-only)
- [ ] 3.6 Remove deprecation-header code from `verifyUpstream` (no more legacy acceptance)
- [ ] 3.7 `package.json` version bump to 2.0.0
- [ ] 3.8 CHANGELOG entry: breaking change + migration guide (reference `ccxray secret upstream`)
- [ ] 3.9 TDD: with AUTH_TOKEN set, launched Claude agent (X-Ccxray-Auth) → accepted
- [ ] 3.10 TDD: with AUTH_TOKEN set, curl without X-Ccxray-Auth → 401
- [ ] 3.11 TDD: ChatGPT-OAuth path (no X-Ccxray-Auth + chatgpt-account-id + JWT) → accepted
- [ ] 3.12 TDD: WS upgrade without auth → rejected (not just warned)
- [ ] 3.13 TDD: WS upgrade with X-Ccxray-Auth → accepted
- [ ] 3.14 TDD: ephemeral mode (no AUTH_TOKEN) + launched agent → accepted via local-secret derived K_upstream
- [ ] 3.15 Smoke test: real proxy + launched claude/codex, verify API calls succeed

## 4. Dashboard enforcement + ephemeral mode (commit 2.3, version 2.1.0)

- [ ] 4.1 `verifyDashboard`: reject if no valid cookie and no valid X-Ccxray-Auth
- [ ] 4.2 Keep `Authorization: Bearer <AUTH_TOKEN>` acceptance on dashboard (permanent per spec)
- [ ] 4.3 Ephemeral mode default: when AUTH_TOKEN unset, auth still required (via local-secret)
- [ ] 4.4 `CCXRAY_LOOPBACK_NO_AUTH=1` env: bypass all auth checks for loopback requests
- [ ] 4.5 Startup banner when CCXRAY_LOOPBACK_NO_AUTH=1 is active (loud warning)
- [ ] 4.6 `package.json` version bump to 2.1.0
- [ ] 4.7 TDD: dashboard without cookie → 401
- [ ] 4.8 TDD: dashboard with cookie → 200
- [ ] 4.9 TDD: CCXRAY_LOOPBACK_NO_AUTH=1 → loopback bypass works
- [ ] 4.10 TDD: non-loopback request with CCXRAY_LOOPBACK_NO_AUTH → still rejected
- [ ] 4.11 Smoke test: fresh CCXRAY_HOME, no AUTH_TOKEN → dashboard requires ccxray open

## 5. PR + review

- [ ] 5.1 Open PR (feat/auth-phase-2 → main)
- [ ] 5.2 Codex review gate
- [ ] 5.3 Merge after APPROVE
- [ ] 5.4 Note Windows limitation in PR description (hub mode requires Unix socket; Windows falls back to standalone)
