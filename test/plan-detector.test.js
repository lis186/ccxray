'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPlan, getEffectivePlan } = require('../server/plan-detector');

const mk5m = (n = 1000) => ({ cache_creation: { ephemeral_5m_input_tokens: n, ephemeral_1h_input_tokens: 0 } });
const mk1h = (n = 1000) => ({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n } });
const mkEmpty = () => ({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
const mkNoUsage = () => ({});

describe('plan-detector', () => {
  describe('detectPlan', () => {
    it('returns insufficient when too few cache writes', () => {
      const result = detectPlan([mk5m(), mk5m()]);
      assert.equal(result.plan, null);
      assert.equal(result.confidence, 'insufficient');
    });

    it('returns max5x when any 1h write observed', () => {
      // 4 x 5m + 1 x 1h still counts as Max
      const usages = [mk5m(), mk5m(), mk5m(), mk5m(), mk1h()];
      const result = detectPlan(usages);
      assert.equal(result.plan, 'max5x');
      assert.equal(result.confidence, 'high');
    });

    it('returns pro when all cache writes are 5m', () => {
      const usages = Array.from({ length: 8 }, () => mk5m());
      const result = detectPlan(usages);
      assert.equal(result.plan, 'pro');
      assert.equal(result.confidence, 'high');
    });

    it('ignores turns with no cache write', () => {
      // 10 empties + 5 x 1h should count as 5 samples, not 15
      const usages = [
        ...Array.from({ length: 10 }, () => mkEmpty()),
        ...Array.from({ length: 5 }, () => mk1h()),
      ];
      const result = detectPlan(usages);
      assert.equal(result.plan, 'max5x');
      assert.equal(result.confidence, 'high');
    });

    it('ignores malformed entries', () => {
      const usages = [null, undefined, mkNoUsage(), mk1h(), mk1h(), mk1h(), mk1h(), mk1h()];
      const result = detectPlan(usages);
      assert.equal(result.plan, 'max5x');
    });

    it('uses only last 20 cache writes (sliding window)', () => {
      // If 25 x 5m THEN 0 → window = last 20 (all 5m) → pro
      // If 25 x 1h THEN 0 → window = last 20 (all 1h) → max5x
      const all5m = Array.from({ length: 25 }, () => mk5m());
      assert.equal(detectPlan(all5m).plan, 'pro');

      const all1h = Array.from({ length: 25 }, () => mk1h());
      assert.equal(detectPlan(all1h).plan, 'max5x');
    });
  });

  describe('getEffectivePlan', () => {
    it('env override takes precedence over detection', () => {
      const usages = Array.from({ length: 10 }, () => mk1h()); // would detect max5x
      const result = getEffectivePlan({ envValue: 'max20x', recentUsages: usages });
      assert.equal(result.plan, 'max20x');
      assert.equal(result.source, 'env');
    });

    it('env unknown value is ignored, falls back to detection', () => {
      const usages = Array.from({ length: 10 }, () => mk1h());
      const result = getEffectivePlan({ envValue: 'enterprise', recentUsages: usages });
      assert.equal(result.plan, 'max5x');
      assert.equal(result.source, 'auto');
    });

    it('auto-detects when no env', () => {
      const usages = Array.from({ length: 10 }, () => mk5m());
      const result = getEffectivePlan({ envValue: '', recentUsages: usages });
      assert.equal(result.plan, 'pro');
      assert.equal(result.source, 'auto');
    });

    it('falls back to api-key default on insufficient data', () => {
      const result = getEffectivePlan({ envValue: '', recentUsages: [] });
      assert.equal(result.plan, 'api-key');
      assert.equal(result.source, 'default');
      assert.equal(result.confidence, 'insufficient');
    });

    it('case-insensitive env value', () => {
      const result = getEffectivePlan({ envValue: 'MAX5X', recentUsages: [] });
      assert.equal(result.plan, 'max5x');
      assert.equal(result.source, 'env');
    });
  });
});
