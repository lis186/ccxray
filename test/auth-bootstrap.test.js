'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Per-run temp CCXRAY_HOME so getRootSecret writes its local-secret somewhere
// safe. AUTH_TOKEN stays unset so we're in ephemeral mode end-to-end.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bootstrap-test-'));
process.env.CCXRAY_HOME = TEST_HOME;
delete process.env.AUTH_TOKEN;

function loadAuthFresh() {
  delete require.cache[require.resolve('../server/auth')];
  return require('../server/auth');
}

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function mockReqRes(opts = {}) {
  const headers = { host: 'localhost:5577', ...(opts.headers || {}) };
  const req = { method: opts.method || 'POST', url: opts.url || '/_auth/redeem', headers };
  const setHeaderCalls = {};
  let bodyBuf = '';
  // Provide chunk delivery for endpoints that read req.on('data') / .on('end').
  const dataListeners = [];
  const endListeners = [];
  req.on = (evt, fn) => {
    if (evt === 'data') dataListeners.push(fn);
    else if (evt === 'end') endListeners.push(fn);
    return req;
  };
  // Caller can invoke req._deliverBody(string) to feed the body chunk + end.
  req._deliverBody = (s) => {
    if (s) dataListeners.forEach(fn => fn(Buffer.from(s, 'utf8')));
    endListeners.forEach(fn => fn());
  };
  const res = {
    statusCode: null,
    body: null,
    writeHeadCalled: false,
    writeHeadHeaders: null,
    setHeader(name, value) { setHeaderCalls[name.toLowerCase()] = value; },
    getHeader(name) { return setHeaderCalls[name.toLowerCase()]; },
    writeHead(code, h) { this.writeHeadCalled = true; this.statusCode = code; this.writeHeadHeaders = h || {}; },
    end(b) { this.body = b == null ? null : String(b); },
  };
  return { req, res, setHeaderCalls };
}

// Helper: mint a bootstrap token directly from the auth module (simulates the
// hub's bootstrap-token endpoint without spinning up the hub).
function mintBootstrap(auth) {
  return auth.mintBootstrapToken();
}

describe('mintBootstrapToken — one-time pad', () => {
  it('returns a URL-safe token string', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    assert.equal(typeof tok, 'string');
    assert.ok(/^[A-Za-z0-9_-]{20,}$/.test(tok), `unexpected token shape: ${tok}`);
  });

  it('produces unique tokens across calls', () => {
    const auth = loadAuthFresh();
    const a = mintBootstrap(auth);
    const b = mintBootstrap(auth);
    assert.notEqual(a, b);
  });
});

describe('/_auth/redeem — happy path', () => {
  it('200 + Set-Cookie when token is valid and request is same-origin', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    const { req, res, setHeaderCalls } = mockReqRes({
      method: 'POST',
      url: '/_auth/redeem',
      headers: {
        'x-ccxray-bootstrap': tok,
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:5577',
        host: 'localhost:5577',
        'content-type': 'application/json',
      },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 204);
    const setCookie = setHeaderCalls['set-cookie'];
    assert.ok(setCookie, 'expected Set-Cookie header');
    assert.match(setCookie, /^ccxray_s=[^;]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
  });
});

describe('/_auth/redeem — rejection cases', () => {
  it('401 when no bootstrap token is sent', () => {
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({
      headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5577' },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 401);
  });

  it('401 when the token is unknown', () => {
    const auth = loadAuthFresh();
    mintBootstrap(auth); // mint one but use a different value
    const { req, res } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': 'definitely-not-the-token',
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:5577',
      },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 401);
  });

  it('401 on replay — same token cannot redeem twice', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    {
      const { req, res } = mockReqRes({
        headers: { 'x-ccxray-bootstrap': tok, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5577' },
      });
      auth.redeemBootstrap(req, res);
      req._deliverBody('{}');
      assert.equal(res.statusCode, 204, 'first redeem should succeed');
    }
    {
      const { req, res } = mockReqRes({
        headers: { 'x-ccxray-bootstrap': tok, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5577' },
      });
      auth.redeemBootstrap(req, res);
      req._deliverBody('{}');
      assert.equal(res.statusCode, 401, 'second redeem should fail (replay)');
    }
  });

  it('403 when Sec-Fetch-Site is cross-site and Origin is missing', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    const { req, res } = mockReqRes({
      headers: { 'x-ccxray-bootstrap': tok, 'sec-fetch-site': 'cross-site' },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 403);
  });

  it('403 when Origin is on a foreign host', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    const { req, res } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': tok,
        origin: 'http://evil.example.com',
      },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 403);
  });

  it('accepts when Sec-Fetch is absent but Origin matches Host (older browsers)', () => {
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    const { req, res } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': tok,
        origin: 'http://localhost:5577',
        host: 'localhost:5577',
      },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 204);
  });
});

