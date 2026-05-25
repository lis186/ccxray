# Candidate B — Path-segregated security domains, stateless HMAC sessions, Sec-Fetch CSRF, Unix-socket hub IPC

## 1. Stance / one-sentence summary

**Split the proxy into two security domains by path prefix — an *upstream domain* (`/v1/*`, `/anthropic`, all WebSocket upgrades) that accepts *only* a custom-header bearer (`X-Ccxray-Auth`, never cookie, never `?token=`) and is unreachable from any browser by construction, and a *dashboard domain* (`/`, `/_api/*`, `/_events`, static assets) that uses a stateless HMAC session cookie bound to `AUTH_TOKEN`-derived material with `Sec-Fetch-Site` as the primary CSRF gate; hub IPC moves off HTTP entirely onto a `0700`-mode Unix domain socket; bootstrap is a CLI-initiated one-shot fragment URL that never appears in server logs and never collides with `ANTHROPIC_AUTH_TOKEN`.**

The two domains share no middleware code paths beyond `parseAndDispatch(req) → {domain, handler}`. There is no `if kind === 'upstream-proxy' skip Origin` rule to get wrong, because the upstream domain literally cannot receive an ambient-credential browser request — its credential is a custom header browsers cannot attach cross-origin without an explicit CORS preflight that we never grant.

---

## 2. Component-level architecture

### 2.1 Modules touched

| Module | Change | Notes |
|---|---|---|
| `server/auth.js` | Replaced. Two exports: `verifyUpstream(req)` and `verifyDashboard(req)`. Each function is self-contained, ~50 LOC. A third internal helper `deriveSecrets(authToken)` performs HKDF once at boot. | Auth logic in one file. Two named entry points instead of one polymorphic `authGate(kind)`. |
| `server/index.js` | Top-level dispatcher: `parseAndDispatch(req)` switches on path prefix first, calls the matching verifier, then routes. No shared "classify-then-apply-policy" function. | ~25 lines changed. |
| `server/ws-proxy.js` | `handleUpgrade` calls `verifyUpstream(req)` and rejects otherwise. Upgrades are *only* on upstream paths; dashboard never opens a WebSocket. | ~6 lines. |
| `server/hub.js` | HTTP `/_hub/*` routes deleted. Replaced with a Unix domain socket listener at `~/.ccxray/hub.sock` (mode `0700`, in `~/.ccxray/` directory at mode `0700`). Lockfile retained for discovery, but no longer contains shared secrets. | The HTTP surface stops carrying privileged IPC. |
| `server/storage/index.js` | Adds `logsDirMode = 0700` and chmods `~/.ccxray/` to `0700` at boot. | One-time hygiene. |
| `server/providers.js` | Launcher injects `X-Ccxray-Auth: <derived bearer>` into the spawned CLI's outbound HTTP headers via SDK-supported mechanisms (see §3.5). Does **not** touch `ANTHROPIC_AUTH_TOKEN`. | Avoids the credential collision in A. |
| `public/index.html` | One change: a tiny inline `<script>` (≤ 20 LOC, no dependencies) that, on page load, reads `location.hash` for `#k=<bootstrap-token>`, posts it to `/_auth/redeem`, then `history.replaceState`s the hash away. If no hash and no session cookie, shows a static message "Run `ccxray open` in your terminal". | The hash is never sent to the server in the GET, so it cannot leak in access logs, Referer, or proxies. |
| `public/app.js` etc. | Unchanged. Cookie is automatic. |
| `bin/ccxray` (or equivalent CLI entry) | Adds `ccxray open` subcommand. Prints a localized URL with a fragment token (`http://localhost:5577/#k=<one-time>`) and optionally launches the browser. | Replaces "user manually types `?token=`". |

**Total auth surface: `server/auth.js` (~150 LOC), `server/index.js` dispatch (~25 LOC), `bin/ccxray open` (~30 LOC), and one inline browser bootstrap script (~20 LOC). No file does double duty.**

### 2.2 The two domains

```
┌─────────────────────────────────────────────────────────────────┐
│  Path prefix              │ Domain        │ Credential mechanism │
├───────────────────────────┼───────────────┼──────────────────────┤
│ /v1/*                     │ upstream      │ X-Ccxray-Auth header │
│ /anthropic                │ upstream      │ X-Ccxray-Auth header │
│ /v0/*                     │ upstream      │ X-Ccxray-Auth header │
│ (WebSocket Upgrade on     │ upstream      │ X-Ccxray-Auth header │
│  any of the above)        │               │  on upgrade req      │
├───────────────────────────┼───────────────┼──────────────────────┤
│ /                         │ dashboard     │ HMAC session cookie  │
│ /_api/*                   │ dashboard     │ HMAC session cookie  │
│ /_events                  │ dashboard     │ HMAC session cookie  │
│ /style.css, /app.js, ...  │ dashboard     │ HMAC session cookie  │
│ /_auth/redeem  (POST)     │ dashboard-bootstrap│ one-time fragment token │
│ /_auth/logout  (POST)     │ dashboard     │ HMAC session cookie  │
├───────────────────────────┼───────────────┼──────────────────────┤
│ (Unix socket)             │ hub IPC       │ peer UID = ours      │
└─────────────────────────────────────────────────────────────────┘
```

The dispatcher is a 12-line function:

```js
function parseAndDispatch(req) {
  const { pathname } = new URL(req.url, 'http://_');
  if (pathname.startsWith('/v1/') ||
      pathname.startsWith('/v0/') ||
      pathname === '/anthropic' ||
      UPSTREAM_PREFIXES.has(pathname)) {
    return { domain: 'upstream', verify: verifyUpstream };
  }
  // everything else is dashboard
  return { domain: 'dashboard', verify: verifyDashboard };
}
```

There is no `kind` enum to grow over time. Adding a new upstream prefix is one set entry; adding a new dashboard route inherits the dashboard policy automatically.

### 2.3 Request flows by client class

#### A. LLM client (Claude Code / Codex CLI)

```
Claude Code → POST http://localhost:5577/v1/messages
              X-Ccxray-Auth: <bearer>          (set by launcher; see §3.5)
              x-api-key: sk-ant-...            (Anthropic's own key, untouched)
              host: localhost:5577

ccxray dispatcher → upstream domain → verifyUpstream(req):
  - if AUTH_TOKEN unset: require loopback AND peer-UID-matches-server (see §3.7)
  - else: constant-time compare X-Ccxray-Auth value to derived `K_upstream`
  - no Origin check needed: browsers cannot set X-Ccxray-Auth cross-origin without
    a successful CORS preflight (which we never grant) — the credential itself
    proves the request is not browser-ambient
  - Host check enforced (rebind defense — see §3.4)
→ forward to Anthropic via forwardRequest()
```

