'use strict';
// #723 round 3: the imported-openai "already normalized" marker is NOT a
// normalization event. A stored exact/prefix cost on such a row must survive
// applyReadTimePricing (origin/main restore/API parity). Hermetic: throwaway
// CCXRAY_HOME and pricing cache, no network.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-reprice-imp-'));
process.env.CCXRAY_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
const cache = path.join(tmpHome, 'pricing-cache.json');
fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
process.env.CCXRAY_PRICING_CACHE = cache;

const { applyReadTimePricing } = require('../server/reprice');

const base = (over = {}) => ({
  imported: true, provider: 'openai', model: 'gpt-5',
  usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 500 },
  cost: { cost: 123, confidence: 'exact' }, ...over,
});

describe('#723 imported openai rows keep stored priced costs', () => {
  it('unmarked imported row with exact cost stays $123', () => {
    assert.equal(applyReadTimePricing(base()).cost.cost, 123);
  });
  it('unmarked imported row with prefix cost stays put', () => {
    const m = applyReadTimePricing(base({ cost: { cost: 123, confidence: 'prefix' } }));
    assert.equal(m.cost.cost, 123);
    assert.equal(m.cost.confidence, 'prefix');
  });
  it('already-marked imported row with exact cost stays $123', () => {
    const usage = { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 500, _ccxrayUsageNormalized: true };
    assert.equal(applyReadTimePricing(base({ usage })).cost.cost, 123);
  });
  it('a stale (unknown) cost on an imported row is still repriced', () => {
    const m = applyReadTimePricing(base({ cost: { cost: null, confidence: 'unknown' } }));
    assert.ok(m.cost.cost > 0 && m.cost.cost < 1);
  });
});

describe('#723 fallback estimate is kept when the table cannot price the model', () => {
  it('does not downgrade a stored fallback to unknown', () => {
    const m = applyReadTimePricing({
      provider: 'anthropic', model: 'model-not-in-any-table',
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: { cost: 0.5, confidence: 'fallback' },
    });
    assert.deepEqual(m.cost, { cost: 0.5, confidence: 'fallback' });
  });
});