describe('/_auth/status — probe endpoint for inline browser script', () => {
  beforeEach(() => { delete process.env.AUTH_TOKEN; });

  it('returns 401 when no AUTH_TOKEN configured and no credential (ephemeral now enforces)', () => {
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({ method: 'GET', url: '/_auth/status' });
    auth.authStatus(req, res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with AUTH_TOKEN configured and no credentials', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({ method: 'GET', url: '/_auth/status' });
    auth.authStatus(req, res);
    assert.equal(res.statusCode, 401);
    delete process.env.AUTH_TOKEN;
  });

  it('returns 200 with AUTH_TOKEN + correct Bearer', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({
      method: 'GET',
      url: '/_auth/status',
      headers: { authorization: 'Bearer sec1' },
    });
    auth.authStatus(req, res);
    assert.equal(res.statusCode, 200);
    delete process.env.AUTH_TOKEN;
  });

  it('returns 200 after successful bootstrap (cookie path)', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    // Redeem to get a cookie
    const { req: r1, res: res1, setHeaderCalls: sh } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': tok,
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:5577',
      },
    });
    auth.redeemBootstrap(r1, res1);
    r1._deliverBody('{}');
    assert.equal(res1.statusCode, 204);
    const setCookie = sh['set-cookie'];
    const cookieValue = setCookie.match(/^ccxray_s=([^;]+);/)[1];

    // Use cookie on status endpoint
    const { req: r2, res: res2 } = mockReqRes({
      method: 'GET',
      url: '/_auth/status',
      headers: { cookie: `ccxray_s=${cookieValue}` },
    });
    auth.authStatus(r2, res2);
    assert.equal(res2.statusCode, 200);
    delete process.env.AUTH_TOKEN;
  });
});

describe('verifyDashboard — cookie path added in Phase 1.3', () => {
  it('accepts a valid cookie when AUTH_TOKEN is set and no Bearer/?token=', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const tok = mintBootstrap(auth);
    // Mint a cookie via redeem
    const { req: r1, res: res1, setHeaderCalls: sh } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': tok,
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:5577',
      },
    });
    auth.redeemBootstrap(r1, res1);
    r1._deliverBody('{}');
    const cookieValue = sh['set-cookie'].match(/^ccxray_s=([^;]+);/)[1];

    const { req, res } = mockReqRes({
      method: 'GET',
      url: '/_api/entries',
      headers: { cookie: `ccxray_s=${cookieValue}` },
    });
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
    delete process.env.AUTH_TOKEN;
  });

  it('falls through to authMiddleware when cookie is absent', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({ method: 'GET', url: '/_api/entries', headers: {} });
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
    delete process.env.AUTH_TOKEN;
  });

  it('falls through to authMiddleware when cookie is present but invalid', () => {
    process.env.AUTH_TOKEN = 'sec1';
    const auth = loadAuthFresh();
    const { req, res } = mockReqRes({
      method: 'GET',
      url: '/_api/entries',
      headers: { cookie: 'ccxray_s=garbage.value' },
    });
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
    delete process.env.AUTH_TOKEN;
  });
});

// ── HTTP /_auth/bootstrap-token endpoint ──────────────────────────

