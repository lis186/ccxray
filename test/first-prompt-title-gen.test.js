'use strict';

// Claude Code 2.1.302 sends its title-generation request BEFORE the first main
// turn, under the same session_id. firstPrompt must come from the main turn.
// Synthetic request shapes only.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const { extractAgentType } = require('../server/system-prompt');

const SID = 'c0ffee00-2302-4000-8000-000000000001';
const META = { user_id: JSON.stringify({ session_id: SID }) };
const PROMPT = 'fix the flaky export cursor test';

function reset() {
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
  for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
}

function titleGenRequest(prompt) {
  return {
    model: 'claude-haiku-4-5',
    metadata: META,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: synthetic' },
      { type: 'text', text: 'You are Claude Code, a synthetic CLI identity block.' },
      { type: 'text', text: 'You are naming a coding session so the user can find it later. Synthetic instructions.' },
    ],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `<session>\n${prompt}\n</session>\n\nWrite the title in the user's language.` }],
    }],
  };
}

function mainTurnRequest(prompt) {
  return {
    model: 'claude-opus-5',
    metadata: META,
    context_management: { edits: [] },
    tools: [{ name: 'Bash' }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\nSynthetic skills list.\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nSynthetic CLAUDE.md context.\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nSynthetic date reminder.\n</system-reminder>' },
        { type: 'text', text: prompt },
      ],
    }],
  };
}

describe('firstPrompt ignores Claude title-generation requests', () => {
  beforeEach(reset);

  it('fixture: title-gen is a subagent, main turn is not', () => {
    assert.equal(store.isAnthropicSubagent(titleGenRequest(PROMPT)), true);
    assert.equal(extractAgentType(titleGenRequest(PROMPT).system).key, 'naming-a-coding-session-so-the');
    assert.equal(store.isAnthropicSubagent(mainTurnRequest(PROMPT)), false);
  });

  it('title-gen first leaves firstPrompt null', () => {
    const out = store.detectSession(titleGenRequest(PROMPT));
    assert.equal(out.sessionId, SID);
    assert.equal(store.getSessionFirstPrompt(SID), null);
    assert.equal(store.sessionMeta[SID].firstUserMsg, undefined);
  });

  it('title-gen then main turn → firstPrompt is the typed prompt exactly', () => {
    store.detectSession(titleGenRequest(PROMPT));
    store.detectSession(mainTurnRequest(PROMPT));
    assert.equal(store.getSessionFirstPrompt(SID), PROMPT);
    assert.equal(store.sessionMeta[SID].firstUserMsg, PROMPT);
  });

  it('a later title-gen request never overwrites the main-turn prompt', () => {
    store.detectSession(mainTurnRequest(PROMPT));
    store.detectSession(titleGenRequest('something else'));
    assert.equal(store.getSessionFirstPrompt(SID), PROMPT);
  });

  it('Codex/Grok input[] bodies still record (no messages[] gate)', () => {
    const sid = 'grok-0000-1111';
    store.detectSession({
      metadata: { session_id: sid },
      input: [
        { role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
        { role: 'user', content: '<user_query> list the open issues </user_query>' },
      ],
    });
    assert.equal(store.sessionMeta[sid].firstUserMsg, 'list the open issues');
  });
});
