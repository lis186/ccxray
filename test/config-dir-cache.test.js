'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storeModule = require('../server/store');

function loadSessionMetaCaller() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');
  const match = source.match(/    if \(parsedBody && reqSessionId\) \{([\s\S]*?)\n    \}\n\n    \/\/ Detect new cc_version/);
  assert.ok(match, 'session metadata caller block must remain discoverable');
  return `if (parsedBody && reqSessionId) {${match[1]}\n}`;
}

test('same-session later turns retain configDir through the real index.js caller block', () => {
  const caller = loadSessionMetaCaller();
  const sessionMeta = {};
  const store = { sessionMeta, extractConfigDir: storeModule.extractConfigDir };
  const common = {
    provider: 'anthropic',
    reqSessionId: '504-config-dir-session',
    clientReq: { headers: {} },
    parser: { getCwd: () => null },
    getAgentCwdFallback: () => null,
    store,
  };

  vm.runInNewContext(caller, {
    ...common,
    parsedBody: {
      system: [{ text: "Contents of /Users/test/.claude-work/CLAUDE.md (user's private global instructions for all projects):" }],
    },
  });
  vm.runInNewContext(caller, { ...common, parsedBody: { messages: [] } });

  assert.equal(sessionMeta['504-config-dir-session'].configDir, '/Users/test/.claude-work');

  vm.runInNewContext(caller, {
    ...common,
    provider: 'openai',
    reqSessionId: 'openai-session',
    parsedBody: {
      system: [{ text: "Contents of /Users/test/.claude-openai/CLAUDE.md (user's private global instructions for all projects):" }],
    },
  });
  assert.ok(!('configDir' in sessionMeta['openai-session']));
});