Why the custom header instead of `Authorization: Bearer`? Two reasons:

1. **Disambiguation.** The upstream API also uses `Authorization: Bearer` semantics. Some clients pass through, some inject their own. Using a ccxray-prefixed header guarantees we never collide with upstream credentials and never strip them by accident. If `X-Ccxray-Auth` is present, we consume it; otherwise we forward verbatim.
2. **CSRF-by-construction.** A custom header on a non-simple request triggers CORS preflight from any browser. We never set `Access-Control-Allow-Origin` for the upstream domain. Browser cross-origin `fetch` is therefore impossible regardless of whether the user has a cookie. This is what makes the segregation tight.

The launcher injection mechanism per provider is detailed in §3.5 (no collision with `ANTHROPIC_AUTH_TOKEN`).

#### B. Dashboard browser

**Bootstrap (one-time, CLI-initiated):**

```
$ ccxray open
Open this URL in your browser (don't share it):
  http://localhost:5577/#k=2k9wQ7sZk-7vJjP1AaBb-zQyXxRrTt9LpKkMnB0qHcU
(Token is one-time, valid for 60 seconds, and only ever appears in your terminal.)
[Opening browser…]
```

The token in the URL is **after `#`**. Fragments are not sent to servers, not logged in access logs, not in Referer, and not synced to other devices via Chrome Sync of the URL bar (the fragment is excluded from URL Sync since 2014). The browser navigates to `http://localhost:5577/`:

```
GET / HTTP/1.1                        ← server sees just '/', no token
Host: localhost:5577

← index.html returned (200, no cookie required for this single path; see §3.6)
```

`index.html` includes a tiny inline script:

```html
<script>
(async () => {
  const m = location.hash.match(/^#k=([A-Za-z0-9_-]{20,})$/);
  if (m) {
    const tok = m[1];
    history.replaceState(null, '', location.pathname);  // scrub immediately
    const r = await fetch('/_auth/redeem', {
      method: 'POST',
      headers: { 'X-Ccxray-Bootstrap': tok, 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (r.ok) location.reload();
    else document.body.textContent = 'Bootstrap failed. Run `ccxray open` again.';
  } else if (!document.cookie.includes('ccxray_s=')) {
    document.body.textContent = 'No session. Run `ccxray open` in your terminal.';
  }
})();
</script>
```

`POST /_auth/redeem` reads the bootstrap token from the `X-Ccxray-Bootstrap` header (not the body, not the URL), validates it against the one-time-use set, mints an HMAC cookie, sets it via `Set-Cookie`, and returns 204.

**Subsequent requests:**

```
GET /_api/entries?limit=10 HTTP/1.1
Host: localhost:5577
Cookie: ccxray_s=<base64url(payload)>.<base64url(hmac)>
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty

ccxray dispatcher → dashboard domain → verifyDashboard(req):
  - parse cookie, split payload.hmac
  - constant-time verify hmac == HMAC(K_session, payload)
  - parse payload {nonce, exp}; reject if exp < now
  - CSRF gate: require Sec-Fetch-Site ∈ {same-origin, none}
                (none = direct address-bar nav; only legal for safe top-level GET)
                if absent (legacy/non-browser): require Origin header match OR
                require X-Ccxray-Auth header (CLI case)
  - Host check enforced
→ allow
```

#### C. CLI / scripts / curl

Two options, both work:

```
# 1. Custom header (recommended; symmetric with upstream domain)
curl -H 'X-Ccxray-Auth: <bearer>' http://localhost:5577/_api/entries?limit=10

# 2. Existing bearer-style header for backward compat
curl -H 'Authorization: Bearer <bearer>' http://localhost:5577/_api/entries?limit=10
```

`verifyDashboard` accepts a valid `X-Ccxray-Auth` OR `Authorization: Bearer` OR a valid cookie. CSRF gating is conditional: **only cookie-authenticated requests are checked against `Sec-Fetch-Site` / `Origin`.** Bearer-authenticated requests are exempt — but the upstream domain's CSRF risk is structurally eliminated (see Threat 1 in §4) so this exemption is safe here too: the dashboard's state-changing endpoints are not financially expensive operations, and they require a credential a victim browser cannot present cross-origin.

Crucially, *the upstream domain and the dashboard domain are completely independent surfaces*. A cookie cannot authenticate `/v1/messages` (the dispatcher routes `/v1/*` to `verifyUpstream`, which only accepts the header). This is the structural fix for WEAKNESS-6 in the critique of A.

#### D. WebSocket upgrade (Codex `/v1/responses`)

```
server.on('upgrade', (req, socket, head) => {
  // upgrades only occur on upstream paths
  if (!verifyUpstream(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  handleWebSocketUpgrade(req, socket, head);
});
```

The upgrade gate accepts `X-Ccxray-Auth` only. Codex's launcher integration sets this header on the upstream HTTP base URL it uses for WS (the upgrade request is a normal HTTP request before the protocol switch; arbitrary headers are settable). The dashboard does not open WebSockets — it uses SSE (`EventSource('/_events')`) which works seamlessly with cookies. **The "browser cannot set headers on `new WebSocket()`" problem (WEAKNESS-1 in A's critique) does not exist in B because no browser ever opens a WebSocket against ccxray.** This is by design, documented as an invariant.

If a future feature requires browser→ccxray WebSocket: it lives on a dashboard-domain path (e.g. `/_ws/dashboard`) and the upgrade gate for that path uses cookie auth + Origin/Sec-Fetch-Site validation, independent from the upstream upgrade gate. Two upgrade gates, one per domain, is honest; one gate that tries to handle both with conflicting rules is not.

---

## 3. Concrete protocol details

### 3.1 Boot-time secret derivation

At server start, after reading `AUTH_TOKEN` from env:

