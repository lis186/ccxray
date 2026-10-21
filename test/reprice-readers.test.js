'use strict';
// #723: every reader of stored index rows reprices a stale unknown/fallback cost
// through the one shared helper (server/reprice.js). Hermetic: synthetic rate
// table via setRateTable, throwaway CCXRAY_HOME, no network.

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-reprice-test-'));
process.env.CCXRAY_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
// Keep the rate table off the developer's package-relative cache (ADR 0013).
const cache = path.join(tmpHome, 'pricing-cache.json');
fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
process.env.CCXRAY_PRICING_CACHE = cache;

const rates = require('../server/default-rates');
const { repricedCost, applyReadTimePricing } = require('../server/reprice');
const { aggregate } = require('../server/usage-query');
const sessionIdx = require('../server/session-index');
const { normalizeIndexEntry } = require('../server/routes/api');

const TABLE = {
  'repr-model-x': { input: 1, output: 2, cache_read: 0.5, cache_create: 1.25 },
  'gpt-repr': { input: 1, output: 2, cache_read: 0.5, cache_create: 1.25 },
};
const usage = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const unknown = () => ({ cost: null, confidence: 'unknown' });
const row = (over = {}) => ({
  id: '2026-08-12T10-00-00-000', sessionId: 's1', provider: 'anthropic', model: 'repr-model-x',
  usage, cost: unknown(), receivedAt: Date.parse('2026-08-12T10:00:00Z'), ...over,
});

beforeEach(() => rates.setRateTable(TABLE));
afterEach(() => rates.__resetRateTableForTests());

describe('#723 shared repricing helper', () => {
  it('prices a stored unknown row once the table has the model, without mutating the row', () => {
    const r = row();
    const c = repricedCost(r);
    assert.ok(Math.abs(c.cost - 2) < 1e-9);
    assert.equal(c.confidence, 'exact');
    assert.deepEqual(r.cost, unknown(), 'input row untouched');
  });

  it('reprices a stored fallback row too', () => {
    assert.equal(repricedCost(row({ cost: { cost: 9, confidence: 'fallback' } })).confidence, 'exact');
  });

  it('leaves exact/prefix objects and legacy numeric costs untouched', () => {
    const exact = { cost: 7, confidence: 'exact' };
    const prefix = { cost: 7, confidence: 'prefix' };
    assert.equal(repricedCost(row({ cost: exact })), exact);
    assert.equal(repricedCost(row({ cost: prefix })), prefix);
    assert.equal(repricedCost(row({ cost: 42 })), 42);
  });

  it('keeps an unpriced model unknown (null cost, never $0)', () => {
    const c = repricedCost(row({ model: 'repr-model-missing' }));
    assert.equal(c.cost, null);
    assert.equal(c.confidence, 'unknown');
  });

  it('INV-2: an imported openai row is never normalized a second time', () => {
    // Already cache-exclusive: 1M input, 0.5M of it read from cache upstream.
    const u = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 0 };
    const c = repricedCost(row({ provider: 'openai', model: 'gpt-repr', imported: true, usage: u }));
    // 1M*$1 + 0.5M*$0.5 — a second subtraction would halve the input to 0.5M.
    assert.ok(Math.abs(c.cost - 1.25) < 1e-9, `got ${c.cost}`);
  });

  it('applyReadTimePricing heals the mutable cold-load meta (api.js path)', () => {
    const e = normalizeIndexEntry(row());
    assert.ok(Math.abs(e.cost.cost - 2) < 1e-9);
    assert.equal(e.cost.confidence, 'exact');
    const still = normalizeIndexEntry(row({ model: 'repr-model-missing' }));
    assert.equal(still.cost.cost, null);
    const m = applyReadTimePricing(row());
    assert.equal(m.cost.confidence, 'exact');
  });
});

// NOTE: usage-query.aggregate backs the agentflow report, NOT the `ccxray usage`
// CLI (that is server/usage.js — see test/reprice-consumers.test.js).
describe('#723 usage-query aggregate (agentflow report fold)', () => {
  it('prices an imported null-cost row once the table has the model', () => {
    const a = aggregate([row()]);
    assert.ok(Math.abs(a.cost - 2) < 1e-9);
    assert.equal(a.costFold.unknownCount, 0);
  });

  it('keeps an unpriced model unknown and counts it, adding no $0', () => {
    const a = aggregate([row({ model: 'repr-model-missing' }), row({ id: 'b' })]);
    assert.ok(Math.abs(a.cost - 2) < 1e-9, 'only the priced row contributes');
    assert.equal(a.costFold.unknownCount, 1);
    assert.equal(a.costFold.count, 2);
  });
});

