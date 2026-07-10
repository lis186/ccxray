'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Render-level regression for the resume copy button: the client is a pure
// view of the server-computed sess.resumeCommand — no button when null.
function loadMillerColumnsContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  function el() {
    return {
      style: {}, dataset: {}, innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, insertBefore() {},
      querySelector: () => el(), querySelectorAll: () => [],
    };
  }
  const context = {
    console, window: {},
    document: {
      getElementById: () => el(), createElement: () => el(),
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(),
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: {},
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  for (const f of ['format.js', 'session-label.js', 'miller-columns.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  return context;
}

function makeSession(overrides) {
  return {
    id: 'sid', agent: 'claude', provider: 'anthropic', resumeCommand: null,
    count: 1, mainCount: 1, subCount: 0, totalCost: 0, model: 'gpt-5',
    firstTs: '10:00:00', firstId: '2026-06-08T10-00-00-000', lastId: '2026-06-08T10-00-00-000',
    latestCacheHitRatio: 0, latestCacheReadTokens: 0,
    ...overrides,
  };
}

describe('renderSessionItem – resume copy button', () => {
  it('omits the button for a codex session without a server-computed command', () => {
    const ctx = loadMillerColumnsContext();
    const sess = makeSession({ id: 'codex-502-sid', agent: 'codex', provider: 'openai', resumeCommand: null });
    const html = ctx.renderSessionItem(sess, 'codex-502-sid');
    assert.equal(html.includes('launch-btn'), false);
    assert.equal(html.includes('copySessionContinue'), false);
  });

  it('renders the button with the exact server-computed command', () => {
    const ctx = loadMillerColumnsContext();
    const sess = makeSession({ id: 'codex-ok-sid', agent: 'codex', provider: 'openai', resumeCommand: 'codex resume codex-ok-sid' });
    const html = ctx.renderSessionItem(sess, 'codex-ok-sid');
    assert.equal(html.includes('launch-btn'), true);
    assert.equal(html.includes('codex resume codex-ok-sid'), true);
  });

  it('renders a claude resume button from the server-computed command', () => {
    const ctx = loadMillerColumnsContext();
    const sess = makeSession({ id: 'claude-sid', resumeCommand: 'claude --resume claude-sid' });
    const html = ctx.renderSessionItem(sess, 'claude-sid');
    assert.equal(html.includes('claude --resume claude-sid'), true);
  });
});
