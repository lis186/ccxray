'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectRatelimitHeaders } = require('../server/ratelimit-log');

describe('ratelimit-log', () => {
  describe('collectRatelimitHeaders', () => {
    it('returns null when no relevant headers present', () => {
      assert.equal(collectRatelimitHeaders({}), null);
      assert.equal(collectRatelimitHeaders({ 'content-type': 'text/event-stream' }), null);
    });

    it('extracts tokens/input/output/requests limits when present', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': '220000',
        'anthropic-ratelimit-tokens-remaining': '215000',
        'anthropic-ratelimit-tokens-reset': '2026-04-19T12:00:00Z',
        'anthropic-ratelimit-input-tokens-limit': '40000',
        'anthropic-ratelimit-input-tokens-remaining': '39500',
        'anthropic-ratelimit-input-tokens-reset': '2026-04-19T11:05:00Z',
        'anthropic-ratelimit-output-tokens-limit': '8000',
        'anthropic-ratelimit-output-tokens-remaining': '8000',
        'anthropic-ratelimit-output-tokens-reset': '2026-04-19T11:05:00Z',
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': '2026-04-19T11:05:00Z',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, 220000);
      assert.equal(result.tokensRemaining, 215000);
      assert.equal(result.tokensReset, '2026-04-19T12:00:00Z');
      assert.equal(result.inputLimit, 40000);
      assert.equal(result.outputLimit, 8000);
      assert.equal(result.requestsLimit, 50);
    });

    it('handles partial headers (only tokens, no input)', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': '220000',
        'anthropic-ratelimit-tokens-remaining': '215000',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, 220000);
      assert.equal(result.inputLimit, null);
      assert.equal(result.outputLimit, null);
    });

    it('returns null for malformed numeric values', () => {
      // NaN values should be null, not break
      const headers = {
        'anthropic-ratelimit-tokens-limit': 'garbage',
      };
      const result = collectRatelimitHeaders(headers);
      // tokensLimit null, and since inputLimit/requestsLimit also null → whole result null
      assert.equal(result, null);
    });

    it('still returns object if one of tokens/input/requests is valid', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': 'garbage',
        'anthropic-ratelimit-input-tokens-limit': '40000',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, null);
      assert.equal(result.inputLimit, 40000);
    });
  });
});