describe('#723 session-index aggregates (sessions.json)', () => {
  before(() => { sessionIdx.rebuildFromIndexContent(''); });

  it('prices a null-cost row once the table has the model', () => {
    sessionIdx.rebuildFromIndexContent([row({ sessionId: 'sess-priced', responseId: 'msg_1' })].map(r => JSON.stringify(r)).join('\n') + '\n');
    const s = sessionIdx.get('sess-priced');
    assert.ok(Math.abs(s.totalCost - 2) < 1e-9, `totalCost ${s.totalCost}`);
    assert.equal(s.unknownCount, 0);
  });

  it('keeps an unpriced model unknown: unknownCount++ and no cost added', () => {
    sessionIdx.rebuildFromIndexContent([row({ sessionId: 'sess-unk', model: 'repr-model-missing', responseId: 'msg_2' })].map(r => JSON.stringify(r)).join('\n') + '\n');
    const s = sessionIdx.get('sess-unk');
    assert.equal(s.totalCost, 0);
    assert.equal(s.unknownCount, 1);
  });

  // Both orders of a priced/unknown duplicate of ONE responseId, then re-seeding
  // (the restart path) and re-feeding the later copy: cost and count stay once.
  for (const order of ['unknown-first', 'priced-first']) {
    it(`priced + unknown duplicates of one responseId (${order}) count once, via seedDedupFromMetas + _upsert`, () => {
      const sid = `sess-dup-${order}`, rid = `msg_dup_${order}`;
      const pricedCopy = row({ sessionId: sid, responseId: rid, model: 'repr-model-missing', cost: { cost: 2, confidence: 'exact' } });
      const unknownCopy = row({ sessionId: sid, responseId: rid, model: 'repr-model-missing', id: '2026-08-12T10-00-01-000' });
      const metas = order === 'unknown-first' ? [unknownCopy, pricedCopy] : [pricedCopy, unknownCopy];
      sessionIdx.rebuildFromIndexContent(metas.map(m => JSON.stringify(m)).join('\n') + '\n');
      const check = () => {
        const s = sessionIdx.get(sid);
        assert.ok(Math.abs(s.totalCost - 2) < 1e-9, `totalCost ${s.totalCost}`);
        assert.equal(s.unknownCount, 0, 'priced copy retracts / never adds the unknown slot');
        assert.equal(s.count, 1);
      };
      check();
      sessionIdx.seedDedupFromMetas(metas);
      for (const m of metas) sessionIdx.updateFromEntry(m);
      check();
    });
  }

  it('live updateFromEntry reprices without mutating the store entry', () => {
    const e = row({ sessionId: 'sess-live', responseId: 'msg_3' });
    sessionIdx.updateFromEntry(e);
    assert.ok(Math.abs(sessionIdx.get('sess-live').totalCost - 2) < 1e-9);
    assert.deepEqual(e.cost, unknown());
  });
});

describe('#723 lookupRates: provider-prefixed model ids', () => {
  it("'openai/<id>' with provider 'openai' resolves to '<id>'", () => {
    const r = rates.lookupRates('openai/gpt-repr', 'openai');
    assert.equal(r.rates, TABLE['gpt-repr']);
    assert.equal(r.confidence, 'exact');
  });

  it('keeps precedence: an existing provider-prefixed row wins over the bare id', () => {
    const own = { input: 9, output: 9, cache_read: 9, cache_create: 9 };
    rates.setRateTable({ ...TABLE, 'openai/gpt-repr': own });
    assert.equal(rates.lookupRates('openai/gpt-repr', 'openai').rates, own);
    assert.equal(rates.lookupRates('gpt-repr', 'openai').rates, own);
  });

  it('does not strip a different provider prefix', () => {
    assert.equal(rates.lookupRates('anthropic/gpt-repr', 'openai').rates, null);
  });
});
