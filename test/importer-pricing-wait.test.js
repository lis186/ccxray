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
