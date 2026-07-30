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

    it('uses thread_id as a Codex session fallback', () => {
      const result = openai.detectSession(null, {}, {
        model: 'gpt-5.5',
        metadata: { thread_id: 'thread-session-123' },
      });
      assert.equal(result.sessionId, 'thread-session-123');
      assert.equal(result.inferred, false);
    });

    it('falls back to codex-raw when no session info', () => {
      const result = openai.detectSession(null, {}, null);
      assert.equal(result.sessionId, 'codex-raw');
      assert.equal(result.inferred, true);
    });

    it('extracts sessionId from x-grok-session-id header', () => {
      const headers = { 'x-grok-session-id': '019f451f-3c47-76c0-9f6c-a46b8be17bc3' };
      const result = openai.detectSession(null, headers, null);
      assert.equal(result.sessionId, '019f451f-3c47-76c0-9f6c-a46b8be17bc3');
      assert.equal(result.inferred, false);
    });

    it('falls back to x-grok-conv-id when session-id empty', () => {
      const headers = {
        'x-grok-session-id': '',
        'x-grok-conv-id': 'conv-uuid-abc',
      };
      const result = openai.detectSession(null, headers, null);
      assert.equal(result.sessionId, 'conv-uuid-abc');
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

    it('injects session_id from thread_id and cwd from workspaces', () => {
      const body = {
        model: 'gpt-5.5',
        metadata: {
          thread_id: 'thread-from-body',
          workspaces: {
            '/Users/test/project': { latest_git_commit_hash: 'abc123' },
          },
        },
      };
      const result = openai.preprocessBody(body, {});
      assert.equal(result.metadata.session_id, 'thread-from-body');
      assert.equal(result.metadata.cwd, '/Users/test/project');
    });

    it('extracts cwd from Codex instructions when metadata is absent', () => {
      const body = {
        model: 'gpt-5.5',
        instructions: 'You are Codex.\n\n# Environment\nOS: macOS\nShell: zsh\nCWD: /Users/test/from-instructions',
      };
      const result = openai.preprocessBody(body, {});
      assert.equal(result.metadata.cwd, '/Users/test/from-instructions');
    });

    it('tags Grok client metadata from headers', () => {
      const body = { model: 'grok-4.5', input: [] };
      const headers = {
        'x-grok-client-identifier': 'grok-shell',
        'x-grok-session-id': 'sess-1',
      };
      const result = openai.preprocessBody(body, headers);
      assert.equal(result.metadata.client, 'grok');
      assert.equal(result.metadata.session_id, 'sess-1');
    });
  });

  describe('Grok wire helpers', () => {
    it('resolveOpenAIAgent labels Grok clients and models', () => {
      assert.equal(openai.resolveOpenAIAgent({ 'x-grok-client-version': '0.2.93' }, {}), 'grok');
      assert.equal(openai.resolveOpenAIAgent({}, { model: 'grok-4.5' }), 'grok');
      assert.equal(openai.resolveOpenAIAgent({}, { model: 'gpt-5.5' }), 'codex');
    });

    it('getOpenAIInstructionsText reads Grok system input', () => {
      const text = openai.getOpenAIInstructionsText({
        model: 'grok-4.5',
        input: [
          { type: 'message', role: 'system', content: 'You are Grok' },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      });
      assert.equal(text, 'You are Grok');
    });

    it('getOpenAIInstructionsText prefers instructions when present', () => {
      const text = openai.getOpenAIInstructionsText({
        instructions: 'Codex instructions',
        input: [{ type: 'message', role: 'system', content: 'ignored' }],
      });
      assert.equal(text, 'Codex instructions');
    });

    it('isNoiseRequest filters Grok control-plane paths', () => {
      const grokHeaders = { 'x-grok-client-identifier': 'grok-shell' };
      assert.equal(openai.isNoiseRequest('/v1/settings', grokHeaders, null), true);
      assert.equal(openai.isNoiseRequest('/v1/feedback/config', grokHeaders, null), true);
      assert.equal(openai.isNoiseRequest('/v1/responses', grokHeaders, null), false);
      assert.equal(openai.isNoiseRequest('/v1/chat/completions', grokHeaders, null), false);
      // Non-Grok clients must not lose conversation paths via this rule
      assert.equal(openai.isNoiseRequest('/v1/settings', {}, null), false);
    });

    it('buildEntryFields labels agent as grok for grok models', () => {
      const fields = openai.buildEntryFields({
        provider: 'openai',
        transport: 'sse',
        parsedBody: {
          model: 'grok-4.5',
          metadata: { client: 'grok', session_id: 's1' },
          input: [{ type: 'message', role: 'user', content: 'pong' }],
          tools: [],
        },
        events: [],
        response: { model: 'grok-4.5', status: 'completed', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
        proxyRes: { statusCode: 200 },
        sessionId: 's1',
      });
      assert.equal(fields.agent, 'grok');
      assert.equal(fields.model, 'grok-4.5');
      assert.equal(fields.maxContext, 500_000);
    });
  });

  describe('low-level exports for ws-proxy compat', () => {
    it('exports all openai-session.js functions', () => {
      assert.equal(typeof openai.getCodexRawSessionId, 'function');
      assert.equal(typeof openai.firstHeader, 'function');
      assert.equal(typeof openai.parseCodexTurnMetadata, 'function');
      assert.equal(typeof openai.getCodexSessionId, 'function');
      assert.equal(typeof openai.getCodexCwd, 'function');
      assert.equal(typeof openai.getCodexWorkspaceCwd, 'function');
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

  describe('isSubagent', () => {
    it('returns true when x-openai-subagent header is truthy', () => {
      assert.equal(openai.isSubagent({}, { 'x-openai-subagent': 'true' }), true);
      assert.equal(openai.isSubagent({}, { 'x-openai-subagent': '1' }), true);
    });

    it('returns false when header is falsy', () => {
      assert.equal(openai.isSubagent({}, { 'x-openai-subagent': '0' }), false);
      assert.equal(openai.isSubagent({}, { 'x-openai-subagent': 'false' }), false);
    });

    it('returns false when no header and no body hint', () => {
      assert.equal(openai.isSubagent({}, {}), false);
    });

    it('detects from body metadata', () => {
      assert.equal(openai.isSubagent({ metadata: { is_subagent: true } }, {}), true);
    });
  });

  describe('rawSessionId', () => {
    it('extracts from session_id header', () => {
      assert.equal(openai.rawSessionId({ 'session_id': 'sess-abc' }, {}), 'sess-abc');
    });

    it('extracts from x-codex-turn-metadata header', () => {
      const headers = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'meta-sess' }) };
      assert.equal(openai.rawSessionId(headers, {}), 'meta-sess');
    });

    it('extracts from body metadata', () => {
      assert.equal(openai.rawSessionId({}, { metadata: { session_id: 'body-sess' } }), 'body-sess');
    });

    it('returns codex-raw fallback when no session info', () => {
      assert.equal(openai.rawSessionId({}, {}), 'codex-raw');
      assert.equal(openai.rawSessionId({}, null), 'codex-raw');
    });
  });

  describe('systemPromptHash', () => {
    it('computes hash from instructions string', () => {
      const body = loadFixture('turn1_req.json');
      const result = openai.systemPromptHash(body);
      assert.equal(result.filePrefix, 'openai_instructions_');
      assert.equal(typeof result.hash, 'string');
      assert.equal(result.hash.length, 12);
      assert.equal(result.content, body.instructions);
    });

    it('returns null hash when no instructions', () => {
      const result = openai.systemPromptHash({ input: [] });
      assert.equal(result.hash, null);
      assert.equal(result.filePrefix, 'openai_instructions_');
      assert.equal(result.content, null);
    });
  });

  describe('toolsHash', () => {
    it('computes 12-char hex hash from tools array', () => {
      const body = loadFixture('turn1_req.json');
      const result = openai.toolsHash(body);
      assert.equal(typeof result.hash, 'string');
      assert.equal(result.hash.length, 12);
      assert.equal(result.filePrefix, 'openai_tools_');
    });

    it('returns null hash when no tools', () => {
      assert.equal(openai.toolsHash({}).hash, null);
      assert.equal(openai.toolsHash({ tools: null }).hash, null);
    });
  });

  describe('getCwd', () => {
    it('extracts cwd from body metadata workspaces', () => {
      const body = loadFixture('turn1_req.json');
      const cwd = openai.getCwd(body, {});
      assert.equal(cwd, '/Users/test/project');
    });

    it('extracts cwd from instructions CWD line', () => {
      const body = { instructions: 'Config\nCWD: /Users/demo/app\nShell: zsh' };
      assert.equal(openai.getCwd(body, {}), '/Users/demo/app');
    });

    it('extracts from x-codex-turn-metadata cwd', () => {
      const headers = { 'x-codex-turn-metadata': JSON.stringify({ cwd: '/from/header' }) };
      assert.equal(openai.getCwd({}, headers), '/from/header');
    });

    it('returns null when no cwd info', () => {
      assert.equal(openai.getCwd({}, {}), null);
    });
  });

  describe('turnStepCount', () => {
    it('counts function_call and function_call_output items in input', () => {
      const body = {
        input: [
          { role: 'user', content: 'hi' },
          { type: 'function_call', name: 'shell', arguments: '{}' },
          { type: 'function_call_output', output: 'done' },
          { role: 'assistant', content: 'ok' },
        ],
      };
      assert.equal(openai.turnStepCount(body), 2);
    });

    it('returns 0 for empty input', () => {
      assert.equal(openai.turnStepCount({}), 0);
      assert.equal(openai.turnStepCount({ input: [] }), 0);
    });

    it('returns 0 when input is not an array', () => {
      assert.equal(openai.turnStepCount({ input: 'hello' }), 0);
    });
  });
});
