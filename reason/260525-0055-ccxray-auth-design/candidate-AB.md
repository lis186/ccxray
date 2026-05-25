# Candidate AB — Two-domain split, stateless HMAC cookie from `AUTH_TOKEN`, fragment-bootstrap with one-shot redemption, Sec-Fetch primary + Origin fallback, Unix-socket hub IPC

## 1. Stance / one-sentence summary

**Split the HTTP surface into an *upstream domain* (`/v1/*`, `/v0/*`, `/anthropic`, all WS upgrades) and a *dashboard domain* (`/`, `/_api/*`, `/_events`, static assets) with two narrow verifiers; the upstream domain accepts only a custom header (`X-Ccxray-Auth: <K_upstream>`) so browsers cannot reach it without a CORS preflight we never grant; the dashboard domain accepts an HMAC-signed stateless `HttpOnly; SameSite=Strict; Path=/` cookie derived from `AUTH_TOKEN` via HKDF (cookies survive restart and hub recycle), plus `Authorization: Bearer <AUTH_TOKEN>` as the unchanged CLI path; first-time browser bootstrap is `ccxray open` printing a one-time URL-fragment token (`/#k=<60s, single-use>`) redeemed by `POST /_auth/redeem` with the token in `X-Ccxray-Bootstrap`; CSRF is gated by `Sec-Fetch-Site ∈ {same-origin, none}` with Origin/Referer fallback for non-browser clients; DNS rebinding by a universal Host allowlist with no per-domain carve-out; hub IPC moves off HTTP onto a `0600` Unix domain socket gated by peer-UID; `AUTH_TOKEN` unset means ephemeral random secret in `~/.ccxray/local-secret` (mode `0600`), with an explicit `CCXRAY_LOOPBACK_NO_AUTH=1` opt-in for single-user laptops.**

This combines A's `Authorization: Bearer` CLI backward-compatibility and crisp three-commit migration with B's structural domain split, stateless HMAC cookies, fragment bootstrap, Sec-Fetch CSRF gate, and Unix-socket hub IPC — without inheriting A's "skip Origin for upstream-proxy" carve-out, in-memory session set that loses to hub recycle, or `?token=` query bootstrap; and without inheriting B's launcher dependency on undocumented `ANTHROPIC_CUSTOM_HEADERS` env nor B's noisier two-CLI-subcommand surface.

---

## 2. Component-level architecture

### 2.1 Modules touched

| Module | Change | Approx LOC |
|---|---|---|
| `server/auth.js` | Replaced. Exports `verifyUpstream(req)`, `verifyDashboard(req)`, `deriveSecrets(rootKey)`, `redeemBootstrap(req,res)`, `logout(req,res)`. HKDF at boot. Stateless cookie verify. | ~180 |
| `server/index.js` | Top-level `dispatch(req)` switches on path prefix → `{ domain, verify }`. The upgrade handler calls `verifyUpstream` only (no browser ever opens a WS against ccxray — documented invariant). | ~25 changed |
| `server/ws-proxy.js` | Reads `req.ccxrayAuth` set by upgrade gate; rejects upgrade if absent. | ~5 |
| `server/hub.js` | HTTP `/_hub/*` routes deleted in Phase 2. Hub listens on `~/.ccxray/hub.sock` (`0600`, parent dir `0700`). Lockfile retained for discovery; carries `{pid, sockPath, version}` only (no secrets). | ~60 changed |
| `server/storage/index.js` | At boot, ensure `~/.ccxray/` mode `0700`; `~/.ccxray/local-secret` mode `0600`. Auth log rotation file `0600`. | ~10 |
| `server/providers.js` | Launcher derives `K_upstream` and injects `X-Ccxray-Auth: <K_upstream>` into the spawned CLI's outbound requests via the provider's documented per-request-header config (Claude Code: `ANTHROPIC_CUSTOM_HEADERS` env; codex: `-c request_headers='X-Ccxray-Auth=...'`). **Never touches `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`.** | ~20 |
| `bin/ccxray` | Adds `ccxray open` (mint bootstrap URL via hub socket, optionally launch browser). Backward-compat: existing `ccxray claude` / `ccxray codex` continue to work, now with header injection. | ~40 |
| `public/index.html` | Adds a 20-line inline bootstrap script that reads `location.hash` for `#k=…`, scrubs it via `history.replaceState`, posts to `/_auth/redeem` with the token in a custom header, and reloads on success. CSP `script-src 'self' 'unsafe-inline'` permits exactly this one inline script (or use a nonce). | ~25 |
| `public/app.js`, `public/miller-columns.js`, `public/sse.js` | **No changes.** Cookies attach automatically; SSE works with cookies; no `fetch` patching, no `EventSource` patching, no `WebSocket` use against ccxray. | 0 |
| `server/log-sanitize.js` | Add `X-Ccxray-Auth`, `X-Ccxray-Bootstrap`, `Cookie`, `Authorization` to redaction class. Strip `?token=` from logged `req.url` during the deprecation window. | ~10 |
| `README.md` / `CLAUDE.md` | One quickstart, one CI section, one remote-deploy section. | docs |

**Auth core surface: `server/auth.js` (~180 LOC) + `server/index.js` dispatch (~25 LOC). CLI bootstrap in `bin/ccxray` (~40 LOC) and the inline browser script (~25 LOC) are separate concerns. Maintainability rubric (≤ 2 files, no per-route bespoke handling) satisfied with margin.**

### 2.2 The two security domains

```
┌───────────────────────────┬──────────────┬───────────────────────────────────┐
│ Path                      │ Domain       │ Credential mechanism              │
├───────────────────────────┼──────────────┼───────────────────────────────────┤
│ /v1/*                     │ upstream     │ X-Ccxray-Auth only                │
│ /v0/*                     │ upstream     │ X-Ccxray-Auth only                │
│ /anthropic                │ upstream     │ X-Ccxray-Auth only                │
│ (WS upgrade on any above) │ upstream     │ X-Ccxray-Auth on upgrade req      │
├───────────────────────────┼──────────────┼───────────────────────────────────┤
│ /                         │ dashboard    │ Cookie OR shell-no-cookie         │
│ /style.css /app.js /…     │ dashboard    │ Cookie OR none (non-sensitive)    │
│ /_api/*                   │ dashboard    │ Cookie OR Authorization: Bearer   │
│                           │              │   OR X-Ccxray-Auth (CLI symmetry) │
│ /_events                  │ dashboard    │ Cookie                            │
│ /_auth/redeem (POST)      │ dashboard-   │ X-Ccxray-Bootstrap (one-shot)     │
│                           │ bootstrap    │   + Sec-Fetch-Site: same-origin   │
│ /_auth/logout (POST)      │ dashboard    │ Cookie or Bearer                  │
├───────────────────────────┼──────────────┼───────────────────────────────────┤
│ (Unix socket)             │ hub IPC      │ peer-UID == server UID            │
└───────────────────────────┴──────────────┴───────────────────────────────────┘
```