describe('/_auth/bootstrap-token via HTTP', () => {
  const http = require('http');
  const { handleAuthRoutes } = require('../server/routes/auth');
  let server, port;

  before(async () => {
    server = http.createServer((req, res) => {
      if (!handleAuthRoutes(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(r => server.close(r));
  });

  // base64url(K_upstream) from the same ephemeral local-secret the server uses
  // — the credential `ccxray open` sends. Force AUTH_TOKEN unset + a fresh
  // module so a prior describe's 'sec1'-cached secrets can't leak in.
  function upstreamToken() {
    delete process.env.AUTH_TOKEN;
    delete require.cache[require.resolve('../server/auth')];
    const auth = require('../server/auth');
    return auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');
  }

  function postBootstrap(headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: '/_auth/bootstrap-token', method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => { let body = null; try { body = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body }); });
      });
      req.on('error', reject);
      req.end('{}');
    });
  }

  it('rejects loopback POST without a credential → 401 (codex R3 P1 gate)', async () => {
    const data = await postBootstrap({});
    assert.equal(data.status, 401);
  });

  it('returns a token on loopback POST with a valid X-Ccxray-Auth', async () => {
    const data = await postBootstrap({ 'X-Ccxray-Auth': upstreamToken() });
    assert.equal(data.status, 200);
    assert.ok(data.body && data.body.token);
    assert.equal(typeof data.body.token, 'string');
  });
});

describe('mintAutoOpenUrl — launcher auto-bootstrap (Phase 2.4)', () => {
  it('returns http://localhost:<port>/#k=<token> with a token that redeems → 204 + Set-Cookie', () => {
    const auth = loadAuthFresh();
    const url = auth.mintAutoOpenUrl(5577);
    const m = url.match(/^http:\/\/localhost:5577\/#k=([A-Za-z0-9_-]{20,})$/);
    assert.ok(m, `URL must carry #k= token, got: ${url}`);
    const tok = m[1];
    // Prove the token is in the pending set: redeem succeeds end-to-end.
    const { req, res, setHeaderCalls } = mockReqRes({
      headers: {
        'x-ccxray-bootstrap': tok,
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:5577',
        host: 'localhost:5577',
      },
    });
    auth.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 204);
    assert.match(setHeaderCalls['set-cookie'] || '', /^ccxray_s=/);
  });

  it('each call mints a fresh, distinct single-use token', () => {
    const auth = loadAuthFresh();
    const t1 = auth.mintAutoOpenUrl(5577).match(/#k=([A-Za-z0-9_-]+)/)[1];
    const t2 = auth.mintAutoOpenUrl(5577).match(/#k=([A-Za-z0-9_-]+)/)[1];
    assert.notEqual(t1, t2);
  });

  it('reflects the supplied port in the URL', () => {
    const auth = loadAuthFresh();
    const url = auth.mintAutoOpenUrl(9999);
    assert.match(url, /^http:\/\/localhost:9999\/#k=/);
  });

  it('formatAutoOpenUrl builds a URL from any caller-supplied token (hub-mode socket-minted)', () => {
    const auth = loadAuthFresh();
    assert.equal(auth.formatAutoOpenUrl(5577, 'tok-xyz'), 'http://localhost:5577/#k=tok-xyz');
  });
});

describe('pending-bootstrap is per-process (hub-mode constraint, codex 2.4 P2 regression)', () => {
  // Codex review caught: pre-fix, hub-mode `ccxray claude` called
  // mintAutoOpenUrl() in the *client* process, but pendingBootstraps is a
  // module-local Map that lives in whichever process minted. Redeem on the
  // hub process therefore 401'd because the token was never in its map. The
  // fix is to mint via the hub socket (`bootstrap-token` command) so the
  // token lives where redeem checks. This test pins the per-process boundary
  // so the bug can't silently come back via a future refactor.
  it('a token minted in one auth instance is NOT redeemable on a separately-loaded instance', () => {
    delete require.cache[require.resolve('../server/auth')];
    const minter = require('../server/auth');
    delete require.cache[require.resolve('../server/auth')];
    const redeemer = require('../server/auth');
    assert.notEqual(minter, redeemer, 'fresh instances should be distinct objects');

    const url = minter.mintAutoOpenUrl(5577);
    const tok = url.match(/#k=([A-Za-z0-9_-]+)/)[1];
    const { req, res } = mockReqRes({
      headers: { 'x-ccxray-bootstrap': tok, 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5577', host: 'localhost:5577' },
    });
    redeemer.redeemBootstrap(req, res);
    req._deliverBody('{}');
    assert.equal(res.statusCode, 401);
  });
});
