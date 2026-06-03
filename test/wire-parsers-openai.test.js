'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const openai = require('../server/wire-parsers/openai');
const { getParser } = require('../server/wire-parsers');

const FIXTURES = path.join(__dirname, 'fixtures', 'wire-parsers', 'openai');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('wire-parsers/openai registry', () => {
  it('getParser returns openai parser', () => {
    const parser = getParser('openai');
    assert.ok(parser);
    assert.equal(typeof parser.extractUsage, 'function');
    assert.equal(typeof parser.isNoiseRequest, 'function');
    assert.equal(typeof parser.preprocessBody, 'function');
  });
});

describe('wire-parsers/openai', () => {
  describe('isNoiseRequest', () => {
    it('filters codex platform noise paths', () => {
      const noisePaths = loadFixture('noise_paths.json');
      for (const p of noisePaths.noise) {
        assert.equal(openai.isNoiseRequest(p, {}, {}), true, `${p} should be noise`);
      }
    });

    it('does not filter real API paths', () => {
      const noisePaths = loadFixture('noise_paths.json');
      for (const p of noisePaths.not_noise) {
        assert.equal(openai.isNoiseRequest(p, {}, {}), false, `${p} should NOT be noise`);
      }
    });

    it('handles paths with query strings', () => {
      assert.equal(openai.isNoiseRequest('/v1/plugins/list?foo=bar', {}, {}), true);
      assert.equal(openai.isNoiseRequest('/v1/responses?stream=true', {}, {}), false);
    });
  });

  describe('extractUsage', () => {
    it('extracts from response object', () => {
      const res = loadFixture('turn1_res.json');
      const usage = openai.extractUsage(res);
      assert.ok(usage);
      assert.equal(usage.input_tokens, 850);
      assert.equal(usage.output_tokens, 35);
      assert.equal(usage.total_tokens, 885);
    });

    it('returns null for missing usage', () => {
      assert.equal(openai.extractUsage(null), null);
      assert.equal(openai.extractUsage({}), null);
      assert.equal(openai.extractUsage({ id: 'resp_01' }), null);
    });
  });

  describe('detectSession', () => {
    it('extracts sessionId from headers', () => {
      const headers = { 'session_id': 'test-session-abc' };
      const result = openai.detectSession(null, headers, null);
      assert.ok(result.sessionId);
      assert.ok(result.sessionId !== 'codex-raw', 'should not fallback to codex-raw when header present');
    });

    it('extracts sessionId from turn metadata', () => {
      const headers = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'meta-session-123' }) };
      const result = openai.detectSession(null, headers, null);
      assert.ok(result.sessionId);
      assert.notEqual(result.sessionId, 'codex-raw');
    });

    it('falls back to codex-raw when no session info', () => {
      const result = openai.detectSession(null, {}, null);
      assert.equal(result.sessionId, 'codex-raw');
      assert.equal(result.inferred, true);
    });
  });

  describe('preprocessBody (withCodexMetadata)', () => {
    it('injects session_id from headers into body metadata', () => {
      const body = { model: 'gpt-5.5', input: [] };
      const headers = { 'session_id': 'injected-session' };
      const result = openai.preprocessBody(body, headers);
      assert.equal(result.metadata.session_id, 'injected-session');
    });

    it('does not overwrite existing metadata', () => {
      const body = { model: 'gpt-5.5', metadata: { session_id: 'original' } };
      const headers = { 'session_id': 'from-header' };
      const result = openai.preprocessBody(body, headers);
      assert.equal(result.metadata.session_id, 'original');
    });

    it('returns body unchanged when no header info', () => {
      const body = { model: 'gpt-5.5' };
      const result = openai.preprocessBody(body, {});
      assert.deepEqual(result, body);
    });
  });

  describe('low-level exports for ws-proxy compat', () => {
    it('exports all openai-session.js functions', () => {
      assert.equal(typeof openai.getCodexRawSessionId, 'function');
      assert.equal(typeof openai.firstHeader, 'function');
      assert.equal(typeof openai.parseCodexTurnMetadata, 'function');
      assert.equal(typeof openai.getCodexSessionId, 'function');
      assert.equal(typeof openai.getOpenAIAgentTypeFromHeaders, 'function');
      assert.equal(typeof openai.isOpenAISubagent, 'function');
      assert.equal(typeof openai.detectOpenAISession, 'function');
      assert.equal(typeof openai.withCodexMetadata, 'function');
    });

    it('isOpenAISubagent detects from header', () => {
      assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': 'true' }, {}), true);
      assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': '0' }, {}), false);
      assert.equal(openai.isOpenAISubagent({}, {}), false);
    });
  });
});
