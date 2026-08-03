'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { groupByDay, groupByMonth } = require('../server/cost-budget');

function usageEntry(overrides = {}) {
  return {
    timestamp: Date.now(),
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUSD: 0,
    costConfidence: 'exact',
    model: 'claude-opus-4-6',
    sessionId: 'synthetic-session',
    accountId: 'claude-default',
    ...overrides,
  };
}

describe('#420 Phase 3 cost-budget confidence grouping', () => {
  it('daily rows and per-account rows carry the complete fold', () => {
    const entries = [
      usageEntry({ costUSD: 1.234, costConfidence: 'fallback', accountId: 'claude-default' }),
      usageEntry({ costUSD: 0.50, costConfidence: 'exact', accountId: 'claude-default' }),
      usageEntry({ costUSD: null, costConfidence: 'unknown', accountId: 'codex-default' }),
    ];
    const day = groupByDay(entries).find(row => row.count === 3);
    assert.ok(day);
    assert.equal(day.fallbackCost, 1.23);
    assert.equal(day.fallbackCount, 1);
    assert.equal(day.unknownCount, 1);
    assert.equal(day.count, 3);
    assert.deepEqual(day.byAccount['claude-default'], {
      totalTokens: 240,
      costUSD: 1.73,
      fallbackCost: 1.23,
      fallbackCount: 1,
      unknownCount: 0,
      count: 2,
    });
    assert.deepEqual(day.byAccount['codex-default'], {
      totalTokens: 120,
      costUSD: 0,
      fallbackCost: 0,
      fallbackCount: 0,
      unknownCount: 1,
      count: 1,
    });
  });

  it('monthly rows carry the same fold and per-account breakdown', () => {
    const month = groupByMonth([
      usageEntry({ costUSD: 2, costConfidence: 'fallback', accountId: 'grok-default' }),
      usageEntry({ costUSD: 3, costConfidence: 'unknown', accountId: 'grok-default' }),
    ]).find(row => row.count === 2);
    assert.ok(month);
    assert.equal(month.fallbackCost, 2);
    assert.equal(month.fallbackCount, 1);
    assert.equal(month.unknownCount, 1);
    assert.equal(month.count, 2);
    assert.deepEqual(month.byAccount['grok-default'], {
      totalTokens: 240,
      costUSD: 5,
      fallbackCost: 2,
      fallbackCount: 1,
      unknownCount: 1,
      count: 2,
    });
  });
});
