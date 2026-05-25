'use strict';

/**
 * Auth primitives for the two-domain auth migration.
 *
 * Phase 1.1: pure crypto + root secret resolution. Module is exported but
 * not yet wired into the request path (that lands in Phase 1.2). The
 * existing authMiddleware below is preserved unchanged so current behavior
 * is byte-identical until Phase 1.2 swaps the call site over.
 *
 * Authoritative design: reason/260525-0055-ccxray-auth-design/candidate-AB.md
 * Implementation deviations: reason/260525-0055-ccxray-auth-design/errata.md
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// ─── Two-domain dispatcher (Phase 1.2: warn-only) ────────────────────
//
// dispatch(req) classifies a request by path into upstream or dashboard
// and returns the matching verifier. The verifiers are byte-identical
// to authMiddleware on success/failure decisions — they internally
// delegate to it. The only new behavior is X-Ccxray-Deprecation
// response headers on requests that used credential forms slated for
// removal in Phase 2:
//   - dashboard: ?token= → deprecation (Bearer stays permanent)
//   - upstream:  Bearer or ?token= → deprecation
//
// The headers are set via setHeader so they survive the downstream
// handler's writeHead call; setHeader can never affect status code
// or body, so this code is incapable of breaking a request that
// authMiddleware would have allowed.

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

function whichLegacyMechanism(req) {
  // Re-derive the same checks authMiddleware did, so we know which
  // legacy form succeeded. Returns 'bearer' | 'token-query' | null.
  const token = process.env.AUTH_TOKEN;
  if (!token) return null;
  const authHeader = req.headers['authorization'] || '';
  if (authHeader === `Bearer ${token}`) return 'bearer';
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.searchParams.get('token') === token) return 'token-query';
  } catch {}
  return null;
}

function setDeprecation(res, value) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('X-Ccxray-Deprecation', value);
  }
}

function verifyDashboard(req, res) {
  const ok = authMiddleware(req, res);
  if (!ok) return false;
  // Bearer is permanent on the dashboard domain (errata §1.1). Only
  // ?token= is flagged for removal here.
  if (whichLegacyMechanism(req) === 'token-query') {
    setDeprecation(res, 'token-query');
  }
  return true;
}

function verifyUpstream(req, res) {
  const ok = authMiddleware(req, res);
  if (!ok) return false;
  const mech = whichLegacyMechanism(req);
  if (mech === 'bearer') setDeprecation(res, 'bearer-on-upstream');
  else if (mech === 'token-query') setDeprecation(res, 'token-query');
  return true;
}

function dispatch(req) {
  const domain = classifyDomain(req);
  return {
    domain,
    verify: domain === 'upstream' ? verifyUpstream : verifyDashboard,
  };
}

// ─── Legacy middleware (call site swapped in Phase 1.2; kept exported
//     so test/auth.test.js stays green and downstream code can still
//     import it through the deprecation window) ───────────────────────

const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

function authMiddleware(req, res) {
  if (!AUTH_TOKEN) return true; // no auth configured — allow all

  const authHeader = req.headers['authorization'] || '';
  if (authHeader === `Bearer ${AUTH_TOKEN}`) return true;

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.searchParams.get('token') === AUTH_TOKEN) return true;

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized', message: 'Valid AUTH_TOKEN required' }));
  return false;
}

module.exports = {
  // Phase 1.1 additions
  deriveSecrets,
  getRootSecret,
  signCookie,
  verifyCookie,
  compareSecret,
  // Phase 1.2 additions
  dispatch,
  verifyDashboard,
  verifyUpstream,
  // Legacy exports — call site swapped to dispatch() in Phase 1.2,
  // but authMiddleware stays exported so test/auth.test.js and any
  // downstream importer continue to work through the deprecation window.
  authMiddleware,
  AUTH_TOKEN,
};
