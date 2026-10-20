'use strict';

// Edge cases for server/pricing.js found by mutation testing (docs/mutation-testing.md).
// Isolation: every test runs against a synthetic cache file in a temp dir (or a
// path that does not exist). The network path of fetchPricing() is exercised
// through a stubbed https.get — no test here can reach LiteLLM or read/write the
// package-relative pricing-cache.json.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pricing-edges-'));
const NO_CACHE = path.join(ROOT, 'absent', 'pricing-cache.json');
process.env.CCXRAY_PRICING_CACHE = NO_CACHE;
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const PRICING_MOD = require.resolve('../server/pricing');
const defaultRates = require('../server/default-rates');
defaultRates.__resetRateTableForTests();

let seq = 0;
function cacheFile(content) {
  const p = path.join(ROOT, `cache-${++seq}.json`);
  if (content !== undefined) fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

// Fresh pricing.js instance bound to `cachePath` (PRICING_CACHE_PATH is read at
// require time). default-rates.js is shared, so its singleton is reset too.
function freshPricing(cachePath) {
  process.env.CCXRAY_PRICING_CACHE = cachePath;
  delete require.cache[PRICING_MOD];
  defaultRates.__resetRateTableForTests();
  return require(PRICING_MOD);
}

// Replaces https.get with a scripted fake. `script(req, respond)` runs on the
// next tick; respond(statusCode, body) emits a response with that body.
const realGet = https.get;
let getCalls = [];
function stubHttps(script) {
  getCalls = [];
  https.get = (url, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.timeoutMs = null;
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.onTimeout = fn; return req; };
    req.destroy = () => { req.destroyed = true; };
    getCalls.push({ url, req });
    process.nextTick(() => script(req, (statusCode, body) => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      cb(res);
      if (body != null) res.emit('data', Buffer.from(body));
      res.emit('end');
    }));
    return req;
  };
}

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.log = orig; console.error = origErr; }).then(() => lines);
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

afterEach(() => {
  https.get = realGet;
  process.env.CCXRAY_PRICING_CACHE = NO_CACHE;
  delete require.cache[PRICING_MOD];
  defaultRates.__resetRateTableForTests();
});

const PER_TOKEN = { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 };

describe('ratesFromLiteLLMEntry', () => {
  const { ratesFromLiteLLMEntry } = freshPricing(NO_CACHE);

  it('converts every per-token field to per-million', () => {
    const r = ratesFromLiteLLMEntry({
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 0.3e-6,
      cache_creation_input_token_cost_above_1hr: 6e-6,
    });
    assert.ok(Math.abs(r.input - 3) < 1e-9);
    assert.ok(Math.abs(r.output - 15) < 1e-9);
    assert.ok(Math.abs(r.cache_create - 3.75) < 1e-9);
    assert.ok(Math.abs(r.cache_read - 0.3) < 1e-9);
    assert.ok(Math.abs(r.cache_create_1h - 6) < 1e-9);
  });

  it('falls back to the input rate when LiteLLM lists no cache fields', () => {
    const r = ratesFromLiteLLMEntry(PER_TOKEN);
    assert.ok(Math.abs(r.cache_create - 3) < 1e-9);
    assert.ok(Math.abs(r.cache_read - 3) < 1e-9);
    assert.ok(Math.abs(r.cache_create_1h - 6) < 1e-9, '1h rate derives 2x input');
  });

  it('honours an explicit zero for every cache rate (#715)', () => {
    const r = ratesFromLiteLLMEntry({
      ...PER_TOKEN,
      cache_creation_input_token_cost: 0,
      cache_read_input_token_cost: 0,
      cache_creation_input_token_cost_above_1hr: 0,
    });
    assert.equal(r.cache_create, 0);
    assert.equal(r.cache_read, 0);
    assert.equal(r.cache_create_1h, 0);
  });

  it('honours each explicit zero cache rate independently (#715)', () => {
    assert.equal(ratesFromLiteLLMEntry({ ...PER_TOKEN, cache_read_input_token_cost: 0 }).cache_read, 0);
    assert.equal(ratesFromLiteLLMEntry({ ...PER_TOKEN, cache_creation_input_token_cost: 0 }).cache_create, 0);
    assert.equal(ratesFromLiteLLMEntry({ ...PER_TOKEN, cache_creation_input_token_cost_above_1hr: 0 }).cache_create_1h, 0);
  });

  it('falls back for null or undefined cache rates (#715)', () => {
    for (const absent of [undefined, null]) {
      const r = ratesFromLiteLLMEntry({
        ...PER_TOKEN,
        cache_creation_input_token_cost: absent,
        cache_read_input_token_cost: absent,
        cache_creation_input_token_cost_above_1hr: absent,
      });
      assert.ok(Math.abs(r.cache_create - 3) < 1e-9);
      assert.ok(Math.abs(r.cache_read - 3) < 1e-9);
      assert.ok(Math.abs(r.cache_create_1h - 6) < 1e-9);
    }
  });

  it('prices a missing output rate at zero, not NaN', () => {
    const r = ratesFromLiteLLMEntry({ input_cost_per_token: 1e-6 });
    assert.equal(r.output, 0);
  });

  it('prices an entry with no rates at all at zero', () => {
    const r = ratesFromLiteLLMEntry({});
    assert.deepEqual(r, { input: 0, output: 0, cache_create: 0, cache_read: 0, cache_create_1h: 0 });
  });
});