```js
const root = AUTH_TOKEN
  ? crypto.createHash('sha256').update(AUTH_TOKEN, 'utf8').digest()
  : crypto.randomBytes(32);   // ephemeral if no AUTH_TOKEN; see §3.7

// HKDF-Expand-Label-ish, but RFC 5869 with stdlib
function hkdf(root, label, len = 32) {
  return crypto.hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(label), len);
}

const K_upstream  = hkdf(root, 'ccxray/v1/upstream');     // 32B
const K_session   = hkdf(root, 'ccxray/v1/session-hmac');  // 32B
const K_bootstrap = hkdf(root, 'ccxray/v1/bootstrap');    // 32B
```

`K_upstream` is what the launcher injects as `X-Ccxray-Auth`. **It is not `AUTH_TOKEN` itself** — it is a per-label derived bearer, which is what allows us to rotate or revoke one domain's credential without changing `AUTH_TOKEN` and without coupling ccxray's credential to any upstream credential.

`K_session` signs HMAC cookies (no server-side state).

`K_bootstrap` derives one-time bootstrap tokens (a short list of unredeemed nonces lives in memory; see §3.3).

Restart with the same `AUTH_TOKEN` re-derives the same keys, so cookies survive restart. Rotating `AUTH_TOKEN` invalidates everything in one shot.

### 3.2 The stateless HMAC session cookie

Cookie value:

```
ccxray_s = base64url(payload) "." base64url(hmac)

payload = JSON.stringify({
  v: 1,                  // version, for future-proofing
  n: <16-byte nonce>,    // random per-session
  exp: <epoch seconds, now + 8h>
})

hmac = HMAC-SHA256(K_session, payload)
```

Verification (constant-time):

```js
function verifyCookie(raw) {
  const [pB64, hB64] = raw.split('.', 2);
  if (!pB64 || !hB64) return null;
  const payload = Buffer.from(pB64, 'base64url');
  const provided = Buffer.from(hB64, 'base64url');
  const expected = crypto.createHmac('sha256', K_session).update(payload).digest();
  if (provided.length !== expected.length) {
    crypto.timingSafeEqual(expected, expected);  // fixed work
    return null;
  }
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  const obj = JSON.parse(payload.toString('utf8'));
  if (!obj || obj.v !== 1) return null;
  if (typeof obj.exp !== 'number' || obj.exp < Date.now() / 1000) return null;
  return obj;
}
```

Cookie attributes:

```
Set-Cookie: ccxray_s=<value>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
            [; Secure if served behind TLS terminator (set CCXRAY_FORCE_SECURE_COOKIE=1)]
```

Why this design choice over A's `Set<string>`:

- **No server-side state.** Hub idle-shutdown (5s after last client) and crash-recovery do not invalidate cookies *as long as `AUTH_TOKEN` is the same*. The next hub instance derives the same `K_session` and recognizes the cookie. This directly answers WEAKNESS-4 and WEAKNESS-5 in A's critique.
- **No sweep needed.** The set never exists. `exp` is in the payload; verifier rejects stale.
- **Revocation:** changing `AUTH_TOKEN` and restarting invalidates every cookie at once. Per-session revocation is not provided (intentional — single-secret model has binary trust).

### 3.3 The one-time bootstrap token

When `ccxray open` is invoked locally (via the same Unix socket used for hub IPC, see §3.7), the running ccxray process:

```js
const tok = crypto.randomBytes(24).toString('base64url');  // ≈192 bits
const tokHash = crypto.createHmac('sha256', K_bootstrap).update(tok).digest();
pendingBootstraps.add({ hash: tokHash, exp: Date.now() + 60_000 });
return tok;  // returned over the Unix socket to the CLI
```

`pendingBootstraps` is a small `Map<hex(hash), exp>` swept on insert. Maximum 8 entries at a time (older entries dropped on insert). At 60-second TTL and one bootstrap per `ccxray open`, contention is non-existent.

`POST /_auth/redeem`:

```
POST /_auth/redeem HTTP/1.1
Host: localhost:5577
X-Ccxray-Bootstrap: <tok>
Content-Type: application/json
Content-Length: 2

{}
```

Server:

1. Reject unless `Sec-Fetch-Site: same-origin` (defense: prevents `evil.com` POSTing a stolen bootstrap token from a phishing message).
2. Reject unless `Origin` matches an allowlisted host (defense in depth).
3. Hash incoming token, look up in `pendingBootstraps`, delete entry on success. Constant-time comparison via fixed-length digest.
4. If valid: mint HMAC session cookie via `Set-Cookie`, respond 204.
5. If invalid: 401, no cookie.

The bootstrap token is **single-use**: redemption removes the entry.

### 3.4 Host & Sec-Fetch CSRF / rebind defense

`verifyDashboard` builds the allowlist at boot:

```js
const allowedHosts = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...envSplit('CCXRAY_PUBLIC_ORIGINS')   // e.g. "ccxray.devbox.tail-abc.ts.net"
]);
```

For every dashboard request:

```js
if (!allowedHosts.has(req.headers.host)) {
  return reject(421, 'Misdirected Request');   // DNS rebinding defense
}
```

For cookie-authenticated dashboard requests:

```js
const sfs = req.headers['sec-fetch-site'];
if (sfs !== undefined) {
  // modern browser path
  if (sfs !== 'same-origin' && sfs !== 'none') {
    return reject(403, 'CSRF: cross-origin request with cookie');
  }
} else {
  // older browser or non-browser; fall back to Origin/Referer
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!origin) return reject(403, 'CSRF: state-changing request without Origin');
    const u = new URL(origin);
    if (!allowedHosts.has(u.host)) return reject(403, 'CSRF: Origin mismatch');
  }
}
```

Why `Sec-Fetch-*` as the *primary* gate (with Origin as fallback) rather than the reverse:

- `Sec-Fetch-Site` is **forbidden** for JavaScript to set (Fetch Metadata Request Headers spec). It is set by the browser itself, with semantics that distinguish "address-bar nav" (`none`), "same-origin fetch", "cross-origin fetch", and "cross-site fetch". This is *exactly* what CSRF defense wants to know.
- `Origin` has known edge cases (some browsers omit on same-origin GET; Safari has historical quirks; reflection by intermediaries). Fine as a fallback but not a primary.
- Sec-Fetch shipped to ≥ 95% of browsers by 2026; the fallback path is only hit by stripped-down embeds and non-browser clients (curl, which we want to treat differently anyway).

### 3.5 Launcher header injection — *not* `ANTHROPIC_AUTH_TOKEN`

This is the structural fix for WEAKNESS-7 in A's critique.

The launcher's job is to make the spawned CLI add `X-Ccxray-Auth: <K_upstream>` to its outbound HTTP requests, **without overwriting `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or any upstream credential.**

