'use strict';

// #169: regression guard — three independent B2_MARKER_DEFS copies must stay
// key+regex-identical. Array order is irrelevant (splitB2IntoBlocks sorts by
// text index), so we normalize to sorted "key pattern.source" strings before
// comparing. A future one-sided marker change will fail this test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXPECTED_KEYS = new Set([
  'autoMemory', 'customSkills', 'customAgents',
  'mcpServersList', 'pluginSkills', 'settingsJson', 'envAndGit',
]);

function normalize(defs) {
  return defs
    .map(d => d.key + ' ' + d.pattern.source)
    .sort()
    .join('\n');
}

// ── Load client (miller-columns.js) in a VM, same pattern as ctx-color.test.js ──
function loadClient() {
  const publicDir = path.join(__dirname, '..', 'public');
  const el = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, insertBefore() {},
    querySelector: () => el(), querySelectorAll: () => [], remove() {},
  });
  const context = {
    console, window: {},
    document: {
      getElementById: () => el(), createElement: () => el(),
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(),
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' },
    history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`
    function updateSysPromptBadge() {} function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; } function setInterval() { return 0; }
    function clearInterval() {} window.ccxraySettings = { visibleProviders: [] };
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  return context;
}

describe('#169 B2_MARKER_DEFS consistency across all three copies', () => {
  const helpers = require('../server/helpers');
  const sysprompt = require('../server/system-prompt');
  const clientCtx = loadClient();

  const serverHelpersDefs  = helpers.B2_MARKER_DEFS;
  const serverSyspromptDefs = sysprompt.B2_MARKER_DEFS;
  const clientDefs          = clientCtx.B2_MARKER_DEFS;

  it('server/helpers.js exports B2_MARKER_DEFS', () => {
    assert.ok(Array.isArray(serverHelpersDefs), 'should be an array');
  });

  it('server/system-prompt.js exports B2_MARKER_DEFS', () => {
    assert.ok(Array.isArray(serverSyspromptDefs), 'should be an array');
  });

  it('public/miller-columns.js exposes B2_MARKER_DEFS as VM global', () => {
    assert.ok(Array.isArray(clientDefs), 'should be an array');
  });

  it('all three copies have exactly 7 entries', () => {
    assert.equal(serverHelpersDefs.length,  7, 'server/helpers.js');
    assert.equal(serverSyspromptDefs.length, 7, 'server/system-prompt.js');
    assert.equal(clientDefs.length,          7, 'public/miller-columns.js');
  });

  it('all three copies contain the 7 expected keys', () => {
    for (const defs of [serverHelpersDefs, serverSyspromptDefs, clientDefs]) {
      const keys = new Set(defs.map(d => d.key));
      for (const k of EXPECTED_KEYS) assert.ok(keys.has(k), `missing key: ${k}`);
      assert.equal(keys.size, 7);
    }
  });

  it('server/helpers.js and server/system-prompt.js are key+regex identical', () => {
    assert.equal(normalize(serverHelpersDefs), normalize(serverSyspromptDefs));
  });

  it('server/helpers.js and public/miller-columns.js are key+regex identical', () => {
    assert.equal(normalize(serverHelpersDefs), normalize(clientDefs));
  });

  it('server/system-prompt.js and public/miller-columns.js are key+regex identical', () => {
    assert.equal(normalize(serverSyspromptDefs), normalize(clientDefs));
  });
});
