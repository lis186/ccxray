## 1. HKDF + HMAC cookie verifier (commit 1.1, `cbd083e`)

- [x] 1.1 HKDF-SHA256 derivation: `getRootSecret()` → `deriveSecrets()` → `{K_upstream, K_session, K_bootstrap}`
- [x] 1.2 `signCookie(payload, K_session)` → base64url(payload).base64url(hmac)
- [x] 1.3 `verifyCookie(raw, K_session)` → constant-time HMAC comparison
- [x] 1.4 `compareSecret(a, b)` → timing-safe buffer comparison
- [x] 1.5 Ephemeral secret: `readOrCreateEphemeralSecret()` → `~/.ccxray/local-secret` (mode `0600`)
- [x] 1.6 TDD: `test/auth-hkdf.test.js` (HKDF derivation) + `test/auth-cookie.test.js` (sign/verify)

## 2. Two-domain dispatcher (commit 1.2, `6d4b4eb`)

- [x] 2.1 `classifyDomain(req)` → `'upstream'` for `/v1/*`, `'dashboard'` for rest
- [x] 2.2 `verifyUpstream(req, res)` → delegates to `authMiddleware` + deprecation headers for Bearer/token-query
- [x] 2.3 `verifyDashboard(req, res)` → cookie check first, then legacy `authMiddleware` fallback
- [x] 2.4 `dispatch(req)` → `{domain, verify}` — call site in `server/index.js` swapped from direct `authMiddleware`
- [x] 2.5 TDD: `test/auth-dispatcher.test.js`

## 3. Bootstrap flow (commit 1.3, `7b94469`)

- [x] 3.1 `mintBootstrapToken()` → random token, store HMAC hash, 60s TTL, cap 8 pending
- [x] 3.2 `redeemBootstrap(token)` → verify + delete (single-use) → mint session cookie
- [x] 3.3 `authStatus(req, res)` → `/_auth/status` endpoint (200 if cookie valid, 401 otherwise)
- [x] 3.4 `server/routes/auth.js` → `/_auth/redeem` POST handler with Sec-Fetch-Site CSRF check
- [x] 3.5 `public/index.html` → inline bootstrap script (fragment probe → POST → cookie → reload)
- [x] 3.6 `server/hub.js` → `/_api/hub/bootstrap-token` POST route (loopback-only)
- [x] 3.7 `ccxray open` CLI command → mint token → open browser with `#k=` fragment
- [x] 3.8 TDD: `test/auth-bootstrap.test.js`
- [x] 3.9 Browser-harness E2E verification (GREEN 5/5)

## 4. Launcher header injection (commit 1.4a, `4b0d142`)

- [x] 4.1 `getUpstreamToken()` → try derive K_upstream base64url, catch → warn + null
- [x] 4.2 Claude `createLaunch`: inject `ANTHROPIC_CUSTOM_HEADERS="X-Ccxray-Auth: <K>"`
- [x] 4.3 Claude: append to existing `ANTHROPIC_CUSTOM_HEADERS` if present
- [x] 4.4 Codex API-key: inject `model_providers.ccxray={...http_headers...}` + `model_provider="ccxray"`
- [x] 4.5 Codex ChatGPT-OAuth: skip model_provider override, use legacy path
- [x] 4.6 TDD: `test/auth-launcher.test.js`

## 5. WS upgrade auth gate + header stripping (commit 1.4b, `aef3f86`)

- [x] 5.1 `isJwtShaped(authHeader)` → Bearer + 3 dot-separated parts + header >10 chars
- [x] 5.2 `classifyUpstreamAuth(headers)` → `'authed'` / `'chatgpt-oauth'` / `'warn'`
- [x] 5.3 Wire into `handleWebSocketUpgrade`: warn-only log for `'warn'` class
- [x] 5.4 `buildWebSocketHeaders` strip `x-ccxray-auth`, `x-ccxray-bootstrap`
- [x] 5.5 TDD: `test/auth-ws.test.js`

## 6. HTTP forward header stripping (commit 1.4c, `0357e09`)

- [x] 6.1 `CCXRAY_INTERNAL_HEADERS` array in `server/index.js`
- [x] 6.2 `buildForwardHeaders` deletes ccxray-internal headers before upstream

## 7. E2E tests (commit `803d91a`)

- [x] 7.1 HTTP forward strips X-Ccxray-Auth + X-Ccxray-Bootstrap from upstream request
- [x] 7.2 Disk logs (_req.json) contain no auth header values
- [x] 7.3 WS upgrade without X-Ccxray-Auth emits warning but succeeds
- [x] 7.4 ChatGPT-OAuth carve-out: no warning
- [x] 7.5 WS upgrade strips ccxray-internal headers from upstream handshake

## 8. Phase 2 reorder documentation (commit `0052492`)

- [x] 8.1 errata.md §5: reorder Phase 2 (Unix socket before enforcement)
- [x] 8.2 depandabot audit artifact: `docs/depandabot/2026-05-26-phase-2-auth-adjustments.md`
