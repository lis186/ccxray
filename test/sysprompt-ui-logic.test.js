'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #170 — extract-and-test pure logic from public/system-prompt-ui.js.
// The file registers a top-level `document.addEventListener('keydown', ...)`
// listener, so it needs a minimal document stub to load at all; the functions
// under test here otherwise don't touch the DOM.
function loadContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  const context = {
    console,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'system-prompt-ui.js'), 'utf8'), context);
  return context;
}

describe('system-prompt-ui: spRelativeTime(dateStr)', () => {
  const ctx = loadContext();
  it('returns "" for a falsy input', () => {
    assert.equal(ctx.spRelativeTime(''), '');
    assert.equal(ctx.spRelativeTime(null), '');
  });
  it('returns the original string when it does not parse as a date', () => {
    assert.equal(ctx.spRelativeTime('not-a-date'), 'not-a-date');
  });
  it('renders "now" for anything under a minute ago', () => {
    assert.equal(ctx.spRelativeTime(new Date(Date.now() - 30 * 1000).toISOString()), 'now');
  });
  it('renders minutes for the sub-hour band', () => {
    assert.equal(ctx.spRelativeTime(new Date(Date.now() - 2 * 60 * 1000).toISOString()), '2m ago');
  });
  it('renders hours for the sub-day band', () => {
    assert.equal(ctx.spRelativeTime(new Date(Date.now() - 3 * 3600 * 1000).toISOString()), '3h ago');
  });
  it('renders days beyond 24h', () => {
    assert.equal(ctx.spRelativeTime(new Date(Date.now() - 2 * 86400 * 1000).toISOString()), '2d ago');
  });
});

describe('system-prompt-ui: buildAgentList(allVersions, apiAgents)', () => {
  const ctx = loadContext();
  it('groups versions by agentKey and counts them', () => {
    const versions = [
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', coreHash: 'a' },
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', coreHash: 'a' },
      { agentKey: 'explorer', agentLabel: 'Explorer', coreHash: 'b' },
    ];
    const agents = ctx.buildAgentList(versions, []);
    const byKey = Object.fromEntries(agents.map(a => [a.key, a]));
    assert.equal(byKey.orchestrator.count, 2);
    assert.equal(byKey.explorer.count, 1);
  });
  it('sorts anthropic agents before openai agents', () => {
    const versions = [
      { agentKey: 'codex-agent', coreHash: 'x', provider: 'openai' },
      { agentKey: 'claude-agent', coreHash: 'y', provider: 'anthropic' },
    ];
    const agents = ctx.buildAgentList(versions, []);
    // Arrays produced inside the vm context aren't reference-equal to Array literals in
    // this realm (different Array.prototype) — compare via JSON like messages-ui.test.js does.
    assert.equal(JSON.stringify(agents.map(a => a.key)), JSON.stringify(['claude-agent', 'codex-agent']));
  });
  it('sorts by version count desc even against alphabetical order', () => {
    const versions = [
      { agentKey: 'apple', coreHash: '1' },
      { agentKey: 'zebra', coreHash: '2' },
      { agentKey: 'zebra', coreHash: '3' },
    ];
    const agents = ctx.buildAgentList(versions, []);
    // zebra has 2 versions vs apple's 1 → zebra sorts first despite losing alphabetically.
    assert.equal(JSON.stringify(agents.map(a => a.key)), JSON.stringify(['zebra', 'apple']));
  });
  it('falls back to alphabetical key order when counts tie', () => {
    const versions = [
      { agentKey: 'zeta', coreHash: '1' },
      { agentKey: 'alpha', coreHash: '2' },
    ];
    const agents = ctx.buildAgentList(versions, []);
    assert.equal(JSON.stringify(agents.map(a => a.key)), JSON.stringify(['alpha', 'zeta']));
  });
  it('adds agents that only appear in apiAgents (no versions yet)', () => {
    const agents = ctx.buildAgentList([], [{ key: 'new-agent', label: 'New Agent', provider: 'anthropic' }]);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].key, 'new-agent');
    assert.equal(agents[0].count, 0);
  });
  it('lets apiAgents override the provider of an agent seen in allVersions', () => {
    const versions = [{ agentKey: 'shared', coreHash: 'a' }]; // no provider → defaults to 'anthropic'
    const agents = ctx.buildAgentList(versions, [{ key: 'shared', provider: 'openai' }]);
    assert.equal(agents[0].provider, 'openai');
  });
});

