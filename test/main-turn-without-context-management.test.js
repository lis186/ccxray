'use strict';

// #725: Claude Code 2.1.304 removes context_management and resends when a
// gateway rejects it. All request shapes and prompt text below are synthetic;
// only the agent-key slug and the structural shape mirror the observed wire.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../server/store');
const { extractAgentType, KNOWN_AGENTS } = require('../server/system-prompt');
const ac = require('../public/agent-classification');

const sysBlocks = (b2) => [{ text: 'billing' }, { text: 'You are Claude Code, a CLI.' }, { text: b2 }];
// Synthetic opening sentence that extractAgentType's regex fallback maps to
// the observed 2.1.304 main slug.
const MAIN_B2 = 'You are an agent working with the user to do things. Synthetic.';
const MAIN_KEY = 'agent-working-with-the-user-to';
const TITLE_B2 = 'You are naming a coding session for later. Synthetic.';
const GP_B2 = 'You are an agent for Claude Code, tasked with a synthetic job.';
const GUIDE_B2 = 'You are the Claude guide agent for synthetic docs.';
const EXPLORE_B2 = 'You are a file search specialist. Synthetic.';
const sid = { metadata: { session_id: 'sess-725' } };
const envMsg = (dir) => ({ role: 'system', content: [{ type: 'text', text: `# Environment\nPrimary working directory: ${dir}` }] });
const sg = (dir) => [{ classifier_context: { live_cwd: dir } }];
const TOOLS = [{ name: 'Bash' }, { name: 'Read' }];
const longMsgs = [
  { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
  { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }, { role: 'user', content: 'e' },
];
// Delta body: top-level system without env, tools, safeguards, and no
// role:'system' message left (it aged out).
const deltaBody = (extra = {}) => ({ ...sid, system: sysBlocks(MAIN_B2), tools: TOOLS,
  messages: longMsgs, safeguards: sg('/proj/delta'), ...extra });
// Title-gen as observed: top-level system, no tools, no safeguards, 1 message.
const titleGen = (extra = {}) => ({ ...sid, system: sysBlocks(TITLE_B2),
  messages: [{ role: 'user', content: 'name it' }], ...extra });

describe('#725 agent keys', () => {
  it('the synthetic main opening resolves to the observed fallback slug', () => {
    assert.equal(extractAgentType(sysBlocks(MAIN_B2)).key, MAIN_KEY);
  });
  it('claude-code is not a main key', () => {
    assert.equal(ac.WF_MAIN_AGENT_KEYS['claude-code'], undefined);
  });
  it('every KNOWN_AGENTS key is either a main key or a known subagent key', () => {
    for (const a of KNOWN_AGENTS) {
      assert.ok(ac.WF_MAIN_AGENT_KEYS[a.key] || ac.KNOWN_SUBAGENT_KEYS[a.key], a.key);
      assert.ok(!(ac.WF_MAIN_AGENT_KEYS[a.key] && ac.KNOWN_SUBAGENT_KEYS[a.key]), a.key);
    }
  });
  it('dashboard: an unfamiliar slug follows the server flag in both directions', () => {
    assert.equal(ac.isMainTurnByAgentKey({ agentKey: MAIN_KEY, isSubagent: false }), true);
    assert.equal(ac.isMainTurnByAgentKey({ agentKey: MAIN_KEY, isSubagent: true }), false);
  });
  it('dashboard: main and named-subagent keys override the flag; unknown/agent follow it', () => {
    assert.equal(ac.isMainTurnByAgentKey({ agentKey: 'orchestrator', isSubagent: true }), true);
    for (const k of ['general-purpose', 'claude-code-guide', 'explore', 'title-generator']) {
      assert.equal(ac.isMainTurnByAgentKey({ agentKey: k, isSubagent: false }), false, k);
    }
    for (const k of ['unknown', 'agent']) {
      assert.equal(ac.isMainTurnByAgentKey({ agentKey: k, isSubagent: false }), true, k);
      assert.equal(ac.isMainTurnByAgentKey({ agentKey: k, isSubagent: true }), false, k);
    }
  });
});

describe('#725 extractCwd', () => {
  it('delta body without context_management reads safeguards live_cwd', () => {
    assert.equal(store.extractCwd(deltaBody()), '/proj/delta');
  });
  it('delta body with context_management reads safeguards live_cwd', () => {
    assert.equal(store.extractCwd(deltaBody({ context_management: { edits: [] } })), '/proj/delta');
  });
  it('reads a role:system env message when the top-level system has none', () => {
    const req = { system: sysBlocks(MAIN_B2), messages: [{ role: 'user', content: 'hi' }, envMsg('/proj/a')] };
    assert.equal(store.extractCwd(req), '/proj/a');
  });
  it('reads a role:system env message at index 0 when there is no top-level system', () => {
    assert.equal(store.extractCwd({ messages: [envMsg('/proj/b'), { role: 'user', content: 'x' }] }), '/proj/b');
  });
  it('never trusts user text, string or block array, to name the project', () => {
    const quote = 'Primary working directory: /evil';
    assert.equal(store.extractCwd({ system: sysBlocks(MAIN_B2), messages: [{ role: 'user', content: quote }] }), null);
    assert.equal(store.extractCwd({ system: sysBlocks(MAIN_B2), tools: TOOLS,
      messages: [{ role: 'user', content: [{ type: 'text', text: quote }] }] }), null);
  });
  it('title-gen as observed (no tools, no safeguards) has no cwd', () => {
    assert.equal(store.extractCwd(titleGen()), null);
  });
  it('a title-gen-shaped side request ignores safeguards if it ever carries them', () => {
    assert.equal(store.extractCwd(titleGen({ safeguards: sg('/parent') })), null);
    const keyed = { ...sid, system: sysBlocks('Generate a concise title. Synthetic.'), tools: TOOLS,
      messages: longMsgs, safeguards: sg('/parent') };
    assert.equal(store.extractCwd(keyed), null);
  });
});

describe('#725 isAnthropicSubagent (server)', () => {
  it('delta body main turn without context_management is main', () => {
    assert.equal(store.isAnthropicSubagent(deltaBody()), false);
  });
  it('main turn with a role:system env message is main', () => {
    const req = { ...sid, system: sysBlocks(MAIN_B2), tools: TOOLS,
      messages: [{ role: 'user', content: 'hi' }, envMsg('/proj/a')] };
    assert.equal(store.isAnthropicSubagent(req), false);
  });
  it('context_management is still main', () => {
    assert.equal(store.isAnthropicSubagent(deltaBody({ context_management: { edits: [] }, safeguards: undefined })), false);
  });
  it('title-gen as observed is a subagent', () => {
    assert.equal(store.isAnthropicSubagent(titleGen()), true);
    assert.equal(store.isAnthropicSubagent(titleGen({ safeguards: sg('/parent') })), true);
  });
  it('named subagents stay subagents even with inherited safeguards or an env line', () => {
    for (const b2 of [GP_B2, GUIDE_B2, EXPLORE_B2]) {
      const withSg = { ...sid, system: sysBlocks(b2), tools: TOOLS, messages: longMsgs, safeguards: sg('/parent') };
      assert.equal(store.isAnthropicSubagent(withSg), true, `${b2} + safeguards`);
      const withEnv = { ...sid, system: sysBlocks(`${b2}\n# Environment\nPrimary working directory: /parent`),
        tools: TOOLS, messages: [{ role: 'user', content: 'go' }] };
      assert.equal(store.isAnthropicSubagent(withEnv), true, `${b2} + env line`);
    }
  });
  it('unfamiliar slug with session_id and no cwd stays a subagent (unchanged)', () => {
    const req = { ...sid, system: sysBlocks(MAIN_B2), tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(store.isAnthropicSubagent(req), true);
  });
  it('unknown/agent keys are unchanged: main with session_id, subagent without', () => {
    const unknown = { system: [{ text: 'only one block' }], messages: [{ role: 'user', content: 'x' }] };
    const agent = { system: sysBlocks('Synthetic text with no role opening.'), messages: [{ role: 'user', content: 'x' }] };
    assert.equal(extractAgentType(unknown.system).key, 'unknown');
    assert.equal(extractAgentType(agent.system).key, 'agent');
    for (const req of [unknown, agent]) {
      assert.equal(store.isAnthropicSubagent({ ...sid, ...req }), false);
      assert.equal(store.isAnthropicSubagent(req), true);
    }
  });
});

describe('#725 orphan inference and parent linking', () => {
  const PARENT = 'parent-725';
  const CHILD = 'child-725';
  beforeEach(() => {
    for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
    store.sessionMeta[PARENT] = { cwd: '/proj/parent', lastSeenAt: Date.now() };
    store.sessionMeta[CHILD] = {};
  });

  it('isLikelySubagent: bare kickoff yes; system-message cwd or tool-bearing delta no', () => {
    assert.equal(store.isLikelySubagent({ messages: [{ role: 'user', content: 'research' }] }), true);
    assert.equal(store.isLikelySubagent({ messages: [envMsg('/proj/a'), { role: 'user', content: 'hi' }] }), false);
    const { metadata, ...noSid } = deltaBody();
    assert.equal(store.isLikelySubagent(noSid), false);
  });
  it('a bare orphan is linked to the active parent', () => {
    assert.equal(store.linkParentSession(CHILD, { messages: [{ role: 'user', content: 'go' }] }, false), PARENT);
  });
  it('an independent main delta body is not linked', () => {
    assert.equal(store.linkParentSession(CHILD, deltaBody(), false), null);
  });
  it('an established session with a cwd is never re-parented without a hint', () => {
    store.sessionMeta[CHILD].cwd = '/proj/child';
    assert.equal(store.linkParentSession(CHILD, { messages: [{ role: 'user', content: 'go' }] }, false), null);
  });
  it('an explicit subagent hint links even a session with a cwd', () => {
    store.sessionMeta[CHILD].cwd = '/proj/child';
    assert.equal(store.linkParentSession(CHILD, deltaBody(), true), PARENT);
  });
});
