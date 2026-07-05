'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const anthropic = require('../server/wire-parsers/anthropic');
const { getParser } = require('../server/wire-parsers');

const FIXTURES = path.join(__dirname, 'fixtures', 'wire-parsers', 'anthropic');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('wire-parsers/index', () => {
  it('getParser returns anthropic parser', () => {
    const parser = getParser('anthropic');
    assert.ok(parser);
    assert.equal(typeof parser.extractUsage, 'function');
  });

  it('getParser returns null for unknown provider', () => {
    assert.equal(getParser('gemini'), null);
  });
});

describe('wire-parsers/anthropic', () => {
  describe('isNoiseRequest', () => {
    it('classifies count_tokens as noise (#146: fake subagent lanes)', () => {
      assert.equal(anthropic.isNoiseRequest('/v1/messages/count_tokens', {}, {}), true);
      assert.equal(anthropic.isNoiseRequest('/v1/messages/count_tokens?beta=true', {}, {}), true);
    });

    it('keeps real conversation and other paths as entries', () => {
      assert.equal(anthropic.isNoiseRequest('/v1/messages', {}, {}), false);
      assert.equal(anthropic.isNoiseRequest('/v1/messages?beta=true', {}, {}), false);
      assert.equal(anthropic.isNoiseRequest('/v1/plugins/list', {}, {}), false);
    });
  });

  describe('extractUsage', () => {
    it('extracts usage from SSE events', () => {
      const events = loadFixture('turn1_res.json');
      const usage = anthropic.extractUsage(events);
      assert.ok(usage);
      assert.equal(usage.input_tokens, 1200);
      assert.equal(usage.output_tokens, 42);
      assert.equal(usage.cache_creation_input_tokens, 500);
      assert.equal(usage.cache_read_input_tokens, 200);
    });

    it('returns null for non-array input', () => {
      assert.equal(anthropic.extractUsage(null), null);
      assert.equal(anthropic.extractUsage('string'), null);
      assert.equal(anthropic.extractUsage({}), null);
    });

    it('returns zeros when usage fields missing', () => {
      const events = [{ type: 'message_start', message: { usage: {} } }];
      const usage = anthropic.extractUsage(events);
      assert.equal(usage.input_tokens, 0);
      assert.equal(usage.output_tokens, 0);
    });
  });

  describe('detectSession', () => {
    it('is a function that delegates to store', () => {
      assert.equal(typeof anthropic.detectSession, 'function');
      // Full integration of detectSession requires store state;
      // tested via integration tests in Phase 6
    });
  });
});