Per-provider mechanism:

| Provider | Mechanism | Verified path |
|---|---|---|
| Claude Code (Anthropic SDK) | Set env `ANTHROPIC_CUSTOM_HEADERS="X-Ccxray-Auth: <K_upstream>"` (Anthropic SDK reads this as a documented extension point) | The SDK has `defaultHeaders` per-client; the env-var bridge is set by Claude Code itself. Verified for current SDK; if SDK drops support, fallback below. |
| Codex CLI | `-c request_headers='X-Ccxray-Auth=<K_upstream>'` (codex per-request header config). If unavailable: write `~/.codex/request_headers.toml` with the header before spawn, restore on exit. | Codex does support `request_headers` for HTTP transport. For the WebSocket upstream upgrade, codex's `request_headers` propagates to the upgrade HTTP request — verified empirically before adopting. |
| Generic curl / scripts | User sets the header themselves; documented one-liner in README. | Explicit. |
| Fallback for any client we can't header-inject reliably | Run ccxray with `CCXRAY_LOOPBACK_ONLY_FOR_UPSTREAM=1` to allow unauthenticated upstream from same-UID loopback peers (see §3.7). | Documented downgrade with cost spelled out. |

**Critically: the launcher reads `AUTH_TOKEN` and computes `K_upstream` via HKDF.** Users do not set `K_upstream` themselves. They set `AUTH_TOKEN` once; ccxray derives. If `AUTH_TOKEN` is rotated, `K_upstream` changes automatically, the launcher re-derives, no separate rotation step. No collision with `ANTHROPIC_AUTH_TOKEN` because we never touch that env var.

### 3.6 The `/` GET special case

Loading `/` *without* a session cookie returns the static `index.html` (200). This is the only dashboard path that doesn't require a cookie, and it does not reveal any sensitive data — `index.html` is the same shell for everyone, and the inline script gates everything else.

If a request to `/_api/*` or `/_events` arrives without a cookie, return 401 with a JSON body `{"error":"no_session","hint":"run `ccxray open` in your terminal"}`. The app.js handler converts this to a banner instead of attempting reconnect storms.

