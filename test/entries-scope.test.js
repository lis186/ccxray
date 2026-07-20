'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolated CCXRAY_HOME + small recent-session window, before requiring config
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-scope-test-'));
process.env.CCXRAY_HOME = tmpHome;
process.env.CCXRAY_RECENT_SESSIONS = '2';
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'logs', 'index.ndjson'), '');

const store = require('../server/store');
const { handleApiRoutes } = require('../server/routes/api');

const INDEX_PATH = path.join(tmpHome, 'logs', 'index.ndjson');

function makeEntry(id, sessionId, receivedAt, extra = {}) {
  return {
    id, sessionId, receivedAt,
    ts: '10:00:00', method: 'POST', url: '/v1/messages', elapsed: '2.0',
    status: 200, isSSE: true, model: 'claude-sonnet-4-5', msgCount: 3,
    usage: { input_tokens: 100, output_tokens: 50 },
    cost: { cost: 0.01 }, provider: 'anthropic',
    ...extra,
  };
}

function callRoute(url) {
  return new Promise((resolve, reject) => {
    const req = { url, method: 'GET' };
    const res = {
      writeHead(code) { this.code = code; },
      end(body) {
        try { resolve({ code: this.code, body: body ? JSON.parse(body) : null }); }
        catch (e) { reject(e); }
      },
      headersSent: false,
    };
    const handled = handleApiRoutes(req, res);
    if (!handled) reject(new Error('route not handled: ' + url));
  });
}

function seedStore() {
  store.entries.length = 0;
  store.entryIndex.clear();
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
  // 3 sessions, recency order: sess-c (newest), sess-b, sess-a (oldest)
  const rows = [
    makeEntry('2026-07-19T10-00-00-000', 'sess-aaaa1111', 1000),
    makeEntry('2026-07-19T11-00-00-000', 'sess-bbbb2222', 2000),
    makeEntry('2026-07-19T11-30-00-000', 'sess-bbbb2222', 2500),
    makeEntry('2026-07-19T12-00-00-000', 'sess-cccc3333', 3000),
  ];
  for (const e of rows) { store.entries.push(e); store.entryIndex.set(e.id, e); }
  store.sessionMeta['sess-aaaa1111'] = {};
  store.sessionMeta['sess-bbbb2222'] = {};
  store.sessionMeta['sess-cccc3333'] = {};
}

describe('/_api/entries scoping', () => {
  beforeEach(seedStore);

  it('default scope returns entries of the N most recent sessions only', async () => {
    const { code, body } = await callRoute('/_api/entries');
    assert.strictEqual(code, 200);
    const sids = new Set(body.entries.map(e => e.sessionId));
    assert.deepStrictEqual([...sids].sort(), ['sess-bbbb2222', 'sess-cccc3333']);
    assert.strictEqual(body.entries.length, 3);
    // restore.entryCount stays the store total, not the scoped count
    assert.strictEqual(body.restore.entryCount, 4);
  });

  it('?sid= full id narrows to that session', async () => {
    const { body } = await callRoute('/_api/entries?sid=sess-bbbb2222');
    const sids = new Set(body.entries.map(e => e.sessionId));
    assert.deepStrictEqual([...sids], ['sess-bbbb2222']);
    assert.strictEqual(body.entries.length, 2);
  });

  it('?sid= unique prefix resolves (deep links carry 8-char prefixes)', async () => {
    const { body } = await callRoute('/_api/entries?sid=sess-aaaa');
    const sids = new Set(body.entries.map(e => e.sessionId));
    assert.deepStrictEqual([...sids], ['sess-aaaa1111']);
  });

  it('?e= resolves the entry to its session scope', async () => {
    const { body } = await callRoute('/_api/entries?e=' + encodeURIComponent('2026-07-19T10-00-00-000'));
    const sids = new Set(body.entries.map(e => e.sessionId));
    assert.deepStrictEqual([...sids], ['sess-aaaa1111']);
  });

  it('child sessions ride along with the parent scope', async () => {
    store.entries.push(makeEntry('2026-07-19T12-05-00-000', 'sess-child444', 3100));
    store.sessionMeta['sess-child444'] = { parentSessionId: 'sess-cccc3333' };
    const { body } = await callRoute('/_api/entries?sid=sess-cccc3333');
    const sids = new Set(body.entries.map(e => e.sessionId));
    assert.deepStrictEqual([...sids].sort(), ['sess-cccc3333', 'sess-child444']);
  });

  it('?sid= of a cold session falls back to index.ndjson', async () => {
    const coldLine = JSON.stringify({
      id: '2026-07-01T09-00-00-000', sessionId: 'cold-sess-999', provider: 'anthropic',
      model: 'claude-sonnet-4-5', msgCount: 2, usage: { input_tokens: 10, output_tokens: 5 },
      cost: { cost: 0.001 }, receivedAt: 500, elapsed: '1.0', status: 200,
    });
    fs.writeFileSync(INDEX_PATH, coldLine + '\n');
    const { body } = await callRoute('/_api/entries?sid=cold-sess-999');
    assert.strictEqual(body.entries.length, 1);
    assert.strictEqual(body.entries[0].sessionId, 'cold-sess-999');
  });
});

describe('/_api/session/:sid/entries', () => {
  beforeEach(seedStore);

  it('serves a cold session from index.ndjson with normalized fields', async () => {
    const lines = [
      JSON.stringify({
        id: '2026-07-01T09-00-00-000', sessionId: 'cold-sess-777', provider: 'anthropic',
        model: 'claude-sonnet-4-5', msgCount: 2, usage: { input_tokens: 10, output_tokens: 5 },
        cost: { cost: 0.001 }, receivedAt: 500, elapsed: '1.0', status: 200,
      }),
      JSON.stringify({
        id: '2026-07-01T09-05-00-000', sessionId: 'other-sess', provider: 'anthropic',
        model: 'claude-sonnet-4-5', msgCount: 2, usage: {}, receivedAt: 600, elapsed: '1.0', status: 200,
      }),
    ];
    fs.writeFileSync(INDEX_PATH, lines.join('\n') + '\n');
    const { code, body } = await callRoute('/_api/session/cold-sess-777/entries');
    assert.strictEqual(code, 200);
    assert.strictEqual(body.entries.length, 1);
    assert.strictEqual(body.entries[0].sessionId, 'cold-sess-777');
    assert.ok(body.entries[0].maxContext > 0, 'maxContext re-inferred for anthropic lines');
  });
});