Dispatcher is a small function:

```js
const UPSTREAM_PREFIXES = ['/v1/', '/v0/', '/anthropic'];
function dispatch(req) {
  const { pathname } = new URL(req.url, 'http://_');
  if (UPSTREAM_PREFIXES.some(p => pathname === p.slice(0, -1) || pathname.startsWith(p))) {
    return { domain: 'upstream', verify: verifyUpstream };
  }
  return { domain: 'dashboard', verify: verifyDashboard };
}
```

No `kind` enum to grow. Adding an upstream prefix is one array entry. Every new dashboard route inherits the dashboard verifier automatically.

### 2.3 Request flows by client class

#### A. LLM client (Claude Code / Codex CLI)

```
Claude Code → POST http://localhost:5577/v1/messages
              X-Ccxray-Auth: <K_upstream>          (set by launcher; §3.5)
              x-api-key: sk-ant-…                  (Anthropic's own key, untouched)
              Host: localhost:5577

dispatch → upstream → verifyUpstream(req):
  - constant-time compare X-Ccxray-Auth value to K_upstream
  - Host check against allowedHosts (rebind defense; §3.4)
  - No Origin/Sec-Fetch check needed: a browser cannot send X-Ccxray-Auth
    cross-origin without a CORS preflight we never grant. The presence of
    the credential is itself proof the request is not browser-ambient.
→ forward to Anthropic via forwardRequest()
```

Why a custom header instead of `Authorization: Bearer` on the upstream domain:

1. **Disambiguation.** The Anthropic API also uses `Authorization` semantics in some flows. A ccxray-prefixed header guarantees no collision and lets us forward `Authorization` verbatim when present.
2. **CSRF-by-construction.** A non-CORS-simple custom header forces preflight. We never grant `Access-Control-Allow-Origin` on the upstream domain. Browser cross-origin `fetch('/v1/...')` is therefore structurally impossible regardless of whether the user has a cookie.

#### B. Dashboard browser (bootstrap)

```
$ ccxray open
Open this URL in your browser (don't share it):
  http://localhost:5577/#k=2k9wQ7sZk-7vJjP1AaBb-zQyXxRrTt9LpKkMnB0qHcU
(Token is one-time, valid 60 seconds, only appears in this terminal.)
[Opening browser…]
```

`ccxray open` connects to `~/.ccxray/hub.sock` (peer-UID gated), the hub mints a bootstrap token and returns it, the CLI prints the URL.

Browser navigates to `http://localhost:5577/`:

```
GET / HTTP/1.1            ← fragment is NOT sent to server
Host: localhost:5577

→ 200, index.html
```

Inline bootstrap script (in `index.html`):

```html
<script>
(async () => {
  const m = location.hash.match(/^#k=([A-Za-z0-9_-]{20,})$/);
  if (m) {
    const tok = m[1];
    history.replaceState(null, '', location.pathname);   // scrub immediately
    const r = await fetch('/_auth/redeem', {
      method: 'POST',
      headers: { 'X-Ccxray-Bootstrap': tok, 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin'
    });
    if (r.ok) location.reload();
    else document.body.textContent = 'Bootstrap failed. Run `ccxray open` again.';
  } else if (!document.cookie.includes('ccxray_s=')) {
    document.body.textContent = 'No session. Run `ccxray open` in your terminal.';
  }
})();
</script>
```

`POST /_auth/redeem` reads `X-Ccxray-Bootstrap`, verifies (a) `Sec-Fetch-Site: same-origin`, (b) `Origin` in allowlist, (c) token in `pendingBootstraps` (single-use), then mints the HMAC cookie via `Set-Cookie` and returns 204.

#### B'. Dashboard browser (steady state)

```
GET /_api/entries?limit=10 HTTP/1.1
Host: localhost:5577
Cookie: ccxray_s=<base64url(payload)>.<base64url(hmac)>
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Origin: http://localhost:5577

dispatch → dashboard → verifyDashboard(req):
  - Host in allowedHosts (rebind)        → §3.4
  - parse cookie, split payload.hmac
  - constant-time HMAC verify             → §3.2
  - parse payload {v, n, exp}; reject if exp < now
  - CSRF gate (cookie-authenticated only): Sec-Fetch-Site ∈ {same-origin, none}
    or fallback to Origin match on state-changing requests
→ allow, route to handler
```

Subresources (`style.css`, `app.js`) are explicitly **not gated by the cookie** — they're non-sensitive static assets. This solves the "subresource 401 after cookie clear" UX A introduces. The sensitivity boundary is `/_api/*` and `/_events`, not the static shell.

#### C. CLI / scripts / curl

Three accepted forms, all unchanged in their ergonomics:

```bash
# 1. The unchanged, primary CLI form. Backward-compatible with existing scripts.
curl -H 'Authorization: Bearer <AUTH_TOKEN>' http://localhost:5577/_api/entries?limit=10

# 2. Custom header (recommended for new code; symmetric with upstream domain).
curl -H 'X-Ccxray-Auth: <K_upstream>' http://localhost:5577/_api/entries?limit=10

# 3. Upstream domain (always X-Ccxray-Auth only — never Bearer on /v1).
curl -H 'X-Ccxray-Auth: <K_upstream>' \
     -H 'x-api-key: sk-ant-...'        \
     http://localhost:5577/v1/messages
```

