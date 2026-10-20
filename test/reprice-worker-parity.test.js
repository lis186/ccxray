'use strict';
// #723 round 2: processGrokIndexEntry (cost-worker, no server graph) must bill a
// stale-cost row exactly like repricedCost (the shared rule), including the
// usage normalization for cached tokens. Hermetic: synthetic rate table.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-reprice-parity-'));
process.env.CCXRAY_HOME = tmpHome;
const cache = path.join(tmpHome, 'pricing-cache.json');
fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
process.env.CCXRAY_PRICING_CACHE = cache;
process.on('exit', () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

const rates = require('../server/default-rates');
const { repricedCost } = require('../server/reprice');
const { processGrokIndexEntry } = require('../server/cost-worker');

const TABLE = { 'xai/grok-parity': { input: 1, output: 2, cache_read: 0.5, cache_create: 1.25 } };
const base = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 500_000 };
const ts = Date.parse('2026-08-12T10:00:00Z');
const row = (over) => ({
  id: '2026-08-12T10-00-00-000', agent: 'grok', provider: 'openai', model: 'grok-parity',
  sessionId: 'g1', receivedAt: ts, usage: base, cost: { cost: 9, confidence: 'fallback' }, ...over,
});

describe('#723 worker/shared-rule parity on cached usage', () => {
  beforeEach(() => rates.setRateTable(TABLE));
  afterEach(() => rates.__resetRateTableForTests());

  const marked = row({ usage: { ...base, _ccxrayUsageNormalized: true } });
  const cases = {
    'legacy openai row, cached tokens, no marker (normalized: $1.75)': row({}),
    'row carrying the normalization marker (not re-subtracted: $2.25)': marked,
    'imported openai row without marker (treated as normalized: $2.25)': row({ imported: true }),
    'imported openai row with marker': row({ imported: true, usage: { ...base, _ccxrayUsageNormalized: true } }),
    'unknown-stored legacy row': row({ cost: { cost: null, confidence: 'unknown' } }),
  };
  for (const [name, r] of Object.entries(cases)) {
    it(name, () => {
      const shared = repricedCost(r);
      const w = processGrokIndexEntry(r);
      assert.ok(Math.abs(w.costUSD - shared.cost) < 1e-9, `worker ${w.costUSD} vs shared ${shared.cost}`);
      assert.equal(w.costConfidence, shared.confidence);
    });
  }

  it('pins the reviewer numbers: unmarked 1.75, marked 2.25', () => {
    assert.ok(Math.abs(processGrokIndexEntry(row({})).costUSD - 1.75) < 1e-9);
    assert.ok(Math.abs(processGrokIndexEntry(marked).costUSD - 2.25) < 1e-9);
  });

  it('does not mutate the input row', () => {
    const r = row({}); const snap = JSON.stringify(r);
    processGrokIndexEntry(r);
    assert.equal(JSON.stringify(r), snap);
  });
});
