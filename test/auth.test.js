'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('auth middleware', () => {
  let originalToken;

  before(() => {
    originalToken = process.env.AUTH_TOKEN;
  });

  after(() => {
    if (originalToken !== undefined) {
      process.env.AUTH_TOKEN = originalToken;
    } else {
      delete process.env.AUTH_TOKEN;
    }
    // Force re-require to pick up env change
    delete require.cache[require.resolve('../server/auth')];
  });

  function mockReqRes(headers = {}, url = '/') {
    const req = { headers, url };
    const res = {
      statusCode: null,
      body: null,
      headers: {},
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
      end(body) { this.body = body; },
    };
    return { req, res };
  }

  it('allows all requests when AUTH_TOKEN is not set', () => {
    delete process.env.AUTH_TOKEN;
    delete require.cache[require.resolve('../server/auth')];
    const { authMiddleware } = require('../server/auth');

    const { req, res } = mockReqRes();
    assert.equal(authMiddleware(req, res), true);
  });

  it('rejects requests without token when AUTH_TOKEN is set', () => {
    process.env.AUTH_TOKEN = 'test-secret';
    delete require.cache[require.resolve('../server/auth')];
    const { authMiddleware } = require('../server/auth');

    const { req, res } = mockReqRes();
    assert.equal(authMiddleware(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('accepts correct Bearer token', () => {
    process.env.AUTH_TOKEN = 'test-secret';
    delete require.cache[require.resolve('../server/auth')];
    const { authMiddleware } = require('../server/auth');

    const { req, res } = mockReqRes({ authorization: 'Bearer test-secret', host: 'localhost' });
    assert.equal(authMiddleware(req, res), true);
  });

  it('rejects wrong Bearer token', () => {
    process.env.AUTH_TOKEN = 'test-secret';
    delete require.cache[require.resolve('../server/auth')];
    const { authMiddleware } = require('../server/auth');

    const { req, res } = mockReqRes({ authorization: 'Bearer wrong', host: 'localhost' });
    assert.equal(authMiddleware(req, res), false);
    assert.equal(res.statusCode, 401);
  });

  it('accepts correct query param token', () => {
    process.env.AUTH_TOKEN = 'test-secret';
    delete require.cache[require.resolve('../server/auth')];
    const { authMiddleware } = require('../server/auth');

    const { req, res } = mockReqRes({ host: 'localhost' }, '/?token=test-secret');
    assert.equal(authMiddleware(req, res), true);
  });
});
