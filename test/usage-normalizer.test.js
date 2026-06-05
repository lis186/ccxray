'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsageForProvider, getUpstreamProfile, UPSTREAM_PROFILES } = require('../server/providers');
const { calculateCost, getModelPricing } = require('../server/pricing');

describe('UPSTREAM_PROFILES', () => {
  it('anthropic profile has ephemeral-ttl cache and no cached-in-input', () => {
    const p = UPSTREAM_PROFILES.anthropic;
    assert.equal(p.cache, 'ephemeral-ttl');
    assert.equal(p.inputIncludesCached, false);
  });

  it('openai profile has server-managed cache and cached-in-input', () => {
    const p = UPSTREAM_PROFILES.openai;
    assert.equal(p.cache, 'server-managed');
    assert.equal(p.inputIncludesCached, true);
  });

  it('getUpstreamProfile returns null for unknown upstream', () => {
    assert.equal(getUpstreamProfile('unknown'), null);
    assert.equal(getUpstreamProfile(null), null);
  });
});

describe('normalizeUsageForProvider', () => {
  it('normalizes OpenAI usage: subtracts cached from input', () => {
    const usage = {
      input_tokens: 61154,
      output_tokens: 678,
      total_tokens: 61832,
      cache_read_input_tokens: 58240,
      cache_creation_input_tokens: 0,
      input_tokens_details: { cached_tokens: 58240 },
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result.input_tokens, 2914);
    assert.equal(result.cache_read_input_tokens, 58240);
    assert.equal(result.cache_creation_input_tokens, 0);
    assert.equal(result._ccxrayUsageNormalized, true);
    assert.equal(result.output_tokens, 678);
    assert.equal(result.total_tokens, 61832);
  });

  it('clamps to 0 when cached > input', () => {
    const usage = {
      input_tokens: 50,
      cache_read_input_tokens: 100,
      input_tokens_details: { cached_tokens: 100 },
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result.input_tokens, 0);
    assert.equal(result.cache_read_input_tokens, 100);
    assert.equal(result._ccxrayUsageNormalized, true);
  });

  it('no-op when cached=0', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result.input_tokens, 1000);
    assert.equal(result._ccxrayUsageNormalized, undefined);
    assert.equal(result, usage);
  });

  it('idempotent: already-normalized usage is returned unchanged', () => {
    const usage = {
      input_tokens: 2914,
      cache_read_input_tokens: 58240,
      _ccxrayUsageNormalized: true,
      input_tokens_details: { cached_tokens: 58240 },
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result, usage);
    assert.equal(result.input_tokens, 2914);
  });

  it('no-op for anthropic provider', () => {
    const usage = {
      input_tokens: 2914,
      cache_read_input_tokens: 58240,
      cache_creation_input_tokens: 0,
    };
    const result = normalizeUsageForProvider('anthropic', usage);
    assert.equal(result, usage);
    assert.equal(result._ccxrayUsageNormalized, undefined);
  });

  it('no-op for unknown provider', () => {
    const usage = { input_tokens: 1000, cache_read_input_tokens: 500 };
    const result = normalizeUsageForProvider('unknown', usage);
    assert.equal(result, usage);
    assert.equal(result._ccxrayUsageNormalized, undefined);
  });

  it('consecutive calls produce same result', () => {
    const usage = {
      input_tokens: 61154,
      input_tokens_details: { cached_tokens: 58240 },
    };
    const first = normalizeUsageForProvider('openai', usage);
    const second = normalizeUsageForProvider('openai', first);
    assert.equal(second, first);
    assert.equal(second.input_tokens, 2914);
    assert.equal(second._ccxrayUsageNormalized, true);
  });

  it('restored old entry: result has _ccxrayUsageNormalized flag', () => {
    const oldIndexUsage = {
      input_tokens: 61154,
      cache_read_input_tokens: 58240,
      cache_creation_input_tokens: 0,
      input_tokens_details: { cached_tokens: 58240 },
    };
    const result = normalizeUsageForProvider('openai', oldIndexUsage);
    assert.equal(result._ccxrayUsageNormalized, true);
    assert.equal(result.input_tokens, 2914);
    const again = normalizeUsageForProvider('openai', result);
    assert.equal(again, result);
  });

  it('fallback: only cache_read_input_tokens, no input_tokens_details', () => {
    const usage = {
      input_tokens: 10000,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 0,
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result.input_tokens, 2000);
    assert.equal(result.cache_read_input_tokens, 8000);
    assert.equal(result._ccxrayUsageNormalized, true);
  });

  it('guarantees cache_read and cache_creation fields exist', () => {
    const usage = {
      input_tokens: 5000,
      input_tokens_details: { cached_tokens: 3000 },
    };
    const result = normalizeUsageForProvider('openai', usage);
    assert.equal(result.cache_read_input_tokens, 3000);
    assert.equal(result.cache_creation_input_tokens, 0);
  });

  it('null/undefined usage returns as-is', () => {
    assert.equal(normalizeUsageForProvider('openai', null), null);
    assert.equal(normalizeUsageForProvider('openai', undefined), undefined);
  });
});

