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
      assert.equal(p.input, 5);
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

    it('returns pricing for grok-build title-gen model from DEFAULT_PRICING', () => {
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
    it('no active overrides (all graduated to DEFAULT_PRICING)', () => {
      assert.equal(LITELLM_LAG_OVERRIDES.length, 0);
    });

    it('applyLagOverrides produces empty status when no overrides exist', () => {
      applyLagOverrides({});
      const pricing = require('../server/pricing');
      assert.deepEqual(pricing.lastLagOverrideStatus, []);
    });
  });

  describe('buildPricingTable precedence (#397)', () => {
    it('LiteLLM wins over DEFAULT_PRICING for models present in both', () => {
      // DEFAULT_PRICING has gpt-5.5 as 2/10/0/1.
      // LiteLLM has it as 5/30/5/0.5. LiteLLM must win.
      const table = buildPricingTable({
        'gpt-5.5': { input: 5, output: 30, cache_create: 5, cache_read: 0.5 },
      });
      assert.equal(table['gpt-5.5'].input, 5, 'LiteLLM input rate must win');
      assert.equal(table['gpt-5.5'].output, 30, 'LiteLLM output rate must win');
      assert.equal(table['gpt-5.5'].cache_create, 5, 'LiteLLM cache_create rate must win');
      assert.equal(table['gpt-5.5'].cache_read, 0.5, 'LiteLLM cache_read rate must win');
    });

    it('DEFAULT_PRICING applies when LiteLLM lacks the model', () => {
      const table = buildPricingTable({});
      assert.ok(table['gpt-5.5'], 'DEFAULT_PRICING floor must still provide gpt-5.5');
      assert.equal(table['gpt-5.5'].input, 5);
    });

    it('only xai/ keys are mirrored to bare names, not azure_ai/ (#397 defect 4)', () => {
      const table = buildPricingTable({
        'azure_ai/grok-code-fast-1': { input: 0.2, output: 1.5, cache_create: 0, cache_read: 0.2 },
        'xai/grok-code-fast-1':     { input: 0.2, output: 1.5, cache_create: 0, cache_read: 0.02 },
      });
      assert.ok(table['grok-code-fast-1'], 'bare key must exist from xai/ mirror');
      assert.equal(table['grok-code-fast-1'].cache_read, 0.02,
        'bare key must have xai/ rate, not azure_ai/ rate');
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

    // #420: confidence level tests
    it('returns exact confidence for exact model match', () => {
      const result = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4');
      assert.equal(result.confidence, 'exact');
    });

    it('returns prefix confidence for dated wire ID', () => {
      const result = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4-20250514');
      assert.equal(result.confidence, 'prefix');
    });

    it('returns exact confidence for xai/ mirrored model', () => {
      const result = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'grok-4.5');
      assert.equal(result.confidence, 'exact');
    });

    it('returns unknown confidence for unrecognized model', () => {
      const result = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'totally-unknown-model');
      assert.equal(result.confidence, 'unknown');
      assert.ok(result.warning);
    });
  });
});

// #568: same model, different upstream, different rates. The provider key is the
// LiteLLM prefix (fireworks_ai, together_ai, xai …); a `provider/model` row wins
// over the bare `model` row, and an unknown provider falls back to model-only.
describe('provider-keyed pricing (#568)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const PRICING_MOD = require.resolve('../server/pricing');

  // Fresh module instance bound to an isolated cache file (CCXRAY_PRICING_CACHE is
  // read at require time — the package-relative default is outside CCXRAY_HOME).
  async function loadWithCache(pricing) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pricing-568-'));
    const cachePath = path.join(dir, 'pricing-cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), pricing, context: {} }));
    const prevEnv = process.env.CCXRAY_PRICING_CACHE;
    const prevMod = require.cache[PRICING_MOD];
    process.env.CCXRAY_PRICING_CACHE = cachePath;
    delete require.cache[PRICING_MOD];
    try {
      const mod = require(PRICING_MOD);
      await mod.fetchPricing();
      return mod;
    } finally {
      delete require.cache[PRICING_MOD];
      if (prevMod) require.cache[PRICING_MOD] = prevMod;
      if (prevEnv === undefined) delete process.env.CCXRAY_PRICING_CACHE;
      else process.env.CCXRAY_PRICING_CACHE = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Real LiteLLM shape (cache fetched 2026-08-14): bare deepseek-v4-pro is the
  // DeepSeek-direct rate; fireworks_ai/deepseek-v4-pro lists a different one.
  const TABLE = {
    'deepseek-v4-pro': { input: 1.74, output: 3.48, cache_create: 1.74, cache_read: 0.87 },
    'fireworks_ai/deepseek-v4-pro': { input: 2.10, output: 4.40, cache_create: 2.10, cache_read: 1.05 },
  };
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

  it('prefers the provider/model row when the provider is known', async () => {
    const mod = await loadWithCache(TABLE);
    const r = mod.calculateCost(usage, 'deepseek-v4-pro', 'fireworks_ai');
    assert.equal(r.confidence, 'exact');
    assert.equal(r.rates.input, 2.10);
    assert.equal(r.cost, 2.10 + 4.40);
  });

  it('falls back to the model-only row when the provider has no row', async () => {
    const mod = await loadWithCache(TABLE);
    const r = mod.calculateCost(usage, 'deepseek-v4-pro', 'together_ai');
    assert.equal(r.confidence, 'exact');
    assert.equal(r.rates.input, 1.74);
  });

  it('is unchanged when no provider is given', async () => {
    const mod = await loadWithCache(TABLE);
    const r = mod.calculateCost(usage, 'deepseek-v4-pro');
    assert.equal(r.rates.input, 1.74);
  });

  it('does not change the existing bare exact match for current upstreams', () => {
    // Anthropic/OpenAI rows are bare in LiteLLM; xai/ rows mirror to bare with equal rates.
    const a = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4', 'anthropic');
    const b = calculateCost({ input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4');
    assert.deepEqual(a, b);
    assert.equal(a.confidence, 'exact');
  });
});
