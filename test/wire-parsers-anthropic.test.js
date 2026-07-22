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

  describe('extractResponseId (#333 dedup key)', () => {
    it('extracts message_start.message.id from SSE events', () => {
      const events = loadFixture('turn1_res.json');
      assert.equal(anthropic.extractResponseId(events), 'msg_01A');
    });

    it('extracts top-level id from a non-SSE response object', () => {
      assert.equal(anthropic.extractResponseId({ id: 'msg_01XYZ', type: 'message' }), 'msg_01XYZ');
    });

    it('returns null when the id is absent or input is empty', () => {
      assert.equal(anthropic.extractResponseId(null), null);
      assert.equal(anthropic.extractResponseId([]), null);
      assert.equal(anthropic.extractResponseId([{ type: 'message_start', message: {} }]), null);
      assert.equal(anthropic.extractResponseId({}), null);
      assert.equal(anthropic.extractResponseId('raw text'), null);
    });
  });

  describe('detectSession', () => {
    it('is a function that delegates to store', () => {
      assert.equal(typeof anthropic.detectSession, 'function');
      // Full integration of detectSession requires store state;
      // tested via integration tests in Phase 6
    });
  });

  describe('isSubagent', () => {
    it('returns true for bare subagent (no cwd, no session_id)', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      assert.equal(anthropic.isSubagent(body, {}), true);
    });

    it('returns false when system prompt has cwd', () => {
      const body = loadFixture('turn1_req.json');
      assert.equal(anthropic.isSubagent(body, {}), false);
    });
  });

  describe('rawSessionId', () => {
    it('extracts x-session-id header', () => {
      assert.equal(anthropic.rawSessionId({ 'x-session-id': 'sess-abc' }, {}), 'sess-abc');
    });

    it('returns null when header absent', () => {
      assert.equal(anthropic.rawSessionId({}, {}), null);
      assert.equal(anthropic.rawSessionId(null, {}), null);
    });
  });

  describe('systemPromptHash', () => {
    it('computes hash from system array', () => {
      const body = loadFixture('turn1_req.json');
      const result = anthropic.systemPromptHash(body);
      assert.equal(result.filePrefix, 'sys_');
      assert.equal(typeof result.hash, 'string');
      assert.equal(result.hash.length, 12);
      assert.deepEqual(result.content, body.system);
    });

    it('returns null hash when no system', () => {
      const result = anthropic.systemPromptHash({ messages: [] });
      assert.equal(result.hash, null);
      assert.equal(result.filePrefix, 'sys_');
      assert.equal(result.content, null);
    });
  });

  describe('toolsHash', () => {
    it('computes 12-char hex hash from tools array', () => {
      const body = loadFixture('turn1_req.json');
      const result = anthropic.toolsHash(body);
      assert.equal(typeof result.hash, 'string');
      assert.equal(result.hash.length, 12);
      assert.equal(result.filePrefix, 'tools_');
    });

    it('returns null hash when no tools', () => {
      assert.equal(anthropic.toolsHash({}).hash, null);
      assert.equal(anthropic.toolsHash({ tools: null }).hash, null);
    });
  });

  describe('getCwd', () => {
    it('extracts cwd from system prompt (Primary working directory)', () => {
      const body = {
        system: [{ type: 'text', text: 'Config' }, { type: 'text', text: 'You are assistant' }, { type: 'text', text: '# Environment\nPrimary working directory: /Users/test/project\nShell: zsh' }],
      };
      assert.equal(anthropic.getCwd(body, {}), '/Users/test/project');
    });

    it('returns null when no system prompt', () => {
      assert.equal(anthropic.getCwd({}, {}), null);
      assert.equal(anthropic.getCwd({ messages: [] }, {}), null);
    });
  });

  describe('turnStepCount', () => {
    it('counts tool_use blocks in assistant messages', () => {
      const body = loadFixture('turn1_req.json');
      const count = anthropic.turnStepCount(body);
      assert.equal(count, 1);
    });

    it('returns 0 for empty messages', () => {
      assert.equal(anthropic.turnStepCount({}), 0);
      assert.equal(anthropic.turnStepCount({ messages: [] }), 0);
    });

    it('counts multiple tool_use blocks across messages', () => {
      const body = {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ]},
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
          { role: 'assistant', content: [
            { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
          ]},
        ],
      };
      assert.equal(anthropic.turnStepCount(body), 3);
    });
  });
});
