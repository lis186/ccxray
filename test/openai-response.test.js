'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getOpenAIInputSummary } = require('../server/openai-response');

describe('getOpenAIInputSummary', () => {
  it('prefers <user_query> over later MCP system-reminder (Grok wire)', () => {
    const input = [
      { type: 'message', role: 'system', content: 'You are Grok.' },
      { type: 'message', role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
      {
        type: 'message',
        role: 'user',
        content: '<user_query> 這個專案是做什麼的？分析一下整體架構 </user_query>',
      },
      {
        type: 'message',
        role: 'user',
        content: '<system-reminder> MCP servers connected: - pointer (1 tool) </system-reminder>',
      },
    ];
    const title = getOpenAIInputSummary(input);
    assert.equal(title, '這個專案是做什麼的？分析一下整體架構');
  });

  it('skips user_info and system-reminder when no user_query', () => {
    const input = [
      { type: 'message', role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
      { type: 'message', role: 'user', content: '<system-reminder> skills list </system-reminder>' },
      { type: 'message', role: 'user', content: 'plain question without tags' },
    ];
    assert.equal(getOpenAIInputSummary(input), 'plain question without tags');
  });

  it('still works for Codex-style content parts', () => {
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'List the files' }],
      },
    ];
    assert.equal(getOpenAIInputSummary(input), 'List the files');
  });
});
