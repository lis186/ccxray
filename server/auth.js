'use strict';

/**
 * Two-domain auth primitives.
 *
 * Upstream domain (`/v1/*`): X-Ccxray-Auth header (or scoped ChatGPT-OAuth
 * carve-out). Dashboard domain (everything else): session cookie OR Bearer
 * AUTH_TOKEN OR X-Ccxray-Auth. Loopback escape hatch (CCXRAY_LOOPBACK_NO_AUTH)
 * bypasses both, guarded by req.socket.remoteAddress. Static shell is served
 * before the gate so the bootstrap script can run without a cookie.
 *
 * Authoritative design: reason/260525-0055-ccxray-auth-design/candidate-AB.md
 * Implementation deviations: reason/260525-0055-ccxray-auth-design/errata.md
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

// ─── Root secret resolution ──────────────────────────────────────────

function getHubDir() {
  return process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
}

function ensureHubDir() {
  const dir = getHubDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync ignores mode on existing dirs; tighten explicitly.
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function readOrCreateEphemeralSecret() {
  const dir = ensureHubDir();
  const secretPath = path.join(dir, 'local-secret');
  try {
    const existing = fs.readFileSync(secretPath);
    if (existing.length === 32) return existing;
    // Wrong length — treat as corrupt and regenerate.
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, fresh, { mode: 0o600 });
  // writeFileSync respects mode only on create; tighten explicitly in case
  // the file already existed with looser perms.
  try { fs.chmodSync(secretPath, 0o600); } catch {}
  return fresh;
}

function getRootSecret() {
  const token = process.env.AUTH_TOKEN;
  if (token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest();
  }
  return readOrCreateEphemeralSecret();
}

// ─── HKDF label-separated derivation ─────────────────────────────────

const LABELS = Object.freeze({
  K_upstream: 'ccxray/v1/upstream',
  K_session: 'ccxray/v1/session-hmac',
  K_bootstrap: 'ccxray/v1/bootstrap',
});

function hkdf(rootKey, label, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', rootKey, Buffer.alloc(0), Buffer.from(label, 'utf8'), len));
}

function deriveSecrets(rootKey) {
  return {
    K_upstream: hkdf(rootKey, LABELS.K_upstream),
    K_session: hkdf(rootKey, LABELS.K_session),
    K_bootstrap: hkdf(rootKey, LABELS.K_bootstrap),
  };
}

// ─── Stateless HMAC session cookie ───────────────────────────────────

const COOKIE_VERSION = 1;

function signCookie(payload, K_session) {
  const json = JSON.stringify(payload);
  const payloadBuf = Buffer.from(json, 'utf8');
  const hmac = crypto.createHmac('sha256', K_session).update(payloadBuf).digest();
  return `${payloadBuf.toString('base64url')}.${hmac.toString('base64url')}`;
}

function verifyCookie(raw, K_session) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payloadB64 = raw.slice(0, dot);
  const hmacB64 = raw.slice(dot + 1);

  let payloadBuf, providedHmac;
  try {
    payloadBuf = Buffer.from(payloadB64, 'base64url');
    providedHmac = Buffer.from(hmacB64, 'base64url');
  } catch {
    return null;
  }
  // base64url decode is lenient — reject anything that round-trips to a
  // different string (catches the '!!!.!!!' garbage-in case).
  if (payloadBuf.toString('base64url') !== payloadB64) return null;
  if (providedHmac.toString('base64url') !== hmacB64) return null;
  if (providedHmac.length !== 32) return null;

  const expected = crypto.createHmac('sha256', K_session).update(payloadBuf).digest();
  if (!crypto.timingSafeEqual(providedHmac, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.v !== COOKIE_VERSION) return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ─── Constant-time string compare ────────────────────────────────────

function compareSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  // Hash both sides to a fixed-width buffer so timingSafeEqual never throws
  // on length mismatch and the comparison work is independent of input length.
  const ph = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const eh = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(ph, eh) && provided.length === expected.length;
}

// ─── Two-domain dispatcher ───────────────────────────────────────────
//
// dispatch(req) classifies a request by path into upstream or dashboard
// and returns the matching verifier.

const UPSTREAM_PREFIXES = ['/v1/'];

function getPathname(url) {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function classifyDomain(req) {
  const pathname = getPathname(req.url || '');
  for (const prefix of UPSTREAM_PREFIXES) {
    if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) {
      return 'upstream';
    }
  }
  return 'dashboard';
}

// ─── Phase 1.3: cookie path + bootstrap flow ─────────────────────────

const ALLOWED_HOSTS = new Set(); // populated lazily from req.headers.host
const COOKIE_TTL_SECONDS = 24 * 60 * 60; // 24h per "最小開發" decision
const BOOTSTRAP_TTL_MS = 60 * 1000;
const BOOTSTRAP_MAX_PENDING = 8;

// Module-level state. Cleared whenever the module is re-required (tests do
// this via delete require.cache).
const pendingBootstraps = new Map(); // hashHex → expireEpochMs
let _cachedSecrets = null;

function getSecrets() {
  if (_cachedSecrets) return _cachedSecrets;
  _cachedSecrets = deriveSecrets(getRootSecret());
  return _cachedSecrets;
}

function _hashBootstrap(tok) {
  const { K_bootstrap } = getSecrets();
  return crypto.createHmac('sha256', K_bootstrap).update(tok, 'utf8').digest('hex');
}

function _gcBootstraps(now = Date.now()) {
  for (const [k, exp] of pendingBootstraps) if (exp < now) pendingBootstraps.delete(k);
}

function mintBootstrapToken() {
  _gcBootstraps();
  // Cap the pending set so a runaway minter can't grow it unbounded.
  while (pendingBootstraps.size >= BOOTSTRAP_MAX_PENDING) {
    // Drop oldest by insertion order (Map preserves it).
    const oldest = pendingBootstraps.keys().next().value;
    pendingBootstraps.delete(oldest);
  }
  const tok = crypto.randomBytes(24).toString('base64url');
  pendingBootstraps.set(_hashBootstrap(tok), Date.now() + BOOTSTRAP_TTL_MS);
  return tok;
}

// Phase 2.4: launcher auto-bootstrap. The CLI that spawned the agent already
// holds the root secret, so for the browser it opens itself it can legitimately
// mint a fresh single-use token and pre-load it in the URL fragment — saving
// the user a manual `ccxray open` for the common local-launch case. No new
// primitive: same 60s single-use token, same redeem endpoint.
//
// formatAutoOpenUrl is a pure builder. Use it directly when the token MUST be
// minted in a different process (hub mode: redeem runs in the hub process, so
// pendingBootstraps has to live there — the client process gets the token via
// the hub socket's `bootstrap-token` command). mintAutoOpenUrl is the in-
// process convenience that mints + formats; safe only when this process is
// also the one whose /_auth/redeem will be hit.
function formatAutoOpenUrl(port, token) {
  return `http://localhost:${port}/#k=${token}`;
}

function mintAutoOpenUrl(port) {
  return formatAutoOpenUrl(port, mintBootstrapToken());
}

function _isAllowedHost(host) {
  if (!host) return false;
  // Phase 1.3 is permissive: any localhost/loopback host is allowed. Phase
  // 2.2 will tighten this with an explicit allowlist + CCXRAY_PUBLIC_ORIGINS.
  if (host.startsWith('localhost:') || host === 'localhost') return true;
  if (host.startsWith('127.0.0.1:') || host === '127.0.0.1') return true;
  if (host.startsWith('[::1]:') || host === '[::1]') return true;
  return false;
}

function _passesCsrfGate(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs !== undefined) {
    return sfs === 'same-origin' || sfs === 'none';
  }
  // Older browser / non-browser fallback: require Origin to match Host.
  const origin = req.headers.origin;
  if (!origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  return _isAllowedHost(u.host);
}

function parseCookie(raw, name) {
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function _readSessionCookie(req) {
  return parseCookie(req.headers.cookie, 'ccxray_s');
}

function _signSessionCookie() {
  const { K_session } = getSecrets();
  const payload = {
    v: 1,
    n: crypto.randomBytes(12).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS,
  };
  return signCookie(payload, K_session);
}

function _verifySessionCookieValue(value) {
  if (!value) return null;
  const { K_session } = getSecrets();
  return verifyCookie(value, K_session);
}

function _send(res, code, body, contentType = 'application/json') {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
}

function redeemBootstrap(req, res) {
  // Drain the body (we don't read it — it's required for POST and that's all).
  let drained = false;
  const finish = (code) => {
    if (drained) return;
    drained = true;
    if (code === 204) {
      const setCookie = `ccxray_s=${_signSessionCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_TTL_SECONDS}`;
      res.setHeader('Set-Cookie', setCookie);
      res.writeHead(204);
      res.end();
    } else if (code === 401) {
      _send(res, 401, { error: 'invalid_bootstrap' });
    } else if (code === 403) {
      _send(res, 403, { error: 'csrf' });
    }
  };

  req.on('data', () => {});
  req.on('end', () => {
    const tok = req.headers['x-ccxray-bootstrap'];
    if (!tok) return finish(401);
    if (!_passesCsrfGate(req)) return finish(403);

    _gcBootstraps();
    const hash = _hashBootstrap(tok);
    if (!pendingBootstraps.has(hash)) return finish(401);
    pendingBootstraps.delete(hash); // single-use
    finish(204);
  });
}

// Single source of truth for "is this dashboard request authenticated?" —
// pure boolean, no side effects. Shared by verifyDashboard (the gate) and
// authStatus (the /_auth/status browser probe) so the two never disagree.
//
// Accepts (in order) the loopback escape hatch, a valid session cookie, a
// valid X-Ccxray-Auth (base64url K_upstream — lets scripts/CI reach /_api/*
// without the bootstrap dance), or `Authorization: Bearer <AUTH_TOKEN>`
// (permanent dashboard credential per spec). 'chatgpt-oauth' is deliberately
// NOT accepted: codex markers are not a dashboard credential.
function _isDashboardAuthenticated(req) {
  if (isLoopbackBypass(req)) return true;
  const cookieValue = _readSessionCookie(req);
  if (cookieValue && _verifySessionCookieValue(cookieValue)) return true;
  if (verifyUpstreamCredential(req.headers) === 'ok') return true;
  if (AUTH_TOKEN && (req.headers['authorization'] || '') === `Bearer ${AUTH_TOKEN}`) return true;
  return false;
}

function authStatus(req, res) {
  if (_isDashboardAuthenticated(req)) {
    _send(res, 200, { ok: true });
  } else {
    _send(res, 401, { error: 'no_session' });
  }
}

function verifyDashboard(req, res) {
  if (!_isDashboardAuthenticated(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'unauthorized',
      message: 'Dashboard requires a session cookie — run: ccxray open',
    }));
    return false;
  }
  return true;
}

// ─── Loopback-guarded escape hatch (Phase 2.3, design 決策 7) ─────────
//
// CCXRAY_LOOPBACK_NO_AUTH=1 disables the auth gate, but only for loopback
// peers. ccxray binds 0.0.0.0, so a blunt header-only bypass (as shipped in
// 2.2) would expose /v1/* and the dashboard to the whole LAN the moment the
// flag is set. The check lives in the gate functions (verifyUpstream, WS
// isAuthorized, verifyDashboard) because they hold req.socket; the taxonomy
// helper verifyUpstreamCredential(headers) cannot see the peer address.
//
// Residual gap: a same-host reverse proxy presents remoteAddress = 127.0.0.1,
// defeating the guard. That needs double opt-in (proxy + flag) and the startup
// banner warns regardless — documented, not closed (errata §5).

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackAddress(addr) {
  return typeof addr === 'string' && LOOPBACK_ADDRESSES.has(addr);
}

function isLoopbackBypass(req) {
  if (process.env.CCXRAY_LOOPBACK_NO_AUTH !== '1') return false;
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

// ─── Upstream credential taxonomy (Phase 2.2) ────────────────────────
//
// Single source of truth for "is this /v1/* request allowed upstream?",
// shared by verifyUpstream (HTTP) and ws-proxy isAuthorized (WS). Returns
// 'ok' | 'chatgpt-oauth' | 'reject'.
//
// X-Ccxray-Auth carries base64url(K_upstream) — the value the launchers in
// server/providers.js inject. We constant-time compare it to the locally
// derived K_upstream, so this behaves identically whether the root secret
// comes from AUTH_TOKEN or the ephemeral local-secret file.

// JWT-shaped: "Bearer <header>.<payload>.<sig>" with a non-trivial header.
function isJwtShaped(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return false;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  const parts = token.split('.');
  return parts.length === 3 && parts[0].length > 10;
}

function verifyUpstreamCredential(headers) {
  // Pure header taxonomy: no env-flag or peer-address awareness. The
  // CCXRAY_LOOPBACK_NO_AUTH escape hatch is enforced by the gate functions
  // (isLoopbackBypass), which alone can see req.socket.remoteAddress.
  const headerVal = headers['x-ccxray-auth'];
  if (headerVal) {
    // Header present → it must be the real K_upstream. A forged value rejects
    // outright; it is never rescued by the ChatGPT-OAuth carve-out below.
    const { K_upstream } = getSecrets();
    return compareSecret(headerVal, K_upstream.toString('base64url')) ? 'ok' : 'reject';
  }
  // ChatGPT-OAuth carve-out (errata §1.3): codex-on-ChatGPT cannot inject
  // X-Ccxray-Auth, so accept its native markers instead.
  if (headers['chatgpt-account-id'] && isJwtShaped(headers['authorization'])) return 'chatgpt-oauth';
  return 'reject';
}

// Single source of truth for "is this /v1/* request authenticated?" — pure
// boolean, shared by verifyUpstream (HTTP gate) and ws-proxy isAuthorized (WS
// gate) so the two can't drift.
//
// Acceptors: the loopback escape hatch, a valid X-Ccxray-Auth, or the Codex-
// on-ChatGPT carve-out IFF the request would route to the ChatGPT backend.
// The carve-out exists because Codex on a ChatGPT login can't inject custom
// headers (errata §1.3), but the markers (chatgpt-account-id + JWT-shaped
// Authorization) are only meaningful on ChatGPT-routed paths. On Anthropic
// /v1/messages they'd be a forgery attempt — caught by the upstream-routing
// check (codex 2.4 P1).
function isUpstreamAuthenticated(req) {
  if (isLoopbackBypass(req)) return true;
  const verdict = verifyUpstreamCredential(req.headers);
  if (verdict === 'ok') return true;
  if (verdict === 'chatgpt-oauth') {
    const upstream = config.getUpstreamForRequestAndHeaders(req.url, req.headers);
    return upstream === config.UPSTREAMS.openaiChatGPT;
  }
  return false;
}

function verifyUpstream(req, res) {
  if (isUpstreamAuthenticated(req)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'unauthorized',
    message: 'Valid X-Ccxray-Auth required on /v1/* (run: ccxray secret upstream)',
  }));
  return false;
}

function dispatch(req) {
  const domain = classifyDomain(req);
  return {
    domain,
    verify: domain === 'upstream' ? verifyUpstream : verifyDashboard,
  };
}

// AUTH_TOKEN: the optional shared secret. When set, the SHA256 hash is the
// root of HKDF derivation and `Bearer <AUTH_TOKEN>` is accepted on the
// dashboard. When unset (ephemeral mode), the root falls back to
// ~/.ccxray/local-secret. Module-local — not exported.
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

module.exports = {
  // HKDF + cookie primitives
  deriveSecrets,
  getRootSecret,
  signCookie,
  verifyCookie,
  compareSecret,
  // Two-domain dispatcher + gates
  dispatch,
  verifyDashboard,
  verifyUpstream,
  // Shared upstream credential taxonomy (pure header check)
  verifyUpstreamCredential,
  // Shared upstream-gate predicate (HTTP + WS); scopes ChatGPT-OAuth carve-out
  // to ChatGPT-routed requests.
  isUpstreamAuthenticated,
  // Loopback-guarded escape hatch, shared by all three gates.
  isLoopbackBypass,
  isLoopbackAddress,
  // Bootstrap + browser session
  mintBootstrapToken,
  mintAutoOpenUrl,
  formatAutoOpenUrl,
  redeemBootstrap,
  authStatus,
  parseCookie,
};