describe('cost calculation with normalized OpenAI usage', () => {
  it('computes correct cost for gpt-5.5 after normalization', () => {
    const rawUsage = {
      input_tokens: 61154,
      output_tokens: 678,
      total_tokens: 61832,
      cache_read_input_tokens: 58240,
      cache_creation_input_tokens: 0,
      input_tokens_details: { cached_tokens: 58240 },
    };
    const normalized = normalizeUsageForProvider('openai', rawUsage);
    assert.equal(normalized.input_tokens, 2914);
    assert.equal(normalized.cache_read_input_tokens, 58240);

    const rates = getModelPricing('gpt-5.5');
    if (!rates) return; // skip if model not in pricing table

    const { cost } = calculateCost(normalized, 'gpt-5.5');
    const expected =
      (2914 / 1_000_000) * rates.input +
      (678 / 1_000_000) * rates.output +
      (0 / 1_000_000) * rates.cache_create +
      (58240 / 1_000_000) * rates.cache_read;
    assert.equal(cost, expected);
  });
});

describe('restore-level: historical OpenAI cost recomputation', () => {
  it('simulates restore flow: normalize usage then recompute cost', () => {
    const staleCost = { cost: 999, rates: { input: 1 } };
    const meta = {
      provider: 'openai',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 61154,
        output_tokens: 678,
        total_tokens: 61832,
        cache_read_input_tokens: 58240,
        cache_creation_input_tokens: 0,
        input_tokens_details: { cached_tokens: 58240 },
      },
      cost: staleCost,
    };

    const before = meta.usage;
    meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);

    if (meta.usage !== before && meta.usage._ccxrayUsageNormalized && meta.model) {
      meta.cost = calculateCost(meta.usage, meta.model);
    }

    assert.notEqual(meta.cost, staleCost);
    assert.equal(meta.usage.input_tokens, 2914);
    assert.equal(meta.usage._ccxrayUsageNormalized, true);

    const rates = getModelPricing('gpt-5.5');
    if (!rates) return;
    const expectedCost =
      (2914 / 1_000_000) * rates.input +
      (678 / 1_000_000) * rates.output +
      (0 / 1_000_000) * rates.cache_create +
      (58240 / 1_000_000) * rates.cache_read;
    assert.equal(meta.cost.cost, expectedCost);
  });

  it('does not recompute cost for already-normalized entries', () => {
    const originalCost = { cost: 0.31, rates: {} };
    const meta = {
      provider: 'openai',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 2914,
        cache_read_input_tokens: 58240,
        _ccxrayUsageNormalized: true,
      },
      cost: originalCost,
    };

    const before = meta.usage;
    meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);

    if (meta.usage !== before && meta.usage._ccxrayUsageNormalized && meta.model) {
      meta.cost = calculateCost(meta.usage, meta.model);
    }

    assert.equal(meta.cost, originalCost);
  });

  it('accumulates recomputed cost into session total', () => {
    const sessionCosts = new Map();
    const entries = [
      { provider: 'openai', model: 'gpt-5.5', sessionId: 'sess1',
        usage: { input_tokens: 61154, output_tokens: 678, cache_read_input_tokens: 58240,
                 input_tokens_details: { cached_tokens: 58240 } },
        cost: { cost: 999 } },
      { provider: 'openai', model: 'gpt-5.5', sessionId: 'sess1',
        usage: { input_tokens: 10000, output_tokens: 200, cache_read_input_tokens: 8000,
                 input_tokens_details: { cached_tokens: 8000 } },
        cost: { cost: 999 } },
    ];

    for (const meta of entries) {
      const before = meta.usage;
      meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);
      if (meta.usage !== before && meta.usage._ccxrayUsageNormalized && meta.model) {
        meta.cost = calculateCost(meta.usage, meta.model);
      }
      if (meta.cost?.cost != null && meta.sessionId) {
        sessionCosts.set(meta.sessionId, (sessionCosts.get(meta.sessionId) || 0) + meta.cost.cost);
      }
    }

    const total = sessionCosts.get('sess1');
    assert.ok(total > 0);
    assert.ok(total < 2);
  });
});
