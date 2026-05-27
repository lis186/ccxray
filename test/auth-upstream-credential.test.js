'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Re-require server/auth after each AUTH_TOKEN/CCXRAY_HOME flip so module-level
// state (AUTH_TOKEN const, cached secrets) refreshes. Mirrors auth.test.js.
function loadAuth({ token, home } = {}) {
  if (token === undefined || token === null) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = token;
  if (home) process.env.CCXRAY_HOME = home;
  delete require.cache[require.resolve('../server/auth')];
  return require('../server/auth');
}

// The valid X-Ccxray-Auth header value is base64url(K_upstream) — exactly what
// server/providers.js getUpstreamToken() injects into spawned CLIs.
function upstreamTokenFor(auth) {
  return auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');
}

const JWT = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakesig';

let originalToken;
let originalHome;
before(() => { originalToken = process.env.AUTH_TOKEN; originalHome = process.env.CCXRAY_HOME; });
after(() => {
  if (originalToken !== undefined) process.env.AUTH_TOKEN = originalToken; else delete process.env.AUTH_TOKEN;
  if (originalHome !== undefined) process.env.CCXRAY_HOME = originalHome; else delete process.env.CCXRAY_HOME;
  delete require.cache[require.resolve('../server/auth')];
});

describe('verifyUpstreamCredential — shared upstream auth taxonomy (2.2)', () => {
  describe('AUTH_TOKEN mode', () => {
    it('valid X-Ccxray-Auth → "ok"', () => {
      const auth = loadAuth({ token: 'sec1' });
      const tok = upstreamTokenFor(auth);
      assert.equal(auth.verifyUpstreamCredential({ 'x-ccxray-auth': tok }), 'ok');
    });

    it('no credential at all → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({}), 'reject');
    });

    it('forged X-Ccxray-Auth (wrong value) → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({ 'x-ccxray-auth': 'not-the-real-token' }), 'reject');
    });

    it('legacy Bearer AUTH_TOKEN (no X-Ccxray-Auth) → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({ authorization: 'Bearer sec1' }), 'reject');
    });
  });

  describe('ChatGPT-OAuth carve-out (errata §1.3)', () => {
    it('chatgpt-account-id + JWT-shaped auth, no X-Ccxray-Auth → "chatgpt-oauth"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({ 'chatgpt-account-id': 'acct-1', authorization: JWT }), 'chatgpt-oauth');
    });

    it('chatgpt-account-id but non-JWT Authorization → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({ 'chatgpt-account-id': 'acct-1', authorization: 'Bearer sk-proj-abc' }), 'reject');
    });

    it('JWT-shaped Authorization but no chatgpt-account-id → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(auth.verifyUpstreamCredential({ authorization: JWT }), 'reject');
    });

    it('present-but-wrong X-Ccxray-Auth is NOT rescued by chatgpt markers → "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      assert.equal(
        auth.verifyUpstreamCredential({ 'x-ccxray-auth': 'forged', 'chatgpt-account-id': 'acct-1', authorization: JWT }),
        'reject'
      );
    });
  });

  describe('ephemeral mode (no AUTH_TOKEN, K_upstream from local-secret)', () => {
    it('valid X-Ccxray-Auth → "ok"', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-vuc-'));
      try {
        const auth = loadAuth({ token: null, home });
        const tok = upstreamTokenFor(auth);
        assert.equal(auth.verifyUpstreamCredential({ 'x-ccxray-auth': tok }), 'ok');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('no X-Ccxray-Auth → "reject"', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-vuc-'));
      try {
        const auth = loadAuth({ token: null, home });
        assert.equal(auth.verifyUpstreamCredential({}), 'reject');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('CCXRAY_LOOPBACK_NO_AUTH — hatch moved out of the taxonomy (2.3)', () => {
    // 2.3 reworked the escape hatch to be loopback-guarded. The env flag is no
    // longer honored here: verifyUpstreamCredential is pure header taxonomy with
    // no access to req.socket. The bypass now lives in the gate functions
    // (verifyUpstream / isAuthorized / verifyDashboard) via isLoopbackBypass(req).
    it('flag "1" does NOT rescue a credential-less request → still "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      process.env.CCXRAY_LOOPBACK_NO_AUTH = '1';
      try {
        assert.equal(auth.verifyUpstreamCredential({}), 'reject');
      } finally {
        delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
      }
    });

    it('flag "1" does NOT rescue a forged X-Ccxray-Auth → still "reject"', () => {
      const auth = loadAuth({ token: 'sec1' });
      process.env.CCXRAY_LOOPBACK_NO_AUTH = '1';
      try {
        assert.equal(auth.verifyUpstreamCredential({ 'x-ccxray-auth': 'forged' }), 'reject');
      } finally {
        delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
      }
    });
  });
});
