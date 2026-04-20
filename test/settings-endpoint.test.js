'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Avoid upstream-loop warning in test env
const prev = process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_BASE_URL;

const store = require('../server/store');
const { computeSettings } = require('../server/routes/api');

const mk1h = () => ({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } });
const mk5m = () => ({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } });

describe('/_api/settings (computeSettings)', () => {
  beforeEach(() => { store.entries.length = 0; });
  after(() => {
    if (prev != null) process.env.ANTHROPIC_BASE_URL = prev;
  });

  it('detects max5x from 1h cache writes', () => {
    for (let i = 0; i < 10; i++) store.entries.push({ usage: mk1h() });
    const s = computeSettings();
    assert.equal(s.plan, 'max5x');
    assert.equal(s.label, 'Max 5x');
    assert.equal(s.source, 'auto');
    assert.equal(s.cacheTtlMs, 3_600_000);
    assert.equal(s.monthlyUSD, 100);
  });

  it('detects pro from 5m cache writes', () => {
    for (let i = 0; i < 10; i++) store.entries.push({ usage: mk5m() });
    const s = computeSettings();
    assert.equal(s.plan, 'pro');
    assert.equal(s.cacheTtlMs, 300_000);
    assert.equal(s.monthlyUSD, 20);
  });

  it('falls back to api-key when no data', () => {
    const s = computeSettings();
    assert.equal(s.plan, 'api-key');
    assert.equal(s.source, 'default');
    assert.equal(s.monthlyUSD, 0);
    assert.equal(s.tokens5h, 0);
  });

  it('env override wins over auto-detect', () => {
    for (let i = 0; i < 10; i++) store.entries.push({ usage: mk1h() });
    const prevEnv = process.env.CCXRAY_PLAN;
    process.env.CCXRAY_PLAN = 'max20x';
    try {
      const s = computeSettings();
      assert.equal(s.plan, 'max20x');
      assert.equal(s.source, 'env');
      assert.equal(s.monthlyUSD, 200);
    } finally {
      if (prevEnv == null) delete process.env.CCXRAY_PLAN;
      else process.env.CCXRAY_PLAN = prevEnv;
    }
  });

  it('always includes autoCompactPct', () => {
    const s = computeSettings();
    assert.equal(s.autoCompactPct, 0.835);
  });
});