describe('system-prompt-ui: parseHunks(unifiedDiff)', () => {
  const ctx = loadContext();
  // parseHunks builds its arrays/objects inside the vm context, so they aren't
  // reference-equal to literals in this realm (different Array/Object.prototype) —
  // compare via JSON like messages-ui.test.js does.
  it('returns an empty array when there are no "@@ " headers', () => {
    assert.equal(ctx.parseHunks('').length, 0);
    assert.equal(ctx.parseHunks('just some text\nmore text').length, 0);
  });
  it('splits a single hunk into header + lines', () => {
    const diff = '@@ -1,2 +1,3 @@\n-old\n+new1\n+new2\n context';
    const hunks = ctx.parseHunks(diff);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].header, '@@ -1,2 +1,3 @@');
    assert.equal(JSON.stringify(hunks[0].lines), JSON.stringify(['-old', '+new1', '+new2', ' context']));
  });
  it('splits multiple hunks on successive "@@ " headers', () => {
    const diff = '@@ -1,2 +1,3 @@\n-old\n+new\n@@ -10,1 +11,1 @@\n-x\n+y';
    const hunks = ctx.parseHunks(diff);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].header, '@@ -1,2 +1,3 @@');
    assert.equal(JSON.stringify(hunks[0].lines), JSON.stringify(['-old', '+new']));
    assert.equal(hunks[1].header, '@@ -10,1 +11,1 @@');
    assert.equal(JSON.stringify(hunks[1].lines), JSON.stringify(['-x', '+y']));
  });
  it('captures the trailing hunk even without a following header', () => {
    const diff = '@@ -1,1 +1,1 @@\n-a\n+b';
    const hunks = ctx.parseHunks(diff);
    assert.equal(hunks.length, 1);
    assert.equal(JSON.stringify(hunks[0].lines), JSON.stringify(['-a', '+b']));
  });
});

describe('system-prompt-ui: classifyHunk(hunk)', () => {
  const ctx = loadContext();
  const hunk = (lines) => ({ header: '@@ @@', lines });
  it('classifies 5+ pure additions as NEW SECTION', () => {
    assert.equal(ctx.classifyHunk(hunk(['+a', '+b', '+c', '+d', '+e', '+f'])), 'NEW SECTION');
  });
  it('classifies fewer than 5 pure additions as EXPANSION (fallback branch)', () => {
    assert.equal(ctx.classifyHunk(hunk(['+a', '+b', '+c', '+d'])), 'EXPANSION');
  });
  it('classifies mixed changes with more additions than deletions as EXPANSION', () => {
    assert.equal(ctx.classifyHunk(hunk(['+a', '+b', '+c', '-x'])), 'EXPANSION');
  });
  it('classifies mixed changes with deletions >= additions as REVISION', () => {
    assert.equal(ctx.classifyHunk(hunk(['+a', '-x', '-y', '-z'])), 'REVISION');
    // equal counts also route to REVISION, not MINOR EDIT
    assert.equal(ctx.classifyHunk(hunk(['+a', '-x'])), 'REVISION');
  });
  it('classifies small single-sided changes (<=2 lines) as MINOR EDIT', () => {
    assert.equal(ctx.classifyHunk(hunk(['+a'])), 'MINOR EDIT');
    assert.equal(ctx.classifyHunk(hunk(['-a', '-b'])), 'MINOR EDIT');
    assert.equal(ctx.classifyHunk(hunk([' context only'])), 'MINOR EDIT');
  });
});
