'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PLAN_CONFIG, DEFAULT_PLAN, getPlanConfig, isKnownPlan } = require('../server/plans');

describe('plans', () => {
  describe('PLAN_CONFIG', () => {
    it('has all four expected plans', () => {
      assert.ok(PLAN_CONFIG.pro);
      assert.ok(PLAN_CONFIG.max5x);
      assert.ok(PLAN_CONFIG.max20x);
      assert.ok(PLAN_CONFIG['api-key']);
    });

    it('has required shape for every plan', () => {
      for (const [id, cfg] of Object.entries(PLAN_CONFIG)) {
        assert.equal(typeof cfg.tokens5h, 'number', id + ' tokens5h');
        assert.equal(typeof cfg.monthlyUSD, 'number', id + ' monthlyUSD');
        assert.equal(typeof cfg.cacheTtlMs, 'number', id + ' cacheTtlMs');
        assert.equal(typeof cfg.label, 'string', id + ' label');
      }
    });

    it('max plans have 1h cache, others 5m', () => {
      assert.equal(PLAN_CONFIG.max5x.cacheTtlMs, 3_600_000);
      assert.equal(PLAN_CONFIG.max20x.cacheTtlMs, 3_600_000);
      assert.equal(PLAN_CONFIG.pro.cacheTtlMs, 300_000);
      assert.equal(PLAN_CONFIG['api-key'].cacheTtlMs, 300_000);
    });

    it('api-key has zero quota/price (metered)', () => {
      assert.equal(PLAN_CONFIG['api-key'].monthlyUSD, 0);
      assert.equal(PLAN_CONFIG['api-key'].tokens5h, 0);
    });

    it('published prices match subscription tiers', () => {
      assert.equal(PLAN_CONFIG.pro.monthlyUSD, 20);
      assert.equal(PLAN_CONFIG.max5x.monthlyUSD, 100);
      assert.equal(PLAN_CONFIG.max20x.monthlyUSD, 200);
    });
  });

  describe('getPlanConfig', () => {
    it('returns correct config for known plans', () => {
      assert.equal(getPlanConfig('pro').monthlyUSD, 20);
      assert.equal(getPlanConfig('max5x').monthlyUSD, 100);
      assert.equal(getPlanConfig('max20x').monthlyUSD, 200);
    });

    it('falls back to api-key for unknown plan', () => {
      const fallback = getPlanConfig('unknown-plan');
      assert.equal(fallback, PLAN_CONFIG[DEFAULT_PLAN]);
      assert.equal(fallback.label, 'API key');
    });

    it('falls back to api-key for null/undefined', () => {
      assert.equal(getPlanConfig(null), PLAN_CONFIG[DEFAULT_PLAN]);
      assert.equal(getPlanConfig(undefined), PLAN_CONFIG[DEFAULT_PLAN]);
    });
  });

  describe('isKnownPlan', () => {
    it('true for known', () => {
      assert.equal(isKnownPlan('pro'), true);
      assert.equal(isKnownPlan('max5x'), true);
      assert.equal(isKnownPlan('max20x'), true);
      assert.equal(isKnownPlan('api-key'), true);
    });

    it('false for unknown', () => {
      assert.equal(isKnownPlan('free'), false);
      assert.equal(isKnownPlan('max'), false);
      assert.equal(isKnownPlan(''), false);
      assert.equal(isKnownPlan(null), false);
    });
  });
});
