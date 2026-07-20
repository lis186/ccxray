'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateCost,
  getModelPricing,
  buildPricingTable,
  applyLagOverrides,
  LITELLM_LAG_OVERRIDES,
} = require('../server/pricing');

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
      assert.equal(getModelPricing('totally-unknown-model'), null);
    });

    it('returns pricing for OpenAI models', () => {
      const p = getModelPricing('gpt-5.5');
      assert.ok(p);
      assert.equal(p.input, 2);
    });

    it('returns pricing for Grok CLI wire model ids via LiteLLM bare mirror', () => {
      // docs.x.ai/developers/models/grok-4.5 — Input $2 / Cached $0.50 / Output $6
      // LiteLLM lists xai/grok-4.5; mirrorProviderPrefixedKeys exposes bare grok-4.5.
      const table = buildPricingTable({
        'xai/grok-4.5': { input: 2, output: 6, cache_create: 0, cache_read: 0.5 },
      });
      assert.ok(table['grok-4.5'], 'bare wire id must mirror from xai/grok-4.5');
      assert.equal(table['grok-4.5'].input, 2);
      assert.equal(table['grok-4.5'].output, 6);
      assert.equal(table['grok-4.5'].cache_read, 0.5);
    });

    it('returns pricing for grok-build title-gen model via lag override', () => {
      const table = buildPricingTable({});
      assert.ok(table['grok-build']);
      assert.equal(table['grok-build'].input, 1);
      assert.equal(table['grok-build'].output, 2);
    });

    it('calculates cost for a typical grok-4.5 turn', () => {
      const table = buildPricingTable({
        'xai/grok-4.5': { input: 2, output: 6, cache_create: 0, cache_read: 0.5 },
      });
      assert.ok(table['grok-4.5']);
      // Live capture (normalized): input 25066, cache_read 5504, output 32
      const rates = table['grok-4.5'];
      const cost =
        (25066 / 1e6) * rates.input +
        (32 / 1e6) * rates.output +
        (5504 / 1e6) * rates.cache_read;
      assert.ok(Math.abs(cost - 0.053076) < 1e-9);
    });
  });

  describe('LITELLM_LAG_OVERRIDES lifecycle', () => {
    it('documents each override with litellmKeys + removeWhen (maintenance memory)', () => {
      assert.ok(LITELLM_LAG_OVERRIDES.length >= 1);
      for (const entry of LITELLM_LAG_OVERRIDES) {
        assert.ok(entry.id, 'override needs id');
        assert.ok(Array.isArray(entry.wireIds) && entry.wireIds.length, 'wireIds');
        assert.ok(Array.isArray(entry.litellmKeys) && entry.litellmKeys.length, 'litellmKeys to watch');
        assert.ok(entry.rates && entry.rates.input != null && entry.rates.output != null);
        assert.ok(entry.source, 'official source URL');
        assert.ok(entry.since, 'since date');
        assert.ok(entry.removeWhen, 'human remove condition');
      }
    });

    it('stops applying override once LiteLLM lists a watched key (auto-return)', () => {
      // Simulate LiteLLM catching up with xai/grok-build
      const litellm = {
        'xai/grok-build': { input: 1.1, output: 2.1, cache_create: 0, cache_read: 0.21 },
      };
      const table = buildPricingTable(litellm);
      // bare mirror from xai/ + lag override sees litellmKeys present → does NOT overwrite
      assert.equal(table['grok-build'].input, 1.1, 'LiteLLM rate must win after catch-up');
      assert.equal(table['xai/grok-build'].input, 1.1);
    });

    it('applyLagOverrides reports remove-override when LiteLLM has the key', () => {
      const { status } = (() => {
        // applyLagOverrides returns table only; status is on module after call
        applyLagOverrides({
          'xai/grok-build': { input: 1, output: 2, cache_create: 0, cache_read: 0.2 },
          'grok-build': { input: 1, output: 2, cache_create: 0, cache_read: 0.2 },
        });
        const pricing = require('../server/pricing');
        return { status: pricing.lastLagOverrideStatus };
      })();
      const grokBuild = status.find(s => s.id === 'grok-build');
      assert.ok(grokBuild);
      assert.equal(grokBuild.active, false);
      assert.equal(grokBuild.action, 'remove-override');
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