describe('applyLagOverrides wrapper', () => {
  it('returns the merged table and records the status', () => {
    const pricing = freshPricing(NO_CACHE);
    const row = { input: 1, output: 2, cache_create: 1, cache_read: 0.1 };
    const table = pricing.applyLagOverrides({ 'synthetic-model': row });
    assert.deepEqual(table['synthetic-model'], row);
    assert.deepEqual(pricing.lastLagOverrideStatus, []);
  });
});

describe('fetchPricing — cache hit', () => {
  it('loads a fresh cache without any network request, including its context table', async () => {
    const p = cacheFile({
      fetchedAt: Date.now() - 60 * 60 * 1000, // 1h old: well inside the 24h TTL
      pricing: { 'syn-cached': { input: 7, output: 9, cache_create: 7, cache_read: 0.7 } },
      context: { 'syn-cached': 123_456, 'xai/syn-ctx': 42 },
    });
    const pricing = freshPricing(p);
    stubHttps(() => assert.fail('cache hit must not fetch'));
    const lines = await captureLogs(() => pricing.fetchPricing());
    assert.equal(getCalls.length, 0);
    assert.equal(pricing.getModelPricing('syn-cached').input, 7);
    assert.equal(pricing.getModelContext('syn-cached'), 123_456);
    assert.equal(pricing.getModelContext('syn-ctx'), 42, 'cached context is provider-mirrored');
    // setRateTable: the shared lookupRates table sees the cached rows too.
    assert.equal(defaultRates.calculateCostSimple({ input_tokens: 1_000_000 }, 'syn-cached').cost, 7);
    assert.ok(lines.some(l => l.includes('Pricing loaded from cache')), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('Pricing lag overrides active')), 'no override line with no overrides');
  });

  it('loads a cache that has no context section', async () => {
    const p = cacheFile({ fetchedAt: Date.now(), pricing: { 'syn-noctx': { input: 4, output: 4, cache_create: 4, cache_read: 4 } } });
    const pricing = freshPricing(p);
    stubHttps(() => assert.fail('cache hit must not fetch'));
    await captureLogs(() => pricing.fetchPricing());
    assert.equal(getCalls.length, 0);
    assert.equal(pricing.getModelPricing('syn-noctx').input, 4);
  });

  it('refetches a cache older than 24h', async () => {
    const p = cacheFile({ fetchedAt: Date.now() - 25 * 60 * 60 * 1000, pricing: { 'syn-stale': { input: 1, output: 1, cache_create: 1, cache_read: 1 } } });
    const pricing = freshPricing(p);
    stubHttps((req, respond) => respond(200, JSON.stringify({ 'syn-stale': { input_cost_per_token: 2e-6, output_cost_per_token: 2e-6 } })));
    await captureLogs(() => pricing.fetchPricing());
    assert.equal(getCalls.length, 1);
    assert.ok(Math.abs(pricing.getModelPricing('syn-stale').input - 2) < 1e-9, 'network data replaces the stale cache');
  });
});

