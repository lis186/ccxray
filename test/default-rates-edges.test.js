'use strict';

// Edge cases for server/default-rates.js found by mutation testing
// (docs/mutation-testing.md). Every test injects its own table with
// setRateTable() or points CCXRAY_PRICING_CACHE at a synthetic temp file; none
// depends on the package-relative pricing-cache.json.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-default-rates-edges-'));
const NO_CACHE = path.join(ROOT, 'absent', 'pricing-cache.json');
process.env.CCXRAY_PRICING_CACHE = NO_CACHE;
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const dr = require('../server/default-rates');
dr.__resetRateTableForTests();

afterEach(() => {
  process.env.CCXRAY_PRICING_CACHE = NO_CACHE;
  dr.__resetRateTableForTests();
});

const row = (input, extra = {}) => ({ input, output: input * 2, cache_create: input * 1.25, cache_read: input / 10, ...extra });

describe('DEFAULT_PRICING rows are complete', () => {
  it('every row carries finite, non-negative per-million rates with output >= input >= cache_read', () => {
    for (const [model, r] of Object.entries(dr.DEFAULT_PRICING)) {
      for (const f of ['input', 'output', 'cache_create', 'cache_read']) {
        assert.ok(Number.isFinite(r[f]) && r[f] >= 0, `${model}.${f} = ${r[f]}`);
      }
      assert.ok(r.input > 0, `${model}.input must be priced`);
      assert.ok(r.output >= r.input, `${model}: output ${r.output} < input ${r.input}`);
      assert.ok(r.cache_read <= r.input, `${model}: cache_read ${r.cache_read} > input ${r.input}`);
    }
  });

  it('every row prices a turn through calculateCostSimple', () => {
    for (const model of Object.keys(dr.DEFAULT_PRICING)) {
      const r = dr.calculateCostSimple({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, model);
      const expected = dr.DEFAULT_PRICING[model].input + dr.DEFAULT_PRICING[model].output;
      assert.equal(r.confidence, 'exact', model);
      assert.ok(Math.abs(r.cost - expected) < 1e-9, `${model}: ${r.cost} vs ${expected}`);
    }
  });
});

describe('mirrorProviderPrefixedKeys', () => {
  it('mirrors a provider/model key to the bare model', () => {
    assert.deepEqual(dr.mirrorProviderPrefixedKeys({ 'a/m': 1 }), { 'a/m': 1, m: 1 });
  });

  it('never overwrites an existing bare key', () => {
    assert.deepEqual(dr.mirrorProviderPrefixedKeys({ m: 1, 'xai/m': 2 }), { m: 1, 'xai/m': 2 });
    assert.deepEqual(dr.mirrorProviderPrefixedKeys({ 'xai/m': 2, m: 1 }), { 'xai/m': 2, m: 1 });
  });

  it('does not create an empty key from a trailing slash', () => {
    assert.deepEqual(dr.mirrorProviderPrefixedKeys({ 'xai/': 1 }), { 'xai/': 1 });
  });

  it('honours the onlyProviders filter', () => {
    assert.deepEqual(dr.mirrorProviderPrefixedKeys({ 'azure_ai/m': 1, 'xai/g': 2 }, ['xai']), { 'azure_ai/m': 1, 'xai/g': 2, g: 2 });
  });
});

describe('hasCacheTierSplit', () => {
  it('rejects non-objects without throwing', () => {
    assert.equal(dr.hasCacheTierSplit(null), false);
    assert.equal(dr.hasCacheTierSplit(undefined), false);
    assert.equal(dr.hasCacheTierSplit('x'), false);
  });

  it('needs at least one tier count', () => {
    assert.equal(dr.hasCacheTierSplit({}), false);
    assert.equal(dr.hasCacheTierSplit({ ephemeral_5m_input_tokens: null }), false);
  });

  it('accepts either tier alone', () => {
    assert.equal(dr.hasCacheTierSplit({ ephemeral_5m_input_tokens: 10 }), true);
    assert.equal(dr.hasCacheTierSplit({ ephemeral_1h_input_tokens: 10 }), true);
    assert.equal(dr.hasCacheTierSplit({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }), true);
  });

  it('rejects a negative or non-numeric tier', () => {
    assert.equal(dr.hasCacheTierSplit({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: -1 }), false);
    assert.equal(dr.hasCacheTierSplit({ ephemeral_5m_input_tokens: '10' }), false);
  });
});

describe('lookupRates', () => {
  it('returns the null shape for a missing model', () => {
    assert.deepEqual(dr.lookupRates(''), { rates: null, confidence: null });
    assert.deepEqual(dr.lookupRates(undefined), { rates: null, confidence: null });
  });

  it('falls back to an xai/ row for a bare id when the table is not mirrored', () => {
    const r = row(1);
    dr.setRateTable({ 'xai/syn-grok': r });
    assert.deepEqual(dr.lookupRates('syn-grok'), { rates: r, confidence: 'exact' });
    assert.deepEqual(dr.lookupRates('other/syn-grok'), { rates: null, confidence: null }, 'only bare ids get the xai/ fallback');
  });

  it('prefix-matches the longest key first', () => {
    const short = row(1), mid = row(2), long = row(3);
    dr.setRateTable({ 'syn-a': short, 'syn-a-b': mid, 'syn-a-b-c': long });
    assert.equal(dr.lookupRates('syn-a-b-c-9').rates, long);
    assert.equal(dr.lookupRates('syn-a-b-9').rates, mid);
    assert.equal(dr.lookupRates('syn-a-9').rates, short);
    assert.equal(dr.lookupRates('syn-a-9').confidence, 'prefix');
    assert.deepEqual(dr.lookupRates('x-syn-a'), { rates: null, confidence: null }, 'prefix, not suffix');
  });

  it('matches a dated key by its undated prefix', () => {
    const r = row(4);
    dr.setRateTable({ 'syn-model-20250101': r });
    assert.deepEqual(dr.lookupRates('syn-model-latest'), { rates: r, confidence: 'prefix' });
  });

  it('keeps the lazily loaded table when setRateTable gets a non-object', () => {
    dr.setRateTable('not-a-table');
    assert.equal(dr.lookupRates('claude-sonnet-4').rates.input, 3);
  });
});

describe('_ensureRateTable — cache file validation', () => {
  function withCache(content) {
    const p = path.join(ROOT, `cache-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, content);
    process.env.CCXRAY_PRICING_CACHE = p;
    dr.__resetRateTableForTests();
  }

  it('merges a cache pricing object over DEFAULT_PRICING', () => {
    withCache(JSON.stringify({ pricing: { 'syn-cached': row(9) } }));
    assert.equal(dr.lookupRates('syn-cached').rates.input, 9);
    assert.equal(dr.lookupRates('claude-sonnet-4').rates.input, 3);
  });

  it('ignores a cache whose pricing is not an object', () => {
    withCache(JSON.stringify({ pricing: 'abc' }));
    const table = dr.__getRateTableForTests();
    assert.equal(table['0'], undefined, 'a string must not be spread into the table');
    assert.deepEqual(Object.keys(table).sort(), Object.keys(dr.getOfflineRates()).sort());
  });

  it('ignores an unparsable or null cache', () => {
    withCache('{nope');
    assert.equal(dr.lookupRates('claude-sonnet-4').rates.input, 3);
    withCache('null');
    assert.equal(dr.lookupRates('claude-sonnet-4').rates.input, 3);
  });

  it('__getRateTableForTests builds the table on demand', () => {
    dr.__resetRateTableForTests();
    const table = dr.__getRateTableForTests();
    assert.ok(table && table['claude-sonnet-4']);
  });

  it('reads package-relative pricing-cache.json when CCXRAY_PRICING_CACHE is unset', () => {
    delete process.env.CCXRAY_PRICING_CACHE;
    dr.__resetRateTableForTests();
    const realReadFileSync = fs.readFileSync;
    const asked = [];
    // Stubbed: the real package-relative file is never read.
    fs.readFileSync = function (p, ...rest) {
      if (String(p).endsWith('pricing-cache.json')) {
        asked.push(p);
        const e = new Error('stubbed'); e.code = 'ENOENT'; throw e;
      }
      return realReadFileSync.call(this, p, ...rest);
    };
    try {
      dr.lookupRates('claude-sonnet-4');
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.deepEqual(asked, [path.join(__dirname, '..', 'pricing-cache.json')]);
  });
});

describe('calculateCostSimple — 1h cache-creation rate', () => {
  it('uses the row\'s own cache_create_1h when it has one', () => {
    dr.setRateTable({ 'syn-1h': row(1, { cache_create_1h: 3 }) });
    const r = dr.calculateCostSimple({ cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }, 'syn-1h');
    assert.ok(Math.abs(r.cost - 3) < 1e-9);
  });

  it('derives 2x input when the row has none', () => {
    dr.setRateTable({ 'syn-1h': row(1) });
    const r = dr.calculateCostSimple({ cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }, 'syn-1h');
    assert.ok(Math.abs(r.cost - 2) < 1e-9);
  });
});