`verifyDashboard` accepts in this order: cookie, `X-Ccxray-Auth` against `K_upstream`, `Authorization: Bearer` against `AUTH_TOKEN`. Bearer-authenticated and `X-Ccxray-Auth`-authenticated requests are exempt from the Sec-Fetch/Origin CSRF gate (the cross-site forgery class requires browser-ambient credentials; a header attacker JS can't add cross-origin without preflight is not browser-ambient). Cookie-authenticated requests are always Sec-Fetch/Origin-gated.

`K_upstream` is retrievable via `ccxray secret upstream` for piping into CI env files; `AUTH_TOKEN` is the user's choice and known to them already.

#### D. WebSocket upgrade

```js
server.on('upgrade', (req, socket, head) => {
  // All current upgrades are on upstream paths (codex /v1/responses, /v1/realtime).
  // Invariant: no browser opens a WS against ccxray. The dashboard uses SSE.
  if (!verifyUpstream(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  handleWebSocketUpgrade(req, socket, head);
});
```

The upgrade gate accepts `X-Ccxray-Auth` only. `?token=` on WS URLs is rejected (the leak channel is closed by construction). The browser-can't-set-headers-on-`new WebSocket()` problem does not arise because no browser path opens a WS.

If a future dashboard feature requires browser→ccxray WS, it lives on a dashboard-domain path (e.g. `/_ws/...`) with its own upgrade gate that requires the cookie + Origin/Sec-Fetch — two gates is honest; one gate trying to handle both is the trap A fell into.

---

## 3. Concrete protocol details

### 3.1 Boot-time secret derivation (HKDF, stateless)

```js
const root =
  process.env.AUTH_TOKEN
    ? crypto.createHash('sha256').update(process.env.AUTH_TOKEN, 'utf8').digest()
    : readOrCreateEphemeralSecret();  // 32 random bytes in ~/.ccxray/local-secret (0600)

function hkdf(root, label, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(label), len));
}

const K_upstream  = hkdf(root, 'ccxray/v1/upstream');      // injected into spawned CLIs
const K_session   = hkdf(root, 'ccxray/v1/session-hmac');  // signs cookies
const K_bootstrap = hkdf(root, 'ccxray/v1/bootstrap');     // hashes pending bootstrap tokens
```

Restart with the same `AUTH_TOKEN` re-derives identical keys, so **browser cookies survive restart and hub recycle**. Rotating `AUTH_TOKEN` invalidates everything in one shot.

`verifyDashboard` also accepts `Authorization: Bearer <AUTH_TOKEN>` directly (constant-time compare against the env value) — this is the CLI back-compat path, independent of `K_upstream`. The two CLI paths share *capability* (full dashboard access) but use distinct token material so that scripts hard-coded to `AUTH_TOKEN` continue to work indefinitely.

### 3.2 The stateless HMAC session cookie

```
Cookie value: ccxray_s = base64url(payload) "." base64url(hmac)

payload  = JSON.stringify({ v: 1, n: <16B random>, exp: <epoch_s + 8h> })
hmac     = HMAC-SHA256(K_session, payload_bytes)
```

Verification (sketch, constant-time):

```js
function verifyCookie(raw) {
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = Buffer.from(raw.slice(0, dot), 'base64url');
  const provided = Buffer.from(raw.slice(dot + 1), 'base64url');
  const expected = crypto.createHmac('sha256', K_session).update(payload).digest();
  // Always do the same work regardless of length parity:
  const probe = Buffer.alloc(expected.length);
  provided.copy(probe, 0, 0, Math.min(provided.length, probe.length));
  const ok = crypto.timingSafeEqual(probe, expected) && provided.length === expected.length;
  if (!ok) return null;
  let obj; try { obj = JSON.parse(payload.toString('utf8')); } catch { return null; }
  if (!obj || obj.v !== 1) return null;
  if (typeof obj.exp !== 'number' || obj.exp < Date.now() / 1000) return null;
  return obj;
}
```

Set-Cookie:

```
Set-Cookie: ccxray_s=<value>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
            [; Secure if CCXRAY_FORCE_SECURE_COOKIE=1 or req.headers['x-forwarded-proto']==='https']
```

Attributes:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | XSS-in-conversation cannot read the cookie (defense in depth over HTML escaping). |
| `SameSite=Strict` | Strict | We never need cross-site top-level navigation to authenticate. Strict kills the cross-site cookie attach class at the browser layer. |
| `Path=/` | yes | Subresources share path scope — no subresource 401 bug. |
| `Domain` | unset | Locked to exact host (`localhost:5577`). No Domain attribute = no parent-domain cookie attach surface for some rebind variants. |
| `Secure` | conditional | Set when behind TLS terminator (`CCXRAY_FORCE_SECURE_COOKIE=1`) or when the upstream `X-Forwarded-Proto: https` is trusted. Omitted on loopback HTTP. |
| `Max-Age=28800` | 8h | One working day. Survives restarts with same `AUTH_TOKEN`. |

Why stateless HMAC over A's in-memory `Set<sha256>`:

- **Cookies survive hub idle-shutdown (5s after last client) and crash-recovery.** A's design wipes the set on every hub recycle, forcing a re-redemption every time the hub idles — which is constantly in normal use. B is correct here; we adopt it.
- **No sweep required.** Expiry is in the payload; the verifier rejects stale.
- **Trade-off: no per-session revocation.** Accepted. Revocation primitive is "rotate `AUTH_TOKEN`", which invalidates everything at once. This is the right semantics for a single-secret binary-trust model.

### 3.3 One-time bootstrap token

`ccxray open` mints a token by connecting to the hub's Unix socket and asking. The hub stores it as `HMAC(K_bootstrap, token)` in a small `Map<hex(hash), exp>` capped at 8 entries (oldest dropped on insert) with 60-second TTL:

```js
const tok = crypto.randomBytes(24).toString('base64url');  // ~192 bits
const hashHex = crypto.createHmac('sha256', K_bootstrap).update(tok).digest('hex');
pendingBootstraps.set(hashHex, Date.now() + 60_000);
return tok;  // returned to CLI over Unix socket
```

`POST /_auth/redeem`:

```
POST /_auth/redeem HTTP/1.1
Host: localhost:5577
Origin: http://localhost:5577
Sec-Fetch-Site: same-origin
X-Ccxray-Bootstrap: <tok>
Content-Type: application/json
Content-Length: 2

{}
```

Server checks, in order:
1. `Host` in allowedHosts (rebind).
2. `Sec-Fetch-Site === 'same-origin'`. If absent, require `Origin` matches allowedHosts.
3. Compute `HMAC(K_bootstrap, tok)`; constant-time lookup in `pendingBootstraps`; delete on match.
4. On success: mint HMAC session cookie, `Set-Cookie`, `204`.
5. On failure: `401`, no cookie, log one line.

The bootstrap token is **single-use** and never appears in any URL the browser navigates to: the fragment is scrubbed within milliseconds by `history.replaceState`, and the value travels server-bound only in a POST body's custom header. Result: not in access logs, not in Referer, not in browser sync of URL bar, not in shell history (it's in the terminal output of `ccxray open`, but that terminal is the user's).

### 3.4 Host & CSRF defense (universal Host, Sec-Fetch primary, Origin fallback)

Boot-time:

```js
const allowedHosts = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
  ...envSplit('CCXRAY_PUBLIC_ORIGINS')      // e.g. "ccxray.dev.tail-abc.ts.net:443"
]);
```

**Host check is universal across both domains, with no carve-out.** This is the principled disagreement with A (see §6 below), where A skipped Origin for "upstream-proxy". We do not skip Host *or* CSRF gating asymmetrically per domain — we use the right mechanism per domain:

- Upstream domain: CSRF is structurally prevented by the custom-header credential (browsers cannot attach `X-Ccxray-Auth` cross-origin without preflight; we never grant the preflight). Host check still applies → rebind defense.
- Dashboard domain (cookie path): explicit Sec-Fetch / Origin gate on top of `SameSite=Strict`.

```js
function checkHostOrReject(req) {
  if (!allowedHosts.has(req.headers.host)) {
    return reject(421, 'Misdirected Request');
  }
}

function checkCsrfForCookie(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs !== undefined) {
    if (sfs !== 'same-origin' && sfs !== 'none') {
      return reject(403, 'CSRF: cross-origin with cookie');
    }
    return;
  }
  // Older browser / non-browser fallback:
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (!origin) return reject(403, 'CSRF: state-changing without Origin');
    let u; try { u = new URL(origin); } catch { return reject(403, 'CSRF: bad Origin'); }
    if (!allowedHosts.has(u.host)) return reject(403, 'CSRF: Origin mismatch');
  }
}
```

Sec-Fetch is the primary gate because it is **forbidden for JavaScript to set** (Fetch Metadata spec). It cleanly distinguishes address-bar nav (`none`) from same-origin fetch (`same-origin`) from cross-site fetch (`cross-site`). Origin is the fallback for clients that don't set Sec-Fetch.

### 3.5 Launcher header injection — never overwrites upstream credentials

The launcher (`server/providers.js`) derives `K_upstream` from the root secret and injects it into the spawned CLI's outbound requests via the provider's first-class per-request-header mechanism. Critically, **it never touches `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`**:

| Provider | Mechanism | Notes |
|---|---|---|
| Claude Code (Anthropic SDK) | `ANTHROPIC_CUSTOM_HEADERS="X-Ccxray-Auth: <K_upstream>"` env (SDK reads this as a documented extension point). Verify against the SDK version at launch; on unsupported versions, fall back to mechanism below. | Does not collide with `ANTHROPIC_AUTH_TOKEN` (a distinct env var the SDK uses for its own auth). |
| Codex CLI | `-c request_headers='X-Ccxray-Auth=<K_upstream>'` via the codex per-request-header config. Verified to propagate to the WebSocket upgrade HTTP request. | Already integrated with ccxray's `-c openai_base_url=…` injection. |
| Generic curl / scripts | Documented one-liner: `curl -H "X-Ccxray-Auth: $(ccxray secret upstream)" …` | `ccxray secret upstream` prints `K_upstream` to stdout once. |
| Provider unable to header-inject reliably | Documented downgrade: `CCXRAY_LOOPBACK_ONLY_FOR_UPSTREAM=1` allows unauthenticated upstream from same-UID loopback peers. | Explicit, opt-in, cost spelled out. |

The launcher reading `AUTH_TOKEN` (or `~/.ccxray/local-secret`) and deriving `K_upstream` means users never set `K_upstream` themselves. Rotation of `AUTH_TOKEN` automatically rotates `K_upstream` on next spawn. No separate rotation step.

### 3.6 The `/` GET special case

`GET /` returns `index.html` regardless of cookie state. `index.html` does not contain any sensitive data — it's the shell. The inline bootstrap script gates everything else: if there is a fragment, it redeems; if there's no fragment and no cookie, it shows the static "No session. Run `ccxray open`" message.

`/_api/*` and `/_events` are the sensitivity boundary. Without a cookie (or other valid credential), they return `401 {"error":"no_session","hint":"run `ccxray open` in your terminal"}`. `public/app.js` already has reconnect-on-error for SSE; we add one line: on 401 from `/_events`, show the banner and stop reconnect storms.

Static subresources (`/style.css`, `/app.js`, fonts, icons) return 200 unconditionally — they are not sensitive, and gating them creates the bookmark-with-cleared-cookies broken-page UX without security benefit.

### 3.7 Hub IPC over Unix domain socket

```
~/.ccxray/             (mode 0700)
├── hub.json           (mode 0600)  ← {pid, sockPath, version, startedAt}, NO secrets
├── hub.sock           (mode 0600)  ← Unix domain socket
├── hub.log            (mode 0600)
├── local-secret       (mode 0600)  ← present iff AUTH_TOKEN unset
└── logs/
```

Discovery flow (unchanged in intent):
1. Client reads `hub.json` for `{pid, sockPath, version}`.
2. Client connects to `sockPath`.
3. Hub verifies peer UID via `getpeereid(2)` (`net.Socket._handle.getpeereid`, available on Linux/macOS Node ≥ 18) and rejects if peer UID ≠ server UID.
4. Client sends framed messages: `register`, `unregister`, `health`, `bootstrap-token`.

`bootstrap-token` is how `ccxray open` retrieves the one-time URL. No HTTP path serves this.

**Windows fallback:** `getpeereid` is not available. Use a named pipe at a per-user path (`\\.\pipe\ccxray-<uid>`) + a one-time secret in `hub.json` at file ACL = current user only. Documented as a different trust model; equivalent in practice for single-user Windows boxes.

### 3.8 The "no `AUTH_TOKEN`" posture — ephemeral mode

When `AUTH_TOKEN` is unset:

1. At first start, generate 32 random bytes, write to `~/.ccxray/local-secret` (mode `0600`).
2. Derive `K_upstream`, `K_session`, `K_bootstrap` from that secret via HKDF as usual.
3. The launcher reads the secret from this file (not env) and computes `K_upstream` for injection.
4. `verifyDashboard` accepts the cookie path and `X-Ccxray-Auth` against `K_upstream`. Bearer compat path is `disabled` in ephemeral mode (no env value to compare to) — documented.
5. Multi-UID localhost is **not** a privileged source. A request from another UID cannot read `local-secret`, cannot mint a cookie via `ccxray open` (peer-UID gated socket), and cannot present `X-Ccxray-Auth`. It gets 401.

For single-user-laptop developer convenience: `CCXRAY_LOOPBACK_NO_AUTH=1` enables anonymous loopback access (matching the old default), with a loud startup banner. **This is an explicit opt-in, not the silent default.** A's "127.0.0.1 = anonymous OK" was a multi-UID footgun; we close it by default and require a flag to re-open.

Tabular summary:

| Configuration | Upstream | Dashboard | Hub IPC |
|---|---|---|---|
| `AUTH_TOKEN=<x>` | `X-Ccxray-Auth` required | Cookie OR `Authorization: Bearer <x>` OR `X-Ccxray-Auth` | Unix socket peer-UID |
| `AUTH_TOKEN` unset (default) | `X-Ccxray-Auth` required (from `~/.ccxray/local-secret`) | Cookie via `ccxray open` OR `X-Ccxray-Auth` | Unix socket peer-UID |
| `AUTH_TOKEN` unset + `CCXRAY_LOOPBACK_NO_AUTH=1` | loopback unauth permitted | loopback unauth permitted | Unix socket peer-UID still required |

In every mode, hub IPC is gated by peer-UID. There is no configuration where a same-machine other-UID process reaches another UID's ccxray data.

---

## 4. Threat-by-threat mitigation table

| # | Threat | Defense | Layer | Residual risk |
|---|---|---|---|---|
| 1 | **Malicious website CSRF** (form POST, `fetch({credentials:'include'})`, `<img>`, etc., against `http://localhost:5577`) | (a) **Upstream domain unreachable by browser ambient credential**: `X-Ccxray-Auth` is a non-CORS-simple header → preflight required → no `Access-Control-Allow-Origin` granted → browser blocks. Structurally impossible regardless of cookie. (b) Dashboard cookie has `SameSite=Strict` — not sent on any cross-site request. (c) `Sec-Fetch-Site` enforcement on cookie path — rejects cross-site even if a future browser bug permits the cookie. (d) Origin/Referer fallback for older browsers and non-browser test harnesses. | Architecture + cookie + middleware (three independent gates) | None. There is no "skip CSRF for upstream-proxy" carve-out as in A. |
| 2 | **DNS rebinding** (attacker domain re-resolves to 127.0.0.1) | **Universal Host allowlist** on every request, both domains, no exemption. `Host: evil.com` → 421. Cookie has no `Domain` attribute, so it would not be sent to a rebound host even if Host were spoofed at a higher layer. `CCXRAY_PUBLIC_ORIGINS` provides explicit opt-in for legitimate non-loopback hostnames. | Middleware (universal) + cookie scope | None for loopback. For remote deploys, the operator must add the public hostname to `CCXRAY_PUBLIC_ORIGINS`; documented. |
| 3 | **Token exfiltration via URL surface** (history, Referer, logs, paste) | The credential never appears in any URL the server sees. Bootstrap token lives in the URL **fragment** (`#k=…`), which is not sent to the server, not in access logs, not in Referer, not in browser-bar sync (excluded since 2014). Fragment is scrubbed by `history.replaceState` within milliseconds. Bootstrap travels server-bound via `POST` with the token in a custom header (`X-Ccxray-Bootstrap`). Token is **one-time** (60s TTL, single-use). After redemption, cookie carries auth — no token persists. **Legacy `?token=` is removed in Phase 3** (deprecation log in Phase 1, restricted to `/` in Phase 2 with a soft redirect to the new flow). | Bootstrap protocol + URL hygiene | Bookmarking the bootstrap URL is moot (single-use, 60s). Users bookmark `http://localhost:5577/` and re-bootstrap with `ccxray open` as needed. The bookmarked URL contains no secret. |
| 4 | **XSS-in-conversation-content** (LLM/tool output injects `<script>`) | (a) `HttpOnly` cookie — JS cannot read it. (b) `K_upstream` is **never** present in any browser-accessible location (server process + `~/.ccxray/local-secret` file). Cross-XSS upstream-credential theft is structurally impossible. (c) `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'` (or with a per-page nonce to eliminate the `'unsafe-inline'` residual) limits exfil channels. (d) Existing HTML escaping in `entry-rendering.js` remains the primary preventive layer. | Cookie attribute + key isolation + CSP + existing escaping | Attacker JS *can* still make same-origin `fetch('/_api/...')` calls under the user's session — accepted as an XSS bug class outside the auth scheme's scope. The auth scheme prevents the strictly worse outcome (credential theft, persistent access). |
| 5 | **Plain-HTTP eavesdropping on non-local deployments** | Out of scope by constraint. ccxray does not terminate TLS. Documented operational guidance: put behind a TLS terminator (Tailscale Serve, Caddy, nginx, SSH `-L`); set `CCXRAY_FORCE_SECURE_COOKIE=1` so the cookie gets `Secure`; add the public hostname to `CCXRAY_PUBLIC_ORIGINS`; configure the terminator to **strip `X-Ccxray-Auth` from incoming untrusted-network requests** (the upstream credential should only originate from trusted CLI clients on the same machine or trusted network). | Documentation + Secure flag + ops guidance | Accepted by constraint. Plain-HTTP on a hostile network is unmitigable without TLS. |
| 6 | **Token leak via WebSocket upgrade URL** | The upgrade gate accepts `X-Ccxray-Auth` header only. `?token=` on WS URLs is rejected with 401 at upgrade. **Invariant: no browser path opens a WebSocket against ccxray.** The dashboard uses SSE (which works with cookies natively). If a future feature needs browser-WS, it lives on a dashboard-domain path with its own cookie-based upgrade gate, separate from the upstream gate. | Upgrade middleware + architectural invariant | None. The "browser can't set headers on `new WebSocket()`" problem does not arise because no browser opens a WS. |

Additional structural threats addressed (raised by the design pressure of the original 6):

| # | Threat | Defense |
|---|---|---|
| 7 | **Hub HTTP IPC reachable cross-UID** | Hub IPC moved to Unix domain socket gated by peer-UID. HTTP listener no longer serves any privileged IPC path. |
| 8 | **Credential collision with `ANTHROPIC_AUTH_TOKEN`** | ccxray's credential is `X-Ccxray-Auth`, derived from a distinct key (`K_upstream`). Launcher never touches `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. |
| 9 | **Multi-UID localhost shared host** | Default-deny when `AUTH_TOKEN` unset (ephemeral mode reads `~/.ccxray/local-secret` mode `0600`). Explicit `CCXRAY_LOOPBACK_NO_AUTH=1` to re-open the old "anonymous loopback" default. |
| 10 | **Hub idle-shutdown / crash-recovery invalidating browser sessions** | Cookies are stateless HMACs over `K_session = HKDF(root, "session-hmac")`. New hub process from the same `AUTH_TOKEN` (or same `~/.ccxray/local-secret`) re-derives the same key. Cookies survive. |

---

## 5. Migration path

Three phases. No phase silently breaks a working setup.

### 5.1 Backward-compatibility surface

| Old behavior | New behavior | Phase introduced | Phase removed |
|---|---|---|---|
| `Authorization: Bearer <AUTH_TOKEN>` on `/_api/*` | Accepted permanently on dashboard domain. | — | never |
| `Authorization: Bearer <AUTH_TOKEN>` on `/v1/*` | Phase 1: accepted with `X-Ccxray-Deprecation: bearer-on-upstream` header. Phase 2: rejected; only `X-Ccxray-Auth` accepted on upstream. | 1 | 2 |
| `?token=<T>` query string on any path | Phase 1: still works with `X-Ccxray-Deprecation: token-query` warning header. Phase 2: rejected everywhere except a single legacy redirect at `/?token=…` that converts to a `Set-Cookie` for old bookmarks. Phase 3: rejected entirely. | 1 | 3 |
| `AUTH_TOKEN` unset → loopback allow-all | Phase 1: behavior unchanged + startup banner "default-allow loopback will require CCXRAY_LOOPBACK_NO_AUTH=1 in next minor". Phase 2: ephemeral mode becomes default; `CCXRAY_LOOPBACK_NO_AUTH=1` re-opens old behavior. | 1 (warn), 2 (enforce) | — |
| HTTP `/_hub/*` routes | Phase 1: HTTP routes still serve, Unix socket also listens; clients prefer socket if present. Phase 2: HTTP routes return `410 Gone`. | 2 | — |
| Browser `/?token=<T>` bookmark | Phase 1: still works; the response renders a one-time deprecation banner + sets cookie via redirect to `/_auth/redeem`-shim. Phase 2: still works (silent `Set-Cookie` redirect). Phase 3: removed in favor of `ccxray open`. | 1, 2 | 3 |

### 5.2 Phased rollout

**Phase 1 (additive, no breakage):**
- Add `verifyUpstream` / `verifyDashboard` split alongside the existing single-middleware path. Both new verifiers accept all legacy credential forms with deprecation log headers.
- Add `/_auth/redeem` endpoint, HMAC cookie minting via HKDF.
- Add Unix domain socket hub IPC (`bootstrap-token` framed message, `register`/`unregister`/`health` parity with HTTP). HTTP `/_hub/*` retained.
- Add `ccxray open` subcommand and `ccxray secret upstream`.
- Add Host check + Sec-Fetch-Site check in **warn-only** mode (log violations, do not block).
- Launcher starts injecting `X-Ccxray-Auth` for spawned children (Claude Code, codex).
- Tests: every legacy path continues to pass; new tests added for fresh paths.

**Phase 2 (enforcement, minor breakage with one-flag opt-out):**
- Host + Sec-Fetch + Origin checks flip from warn to block.
- `Authorization: Bearer` on `/v1/*` rejected (only `X-Ccxray-Auth`).
- `?token=` rejected except on `/` (where it redirects through cookie minting for old bookmarks).
- `AUTH_TOKEN` unset becomes ephemeral mode by default; `CCXRAY_LOOPBACK_NO_AUTH=1` for old behavior.
- HTTP `/_hub/*` returns `410 Gone`; Unix socket is the only IPC.
- `bin/ccxray` documents `ccxray open` as the canonical browser bootstrap.

**Phase 3 (cleanup):**
- Remove `?token=` redirect on `/`. `ccxray open` is the only browser bootstrap.
- Final auth surface: `server/auth.js` ~180 LOC, `server/index.js` dispatch ~25 LOC.
- Remove the deprecation-header code path.

### 5.3 Communication

Each phase ships with a CHANGELOG entry stating exactly "If you were doing X, now do Y" with the deprecation header strings users will see in their logs. The README has one quickstart (`ccxray open`), one "CI / scripting" section (`Authorization: Bearer $AUTH_TOKEN` for dashboard, `X-Ccxray-Auth: $(ccxray secret upstream)` for `/v1`), and one remote-deploy section.

---

## 6. Explicitly rejected alternatives

### 6.1 Pure cookie (no header credential for CLI)
**Rejected.** Breaks `curl -H 'Authorization: Bearer X'` and the CI ergonomics constraint. We keep both header forms permanently for dashboard access and a custom header for upstream.

### 6.2 Pure bootstrap-injection (`window.__CCXRAY_TOKEN__` + monkey-patch fetch/EventSource/WebSocket)
**Rejected.** Violates the no-client-side-monkey-patching rubric. Degrades the threat model: token in JS-readable memory loses to XSS-in-conversation immediately. `EventSource` cannot send custom headers, forcing a `?token=` fallback that reintroduces the URL leak we are removing. Cookie + `HttpOnly` is strictly stronger and structurally simpler.

### 6.3 OAuth / OIDC / device-code flow
**Rejected.** Violates "no external IdP / SSO / OAuth" and "zero new runtime deps". OAuth solves problems ccxray does not have (multi-user, scoped consent, third-party identity) and adds enormous failure surface (refresh tokens, JWKS rotation, clock skew). Trust root is "you set an env var on your machine"; OAuth assumes a richer hierarchy that does not exist here.

### 6.4 mTLS
**Rejected.** Requires HTTPS in ccxray (constraint says no) and per-client cert config that the Claude/Codex SDKs do not surface cleanly. Right answer for service meshes; wrong answer for a local dev proxy.

### 6.5 Server-side session set (`Set<sha256>` of valid sessions, as in candidate A)
**Rejected.** Loses to hub idle-shutdown (5s after last client) and crash-recovery (clients fork a new hub). Every recycle invalidates all browser sessions. HMAC-signed stateless cookies derived from `K_session = HKDF(root, "session-hmac")` reproduce the same security property without the lifetime contradiction: same root → same key → cookies still validate. Per-session revocation is sacrificed; revocation primitive is `AUTH_TOKEN` rotation. Acceptable for a single-secret binary-trust model.

### 6.6 `Authorization: Bearer` as the primary upstream credential (as in candidate A)
**Rejected for the upstream domain.** Two reasons: (a) `Authorization` collides semantically with upstream API credentials and some SDKs auto-attach `Authorization` headers — distinct custom header sidesteps the collision risk and keeps forwarding-to-Anthropic clean; (b) custom `X-Ccxray-Auth` forces CORS preflight from browsers, making the upstream domain unreachable from a browser context by construction. `Authorization: Bearer` is still accepted on the **dashboard** domain (against the env `AUTH_TOKEN`) for back-compat with existing scripts — that's the part of A we keep.

### 6.7 `?token=` query-string bootstrap (as in candidate A's first-visit URL)
**Rejected as the canonical path.** Token in query reaches the server in `GET /` (so it lands in any reverse-proxy / dev-tools access log unless explicitly scrubbed), reaches Referer of any external resource loaded by `index.html`, and is bookmark-able by accident. Fragment (`#k=…`) avoids all four channels (server, log, Referer, bookmark utility). Retained only as a Phase-1/2 back-compat redirect.

### 6.8 Pure `Sec-Fetch-Site` (no Origin fallback)
**Rejected.** Coverage is ≥ 95% but not 100%. Older browsers and non-browser test harnesses don't set Sec-Fetch headers. Origin fallback keeps the fallback path coherent.

### 6.9 Synchronizer CSRF token / double-submit cookie
**Rejected.** `SameSite=Strict` + `Sec-Fetch-Site` covers the threat without per-page-render token state. Synchronizer tokens are a 2014-era pattern; in 2026 they are overhead with no marginal benefit at this threat surface.

### 6.10 Per-request token rotation / JWT with refresh
**Rejected.** Adds key management complexity (signing key storage, rotation, clock-skew tolerance) for no benefit at this scope. The HMAC cookie with `exp` in payload + `AUTH_TOKEN` as rotation primitive is simpler and sufficient.

### 6.11 Hub IPC over HTTP with shared secret in lockfile (as in candidate A)
**Rejected.** Even with `~/.ccxray/hub.json` at `0600`, the HTTP listener becomes a privileged surface that must be defended against same-machine other-UID attackers, path-classifier bugs, header-smuggling proxy intermediaries, and accidental external exposure. Unix socket with peer-UID check moves the trust root to the OS kernel — the right place. On Windows: named pipe + secret file as a documented different trust model.

### 6.12 HTTPS terminated by ccxray itself (built-in TLS)
**Rejected.** Out of scope by constraint. For remote deploy, terminator-in-front is the documented pattern.

---

## 7. Failure modes & operational notes

### 7.1 Token rotation

Change `AUTH_TOKEN` (or delete and recreate `~/.ccxray/local-secret`) and restart ccxray. All keys re-derive; all cookies invalidate (new HMAC); `K_upstream` rotates → next spawn picks it up. Browser users run `ccxray open` again. CLI users update their env. **Cookies survive *restart* if `AUTH_TOKEN` is unchanged** — this is the practical convenience win over A and is the only way the dashboard remains usable across the hub's 5s idle-shutdown cycle.

### 7.2 Cookie clearing

User clears cookies → next `/_api/*` or `/_events` request 401 → `index.html` inline script (on next page load) detects no cookie, shows static message "No session. Run `ccxray open`". Subresources continue to load (they are not gated). No reconnect storm.

### 7.3 Multiple browser tabs

Cookie is per-origin. All tabs share the session. Open a fifth tab → inherits cookie → works. Closing tabs does not invalidate.

### 7.4 Server restart mid-session

- `AUTH_TOKEN` unchanged → cookies still valid (HMAC verifies; `exp` not reached) → no interruption.
- `AUTH_TOKEN` changed → cookies invalid → `index.html` detects on next 401, shows "Session expired. Run `ccxray open`" banner. `public/app.js` SSE reconnect logic is patched: on 401 from `/_events`, show banner and stop reconnect attempts.

### 7.5 Hub mode

- Hub idle-shutdown (5s after last client): no impact on cookies. Next hub re-derives `K_session` from the same `AUTH_TOKEN` and accepts the same cookies.
- Hub crash-recovery (clients fork new hub via the existing pid-monitor logic): same — new hub re-derives identically.
- `pendingBootstraps` is ephemeral (60s TTL). If hub recycles mid-bootstrap, the user re-runs `ccxray open`. Negligible window.
- Lockfile (`~/.ccxray/hub.json`) carries discovery info only; no secrets. Mode `0600`, parent dir `0700`.

### 7.6 Non-local HTTP deployment

Documented snippet (`README.md` "Remote deployment"):

> ccxray does not terminate TLS. If you expose it beyond loopback:
> - Put it behind a TLS terminator (Tailscale Serve, Caddy, nginx, SSH `-L`).
> - Set `CCXRAY_FORCE_SECURE_COOKIE=1` to add `Secure` to the session cookie.
> - Set `CCXRAY_PUBLIC_ORIGINS=ccxray.example.com:443` so the Host/Origin allowlist includes the public hostname.
> - Configure the terminator to **strip `X-Ccxray-Auth` from inbound untrusted-network requests** — the upstream credential should only originate from trusted CLI peers, never from browser traffic.

### 7.7 Multi-UID localhost footgun

Default behavior is safe: ephemeral mode with `~/.ccxray/local-secret` at `0600`. Other UIDs cannot read the secret, cannot mint a cookie via `ccxray open` (peer-UID-gated socket), and cannot present `X-Ccxray-Auth`. They get 401 across the board.

Explicit opt-in for single-user laptop developer convenience: `CCXRAY_LOOPBACK_NO_AUTH=1` with a loud startup banner.

### 7.8 Constant-time comparison

`crypto.timingSafeEqual` on equal-length buffers, with inputs hashed to fixed-width digests before comparison:

```js
function compareSecret(provided, expected) {
  const ph = crypto.createHash('sha256').update(provided || '').digest();
  const eh = crypto.createHash('sha256').update(expected || '').digest();
  return crypto.timingSafeEqual(ph, eh);
}
```

Both inputs are hashed unconditionally; comparison runs on fixed-length buffers; no early return on length mismatch. Cookie HMAC verification follows the same pattern (probe-buffer copy, fixed-width compare, length re-check after).

### 7.9 Logging

- Successful auth: no log line (spam avoidance).
- Failed auth: one structured line `{ts, ip, method, path, domain, reason}` to `~/.ccxray/auth.log` with 10 MB rotation at file mode `0600`.
- Redaction class in `server/log-sanitize.js`: `Authorization`, `Cookie`, `X-Ccxray-Auth`, `X-Ccxray-Bootstrap`, and any `?token=` suffix in `req.url`.

### 7.10 Test coverage matrix

Test files (each ~50–100 LOC using the existing http test harness, zero new deps):

- `test/auth-upstream.test.js` — `X-Ccxray-Auth` accepted; missing → 401; wrong → 401; `?token=` rejected; legacy `Authorization: Bearer` on `/v1` warns in Phase 1, rejected in Phase 2.
- `test/auth-dashboard.test.js` — cookie accepted; Bearer accepted; `X-Ccxray-Auth` accepted; expired cookie → 401; malformed cookie → 401.
- `test/auth-bootstrap.test.js` — `/_auth/redeem` mints cookie; replay rejected (single-use); 60s TTL enforced; bootstrap without same-origin → 403.
- `test/auth-csrf.test.js` — `Sec-Fetch-Site: cross-site` → 403; missing Sec-Fetch + missing Origin on POST → 403; bearer-authenticated cross-origin → allowed (no ambient credential); GET never CSRF-checked.
- `test/auth-rebind.test.js` — `Host: evil.com` → 421 on both domains, regardless of credential.
- `test/auth-ws.test.js` — upgrade with `X-Ccxray-Auth` → 101; with `?token=` → 401; with no auth → 401.
- `test/auth-hub-socket.test.js` — peer-UID match → ok; different UID → reject; HTTP `/_hub/*` returns 410 in Phase 2.
- `test/auth-migration.test.js` — Phase 1 legacy `?token=` works with deprecation header; Phase 2 it's rejected (except `/` redirect); cookies survive simulated restart with same `AUTH_TOKEN`.
- `test/auth-timing.test.js` — 1000-run statistical timing test for `compareSecret` and HMAC verify (stddev within tolerance).

Coverage is asserted by the matrix (every cell has ≥ 1 assertion), not by LOC.

### 7.11 What this design does **not** solve

Honest residuals:

- **XSS in conversation content** is mitigated for credential theft (HttpOnly + key isolation + CSP) but not for "attacker JS makes authenticated `fetch('/_api/...')` calls". Right fix is the existing escape layer in `entry-rendering.js`.
- **TLS** is not provided; plain-HTTP eavesdropping on a hostile network is unmitigable in-scope. Ops guidance covers it via terminator-in-front.
- **Per-session revocation** is not provided. Single-secret binary-trust: revocation primitive is `AUTH_TOKEN` rotation.
- **Compromise of `~/.ccxray/local-secret`** (file permissions weakened by user error) compromises everything. Inherent to the single-secret model.
- **Windows peer-UID gap**: Unix domain socket peer credentials are not available on Windows in Node ≤ 22. Documented fallback: named pipe + per-user secret file at user-only ACL. Functionally equivalent for single-user Windows; flagged as a different trust model.
- **Pre-Sec-Fetch browser CSRF coverage** is via Origin fallback only. Genuinely old browsers (pre-Chrome 76 / Firefox 90) without Sec-Fetch and that don't send Origin on POSTs would degrade to "SameSite=Strict only", which is still strong but not three-layer. Documented; affects < 0.5% of browsers in 2026.

---

## 8. Principled disagreement: the one place A and B actually conflict

A and B disagree on whether the upstream domain should be CSRF-gated by Origin/Sec-Fetch.

- **A's position:** Skip the Origin check for `upstream-proxy` because bearer-authenticated requests aren't browser-ambient (the OWASP "custom header" reasoning).
- **B's position:** Don't even consider the question — the upstream domain accepts only a non-CORS-simple custom header, so browsers literally cannot reach it without a preflight that we never grant. The "skip" is replaced by "cannot occur".

**We adopt B's framing.** A's reasoning is correct for the threat (bearer-as-custom-header is CSRF-resistant), but A's *implementation* still routes the upstream policy through a single `authGate(kind)` that has to know to skip the check. Any future refactor that mistakenly drops the `kind === 'upstream-proxy'` exemption re-introduces the issue. B's structural separation means the upstream verifier has no Origin-check branch to forget — it doesn't exist. That's strictly more robust.

The conflict on `Authorization: Bearer` (A's primary CLI form vs B's custom-header preference) we resolve by **keeping both, asymmetrically**: `Authorization: Bearer <AUTH_TOKEN>` is permanently valid on the dashboard domain (back-compat with existing curl scripts and CI is the load-bearing convenience win from A); `X-Ccxray-Auth` is the only credential on the upstream domain (B's CORS-by-construction win). Two domains, two policies, one shared root secret via HKDF.

---

## 9. Summary scoring against the rubric

| Rubric criterion | Status |
|---|---|
| Threat 1 (CSRF) | Mitigated structurally on upstream (CORS preflight), and via `SameSite=Strict` + `Sec-Fetch-Site` + Origin fallback on dashboard. No per-kind carve-out. |
| Threat 2 (DNS rebind) | Mitigated by universal Host allowlist on both domains; cookie without `Domain`. |
| Threat 3 (Token in URL) | Mitigated structurally: bootstrap via URL fragment + custom header on POST; one-time 60s TTL; legacy `?token=` deprecated and removed by Phase 3. |
| Threat 4 (XSS exfil) | Mitigated for credential theft via HttpOnly + key isolation + CSP. Residual "active session" accepted as outside auth scope. |
| Threat 5 (plain-HTTP) | Accepted by constraint; ops guidance includes Secure-flag + `X-Ccxray-Auth` strip at terminator. |
| Threat 6 (WS URL token) | Mitigated by `X-Ccxray-Auth`-only upgrade gate + architectural invariant (no browser opens a WS). |
| First-time setup ≤ 1 step beyond `AUTH_TOKEN` | Yes: set `AUTH_TOKEN`, run `ccxray open`, done. (And ephemeral mode requires zero env vars.) |
| Browser works across reloads (no manual re-entry) | Yes: cookie persists 8h; survives restart with same `AUTH_TOKEN`; survives hub idle-shutdown and crash-recovery. |
| CLI/curl/CI trivial | Yes: `curl -H 'Authorization: Bearer $AUTH_TOKEN'` works permanently on dashboard; `curl -H 'X-Ccxray-Auth: $(ccxray secret upstream)'` for `/v1`. |
| Auth logic ≤ 2 files | Yes: `server/auth.js` (verifyUpstream + verifyDashboard + deriveSecrets + redeemBootstrap + logout) + `server/index.js` dispatcher. CLI bootstrap and inline browser script are separate concerns. |
| No per-route bespoke handling | Yes: path-prefix → domain → verifier. No `kind` enum. |
| No client-side monkey-patching | Yes: 20-line inline bootstrap reads a fragment, scrubs it, POSTs once. Not a patch. SSE and fetch use cookies natively. |
| Composes with future features | Yes: adding an upstream prefix is one array entry; adding a dashboard route inherits the dashboard verifier automatically; adding a new credential form is one branch in one file. |
| Hub mode preserved | Yes, structurally improved: IPC moves off HTTP onto a peer-UID-gated Unix socket. Lockfile carries discovery only. |
| Multi-UID localhost defensible | Yes: ephemeral mode (default) restricts to owning UID; opt-in flag re-opens old anonymous-loopback behavior. |

This design takes A's CLI back-compat, three-commit staging discipline, and clear migration table, and combines them with B's structural domain split, stateless HMAC cookies, fragment bootstrap, Sec-Fetch-Site primary CSRF gate, Unix-socket hub IPC, and default-safe multi-UID posture. It avoids A's three real weaknesses (in-memory session set incompatible with hub idle-shutdown; `?token=` in query of the bootstrap URL; "skip Origin for upstream-proxy" carve-out) and B's two non-load-bearing complications (CLI subcommand sprawl, hard dependency on `ANTHROPIC_CUSTOM_HEADERS` — kept as primary mechanism but with explicit fallback documented).

--- end of candidate AB ---