describe('fetchPricing — LiteLLM fetch (stubbed https)', () => {
  const BODY = JSON.stringify({
    'syn-net': { ...PER_TOKEN, max_input_tokens: 500_000 },
    'xai/syn-grok': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, max_input_tokens: 256_000 },
    'syn-ctx-only': { max_input_tokens: 8_192 },
    'syn-unpriced': { output_cost_per_token: 1e-6 },
  });

  it('requests the LiteLLM price table and builds the live table from it', async () => {
    const p = cacheFile();
    const pricing = freshPricing(p);
    stubHttps((req, respond) => respond(200, BODY));
    const lines = await captureLogs(() => pricing.fetchPricing());
    assert.equal(getCalls.length, 1);
    assert.match(String(getCalls[0].url), /^https:\/\/raw\.githubusercontent\.com\/BerriAI\/litellm\/.*model_prices_and_context_window\.json$/);
    assert.equal(getCalls[0].req.timeoutMs, 5000);
    assert.ok(Math.abs(pricing.getModelPricing('syn-net').input - 3) < 1e-9);
    assert.ok(Math.abs(pricing.getModelPricing('syn-grok').output - 2) < 1e-9, 'xai/ rows mirror to bare ids');
    assert.equal(pricing.getModelPricing('syn-unpriced'), null, 'a row without input_cost_per_token is not priced');
    assert.equal(pricing.getModelContext('syn-net'), 500_000);
    assert.equal(pricing.getModelContext('syn-ctx-only'), 8_192);
    assert.equal(pricing.getModelContext('syn-grok'), 256_000);
    assert.ok(Math.abs(defaultRates.calculateCostSimple({ input_tokens: 1_000_000 }, 'syn-net').cost - 3) < 1e-9,
      'the fetched table reaches the shared lookupRates table');
    assert.ok(lines.some(l => l.includes('Pricing fetched: 2 models, 3 context windows')), lines.join('\n'));
  });

  it('writes the fetched table to the cache file', async () => {
    const p = cacheFile();
    const pricing = freshPricing(p);
    stubHttps((req, respond) => respond(200, BODY));
    const before = Date.now();
    await captureLogs(() => pricing.fetchPricing());
    const readCache = () => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
    assert.ok(await waitFor(() => readCache() && readCache().context), 'cache file written');
    const cached = readCache();
    assert.ok(cached.fetchedAt >= before);
    assert.deepEqual(Object.keys(cached.pricing).sort(), ['syn-net', 'xai/syn-grok']);
    assert.ok(Math.abs(cached.pricing['syn-net'].output - 15) < 1e-9);
    assert.equal(cached.context['syn-ctx-only'], 8_192);
    assert.equal(cached.context['syn-grok'], 256_000, 'cached context is stored mirrored');
  });

  it('reports a cache write failure instead of throwing', async () => {
    const p = path.join(ROOT, 'no-such-dir', 'pricing-cache.json');
    const pricing = freshPricing(p);
    stubHttps((req, respond) => respond(200, BODY));
    const lines = await captureLogs(async () => {
      await pricing.fetchPricing();
      await waitFor(() => false, 100);
    });
    assert.ok(lines.some(l => l.includes('Write pricing cache failed:') && l.includes('ENOENT')), lines.join('\n'));
    assert.ok(Math.abs(pricing.getModelPricing('syn-net').input - 3) < 1e-9);
  });

  const DEFAULTS_CASES = [
    ['a non-200 status', (req, respond) => respond(503, null), 'Pricing fetch failed (503)'],
    ['an unparsable body', (req, respond) => respond(200, '{not json'), 'Pricing parse error'],
    ['a request error', (req) => req.emit('error', new Error('synthetic')), 'Pricing fetch error'],
    ['a timeout', (req) => req.onTimeout(), 'Pricing fetch timeout'],
  ];
  for (const [label, script, message] of DEFAULTS_CASES) {
    it(`falls back to the offline defaults on ${label}`, async () => {
      const p = cacheFile();
      const pricing = freshPricing(p);
      stubHttps(script);
      const lines = await captureLogs(() => pricing.fetchPricing());
      assert.ok(lines.some(l => l.includes(message) && l.includes('using defaults')), lines.join('\n'));
      assert.equal(pricing.getModelPricing('claude-sonnet-4').input, 3, 'DEFAULT_PRICING still prices');
      assert.equal(pricing.getModelPricing('syn-net'), null);
      assert.ok(pricing.pricingTable['claude-sonnet-4'], 'pricingTable rebuilt from defaults');
      assert.equal(fs.existsSync(p), false, 'no cache written on failure');
      if (label === 'a timeout') assert.equal(getCalls[0].req.destroyed, true, 'timed-out request is destroyed');
    });
  }
});

