'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Match the existing test/auth.test.js style: re-require server/auth after
// each AUTH_TOKEN flip so the module's AUTH_TOKEN constant refreshes.
function loadAuthWith(token) {
  if (token === null) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = token;
  delete require.cache[require.resolve('../server/auth')];
  return require('../server/auth');
}

function mockReqRes(headers = {}, url = '/') {
  const setHeaderCalls = {};
  const req = { headers, url };
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

describe('verifyDashboard — Phase 1.2 byte-identical to authMiddleware', () => {
  beforeEach(() => {});

  it('no AUTH_TOKEN: returns true without touching res', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({}, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, no credentials: returns false and writes 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({}, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, correct Bearer: returns true', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearer sec1', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, wrong Bearer: returns false and writes 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ authorization: 'Bearer wrong', host: 'localhost' }, '/_api/entries');
    assert.equal(auth.verifyDashboard(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, correct ?token= query: returns true', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({ host: 'localhost' }, '/_api/entries?token=sec1');
    assert.equal(auth.verifyDashboard(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, correct ?token= query: adds X-Ccxray-Deprecation header', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ host: 'localhost' }, '/_api/entries?token=sec1');
    auth.verifyDashboard(req, res);
    assert.match(setHeaderCalls['X-Ccxray-Deprecation'] || '', /token-query/);
  });

  it('AUTH_TOKEN set, correct Bearer: does NOT add deprecation header (Bearer is permanent on dashboard)', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1', host: 'localhost' }, '/_api/entries');
    auth.verifyDashboard(req, res);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });
});

describe('verifyUpstream — Phase 1.2 byte-identical to authMiddleware (with deprecation hint)', () => {
  it('no AUTH_TOKEN: returns true without touching res', () => {
    const auth = loadAuthWith(null);
    const { req, res } = mockReqRes({}, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), true);
    assert.equal(res.writeHeadCalled, false);
  });

  it('AUTH_TOKEN set, no credentials: returns false and writes 401', () => {
    const auth = loadAuthWith('sec1');
    const { req, res } = mockReqRes({}, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('AUTH_TOKEN set, Bearer accepted on /v1/* (warn-only Phase 1): returns true + deprecation header', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1', host: 'localhost' }, '/v1/messages');
    assert.equal(auth.verifyUpstream(req, res), true);
    assert.match(setHeaderCalls['X-Ccxray-Deprecation'] || '', /bearer-on-upstream/);
  });

  it('AUTH_TOKEN set, ?token= accepted on /v1/* (warn-only Phase 1): returns true + deprecation header', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ host: 'localhost' }, '/v1/messages?token=sec1');
    assert.equal(auth.verifyUpstream(req, res), true);
    assert.match(setHeaderCalls['X-Ccxray-Deprecation'] || '', /token-query/);
  });
});

describe('dispatch().verify — sanity: same instance routes to correct verifier', () => {
  it('upstream path routes to verifyUpstream', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1' }, '/v1/messages');
    const { verify } = auth.dispatch(req);
    assert.equal(verify(req, res), true);
    assert.match(setHeaderCalls['X-Ccxray-Deprecation'] || '', /bearer-on-upstream/);
  });

  it('dashboard path routes to verifyDashboard', () => {
    const auth = loadAuthWith('sec1');
    const { req, res, setHeaderCalls } = mockReqRes({ authorization: 'Bearer sec1' }, '/_api/entries');
    const { verify } = auth.dispatch(req);
    assert.equal(verify(req, res), true);
    assert.equal(setHeaderCalls['X-Ccxray-Deprecation'], undefined);
  });
});
