'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getParser } = require('../server/wire-parsers');
const { buildIndexLine } = require('../server/entry');

// Execute the HTTP handler's actual session-cwd assignment without opening a
// listener or starting the CLI. Keep wire extraction and index encoding real.
const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const start = source.indexOf('    // Extract and store cwd (after linkParentSession');
const end = source.indexOf('    // Detect new cc_version', start);
assert.ok(start >= 0 && end > start);
const assignCwd = new vm.Script(source.slice(start, end));

function indexedCwd(provider, { identity = false, wireCwd = null, hubCwd = '/synthetic/project' } = {}) {
  const clientReq = { ccxrayClientPid: 123, headers: {} };
  if (identity) clientReq.headers['x-ccxray-agent-id'] = 'herdr:test:claude';
  const parsedBody = provider === 'anthropic'
    ? { system: wireCwd ? `Primary working directory: ${wireCwd}` : '', messages: [] }
    : { input: [], ...(wireCwd ? { metadata: { cwd: wireCwd } } : {}) };
  const store = { sessionMeta: {}, cacheConfigDir() {} };
  assignCwd.runInNewContext({
    parsedBody, reqSessionId: 'synthetic-session', provider,
    parser: getParser(provider), clientReq, store,
    hub: { lookupClientCwdForRequest: req => req.ccxrayClientPid === 123 ? hubCwd : null },
    getAgentCwdFallback: () => hubCwd,
  });
  return JSON.parse(buildIndexLine({ cwd: store.sessionMeta['synthetic-session'].cwd || null })).cwd;
}

describe('HTTP session cwd attribution', () => {
  for (const [tool, provider] of [['claude', 'anthropic'], ['codex', 'openai']]) {
    for (const identity of [false, true]) {
      it(`${tool}, identity=${identity}: persists the registered cwd when the wire has none`, () => {
        assert.equal(indexedCwd(provider, { identity }), '/synthetic/project');
      });
    }
    it(`${tool}: prefers the wire cwd over the registered cwd`, () => {
      assert.equal(indexedCwd(provider, { identity: true, wireCwd: '/synthetic/wire' }), '/synthetic/wire');
    });
    it(`${tool}: leaves cwd unknown when neither source supplies one`, () => {
      assert.equal(indexedCwd(provider, { identity: true, hubCwd: null }), null);
    });
  }
});
