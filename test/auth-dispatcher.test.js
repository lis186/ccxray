'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-run temp CCXRAY_HOME so ephemeral-mode derivation writes its local-secret
// somewhere safe and never touches the user's real ~/.ccxray.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-dispatcher-'));
process.env.CCXRAY_HOME = TEST_HOME;

// Match the existing test/auth.test.js style: re-require server/auth after
// each AUTH_TOKEN flip so the module's AUTH_TOKEN constant refreshes.
function loadAuthWith(token) {
  if (token === null) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = token;
  delete require.cache[require.resolve('../server/auth')];
  return require('../server/auth');
}

// The valid X-Ccxray-Auth header value the launchers inject: base64url(K_upstream).
function upstreamTokenFor(auth) {
  return auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');
}

// A valid ccxray_s session cookie value, signed with the current K_session —
// what /_auth/redeem mints after a successful bootstrap.
function validCookie(auth) {
  const { K_session } = auth.deriveSecrets(auth.getRootSecret());
  const payload = { v: 1, n: 'test', exp: Math.floor(Date.now() / 1000) + 3600 };
  return 'ccxray_s=' + auth.signCookie(payload, K_session);
}

function mockReqRes(headers = {}, url = '/', remoteAddress) {
  const setHeaderCalls = {};
  const req = { headers, url };
  // Only attach a socket when a peer address is supplied, so existing callers
  // (socket undefined) exercise the "no req.socket" defensive path.
  if (remoteAddress !== undefined) req.socket = { remoteAddress };
  const res = {
    statusCode: null,
    body: null,
    writeHeadCalled: false,
    writeHeadHeaders: null,
    setHeader(name, value) { setHeaderCalls[name] = value; },
    getHeader(name) { return setHeaderCalls[name]; },
    writeHead(code, h) { this.writeHeadCalled = true; this.statusCode = code; this.writeHeadHeaders = h || {}; },
    end(body) { this.body = body; },
  };
  return { req, res, setHeaderCalls };
}

