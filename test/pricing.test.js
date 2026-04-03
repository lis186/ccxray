'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { calculateCost, getModelPricing } = require('../server/pricing');

describe('pricing', () => {
  describe('getModelPricing', () => {
    it('returns null for null/undefined model', () => {
      assert.equal(getModelPricing(null), null);
      assert.equal(getModelPricing(undefined), null);
    });

    it('returns exact match for known model', () => {
      const p = getModelPricing('claude-sonnet-4');
      assert.ok(p);
      assert.equal(p.input, 3);
      assert.equal(p.output, 15);
    });

    it('matches by prefix for versioned model IDs', () => {
      const p = getModelPricing('claude-sonnet-4-20250514');
      assert.ok(p);
      assert.equal(p.input, 3);
    });

    it('returns null for unknown model', () => {
      assert.equal(getModelPricing('gpt-4o'), null);
    });
  });

  describe('calculateCost', () => {
    it('returns null for null usage', () => {
      assert.equal(calculateCost(null, 'claude-sonnet-4'), null);
    });

    it('returns warning for unknown model', () => {
      const result = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'unknown-model');
      assert.equal(result.cost, null);
      assert.ok(result.warning);
    });

    it('calculates cost correctly for simple usage', () => {
      const usage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const result = calculateCost(usage, 'claude-sonnet-4');
      // input: 1M * $3/M = $3, output: 1M * $15/M = $15
      assert.equal(result.cost, 18);
    });

    it('includes cache costs', () => {
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      };
      const result = calculateCost(usage, 'claude-sonnet-4');
      // cache_create: 1M * $3.75/M = $3.75, cache_read: 1M * $0.30/M = $0.30
      assert.equal(result.cost, 4.05);
    });

    it('handles zero token usage', () => {
      const result = calculateCost({
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      }, 'claude-sonnet-4');
      assert.equal(result.cost, 0);
    });
  });
});
