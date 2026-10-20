'use strict';
// #723 fix round 1: the readers the first pass missed. `ccxray usage` is
// server/usage.js (NOT usage-query.js); the Grok worker and the Grok live
// overlay also read stored costs. Hermetic: throwaway home, synthetic rows,
// synthetic rate tables, no network.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-reprice-cons-'));
process.env.CCXRAY_HOME = tmpHome;
const cache = path.join(tmpHome, 'pricing-cache.json');
fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
process.env.CCXRAY_PRICING_CACHE = cache;
process.on('exit', () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

const rates = require('../server/default-rates');
const { analyze } = require('../server/usage');
const { processGrokIndexEntry, scanGrokFromCcxrayIndex } = require('../server/cost-worker');
const { withGrokLiveCosts } = require('../server/adapters/grok-adapter');

const usage = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const unknown = () => ({ cost: null, confidence: 'unknown' });
const fallback = () => ({ cost: 9, confidence: 'fallback' });

// ── real `ccxray usage` (server/index.js → server/usage.js) ───────────────
describe('#723 ccxray usage (server/usage.js)', () => {
  // claude-sonnet-4-5 is in the built-in table: 1M*$3 + 0.5M*$15 = $10.50.
  const row = (sid, id, cost) => ({
    id, sessionId: sid, provider: 'anthropic', agent: 'claude', model: 'claude-sonnet-4-5',
    receivedAt: Date.now() - 60_000, usage, cost,
  });

  it('analyze(): totalCost, confidence fold and session cost use the repriced view; inputs untouched', () => {
    const rows = [row('s1', 'a', unknown()), row('s2', 'b', fallback())];
    const r = analyze(rows);
    assert.ok(Math.abs(r.meta.totalCost - 21) < 1e-9, `totalCost ${r.meta.totalCost}`);
    assert.equal(r.meta.costAgg.unknownCount, 0);
    assert.equal(r.meta.costAgg.fallbackCount, 0);
    assert.deepEqual(rows[0].cost, unknown(), 'caller row not mutated');
    assert.deepEqual(rows[1].cost, fallback(), 'caller row not mutated');
    assert.ok(r.sessions.topSessions.every(s => Math.abs(s.cost - 10.5) < 0.01));
  });

  it('analyze(): a model still outside the table stays unknown (counted, never $0 priced)', () => {
    const r = analyze([{ ...row('s1', 'a', unknown()), model: 'repr-no-such-model' }]);
    assert.equal(r.meta.totalCost, 0);
    assert.equal(r.meta.costAgg.unknownCount, 1);
  });

  it('CLI --session costliest picks the session that is costliest after repricing', () => {
    const home = fs.mkdtempSync(path.join(tmpHome, 'cli-'));
    fs.mkdirSync(path.join(home, 'logs'));
    // A: stored unknown, really $10.50. B: exact $1. Pre-fix A summed to $0 and B won.
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'),
      [row('sess-A', 'a1', unknown()), row('sess-B', 'b1', { cost: 1, confidence: 'exact' })]
        .map(x => JSON.stringify(x)).join('\n') + '\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CCXRAY_HOME: home,
      LOGS_DIR: path.join(home, 'logs'), CCXRAY_PRICING_CACHE: cache,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
    const out = JSON.parse(execFileSync(process.execPath,
      ['server/index.js', 'usage', '--json', '--session', 'costliest'], { env, timeout: 15000 }).toString());
    assert.equal(out.sessions.topSessions[0].sessionId, 'sess-A');
    assert.ok(Math.abs(out.meta.totalCost - 10.5) < 1e-9, `totalCost ${out.meta.totalCost}`);
    assert.equal(out.meta.costAgg.unknownCount, 0);
  });
});

// ── Grok worker + live overlay ────────────────────────────────────────────
describe('#723 Grok readers', () => {
  const TABLE = { 'grok-repr': { input: 1, output: 2, cache_read: 0.5, cache_create: 1.25 } };
  beforeEach(() => rates.setRateTable(TABLE));
  afterEach(() => rates.__resetRateTableForTests());

  const ts = Date.parse('2026-08-12T10:00:00Z');
  const grok = (cost, over = {}) => ({
    id: '2026-08-12T10-00-00-000', agent: 'grok', provider: 'openai', model: 'grok-repr',
    sessionId: 'g1', receivedAt: ts, usage, cost, ...over,
  });

  it('worker: a stored fallback amount is repriced, not trusted', () => {
    const e = processGrokIndexEntry(grok(fallback()));
    assert.ok(Math.abs(e.costUSD - 2) < 1e-9, `got ${e.costUSD}`);
    assert.equal(e.costConfidence, 'exact');
  });

  it('worker: a stored unknown row is repriced once the model is known', () => {
    const e = processGrokIndexEntry(grok(unknown()));
    assert.ok(Math.abs(e.costUSD - 2) < 1e-9);
    assert.equal(e.costConfidence, 'exact');
  });

  it('worker: a still-unpriced row stays null/unknown, and exact stays untouched', () => {
    const u = processGrokIndexEntry(grok(unknown(), { model: 'zz-unlisted-model' }));
    assert.equal(u.costUSD, null);
    assert.equal(u.costConfidence, 'unknown');
    const x = processGrokIndexEntry(grok({ cost: 7, confidence: 'exact' }));
    assert.equal(x.costUSD, 7);
  });

  it('worker: scanGrokFromCcxrayIndex reprices rows read from the index', async () => {
    const home = fs.mkdtempSync(path.join(tmpHome, 'worker-'));
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify(grok(fallback())) + '\n');
    const entries = [];
    await scanGrokFromCcxrayIndex(new Set(), entries, { CCXRAY_HOME: home });
    assert.equal(entries.length, 1);
    assert.ok(Math.abs(entries[0].costUSD - 2) < 1e-9);
  });

  const dateStr = new Date(ts).toLocaleDateString('sv-SE');
  const month = `${new Date(ts).getFullYear()}-${String(new Date(ts).getMonth() + 1).padStart(2, '0')}`;
  const data = () => ({ blocks: [], daily: [{ date: dateStr, totalTokens: 0, costUSD: 0 }], monthly: [{ month, totalTokens: 0, costUSD: 0 }] });

  it('overlay: a stored fallback store entry is repriced, cost AND confidence; entry untouched', () => {
    const e = grok(fallback());
    const out = withGrokLiveCosts(data(), { entries: [e] });
    const d = out.daily[0];
    assert.ok(Math.abs(d.costUSD - 2) < 1e-9, `daily ${d.costUSD}`);
    assert.equal(d.fallbackCount, 0, 'no longer a fallback after repricing');
    assert.equal(d.fallbackCost, 0);
    assert.ok(Math.abs(out.monthly[0].costUSD - 2) < 1e-9);
    assert.deepEqual(e.cost, fallback(), 'live store entry not mutated');
  });

  it('overlay: a stored unknown entry is repriced; one still unpriced keeps unknownCount and adds no cost', () => {
    const priced = withGrokLiveCosts(data(), { entries: [grok(unknown())] }).daily[0];
    assert.ok(Math.abs(priced.costUSD - 2) < 1e-9);
    assert.equal(priced.unknownCount, 0);
    const still = withGrokLiveCosts(data(), { entries: [grok(unknown(), { model: 'zz-unlisted-model' })] }).daily[0];
    assert.equal(still.costUSD, 0);
    assert.equal(still.unknownCount, 1);
  });
});
