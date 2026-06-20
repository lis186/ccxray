'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Server: summarizeEntry includes toolsHash ──────────────────────────

describe('sysprompt-ux #89', () => {

  describe('summarizeEntry includes toolsHash', () => {
    const { summarizeEntry } = require('../server/sse-broadcast');

    it('passes through toolsHash when present', () => {
      const entry = {
        id: 'th-1', sessionId: 's1', provider: 'anthropic',
        toolsHash: 'abc123def456',
        usage: { input_tokens: 1 }, isSubagent: false,
      };
      const summary = summarizeEntry(entry);
      assert.equal(summary.toolsHash, 'abc123def456');
    });

    it('defaults toolsHash to null when absent', () => {
      const entry = {
        id: 'th-2', sessionId: 's2', provider: 'anthropic',
        usage: { input_tokens: 1 }, isSubagent: false,
      };
      const summary = summarizeEntry(entry);
      assert.equal(summary.toolsHash, null);
    });
  });

  // ── Server: versionIndex includes provider ──────────────────────────

  describe('versionIndex provider field', () => {
    const store = require('../server/store');

    beforeEach(() => {
      store.versionIndex.clear();
    });

    it('anthropic registerPromptVersion sets provider to anthropic', () => {
      const { registerPromptVersion } = require('../server/wire-parsers/anthropic');
      // Build a ctx that passes the filters in registerPromptVersion:
      // needs parsedBody.system with >= 3 blocks, b2 >= 500 chars, cc_version in b0
      const b0 = 'cc_version=2.1.177.test; session_id=test-sess';
      const b1 = 'identity block';
      const b2 = 'A'.repeat(600); // >= 500 chars
      const ctx = {
        parsedBody: { system: [{ text: b0 }, { text: b1 }, { text: b2 }] },
        sysHash: 'fakesyshash1',
      };
      registerPromptVersion(ctx);

      const entries = [...store.versionIndex.values()];
      assert.ok(entries.length > 0, 'should have created a version entry');
      assert.equal(entries[0].provider, 'anthropic');
    });

    it('openai registerPromptVersion sets provider to openai', () => {
      const { registerPromptVersion } = require('../server/wire-parsers/openai');
      const ctx = {
        parsedBody: { instructions: 'You are a helpful assistant. '.repeat(30) },
        sysHash: 'fakesyshash2',
      };
      registerPromptVersion(ctx);

      const entries = [...store.versionIndex.values()];
      assert.ok(entries.length > 0, 'should have created a version entry');
      assert.equal(entries[0].provider, 'openai');
    });
  });

  // ── Server: /_api/sysprompt/versions includes provider + sessionCount ──

  describe('/_api/sysprompt/versions response', () => {
    const store = require('../server/store');

    beforeEach(() => {
      store.versionIndex.clear();
      store.entries.length = 0;
    });

    it('versions include provider and sessionCount', async () => {
      // Seed versionIndex
      store.versionIndex.set('orchestrator::hash1', {
        reqId: null, sharedFile: null, b2Len: 1000, coreLen: 800,
        coreHash: 'hash1', firstSeen: '2026-06-19', agentKey: 'orchestrator',
        agentLabel: 'Orchestrator', version: '2.1.177.test', provider: 'anthropic',
      });

      // Seed entries with matching coreHash
      store.entries.push(
        { id: 'e1', sessionId: 'sess-a', coreHash: 'hash1' },
        { id: 'e2', sessionId: 'sess-a', coreHash: 'hash1' },
        { id: 'e3', sessionId: 'sess-b', coreHash: 'hash1' },
      );

      // Simulate API call
      const { handleApiRoutes } = require('../server/routes/api');
      const result = await new Promise((resolve) => {
        const clientReq = { url: '/_api/sysprompt/versions', method: 'GET' };
        const chunks = [];
        const clientRes = {
          writeHead: () => {},
          end: (data) => { resolve(JSON.parse(data)); },
        };
        handleApiRoutes(clientReq, clientRes);
      });

      assert.ok(result.versions.length > 0);
      const v = result.versions[0];
      assert.equal(v.provider, 'anthropic');
      assert.equal(v.sessionCount, 2, 'should count 2 unique sessions');

      assert.ok(result.agents.length > 0);
      assert.equal(result.agents[0].provider, 'anthropic');
    });
  });

  // ── Server: /_api/tools-diff endpoint ──────────────────────────────

  describe('/_api/tools-diff', () => {
    it('returns 400 when params missing', async () => {
      const { handleApiRoutes } = require('../server/routes/api');
      const result = await new Promise((resolve) => {
        const clientReq = { url: '/_api/tools-diff', method: 'GET' };
        let statusCode;
        const clientRes = {
          writeHead: (code) => { statusCode = code; },
          end: (data) => { resolve({ statusCode, body: JSON.parse(data) }); },
        };
        handleApiRoutes(clientReq, clientRes);
      });
      assert.equal(result.statusCode, 400);
    });
  });

  // ── Server: version_detected SSE event includes provider ─────────

  describe('version_detected SSE event includes provider', () => {
    const store = require('../server/store');

    beforeEach(() => {
      store.versionIndex.clear();
      // Drain any existing SSE clients
      store.sseClients.length = 0;
    });

    it('anthropic version_detected includes provider', () => {
      const { registerPromptVersion } = require('../server/wire-parsers/anthropic');

      let captured = null;
      const fakeRes = {
        write: (chunk) => { captured = chunk; },
      };
      store.sseClients.push(fakeRes);

      const b0 = 'cc_version=2.1.999.sse; session_id=sse-test';
      const b2 = 'B'.repeat(600);
      const ctx = {
        parsedBody: { system: [{ text: b0 }, { text: 'id' }, { text: b2 }] },
        sysHash: 'ssehash1',
      };
      registerPromptVersion(ctx);

      store.sseClients.length = 0;

      assert.ok(captured, 'should have broadcast version_detected');
      const match = captured.match(/^data: (.+)\n\n$/);
      assert.ok(match, 'should be SSE format');
      const data = JSON.parse(match[1]);
      assert.equal(data._type, 'version_detected');
      assert.equal(data.provider, 'anthropic');
    });
  });
});
