'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PRICING,
  LITELLM_LAG_OVERRIDES,
  applyLagOverrides,
  getOfflineRates,
  calculateCostSimple,
} = require('../server/default-rates');

describe('default-rates: single source of truth (#397)', () => {

  describe('DEFAULT_PRICING completeness', () => {
    it('covers all Claude model families', () => {
      const families = [
        'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5',
        'claude-opus-4-1', 'claude-opus-4', 'claude-sonnet-4',
        'claude-haiku-4', 'claude-fable-5',
        'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus',
      ];
      for (const key of families) {
        assert.ok(DEFAULT_PRICING[key], `missing: ${key}`);
        assert.ok(DEFAULT_PRICING[key].input > 0, `${key}.input must be positive`);
        assert.ok(DEFAULT_PRICING[key].output > 0, `${key}.output must be positive`);
      }
    });

    it('has wire-ID aliases for dated Claude wire IDs', () => {
      // claude-sonnet-4-5-20250514 prefix-matches this key
      assert.ok(DEFAULT_PRICING['claude-sonnet-4-5']);
      // claude-haiku-3-5-20241022 prefix-matches this key
      assert.ok(DEFAULT_PRICING['claude-haiku-3-5']);
    });

    it('covers grok models', () => {
      assert.ok(DEFAULT_PRICING['grok-4.5']);
      assert.ok(DEFAULT_PRICING['grok-4.3']);
      assert.ok(DEFAULT_PRICING['grok-build']);
      assert.ok(DEFAULT_PRICING['grok-build-0.1']);
    });

    it('covers OpenAI models', () => {
      for (const key of ['gpt-5.5', 'gpt-5', 'gpt-4o', 'o3', 'o4-mini']) {
        assert.ok(DEFAULT_PRICING[key], `missing: ${key}`);
      }
    });

    it('claude-opus-4-5 is $5/$25 not $15/$75 (old cost-worker bug)', () => {
      assert.equal(DEFAULT_PRICING['claude-opus-4-5'].input, 5);
      assert.equal(DEFAULT_PRICING['claude-opus-4-5'].output, 25);
    });
  });

  describe('applyLagOverrides', () => {
    it('returns { table, status } (pure — no side effects)', () => {
      const result = applyLagOverrides({ ...DEFAULT_PRICING });
      assert.ok(result.table);
      assert.ok(Array.isArray(result.status));
    });

    it('returns empty status when no overrides are defined', () => {
      const { table, status } = applyLagOverrides({});
      assert.ok(table);
      assert.deepEqual(status, []);
    });
  });

  describe('getOfflineRates', () => {
    it('returns DEFAULT_PRICING merged (no active lag overrides)', () => {
      const rates = getOfflineRates();
      for (const key of Object.keys(DEFAULT_PRICING)) {
        assert.ok(rates[key], `missing: ${key}`);
      }
      assert.ok(rates['grok-build']);
      assert.ok(rates['grok-build-0.1']);
    });
  });

  describe('calculateCostSimple', () => {
    const usage1M = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    it('matches grok-4.5-build to grok-4.5-build (exact, $2/MTok input)', () => {
      assert.equal(calculateCostSimple(usage1M, 'grok-4.5-build').cost, 2);
    });

    it('matches grok-build to grok-build ($1/MTok input)', () => {
      assert.equal(calculateCostSimple(usage1M, 'grok-build').cost, 1);
    });

    it('matches dated wire ID claude-sonnet-4-5-20250514 ($3/MTok input)', () => {
      assert.equal(calculateCostSimple(usage1M, 'claude-sonnet-4-5-20250514').cost, 3);
    });

    it('matches dated wire ID claude-haiku-3-5-20241022 ($0.80/MTok input)', () => {
      assert.equal(calculateCostSimple(usage1M, 'claude-haiku-3-5-20241022').cost, 0.8);
    });

    it('matches claude-fable-5 ($10/MTok input)', () => {
      assert.equal(calculateCostSimple(usage1M, 'claude-fable-5').cost, 10);
    });

    it('falls back to sonnet-4 rates for unknown model', () => {
      assert.equal(calculateCostSimple(usage1M, 'totally-unknown').cost, 3);
    });

    it('falls back to sonnet-4 rates for null model', () => {
      assert.equal(calculateCostSimple(usage1M, null).cost, 3);
    });

    it('calculates all four cost components', () => {
      const usage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      };
      const result = calculateCostSimple(usage, 'claude-sonnet-4');
      // $3 + $15 + $0.30 + $3.75 = $22.05
      assert.equal(result.cost, 22.05);
    });

    it('longest-prefix-first: grok-4.5-build matches grok-4.5-build not grok-build', () => {
      // grok-4.5-build has input $2/MTok (DEFAULT_PRICING), grok-build has $1/MTok.
      // Longest-prefix-first ensures grok-4.5-build wins.
      assert.equal(calculateCostSimple(usage1M, 'grok-4.5-build').cost, 2);
    });

    it('bare gpt-5.6 must NOT fall through to gpt-5 (codex review P1)', () => {
      // gpt-5.6 = $5/MTok input (same as gpt-5.6-sol), not gpt-5 at $1.25
      assert.equal(calculateCostSimple(usage1M, 'gpt-5.6').cost, 5);
    });

    it('getModelPricing uses date-strip parity with calculateCostSimple (codex review P2)', () => {
      const { getModelPricing } = require('../server/pricing');
      // claude-haiku-4-5-20251001 should resolve the same in both matchers
      const offline = calculateCostSimple(usage1M, 'claude-haiku-4-5-20251001').cost;
      const live = getModelPricing('claude-haiku-4-5-20251001');
      assert.ok(live, 'getModelPricing must resolve claude-haiku-4-5-20251001');
      const liveCost = usage1M.input_tokens * live.input / 1e6;
      assert.ok(Math.abs(offline - liveCost) < 0.01,
        `offline=${offline} live=${liveCost} — matchers disagree`);
    });

    // #420: confidence level tests
    it('returns exact confidence for exact model match', () => {
      assert.equal(calculateCostSimple(usage1M, 'claude-opus-4-6').confidence, 'exact');
    });

    it('returns prefix confidence for dated wire ID', () => {
      assert.equal(calculateCostSimple(usage1M, 'claude-opus-4-6-20260115').confidence, 'prefix');
    });

    it('returns fallback confidence for unknown model', () => {
      assert.equal(calculateCostSimple(usage1M, 'totally-unknown').confidence, 'fallback');
    });

    it('returns fallback confidence for null model', () => {
      assert.equal(calculateCostSimple(usage1M, null).confidence, 'fallback');
    });

    it('returns exact confidence for grok-build', () => {
      assert.equal(calculateCostSimple(usage1M, 'grok-build').confidence, 'exact');
    });

    it('returns { cost, confidence } shape', () => {
      const result = calculateCostSimple(usage1M, 'claude-sonnet-4');
      assert.ok(typeof result === 'object');
      assert.ok(typeof result.cost === 'number');
      assert.ok(['exact', 'prefix', 'fallback'].includes(result.confidence));
    });
  });

  describe('cross-module consistency', () => {
    it('pricing.js re-exports the same DEFAULT_PRICING', () => {
      // pricing.js does not re-export DEFAULT_PRICING directly, but
      // buildPricingTable({}) should produce a table that contains all
      // DEFAULT_PRICING keys (plus lag override keys).
      const { buildPricingTable } = require('../server/pricing');
      const table = buildPricingTable({});
      for (const [key, rates] of Object.entries(DEFAULT_PRICING)) {
        assert.ok(table[key], `buildPricingTable({}) missing: ${key}`);
        assert.equal(table[key].input, rates.input, `${key}.input mismatch`);
        assert.equal(table[key].output, rates.output, `${key}.output mismatch`);
      }
    });

    it('pricing.js re-exports the same LITELLM_LAG_OVERRIDES', () => {
      const pricing = require('../server/pricing');
      assert.equal(pricing.LITELLM_LAG_OVERRIDES, LITELLM_LAG_OVERRIDES);
    });

    it('cost-worker.js re-exports calculateCostSimple from default-rates.js', () => {
      const cw = require('../server/cost-worker');
      assert.equal(cw.calculateCostSimple, calculateCostSimple);
    });

    it('side-effect free: requiring default-rates.js installs no handlers', () => {
      const before = process.listenerCount('disconnect');
      require('../server/default-rates');
      assert.equal(process.listenerCount('disconnect'), before);
    });
  });
});
