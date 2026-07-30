'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { withGrokLiveCosts } = require('../server/adapters/grok-adapter');

describe('withGrokLiveCosts', () => {
  it('only rewrites grok-default byAccount from store entries', () => {
    const today = new Date().toLocaleDateString('sv-SE');
    const month = today.slice(0, 7);
    const data = {
      blocks: [],
      daily: [{
        date: today,
        totalTokens: 1000,
        costUSD: 1,
        models: ['claude'],
        sessionCount: 1,
        byAccount: {
          'claude-default': { totalTokens: 1000, costUSD: 1 },
          'grok-default': { totalTokens: 0, costUSD: 0 },
        },
      }],
      monthly: [{
        month,
        totalTokens: 1000,
        costUSD: 1,
        models: ['claude'],
        byAccount: {
          'claude-default': { totalTokens: 1000, costUSD: 1 },
        },
      }],
    };
    const fakeStore = {
      entries: [{
        agent: 'grok',
        receivedAt: Date.now(),
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost: { cost: 0.05 },
      }],
    };
    const out = withGrokLiveCosts(data, fakeStore);
    assert.equal(out.daily[0].byAccount['claude-default'].costUSD, 1);
    assert.equal(out.daily[0].byAccount['grok-default'].costUSD, 0.05);
    assert.equal(out.daily[0].byAccount['grok-default'].totalTokens, 110);
    assert.equal(out.monthly[0].byAccount['grok-default'].costUSD, 0.05);
  });
});