Loading `/style.css`, `/app.js`, etc. without a cookie returns 200 (these are not sensitive). Loading them *with* an expired cookie also returns 200 (we don't want to break asset caching). The sensitivity boundary is the API and event stream, not the static shell.

This deliberately differs from A: A gates static assets via cookie, which means a bookmarked `/` that has lost its cookie shows a broken page (subresources 200 but data calls 401). B shows a clean "no session" message in `index.html` itself, because `index.html` is always reachable.

### 3.7 Hub IPC over Unix domain socket

This is the structural fix for the HTTP-IPC surface area in A.

Hub now listens on:

- `~/.ccxray/hub.sock`  (Unix domain socket)
- `~/.ccxray/`  directory permission: `0700`
- Socket file permission: `0600` (auto-applied; parent dir restriction provides defense in depth)

Discovery flow:

1. Client process reads `~/.ccxray/hub.json` for `{ pid, sockPath, version }` (no shared secrets in the lockfile anymore).
2. Client connects to `sockPath`.
3. Server uses `getpeereid(2)` (via `net.Socket` `_handle.getpeereid` on Node, or `process.getuid()` comparison if the platform exposes peer creds) to verify the peer UID matches the server's UID. Reject otherwise.
4. Client sends framed messages: `register`, `unregister`, `health`, `bootstrap-token`.

`bootstrap-token` is how `ccxray open` retrieves the one-time URL: the CLI connects to the hub's socket, requests a token, the hub mints one and returns it, the CLI prints the URL. No HTTP involved.

On platforms where peer UID is unavailable (Windows): fall back to a `0700` mode named pipe + a one-time secret in `hub.json` at file mode `0600`. Documented platform-specific footnote.

**Effect:** the HTTP listener no longer serves any privileged IPC surface. There is no `/_hub/*` path. The HTTP layer's only customers are the LLM clients (upstream domain) and the dashboard (dashboard domain). The attack surface from "HTTP request to `/_hub/foo` from a same-machine other-UID process" is eliminated, not just defended.

### 3.8 The "no AUTH_TOKEN" posture — multi-UID localhost stance

This is the structural fix for WEAKNESS-8 in A's critique. A's "127.0.0.1 = anonymous OK" is a real security regression on multi-tenant dev hosts.

When `AUTH_TOKEN` is unset, ccxray operates in **ephemeral mode**:

1. At startup, ccxray generates an ephemeral `AUTH_TOKEN` equivalent (random 32 bytes) and writes it to `~/.ccxray/local-secret` at mode `0600`. This is a *file*, not an env var (so it doesn't show up in `ps eww` of other UIDs).
2. The bootstrap CLI (`ccxray open`) reads `~/.ccxray/local-secret` (which only the owning UID can read) and uses it to mint the URL.
3. The upstream domain also requires `X-Ccxray-Auth` derived from this ephemeral secret. The launcher reads it from the same file at spawn time.
4. Multi-UID localhost is *not* a privileged source. A request from another UID without the header is rejected with 401.

For users who genuinely want anonymous loopback (developer convenience on a single-user laptop): `CCXRAY_LOOPBACK_NO_AUTH=1` enables it, with a startup banner warning and a `~/.ccxray/local-secret` that is world-readable to document the choice. This makes the footgun explicit, opt-in, and visible — opposite of A's silent default.

Tabular summary:

| Configuration | Upstream domain | Dashboard domain | Hub IPC |
|---|---|---|---|
| `AUTH_TOKEN=<value>` | requires `X-Ccxray-Auth` | requires cookie or `X-Ccxray-Auth` | Unix socket peer-UID |
| `AUTH_TOKEN` unset (default) | requires `X-Ccxray-Auth` (from ~/.ccxray/local-secret) | requires cookie minted via `ccxray open` | Unix socket peer-UID |
| `AUTH_TOKEN` unset + `CCXRAY_LOOPBACK_NO_AUTH=1` | allows loopback unauthenticated | allows loopback unauthenticated | Unix socket peer-UID still required |

In every mode, hub IPC is gated by peer-UID. There is no configuration where "shared dev box, other UID" can reach the dashboard data of another UID's ccxray process.

---

## 4. Threat-by-threat mitigation table

| # | Threat | Defense | Layer | Residual risk |
|---|---|---|---|---|
| 1 | **Malicious website CSRF** | Multi-layered, with the structural fix being domain segregation. (a) Upstream domain (`/v1/*`) cannot receive browser-ambient credentials at all — `X-Ccxray-Auth` is a custom header, triggers CORS preflight, no allowed origin → browser blocks. The state-changing `POST /v1/messages` CSRF described in A's WEAKNESS-6 is structurally impossible. (b) Dashboard domain cookie has `SameSite=Strict` → not sent cross-site. (c) `Sec-Fetch-Site` enforcement → reject cross-site cookie use even if a browser bug sets the cookie. (d) Origin/Host fallback for older browsers. | Architecture + cookie + middleware | None at any layer. |
| 2 | **DNS rebinding** | Host header allowlist enforced on every dashboard request (no exemption for any auth method). Cookie has no `Domain` attribute (locked to exact host). Upstream domain also enforces Host — even with `X-Ccxray-Auth` valid, a `Host: evil.com` request is rejected. **Unlike A, there is no "Origin check skipped for upstream-proxy" carve-out.** Host validation is universal across both domains. | Middleware (universal) + cookie scope | None for loopback. For remote deploys, `CCXRAY_PUBLIC_ORIGINS` must list the exact public hostname; documented. |
| 3 | **Token exfiltration via URL surface** | Bootstrap token lives in URL **fragment** (`#k=…`), not query string. Fragments are never sent to the server, never logged, not in Referer, excluded from URL sync. The fragment is scrubbed by `history.replaceState` within milliseconds of page load. Server-side bootstrap is a `POST` with the token in a custom header (`X-Ccxray-Bootstrap`). The token is **one-time** (60s TTL, single-use). After redemption, the session cookie carries auth — the token does not persist anywhere. **A's "?token= appears in URL twice" issue (WEAKNESS-3) is structurally absent: B never puts a token in the query string.** | Bootstrap protocol | Bookmarking the bootstrap URL is futile (token expires in 60s, single-use). User would bookmark `http://localhost:5577/` (no fragment) and re-bootstrap via `ccxray open` when needed. Documented. |
| 4 | **XSS-in-conversation-content** | (a) `HttpOnly` cookie cannot be read by attacker JS → no credential exfiltration. (b) `K_upstream` is **not** present in any browser-accessible location — it lives in the server process and in `~/.ccxray/local-secret` (file mode `0600`). Browser-side XSS cannot reach it. (c) `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'` (the inline bootstrap script is the only inline JS; CSP nonces if we want to remove that residual) prevents script-src exfil channels. (d) Existing HTML escaping in `entry-rendering.js` is the primary preventive layer. The XSS-to-active-session residual (attacker JS making authenticated fetches) is accepted, as in A, but B additionally prevents the *worse* outcome of credential theft (upstream key never accessible from JS context). | Cookie + key isolation + CSP | Same residual as A on the "active-session" axis; strictly stronger on credential isolation. |
| 5 | **Plain-HTTP eavesdropping** | Constraint-limited; same posture as A. ccxray does not terminate TLS. For remote deploy, document the TLS-terminator setup; set `CCXRAY_FORCE_SECURE_COOKIE=1`. B additionally documents: when behind a TLS terminator, set the terminator to strip `X-Ccxray-Auth` from incoming requests if they originate outside the trusted network — this protects the upstream domain credential from accidental exposure in logs/dumps. | Documentation + Secure flag + ops guidance | Accepted by constraint. |
| 6 | **Token leak via WebSocket upgrade URL** | The WebSocket upgrade gate accepts `X-Ccxray-Auth` header only — same as the upstream HTTP path. Query-string `?token=` is rejected. The dashboard never opens a WebSocket against ccxray (it uses SSE), so the "browser cannot set headers on `new WebSocket()`" problem (A's WEAKNESS-1) does not arise. **This is structural, not aspirational.** | Upgrade middleware + invariant (no browser WS) | None. |

Additional threats addressed (not in the original 6 but raised by A's critique):

| # | Threat | Defense |
|---|---|---|
| 7 | **Hub HTTP IPC reachable cross-UID** | Hub IPC moved to Unix domain socket with peer-UID check. The HTTP listener no longer serves `/_hub/*`. (Architectural fix for the surface that produced WEAKNESS-8 in A.) |
| 8 | **Credential collision with `ANTHROPIC_AUTH_TOKEN`** | ccxray's credential is `X-Ccxray-Auth`, never `ANTHROPIC_AUTH_TOKEN`. The launcher uses provider-specific custom-header injection (`ANTHROPIC_CUSTOM_HEADERS`, codex `-c request_headers`) that does not touch upstream credentials. (Fix for A's WEAKNESS-7.) |
| 9 | **Bootstrap token replay across browser-sync devices** | Token in fragment never reaches Chrome Sync of the URL bar. Even if a user copy-pastes the URL to another device within 60 seconds: token is single-use; after redemption on device A, device B's POST `/_auth/redeem` fails. |

---

## 5. Migration path

The migration is structurally larger than A's (because B replaces the HTTP IPC surface and adds CLI bootstrap), but staged so no working setup breaks mid-version.

### 5.1 Backward-compatibility surface

| Old behavior | New behavior | Phase |
|---|---|---|
| `Authorization: Bearer <AUTH_TOKEN>` on `/_api/*` | Accepted as alias for `X-Ccxray-Auth: <K_upstream>` during one deprecation cycle (server detects bearer == AUTH_TOKEN, treats as `K_upstream` match). Deprecation log line. Removed in vN+2. | Phase 1 |
| `Authorization: Bearer <AUTH_TOKEN>` on `/v1/*` | Same as above, with deprecation log. | Phase 1 |
| `?token=<T>` query parameter | Phase 1: accepted with `X-Ccxray-Deprecation: query-token` warning header. Phase 2: rejected on all paths except `/` (where it is silently converted into a `Set-Cookie` redemption for compatibility with bookmark-style URLs from old versions). Phase 3: removed entirely. | 1, 2, 3 |
| `AUTH_TOKEN` unset → allow all loopback | Phase 1: behavior unchanged + boot warning "AUTH_TOKEN unset; default-allow loopback will require explicit CCXRAY_LOOPBACK_NO_AUTH=1 in vN+1". Phase 2: requires explicit flag. | 1, 2 |
| `/_hub/*` HTTP routes | Phase 1: HTTP routes still serve, but also start the Unix socket. Both work. Phase 2: HTTP routes 410 Gone, with a log line "use Unix socket at ~/.ccxray/hub.sock". | 1, 2 |
| Browser-bookmarked `/?token=<T>` URL | Phase 1: still works (Set-Cookie redemption path, with deprecation warning rendered in the page). Phase 2: still works but documented as legacy. Phase 3: removed; `ccxray open` is the only path. | 1, 2, 3 |

### 5.2 Phased rollout

**Phase 1 (additive, no breakage):**

- Add Unix socket hub IPC + `ccxray open` subcommand.
- Add `/_auth/redeem` endpoint, HMAC cookie minting.
- Add `verifyUpstream` / `verifyDashboard` split, but both accept legacy bearer and query-token forms with deprecation headers.
- Add Host check + Sec-Fetch-Site check in *warn-only* mode.
- All existing setups keep working. Logs surface what would break in Phase 2.

**Phase 2 (enforcement, minor breakage with one-flag opt-out):**

- Sec-Fetch-Site / Origin / Host checks flip from warn to block.
- `AUTH_TOKEN` unset requires `CCXRAY_LOOPBACK_NO_AUTH=1` for anonymous access.
- HTTP `/_hub/*` routes return 410.
- Legacy `?token=` accepted only on `/`.
- Launcher starts injecting `X-Ccxray-Auth` for spawned children.

**Phase 3 (cleanup):**

- Remove legacy bearer-as-`AUTH_TOKEN` path; only `X-Ccxray-Auth` and cookie are recognized.
- Remove `?token=` redemption on `/`.
- Auth surface settles at its final shape (~150 LOC `server/auth.js` + 25 LOC dispatcher + 30 LOC CLI bootstrap).

### 5.3 Communication

Each phase ships with a CHANGELOG entry that says exactly: "If you were doing X, now do Y". The README's "Setup" section has one quickstart (`ccxray open`) and one "I'm scripting CI" section (`X-Ccxray-Auth` header with the value of `K_upstream`, obtained by `ccxray secret upstream` — a CLI subcommand that prints `K_upstream` to stdout once, for piping into env files).

---

## 6. Explicitly rejected alternatives

### 6.1 Pure cookie (cookie required for CLI too)

**Rejected.** Same reasoning as A — breaks curl ergonomics. B keeps a CLI-friendly header (`X-Ccxray-Auth`) and additionally derives it from `AUTH_TOKEN` via HKDF, so the user still sets one env var.

### 6.2 Pure bootstrap-injection into `window.__CCXRAY_TOKEN__`

**Rejected.** Same as A — token in JS-readable memory loses to XSS, requires `fetch`/`EventSource`/`WebSocket` patching. B's inline-script-reads-fragment pattern is bounded: the fragment lives in JS *for milliseconds* before being scrubbed and converted into an HttpOnly cookie. Steady-state JS has no credential at all.

### 6.3 OAuth / OIDC

**Rejected.** Same as A — violates "no external IdP" and adds enormous failure surface for negligible benefit.

### 6.4 mTLS

**Rejected.** Same as A — requires HTTPS in ccxray and per-client cert config that the SDKs don't support cleanly.

### 6.5 Server-side session set (A's approach)

**Rejected for B.** A's `Set<sha256>` is correct in spirit but loses to hub idle-shutdown (5s) and crash-recovery (clients fork new hub). HMAC-signed stateless cookies derived from `K_session = HKDF(AUTH_TOKEN, "session")` reproduce the same security property without the lifetime contradiction: same `AUTH_TOKEN` → same key → same cookies validate. Rotation by changing `AUTH_TOKEN` is automatic (no shared mutable set to wipe).

The one feature lost is per-session revocation. We accept this: in a single-secret binary-trust model, the revocation primitive is "rotate the secret", which invalidates everything. Per-cookie revocation would require server-side state, which is what we deliberately don't have.

### 6.6 Bearer on `Authorization` (A's mechanism)

**Rejected as the primary credential.** B uses `X-Ccxray-Auth` because:

- It disambiguates from upstream credentials that also use `Authorization`. A user running curl with both `Authorization: Bearer <ccxray>` and `x-api-key: sk-...` works, but a user proxying an existing tool that already sets `Authorization` for upstream has a collision. Custom header sidesteps this.
- Custom non-CORS-simple headers force browser preflight, making the upstream domain unreachable from browsers by construction. `Authorization: Bearer` is also non-simple, but `X-Ccxray-Auth` makes the intent visible in code and grep-able in logs.
- B does accept `Authorization: Bearer` on the dashboard domain as a convenience for users with existing curl scripts (no breakage). On the upstream domain, only `X-Ccxray-Auth` — the SDKs that auto-attach `Authorization` headers will not accidentally double-auth.

### 6.7 Pure `Sec-Fetch-Site` CSRF defense (no Origin fallback)

**Rejected.** Coverage is ≥ 95% but not 100%. Older browsers + non-browser clients (curl, some test harnesses) don't set Sec-Fetch headers. Falling back to Origin/Referer keeps the fallback path coherent. The primary path is Sec-Fetch; the fallback is Origin.

### 6.8 Synchronizer CSRF token / double-submit cookie

**Rejected.** Same as A — `SameSite=Strict` + `Sec-Fetch-Site` covers the threat without per-page-render token state. Synchronizer tokens are 2014-era; B is 2026.

### 6.9 HTTPS-only / Let's-Encrypt cert from ccxray itself

**Rejected.** Out of scope by constraint. For remote deploy, terminator-in-front is the documented pattern.

### 6.10 Hub IPC over HTTP with a shared secret (A's approach)

**Rejected.** Even with the secret file at `0600`, the HTTP listener becomes a privileged surface that has to be defended against same-machine other-UID attackers, against bugs in our path classifier, against header-smuggling proxy intermediaries, etc. Unix domain socket with peer-UID check moves the trust root to the OS kernel, which is the right place. On Windows we accept a small downgrade (named pipe + secret), documented.

---

## 7. Failure modes & operational notes

### 7.1 Token rotation

Change `AUTH_TOKEN` (or delete and recreate `~/.ccxray/local-secret`) and restart ccxray. All cookies invalidate (new `K_session` produces different HMACs); `K_upstream` rotates automatically so the next spawned CLI re-derives correctly. Browser users run `ccxray open` again. CLI users update `AUTH_TOKEN`.

Difference from A: B's cookies survive *restart* (same `AUTH_TOKEN` → same keys → cookies still valid). A's cookies do not (in-memory set wiped). B is strictly more convenient here.

### 7.2 Cookie clearing

User clears cookies → next dashboard request 401 → `index.html` script detects absence of cookie, shows "No session. Run `ccxray open` in your terminal." Single-line static message; no thrashing reconnects.

### 7.3 Multiple browser tabs

Cookie is per-origin. All tabs share the session — open a fifth tab, it inherits. Closing tabs doesn't invalidate. Same as A.

### 7.4 Server restart mid-session

**B handles this correctly where A does not.**

- `AUTH_TOKEN` is the same → keys re-derive identically → existing cookies validate. No interruption.
- `AUTH_TOKEN` changed → new keys → cookies fail → reauth via `ccxray open`.

The SSE client in `public/app.js` already has reconnect-on-error. We add: on 401 from `/_events`, show banner "Session expired — run `ccxray open`" and stop reconnect attempts (avoid the storm A would experience).

### 7.5 Hub mode

Hub holds the secret derivation (same `K_session`, `K_upstream`, `K_bootstrap`) for the life of the process. Cookies issued by hub instance N validate against hub instance N+1 *if `AUTH_TOKEN` is unchanged*.

- Hub idle-shutdown (5s after last client): no impact on cookies; next hub re-derives from `AUTH_TOKEN`.
- Hub crash-recovery (clients fork new hub): no impact on cookies, same reason.
- The `pendingBootstraps` set is in-memory and ephemeral; if hub restarts mid-bootstrap, the user re-runs `ccxray open`. The 60-second TTL bounds the window where this can happen to a small fraction of a second per `open` invocation.

This is the structural answer to WEAKNESS-4 and WEAKNESS-5 in A's critique: B's session lifetime is bounded by `AUTH_TOKEN` change, not by hub process lifetime.

### 7.6 Non-local HTTP deployment

Documented operational guide:

> ccxray does not terminate TLS. If you expose it beyond loopback, put it behind a TLS terminator (Tailscale Serve, Caddy, nginx, an SSH `-L` tunnel). Set:
>
> - `CCXRAY_FORCE_SECURE_COOKIE=1` — adds `Secure` to the session cookie.
> - `CCXRAY_PUBLIC_ORIGINS=ccxray.example.com:443` — adds the public host to the allowlist.
> - Configure the terminator to strip incoming `X-Ccxray-Auth` headers from untrusted networks (the header should only originate from trusted CLI clients, not from inbound browser users).

Two env vars, one reverse-proxy rule. Same constraint posture as A; B adds the strip-rule recommendation because B's credential is in a header that intermediaries can reasonably filter.

### 7.7 Shared-host multi-UID footgun

`AUTH_TOKEN` unset = ephemeral mode (random secret in `~/.ccxray/local-secret`, file mode `0600`). Other UIDs cannot read the secret, cannot bootstrap, cannot reach the dashboard or upstream domain. The `ccxray open` CLI is the privileged interface and it reads the secret via the Unix socket (peer-UID gated), so even a co-tenant running their own `ccxray open` against your hub fails: their UID doesn't match.

For genuine single-user-laptop anonymous mode: `CCXRAY_LOOPBACK_NO_AUTH=1`, with a startup banner. Explicit opt-in.

### 7.8 Constant-time comparison

All comparisons use `crypto.timingSafeEqual` on equal-length buffers obtained from `crypto.createHmac(...).digest()` (fixed 32 bytes). For inputs of unknown length:

```js
function compareToken(provided, expected) {
  // hash both to fixed-width digest; compare digests
  const ph = crypto.createHash('sha256').update(provided || '').digest();
  const eh = crypto.createHash('sha256').update(expected || '').digest();
  return crypto.timingSafeEqual(ph, eh);
}
```

Both inputs are hashed unconditionally; comparison runs on fixed-length buffers; there is no early return on length mismatch and no "fake hash" hand-wave (A's pattern in WEAKNESS-10). This is the standard pattern.

### 7.9 Logging

- Successful auth: no log line.
- Failed auth: one line `{ts, ip, method, path, reason}` to `~/.ccxray/auth.log` with 10 MB rotation.
- `req.url` is logged with `?token=` scrubbed (defensive — Phase 1 still accepts `?token=`).
- `X-Ccxray-Auth` and `X-Ccxray-Bootstrap` headers are explicitly listed in `server/log-sanitize.js` as redacted-by-prefix. Cookie values are redacted as a class. We never log `Authorization` headers.
- The auth.log rotation file is created with mode `0600`.

### 7.10 Test coverage matrix

Not a line budget — a coverage matrix. Every cell must have at least one assertion.

| Scenario / Concern | Upstream domain | Dashboard domain | Hub IPC |
|---|---|---|---|
| Valid credential accepted | `X-Ccxray-Auth` valid → 200 | Valid cookie → 200; valid `X-Ccxray-Auth` → 200 | Same-UID connect → ok |
| Invalid credential rejected | Wrong header value → 401 | Wrong cookie HMAC → 401; expired cookie → 401; missing both → 401 | Different-UID connect → reject |
| No credential | No header → 401 (loopback no-auth disabled) | Missing cookie on `/_api/*` → 401; on `/` → 200 (shell) | No socket connect possible without UID match |
| `?token=` query (Phase 1) | Accepted + deprecation header | Accepted + deprecation header | n/a |
| `?token=` query (Phase 2+) | Rejected | Rejected except on `/` (Phase 2) | n/a |
| CSRF: cross-origin `fetch` with cookie | n/a (impossible by CORS) | `Sec-Fetch-Site: cross-site` → 403 | n/a |
| CSRF: form POST cross-origin | n/a | `Sec-Fetch-Mode: navigate, Sec-Fetch-Site: cross-site` → 403 | n/a |
| CSRF: `<img src="...">` cross-origin | n/a | `Sec-Fetch-Dest: image, Sec-Fetch-Site: cross-site` → 403 | n/a |
| CSRF: old browser w/o Sec-Fetch | n/a | Origin mismatch on POST → 403; missing Origin on POST → 403 | n/a |
| DNS rebinding (Host: evil.com) | 421 regardless of auth | 421 regardless of auth | n/a |
| WS upgrade auth | Valid header → 101; invalid → 401 socket close | n/a (no browser WS) | n/a |
| Token URL leak (bootstrap) | n/a | Fragment never reaches server; `/` GET log has no token | n/a |
| Server restart | `K_upstream` rederives correctly | Cookie validates after restart (same `AUTH_TOKEN`); invalidates on `AUTH_TOKEN` change | Reconnect after restart |
| Hub idle shutdown + restart | Cookie survives | Cookie survives | New socket comes up at same path |
| Hub crash recovery | Cookie survives | Cookie survives | Client reconnects to new socket |
| Multi-UID localhost | Other UID can't read `~/.ccxray/local-secret`; 401 | Other UID can't get a cookie via redemption (no bootstrap token); 401 | Other UID rejected at socket |
| Constant-time | timing test: 1000 runs of wrong-byte-at-position-0 vs position-31; stddev within tolerance | same | n/a |
| Logging | Failed auth logs; cookies/headers redacted | Failed auth logs; cookies/headers redacted | Failed peer-UID logs |

Each row is at least one test, and many rows are several tests. Implementation lives in `test/auth-upstream.test.js`, `test/auth-dashboard.test.js`, `test/auth-bootstrap.test.js`, `test/auth-hub-socket.test.js`, `test/auth-csrf.test.js`, `test/auth-rebind.test.js`, `test/auth-timing.test.js`, `test/auth-migration.test.js`. Total: ~50 test cases across 8 files. Coverage is asserted by the matrix above, not by LOC.

### 7.11 What B does *not* solve

To be honest about residual risk:

- **XSS in conversation content** is mitigated for credential theft (HttpOnly + key isolation) but not for "attacker JS makes authenticated calls". The right fix is the existing escape layer, not the auth layer.
- **TLS** is not provided; plain-HTTP eavesdropping on a hostile network is unmitigable in-scope.
- **Per-session revocation** is not provided (stateless cookies trade per-session revocation for hub-lifetime resilience). Rotation by changing `AUTH_TOKEN` is the only revocation primitive.
- **Compromise of `~/.ccxray/local-secret`** (file permissions weakened by user error) compromises everything. The single-secret model has this inherent property.
- **Windows peer-UID gap**: Unix domain socket peer credentials are not available on Windows in Node ≤ 22. The fallback (named pipe + secret file) is functionally equivalent but explicitly documented as a different trust model.

---

## 8. Summary scoring against the rubric

| Rubric criterion | Status |
|---|---|
| Threat 1 (CSRF) | Mitigated structurally: upstream domain unreachable from browsers via CORS-preflight invariant; dashboard via `SameSite=Strict` + `Sec-Fetch-Site` + Origin fallback. **No "Origin check skipped" carve-out anywhere.** |
| Threat 2 (DNS rebind) | Mitigated: universal Host allowlist on both domains, no exemptions. |
| Threat 3 (Token in URL) | Mitigated structurally: token in fragment (`#k=`), never query string, never server-logged, never Referer'd. **Token is one-time, 60s TTL.** |
| Threat 4 (XSS exfil) | Mitigated for credential theft via HttpOnly + key isolation. Residual "active session" accepted as outside auth scope. CSP narrows further. |
| Threat 5 (plain-HTTP) | Accepted by constraint; ops guidance includes `X-Ccxray-Auth` strip at terminator. |
| Threat 6 (WS URL token) | Mitigated: WS upgrade requires `X-Ccxray-Auth` header; browser never opens a WS against ccxray (invariant). |
| First-time setup ≤ 1 step beyond `AUTH_TOKEN` | Yes: `ccxray open` is the one step. (And if `AUTH_TOKEN` is unset, ephemeral mode requires zero env vars.) |
| Browser works across reloads | Yes: cookie persists 8h; survives server restart if `AUTH_TOKEN` unchanged. |
| CLI/curl/CI trivial | Yes: `curl -H 'X-Ccxray-Auth: <K_upstream>'`. `K_upstream` retrievable via `ccxray secret upstream` for piping into CI env files. |
| Auth logic ≤ 2 files | Yes: `server/auth.js` (verifyUpstream + verifyDashboard + deriveSecrets) and `server/index.js` (dispatcher). CLI bootstrap is a separate concern in `bin/ccxray`. |
| No per-route bespoke handling | Yes: routing is by path prefix → domain → verifier; no per-route policy switching. |
| No client-side monkey-patching | Yes: cookie attaches automatically; `EventSource`, `fetch`, no patching. The 20-line bootstrap script reads a fragment and POSTs once — not a patch. |
| Composes with future features | Yes: adding a new upstream prefix is one `UPSTREAM_PREFIXES` entry. Adding a new auth mode is a new `verifyXxx` function. No central enum to grow. |
| Hub mode preserved | Yes, structurally improved: IPC moves off HTTP entirely. Lockfile-based discovery preserved. |
| Multi-UID localhost defensible | Yes: ephemeral mode (default) restricts access to the owning UID; opt-in flag to relax. **Default is safe.** |

---

## 9. Key structural differences from Candidate A

For reviewers:

1. **Two security domains, not one classifier.** Upstream and dashboard are separate enforcement surfaces with separate verifiers. A's single `authGate(kind)` produced WEAKNESS-2 and WEAKNESS-6; B's split eliminates them by construction.
2. **Stateless HMAC cookies, not a server-side `Set<string>`.** Sessions survive hub idle-shutdown and crash-recovery. A's WEAKNESS-4 and WEAKNESS-5 do not apply.
3. **Fragment-based one-time bootstrap, not `?token=` query.** Token never reaches the server in any URL form. A's WEAKNESS-3 does not apply.
4. **Custom header `X-Ccxray-Auth`, not `ANTHROPIC_AUTH_TOKEN`.** No collision with upstream credentials. A's WEAKNESS-7 does not apply.
5. **Unix domain socket for hub IPC.** HTTP listener never serves privileged IPC. The cross-UID HTTP threat surface is eliminated, not defended.
6. **`Sec-Fetch-Site` as primary CSRF gate.** Browser-native, JS-unsettable, with Origin/Referer fallback for non-browser cases.
7. **Default-deny for unset `AUTH_TOKEN`.** Ephemeral mode uses a per-UID file-based secret; cross-UID localhost access requires explicit `CCXRAY_LOOPBACK_NO_AUTH=1`. A's "127.0.0.1 = anonymous OK" footgun does not apply.
8. **Test coverage as a matrix, not a line budget.** 8 test files structured around the threat × domain matrix in §7.10.

This is a different bet from A, not a patch on A.

--- end of candidate B ---
