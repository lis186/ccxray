'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const { handleApiRoutes } = require('../server/routes/api');

// Regression for the query-string-bypass bug class: when AUTH_TOKEN mode is on,
// the dashboard hits /_api/<route>?token=... — every route matcher must compare
// against the pathname, not the raw URL, or auth-mode requests fall through to
// the upstream proxy (404 + dashboard pollution) or fail to look up records.

function fakeRes() {
  let status = 0;
  let body = null;
  return {
    headersSent: false,
    status: () => status,
    body: () => body,
    writeHead: (s) => { status = s; },
    end: (data) => { body = data; },
  };
}

function reset() {
  store.entries.length = 0;
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
}

describe('route matchers tolerate query strings (e.g. ?token=… auth)', () => {
  beforeEach(reset);

  it('/_api/entries?limit=3 returns 200 with entries (not 404 fallthrough)', () => {
    const res = fakeRes();
    const handled = handleApiRoutes({ url: '/_api/entries?limit=3', method: 'GET' }, res);
    assert.equal(handled, true);
    assert.equal(res.status(), 200);
    const payload = JSON.parse(res.body());
    assert.ok(Array.isArray(payload.entries));
  });

  it('/_api/entry/<id>?token=x finds the entry (regex must use pathname)', async () => {
    const id = '2026-05-23T09-33-05-486';
    store.entries.push({
      id,
      sessionId: 'sid-x',
      provider: 'openai',
      _loaded: true,
      req: { foo: 'bar' },
      res: { ok: true },
      receivedAt: 1700000000000,
      toolSources: null,
    });

    const res = fakeRes();
    const handled = handleApiRoutes(
      { url: `/_api/entry/${id}?token=secret`, method: 'GET' },
      res,
    );
    assert.equal(handled, true);
    // Async body resolution — wait a tick for the inner async IIFE.
    await new Promise(r => setImmediate(r));
    assert.equal(res.status(), 200, 'should not 404 when query string is present');
    const payload = JSON.parse(res.body());
    assert.deepEqual(payload.req, { foo: 'bar' });
  });

  it('/_api/tokens/<id>?token=x finds the entry (regex must use pathname)', async () => {
    const id = '2026-05-23T09-33-05-486';
    store.entries.push({
      id,
      sessionId: 'sid-y',
      tokens: { contextBreakdown: { loadedSkills: [] } },
    });

    const res = fakeRes();
    const handled = handleApiRoutes(
      { url: `/_api/tokens/${id}?token=secret`, method: 'GET' },
      res,
    );
    assert.equal(handled, true);
    await new Promise(r => setImmediate(r));
    assert.equal(res.status(), 200, 'should not 404 when query string is present');
  });
});
