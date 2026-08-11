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

test('WebSocket entry expands deployment fields with its receivedAt timestamp', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'ws-proxy.js'), 'utf8');
  const entryImport = source.match(/const \{ ([^}]+) \} = require\('\.\/entry'\);/);
  assert.ok(entryImport, 'entry helper import must remain discoverable');
  assert.ok(entryImport[1].split(',').map(name => name.trim()).includes('deploymentFields'));

  const entryMatch = source.match(/  const entry = \{([\s\S]*?)\n  \};\n  entry\.hasCredential/);
  assert.ok(entryMatch, 'WebSocket entry literal must remain discoverable');
  const entryBody = entryMatch[1];
  const receivedAtMatch = entryBody.match(/receivedAt:\s*([^,\n]+),/);
  const deploymentMatch = entryBody.match(/\.\.\.deploymentFields\(([^)\n]+)\),/);
  assert.ok(receivedAtMatch, 'WebSocket entry must set receivedAt');
  assert.ok(deploymentMatch, 'WebSocket entry must expand deploymentFields');
  assert.ok(
    entryBody.indexOf(deploymentMatch[0]) < entryBody.indexOf("...getParser('openai').buildEntryFields("),
    'deploymentFields must precede parser-built entry fields',
  );
  assert.equal(deploymentMatch[1].trim(), receivedAtMatch[1].trim());
});