describe('fetchPricing / lookupRates — default cache path', () => {
  it('is package-relative pricing-cache.json when CCXRAY_PRICING_CACHE is unset', async () => {
    delete process.env.CCXRAY_PRICING_CACHE;
    delete require.cache[PRICING_MOD];
    defaultRates.__resetRateTableForTests();
    const fsp = fs.promises;
    const realReadFile = fsp.readFile;
    const realReadFileSync = fs.readFileSync;
    const asked = [];
    // Neither stub touches the disk: the real package-relative file is never read.
    fsp.readFile = async (p) => { asked.push(['async', p]); return JSON.stringify({ fetchedAt: Date.now(), pricing: {} }); };
    fs.readFileSync = function (p, ...rest) {
      if (String(p).endsWith('pricing-cache.json')) {
        asked.push(['sync', p]);
        const e = new Error('stubbed'); e.code = 'ENOENT'; throw e;
      }
      return realReadFileSync.call(this, p, ...rest);
    };
    try {
      const pricing = require(PRICING_MOD);
      stubHttps(() => assert.fail('cache hit must not fetch'));
      await captureLogs(() => pricing.fetchPricing());
      defaultRates.__resetRateTableForTests();
      defaultRates.lookupRates('claude-sonnet-4');
    } finally {
      fsp.readFile = realReadFile;
      fs.readFileSync = realReadFileSync;
    }
    const expected = path.join(__dirname, '..', 'pricing-cache.json');
    assert.deepEqual(asked, [['async', expected], ['sync', expected]]);
  });
});

describe('getModelContext', () => {
  it('returns null for a missing model', () => {
    const pricing = freshPricing(NO_CACHE);
    assert.equal(pricing.getModelContext(null), null);
    assert.equal(pricing.getModelContext(''), null);
  });

  it('reads the cache synchronously on first use, before fetchPricing() lands', () => {
    const p = cacheFile({ fetchedAt: 0, pricing: {}, context: { 'syn-sync': 77_000, 'xai/syn-sync-x': 11 } });
    const pricing = freshPricing(p);
    assert.equal(pricing.getModelContext('syn-sync'), 77_000);
    assert.equal(pricing.getModelContext('syn-sync-x'), 11);
  });

  it('does not re-read the cache once fetchPricing() has filled the table', async () => {
    const p = cacheFile({ fetchedAt: Date.now(), pricing: {}, context: { 'syn-warm': 100 } });
    const pricing = freshPricing(p);
    await captureLogs(() => pricing.fetchPricing());
    fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: { 'syn-warm': 200 } }));
    assert.equal(pricing.getModelContext('syn-warm'), 100);
  });

  it('prefers the longest matching key for a prefixed model id', () => {
    const pricing = freshPricing(NO_CACHE);
    pricing.__setContextTableForTests({ 'syn-a': 1, 'syn-a-long': 2, 'syn-a-long-x': 3, 'syn-b': 4 });
    assert.equal(pricing.getModelContext('syn-a-long-2026'), 2);
    assert.equal(pricing.getModelContext('syn-a-long-x9'), 3);
    assert.equal(pricing.getModelContext('syn-a-other'), 1);
    assert.equal(pricing.getModelContext('syn-a-long'), 2, 'exact match');
    assert.equal(pricing.getModelContext('zzz-syn-a'), null, 'prefix match, not suffix');
  });

  it('memoizes the sorted prefix keys across lookups', () => {
    const pricing = freshPricing(NO_CACHE);
    const table = { 'syn-memo': 9 };
    for (let i = 0; i < 50; i++) table[`syn-filler-${i}`] = i;
    pricing.__setContextTableForTests(table);
    const originalKeys = Object.keys;
    let enumerations = 0;
    Object.keys = function countedKeys(value) {
      if (value && Object.hasOwn(value, 'syn-memo')) enumerations++;
      return originalKeys(value);
    };
    try {
      for (let i = 0; i < 20; i++) assert.equal(pricing.getModelContext('syn-memo-dated'), 9);
    } finally {
      Object.keys = originalKeys;
    }
    assert.ok(enumerations <= 1, `enumerated ${enumerations} times for 20 prefix lookups`);
  });

  it('__setContextTableForTests mirrors provider keys and suppresses the cache read', () => {
    const p = cacheFile({ fetchedAt: 0, pricing: {}, context: { 'syn-from-cache': 5 } });
    const pricing = freshPricing(p);
    pricing.__setContextTableForTests({ 'syn-set': 6, 'xai/syn-mirror': 7 });
    assert.equal(pricing.getModelContext('syn-set'), 6);
    assert.equal(pricing.getModelContext('syn-mirror'), 7);
    assert.equal(pricing.getModelContext('syn-from-cache'), null);

    const empty = freshPricing(p);
    empty.__setContextTableForTests(null);
    assert.equal(empty.getModelContext('syn-from-cache'), null, 'null injects an empty table, not the cache');
  });
});

describe('calculateCost — 1h cache-creation rate', () => {
  it('uses the row\'s own cache_create_1h when it has one', () => {
    const pricing = freshPricing(NO_CACHE);
    defaultRates.setRateTable({ 'syn-1h': { input: 1, output: 1, cache_create: 1.25, cache_read: 0.1, cache_create_1h: 3 } });
    const r = pricing.calculateCost({ cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }, 'syn-1h');
    assert.equal(r.cost, 3);
  });
});