let originalToken;
before(() => { originalToken = process.env.AUTH_TOKEN; });
after(() => {
  if (originalToken !== undefined) process.env.AUTH_TOKEN = originalToken;
  else delete process.env.AUTH_TOKEN;
  delete require.cache[require.resolve('../server/auth')];
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('dispatch(req) — path classification', () => {
  const auth = loadAuthWith(null);

  it('classifies /v1/messages as upstream', () => {
    assert.equal(auth.dispatch({ url: '/v1/messages', headers: {} }).domain, 'upstream');
  });

  it('classifies /v1/responses (codex WS upgrade) as upstream', () => {
    assert.equal(auth.dispatch({ url: '/v1/responses', headers: {} }).domain, 'upstream');
  });

  it('classifies /v1/anything-else as upstream', () => {
    assert.equal(auth.dispatch({ url: '/v1/foo/bar', headers: {} }).domain, 'upstream');
  });

  it('classifies query strings on /v1/* as upstream (pathname split)', () => {
    assert.equal(auth.dispatch({ url: '/v1/messages?x=1', headers: {} }).domain, 'upstream');
  });

  it('classifies / as dashboard', () => {
    assert.equal(auth.dispatch({ url: '/', headers: {} }).domain, 'dashboard');
  });

  it('classifies /_api/entries as dashboard', () => {
    assert.equal(auth.dispatch({ url: '/_api/entries', headers: {} }).domain, 'dashboard');
  });

  it('classifies /_api/entries?token=x as dashboard (pathname split)', () => {
    assert.equal(auth.dispatch({ url: '/_api/entries?token=x', headers: {} }).domain, 'dashboard');
  });

  it('classifies /_events as dashboard', () => {
    assert.equal(auth.dispatch({ url: '/_events', headers: {} }).domain, 'dashboard');
  });

  it('classifies /style.css as dashboard', () => {
    assert.equal(auth.dispatch({ url: '/style.css', headers: {} }).domain, 'dashboard');
  });

  it('exposes a verify function for each domain', () => {
    assert.equal(typeof auth.dispatch({ url: '/v1/m', headers: {} }).verify, 'function');
    assert.equal(typeof auth.dispatch({ url: '/_api/x', headers: {} }).verify, 'function');
  });
});

describe('verifyDashboard — Phase 2.3 enforcement (cookie / Bearer / X-Ccxray-Auth; ephemeral enforces)', () => {
  it('ephemeral (no AUTH_TOKEN) + no credential → 401 (allow-all is gone) (4.3/4.7)', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({}, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('ephemeral + valid X-Ccxray-Auth → true (K_upstream from local-secret) (4.3)', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({ 'x-ccxray-auth': upstreamTokenFor(auth) }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('valid session cookie → true (4.8)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ cookie: validCookie(auth) }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, no credentials → 401 (4.7)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({}, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, correct Bearer → true, no deprecation header (permanent) (4.2)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });

  it('provider header hygiene handles dashboard bearer scheme variants', () => {
    const auth = loadAuthWith('sec1');
    for (const scheme of ['Bearer', 'bearer', 'bEaReR']) {
      const { req, res } = mockReqRes({ authorization: `${scheme} sec1` }, '/_api/entries');
      assert.equal(auth.verifyDashboard(req, res), true);
      const wrong = mockReqRes({ authorization: `${scheme} SEC1` }, '/_api/entries');
      assert.equal(auth.verifyDashboard(wrong.req, wrong.res), false);
    }
  });

  it('AUTH_TOKEN set, wrong Bearer → 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearer wrong', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, different-length Bearer token → 401, no throw (timing-safe path)', () => {
    // compareSecret hashes both sides to sha256 fixed-width before timingSafeEqual,
    // so a length-mismatched token must not throw and must be rejected.
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearer averylongtokenthatdoesnotmatch', host: 'localhost' }, '/_api/entries');
    assert.doesNotThrow(() => auth.verifyDashboard(req, res));
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, malformed header without "Bearer " prefix → 401', () => {
    // Old === check: `'sec1' === 'Bearer sec1'` → false (same outcome).
    // New code: startsWith('Bearer ') guard rejects before compareSecret.
    // Behavior is identical, but the guard is now explicit; test documents the boundary.
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'sec1', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, "Bearertoken" (no space) → 401', () => {
    // Ensures the prefix check requires the space: 'Bearer' followed by a space.
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearersec1', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, valid X-Ccxray-Auth → true (programmatic dashboard access) (4.1)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'x-ccxray-auth': upstreamTokenFor(auth) }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, non-matching X-Ccxray-Auth (no other cred) → 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'x-ccxray-auth': 'forged' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, legacy ?token= → 401 (Phase 3 removed it)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ host: 'localhost' }, '/_api/entries?token=sec1');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });

  it('dashboard loopback trust: loopback peer + no cred → true (default since 1.11)', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/_api/entries', '127.0.0.1');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('dashboard loopback trust: ::1 + no cred → true', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/_api/entries', '::1');
    assert.equal(auth.verifyDashboard(req, res), true);
  });

  it('dashboard loopback trust: REQUIRE_AUTH=1 + loopback → 401', () => {
    const auth = loadAuthWith('sec1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      const { req, res } = mockReqRes({}, '/_api/entries', '127.0.0.1');
      assert.equal(auth.verifyDashboard(req, res), false);
      assert.equal(res.statusCode, 401);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('dashboard loopback trust: non-loopback + no cred → 401', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/_api/entries', '192.168.1.50');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('legacy hatch: flag "1" + loopback peer + no cred → true (still works for dashboard)', () => {
    const auth = loadAuthWith('sec1');
    process.env.CCXRAY_LOOPBACK_NO_AUTH = '1';
    try {
      const { req, res } = mockReqRes({}, '/_api/entries', '127.0.0.1');
      assert.equal(auth.verifyDashboard(req, res), true);
      assert.equal(res.writeHeadCalled, false);
    } finally { delete process.env.CCXRAY_LOOPBACK_NO_AUTH; }
  });
});

describe('verifyUpstream — Phase 2.2 enforcement (X-Ccxray-Auth required, legacy rejected)', () => {
  it('no AUTH_TOKEN, no X-Ccxray-Auth: rejects with 401 (ephemeral still enforces)', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({}, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('no AUTH_TOKEN, valid X-Ccxray-Auth: returns true (ephemeral K_upstream)', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({ 'x-ccxray-auth': upstreamTokenFor(auth) }, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, no credentials: returns false and writes 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({}, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, valid X-Ccxray-Auth: returns true (no deprecation header)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ 'x-ccxray-auth': upstreamTokenFor(auth), host: 'localhost' }, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), true);
    assert.equal(res.writeHeadCalled, false);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });

  it('AUTH_TOKEN set, non-matching X-Ccxray-Auth: returns false and writes 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'x-ccxray-auth': 'forged-value', host: 'localhost' }, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, legacy Bearer on /v1/* now REJECTED with 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearer sec1', host: 'localhost' }, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, legacy ?token= on /v1/* now REJECTED with 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ host: 'localhost' }, '/v1/messages?token=sec1');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('ChatGPT-login headers accepted on a ChatGPT-routed request', () => {
    const auth = loadAuthWith('sec1');
    const jwt = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';
    const { req, res } = mockReqRes({ 'chatgpt-account-id': 'acct-1', authorization: jwt }, '/v1/responses', '127.0.0.1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      assert.equal(auth.verifyUpstream(req, res), true);
      assert.equal(res.writeHeadCalled, false);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });
});

describe('isLoopbackBypass — default-on loopback trust', () => {
  function check(req) {
    const auth = loadAuthWith('sec1');
    return auth.isLoopbackBypass(req);
  }

  it('no flags + 127.0.0.1 → true (default trust)', () => {
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    assert.equal(check({ socket: { remoteAddress: '127.0.0.1' } }), true);
  });

  it('no flags + ::1 → true', () => {
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    assert.equal(check({ socket: { remoteAddress: '::1' } }), true);
  });

  it('no flags + ::ffff:127.0.0.1 → true', () => {
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    assert.equal(check({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  });

  it('no flags + non-loopback → false', () => {
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    assert.equal(check({ socket: { remoteAddress: '192.168.1.50' } }), false);
  });

  it('REQUIRE_AUTH=1 + loopback → false (paranoid mode)', () => {
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try { assert.equal(check({ socket: { remoteAddress: '127.0.0.1' } }), false); }
    finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('REQUIRE_AUTH=0 + loopback → true (only exact "1" gates)', () => {
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '0';
    try { assert.equal(check({ socket: { remoteAddress: '127.0.0.1' } }), true); }
    finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('missing socket → false (defensive)', () => {
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    assert.equal(check({}), false);
  });

  it('legacy CCXRAY_LOOPBACK_NO_AUTH=1 is ignored (no-op)', () => {
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    process.env.CCXRAY_LOOPBACK_NO_AUTH = '1';
    try { assert.equal(check({ socket: { remoteAddress: '127.0.0.1' } }), true); }
    finally { delete process.env.CCXRAY_LOOPBACK_NO_AUTH; }
  });
});

describe('loopback trust covers both dashboard and upstream', () => {
  it('loopback + upstream /v1/messages + no cred → true (default trust)', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/v1/messages', '127.0.0.1');
    assert.equal(auth.verifyUpstream(req, res), true);
  });

  it('non-loopback + upstream + no cred → 401', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/v1/messages', '192.168.1.50');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('REQUIRE_AUTH=1 + loopback + upstream + no cred → 401', () => {
    const auth = loadAuthWith('sec1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      const { req, res } = mockReqRes({}, '/v1/messages', '127.0.0.1');
      assert.equal(auth.verifyUpstream(req, res), false);
      assert.equal(res.statusCode, 401);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('loopback + dashboard POST (intercept) + no cred → true', () => {
    const auth = loadAuthWith('sec1');
    delete process.env.CCXRAY_LOOPBACK_NO_AUTH;
    delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    const { req, res } = mockReqRes({}, '/_api/intercept/toggle', '127.0.0.1');
    assert.equal(auth.verifyDashboard(req, res), true);
  });
});

describe('verifyUpstream — ChatGPT-login compatibility scoped to ChatGPT-routed requests', () => {
  // Codex on a ChatGPT login cannot inject custom headers, so its native
  // headers are accepted only when the request routes to the ChatGPT backend.
  const JWT = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';

  it('ChatGPT-login headers not accepted on /v1/messages (Anthropic route) → 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'chatgpt-account-id': 'acct-1', authorization: JWT }, '/v1/messages', '127.0.0.1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      assert.equal(auth.verifyUpstream(req, res), false);
      assert.equal(res.statusCode, 401);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('ChatGPT-login headers on /v1/responses (Codex path → ChatGPT route) → allowed', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'chatgpt-account-id': 'acct-1', authorization: JWT }, '/v1/responses', '127.0.0.1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      assert.equal(auth.verifyUpstream(req, res), true);
      assert.equal(res.writeHeadCalled, false);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });

  it('ChatGPT-login headers on /v1/realtime (OpenAI path + chatgpt-account-id → ChatGPT route) → allowed', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ 'chatgpt-account-id': 'acct-1', authorization: JWT }, '/v1/realtime', '127.0.0.1');
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      assert.equal(auth.verifyUpstream(req, res), true);
      assert.equal(res.writeHeadCalled, false);
    } finally { delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH; }
  });
});

describe('dispatch().verify — sanity: same instance routes to correct verifier', () => {
  it('upstream path routes to verifyUpstream (valid X-Ccxray-Auth accepted)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ 'x-ccxray-auth': upstreamTokenFor(auth) }, '/v1/messages');
    const { verify } = auth.dispatch(req);
    assert.equal(verify(req, res), true);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });

  it('dashboard path routes to verifyDashboard', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1' }, '/_api/entries');
    const { verify } = auth.dispatch(req);
    assert.equal(verify(req, res), true);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });
});

describe('ChatGPT-login headers are a credential for loopback peers only', () => {
  const JWT = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';
  const LOGIN = { 'chatgpt-account-id': 'acct-1', authorization: JWT };

  function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  function authed(headers, remoteAddress, url = '/v1/responses') {
    const auth = loadAuthWith('sec1');
    return auth.isUpstreamAuthenticated({ headers, url, socket: { remoteAddress } });
  }

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`accepted from loopback ${addr} with CCXRAY_LOOPBACK_REQUIRE_AUTH=1`, () => {
      withEnv({ CCXRAY_LOOPBACK_REQUIRE_AUTH: '1', CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: undefined }, () => {
        assert.equal(authed(LOGIN, addr), true);
      });
    });
  }

  it('accepted from loopback under default loopback trust', () => {
    withEnv({ CCXRAY_LOOPBACK_REQUIRE_AUTH: undefined, CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: undefined }, () => {
      assert.equal(authed(LOGIN, '127.0.0.1'), true);
    });
  });

  it('rejected from a non-loopback peer', () => {
    withEnv({ CCXRAY_LOOPBACK_REQUIRE_AUTH: undefined, CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: undefined }, () => {
      assert.equal(authed(LOGIN, '192.168.1.50'), false);
      assert.equal(authed(LOGIN, '192.168.1.50', '/v1/realtime'), false);
      assert.equal(authed(LOGIN, '::ffff:10.0.0.7'), false);
    });
  });

  it('rejected when the peer address is unknown', () => {
    withEnv({ CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: undefined }, () => {
      const auth = loadAuthWith('sec1');
      assert.equal(auth.isUpstreamAuthenticated({ headers: LOGIN, url: '/v1/responses' }), false);
    });
  });

  it('accepted from a non-loopback peer with CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN=1', () => {
    withEnv({ CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: '1' }, () => {
      assert.equal(authed(LOGIN, '192.168.1.50'), true);
    });
  });

  it('the opt-in still requires a ChatGPT-routed request', () => {
    withEnv({ CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: '1' }, () => {
      assert.equal(authed(LOGIN, '192.168.1.50', '/v1/messages'), false);
    });
  });

  it('only the exact value "1" enables the opt-in', () => {
    withEnv({ CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: 'true' }, () => {
      assert.equal(authed(LOGIN, '192.168.1.50'), false);
    });
  });

  it('X-Ccxray-Auth is still accepted from a non-loopback peer', () => {
    withEnv({ CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN: undefined }, () => {
      const auth = loadAuthWith('sec1');
      const headers = { 'x-ccxray-auth': upstreamTokenFor(auth) };
      assert.equal(auth.isUpstreamAuthenticated({ headers, url: '/v1/messages', socket: { remoteAddress: '192.168.1.50' } }), true);
      assert.equal(auth.isUpstreamAuthenticated({ headers, url: '/v1/responses', socket: { remoteAddress: '192.168.1.50' } }), true);
    });
  });
});
