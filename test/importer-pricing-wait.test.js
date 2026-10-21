'use strict';
// #723 cause 1: the importer prices before the price list has loaded. With no
// cache file only the built-in table exists, so a model outside it is written as
// unknown. The importer must wait (bounded) for the price list first. The fetch
// is stubbed at https.get — no network (the unit lane enforces it).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pwait-test-'));
process.env.CCXRAY_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
const INDEX = path.join(tmpHome, 'logs', 'index.ndjson');
fs.writeFileSync(INDEX, '');
// A cache path that does NOT exist: the fresh-install / child-process case.
const cachePath = path.join(tmpHome, 'pricing-cache.json');
process.env.CCXRAY_PRICING_CACHE = cachePath;

const store = require('../server/store');
const config = require('../server/config');
const rates = require('../server/default-rates');
const pricing = require('../server/pricing');
const { scanAndImport } = require('../server/importer');

const MODEL = 'gpt-wait-test-model';
let restoreGet;
let codexDir, claudeDir;

function stubGet(handler) {
  const orig = https.get;
  https.get = (url, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    process.nextTick(() => handler(req, cb));
    return req;
  };
  restoreGet = () => { https.get = orig; };
}

function respondWith(body) {
  return (req, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    cb(res);
    res.emit('data', Buffer.from(JSON.stringify(body)));
    res.emit('end');
  };
}

function codexTranscript() {
  const l = (type, payload, ts) => JSON.stringify({ timestamp: ts, type, payload });
  return [
    l('session_meta', { session_id: 'codex-wait', cwd: '/tmp/pwait', originator: 'codex_exec' }, '2026-07-15T10:30:00.000Z'),
    l('turn_context', { turn_id: 't1', cwd: '/tmp/pwait', model: MODEL }, '2026-07-15T10:30:01.000Z'),
    l('event_msg', { type: 'token_count', info: { model_context_window: 258400, last_token_usage: {
      input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 500_000, reasoning_output_tokens: 0, total_tokens: 1_500_000 } } },
    '2026-07-15T10:30:05.000Z'),
  ].join('\n');
}

function importedRow() {
  const lines = fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return lines.find(m => m.model === MODEL);
}

beforeEach(() => {
  store.entries.length = 0;
  store.entryIndex.clear();
  fs.writeFileSync(INDEX, '');
  fs.rmSync(cachePath, { force: true });
  rates.__resetRateTableForTests();
  pricing.__resetPricingLoadStateForTests();
  codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pwait-codex-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pwait-claude-'));
  process.env.CCXRAY_IMPORT_CODEX_HOMES = codexDir;
  process.env.CCXRAY_IMPORT_HOMES = claudeDir;
  fs.writeFileSync(path.join(codexDir, 'rollout-wait.jsonl'), codexTranscript());
});

afterEach(() => {
  if (restoreGet) restoreGet();
  restoreGet = null;
  delete process.env.CCXRAY_IMPORT_CODEX_HOMES;
  delete process.env.CCXRAY_IMPORT_HOMES;
  fs.rmSync(cachePath, { recursive: true, force: true });
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('#723 importer waits for the price list when the cache file is missing', () => {
  it('a failing fetch keeps the row unknown (built-in table only): no crash, no $0', async () => {
    stubGet(req => req.emit('error', new Error('offline')));
    await scanAndImport();
    const row = importedRow();
    assert.ok(row, 'row imported');
    assert.equal(row.cost.cost, null);
    assert.equal(row.cost.confidence, 'unknown');
  });

  it('a hanging fetch is bounded: ensurePricingLoaded resolves after the timeout', async () => {
    stubGet(() => {}); // never responds
    const t0 = Date.now();
    await pricing.ensurePricingLoaded({ timeoutMs: 60 });
    assert.ok(Date.now() - t0 < 2000, 'returned at the bound, did not hang');
  });

  it('prices the imported row with the loaded table once the fetch lands', async () => {
    stubGet(respondWith({ [MODEL]: {
      input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, max_input_tokens: 400000 } }));
    await scanAndImport();
    const row = importedRow();
    assert.ok(row, 'row imported');
    assert.equal(row.cost.confidence, 'exact');
    assert.ok(Math.abs(row.cost.cost - 2) < 1e-9, `1M*$1 + 0.5M*$2, got ${row.cost.cost}`);
  });

  it('a present cache file needs no fetch', async () => {
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 0, pricing: {}, context: {} }));
    stubGet(() => assert.fail('must not fetch when a cache file exists'));
    await pricing.ensurePricingLoaded();
  });
});

