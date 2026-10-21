'use strict';

// #725: Claude Code 2.1.304 removes context_management and resends when a
// gateway rejects it. All request shapes below are synthetic.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../server/store');
const { extractAgentType } = require('../server/system-prompt');
const { isMainTurnByAgentKey } = require('../public/agent-classification');

const sysBlocks = (b2) => [{ text: 'billing' }, { text: 'You are Claude Code, a CLI.' }, { text: b2 }];
const MAIN_B2 = 'You are Claude Code, an interactive coding assistant.';
const SUB_B2 = 'You are an agent for Claude Code, tasked with completing a task.';
const TITLE_B2 = 'Generate a concise title for this session.';
const sid = { metadata: { session_id: 'sess-1' } };
const envMsg = (dir) => ({ role: 'system', content: [{ type: 'text', text: `# Environment\nPrimary working directory: ${dir}` }] });

describe('#725 main-prompt agent key', () => {
  it('synthetic 2.1.304-style main prompt resolves to claude-code and counts as main', () => {
    assert.equal(extractAgentType(sysBlocks(MAIN_B2)).key, 'claude-code');
    assert.equal(isMainTurnByAgentKey({ agentKey: 'claude-code', isSubagent: true }), true);
  });
  it('named claude-code-* subagents stay non-main', () => {
    const k = extractAgentType(sysBlocks('You are the Claude guide agent for docs.')).key;
    assert.equal(k, 'claude-code-guide');
    assert.equal(isMainTurnByAgentKey({ agentKey: k, isSubagent: false }), false);
  });
});

describe('#725 extractCwd without context_management', () => {
  it('reads role:system message when top-level system has no env line', () => {
    const req = { system: sysBlocks(MAIN_B2), messages: [{ role: 'user', content: 'hi' }, envMsg('/proj/a')] };
    assert.equal(store.extractCwd(req), '/proj/a');
  });
  it('reads role:system message when there is no top-level system', () => {
    assert.equal(store.extractCwd({ messages: [envMsg('/proj/b'), { role: 'user', content: 'x' }] }), '/proj/b');
  });
  it('falls back to safeguards live_cwd when there is no top-level system', () => {
    const req = { messages: [{ role: 'user', content: 'hi' }],
      safeguards: [{ classifier_context: { live_cwd: '/proj/c' } }] };
    assert.equal(store.extractCwd(req), '/proj/c');
  });
  it('never trusts user text, string or block array, to name the project', () => {
    const quote = 'Primary working directory: /evil';
    assert.equal(store.extractCwd({ system: sysBlocks(MAIN_B2), messages: [{ role: 'user', content: quote }] }), null);
    assert.equal(store.extractCwd({ system: sysBlocks(MAIN_B2),
      messages: [{ role: 'user', content: [{ type: 'text', text: quote }] }] }), null);
  });
  it('a top-level system without env keeps ignoring safeguards (title-gen carries the parent\'s)', () => {
    const req = { system: sysBlocks(TITLE_B2), messages: [{ role: 'user', content: 'x' }],
      safeguards: [{ classifier_context: { live_cwd: '/parent' } }] };
    assert.equal(store.extractCwd(req), null);
    assert.equal(store.isAnthropicSubagent({ ...sid, ...req }), true);
  });
  it('returns null with no signal at all', () => {
    assert.equal(store.extractCwd({ system: sysBlocks(TITLE_B2), messages: [{ role: 'user', content: 'x' }] }), null);
  });
});

describe('#725 isAnthropicSubagent without context_management', () => {
  it('main turn with env in a system message is not a subagent', () => {
    const req = { ...sid, system: sysBlocks(MAIN_B2), messages: [{ role: 'user', content: 'hi' }, envMsg('/proj/a')] };
    assert.equal(store.isAnthropicSubagent(req), false);
  });
  it('main turn with only safeguards cwd is not a subagent', () => {
    const req = { ...sid, messages: [{ role: 'user', content: 'hi' }],
      safeguards: [{ classifier_context: { live_cwd: '/proj/c' } }] };
    assert.equal(store.isAnthropicSubagent(req), false);
  });
  it('main turn with no cwd anywhere is still main by its agent key', () => {
    const req = { ...sid, system: sysBlocks(MAIN_B2), tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(store.isAnthropicSubagent(req), false);
  });
  it('real subagent is still a subagent', () => {
    const req = { ...sid, system: sysBlocks(SUB_B2), tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'go' }] };
    assert.equal(store.isAnthropicSubagent(req), true);
  });
  it('title-gen side request (no tools, short) is still a subagent', () => {
    const req = { ...sid, system: sysBlocks(TITLE_B2), messages: [{ role: 'user', content: 'name it' }] };
    assert.equal(store.isAnthropicSubagent(req), true);
  });
});

describe('#725 orphan linking is unchanged', () => {
  it('bare kickoff is still a likely subagent; a main turn with a system-message cwd is not', () => {
    assert.equal(store.isLikelySubagent({ messages: [{ role: 'user', content: 'research' }] }), true);
    assert.equal(store.isLikelySubagent({ messages: [envMsg('/proj/a'), { role: 'user', content: 'hi' }] }), false);
  });
});