describe('#723 ensurePricingLoaded: shared fetch, loaded state, bounded wait', () => {
  const never = () => {};
  function countingGet(handler) {
    const calls = { n: 0 };
    stubGet((req, cb) => { handler(req, cb); });
    const inner = https.get;
    https.get = (...a) => { calls.n++; return inner(...a); };
    return calls;
  }

  it('importer sees the NEW table after the lazy rate table was already warmed', async () => {
    // Warm the lazy table first (no cache file → built-in only): the model is unknown.
    assert.equal(rates.lookupRates(MODEL, 'openai').rates, null);
    stubGet(respondWith({ [MODEL]: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, max_input_tokens: 400000 } }));
    await scanAndImport();
    const row = importedRow();
    assert.ok(row, 'row imported');
    assert.equal(row.cost.confidence, 'exact');
    assert.ok(Math.abs(row.cost.cost - 2) < 1e-9, `got ${row.cost.cost}`);
  });

  it('concurrent waits, including after their own timeouts, share ONE fetch', async () => {
    const calls = countingGet(never); // never responds
    const a = pricing.ensurePricingLoaded({ timeoutMs: 15 });
    const b = pricing.ensurePricingLoaded({ timeoutMs: 30 });
    await Promise.all([a, b]);
    assert.equal(calls.n, 1, 'two concurrent waiters, one request');
    await pricing.ensurePricingLoaded({ timeoutMs: 15 }); // first wait already timed out, fetch still pending
    assert.equal(calls.n, 1, 'a timed-out wait does not start a second fetch');
  });

  it('a successful live load is not fetched again even when the cache write failed', async () => {
    fs.mkdirSync(cachePath); // a directory: read fails, write fails (EISDIR)
    const calls = countingGet(respondWith({ [MODEL]: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }));
    const err = console.error;
    console.error = () => {};
    try {
      await pricing.ensurePricingLoaded({ timeoutMs: 500 });
      await new Promise(r => setTimeout(r, 20)); // let the failed write settle
    } finally { console.error = err; }
    assert.equal(calls.n, 1);
    await pricing.ensurePricingLoaded({ timeoutMs: 500 });
    assert.equal(calls.n, 1, 'loaded state remembered; no second fetch');
  });

  describe('timer cleanup (controlled timers, no real waits)', () => {
    const DELAY = 4321;
    let set, cleared, realSet, realClear;
    beforeEach(() => {
      set = []; cleared = [];
      realSet = global.setTimeout; realClear = global.clearTimeout;
      global.setTimeout = (fn, ms, ...r) => {
        if (ms !== DELAY) return realSet(fn, ms, ...r);
        const h = { fn, unref() { return this; } };
        set.push(h);
        return h;
      };
      global.clearTimeout = h => { if (h && set.includes(h)) cleared.push(h); else realClear(h); };
    });
    afterEach(() => { global.setTimeout = realSet; global.clearTimeout = realClear; });

    it('clears the timer when the fetch finishes first', async () => {
      stubGet(respondWith({}));
      await pricing.ensurePricingLoaded({ timeoutMs: DELAY });
      assert.equal(set.length, 1);
      assert.deepEqual(cleared, set, 'timer cleared on early completion');
    });

    it('clears the timer when the bound wins, and leaves the fetch in flight for the next caller', async () => {
      const calls = countingGet(never);
      const p = pricing.ensurePricingLoaded({ timeoutMs: DELAY });
      assert.equal(set.length, 1);
      set[0].fn(); // fire the bound by hand
      await p;
      assert.deepEqual(cleared, set, 'timer cleared after the bound fired');
      await Promise.resolve();
      const p2 = pricing.ensurePricingLoaded({ timeoutMs: DELAY });
      set[1].fn();
      await p2;
      await new Promise(r => realSet(r, 30)); // let the async cache read fall through to https.get
      assert.equal(calls.n, 1, 'no second fetch while the first is still pending');
    });
  });

  it('CCXRAY_PRICING_WAIT_MS: validated, defaults to 8000', () => {
    const wait = (v) => { const e = {}; if (v !== undefined) e.CCXRAY_PRICING_WAIT_MS = v; return pricing.pricingWaitMs(e); };
    assert.equal(wait(undefined), 8000);
    assert.equal(wait('250'), 250);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) assert.equal(wait(bad), 8000, bad);
    assert.equal(wait('99999999'), 120000, 'capped');
  });
});
