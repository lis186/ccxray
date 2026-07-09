'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMessagesContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  const context = { console, window: {} };
  vm.createContext(context);
  // Load renderers first (they register on window.RENDERERS)
  for (const f of ['renderers/index.js', 'renderers/anthropic.js', 'renderers/openai.js', 'renderers/fallback.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  // Promote window globals into context scope (messages.js reads getRenderer as a global)
  vm.runInContext('var RENDERERS = window.RENDERERS; var getRenderer = window.getRenderer;', context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'messages.js'), 'utf8'), context);
  return context;
}

describe('dashboard timeline rendering helpers', () => {
  it('renders OpenAI Responses output text deltas as assistant timeline text', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.output_text.delta', delta: '. What' },
      { type: 'response.output_text.delta', delta: ' next?' },
    ], 'openai');

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'assistant-text');
    assert.equal(steps[0].source, 'current');
    assert.equal(steps[0].text, 'Hi. What next?');
  });

  it('falls back to OpenAI Responses output_text.done when deltas are absent', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.output_text.done', text: 'Done text' },
    ], 'openai');

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'assistant-text');
    assert.equal(steps[0].text, 'Done text');
  });

  it('renders OpenAI Responses reasoning deltas as current thinking', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      { type: 'response.reasoning_text.delta', delta: 'Check repo. ' },
      { type: 'response.reasoning_summary_part.added', part: { text: 'Found renderer path.' } },
      { type: 'response.completed', _ts: 1200 },
    ], 'openai');

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'tool-group');
    assert.equal(steps[0].source, 'current');
    assert.equal(steps[0].thinking, 'Check repo. Found renderer path.');
  });

  it('renders OpenAI Responses function-call events as pending tool calls', () => {
    const context = loadMessagesContext();
    const steps = context.buildMergedSteps([], [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_1', type: 'function_call', name: 'shell' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"command":"' },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: 'npm test"}' },
    ], 'openai');

    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'tool-group');
    assert.equal(steps[0].calls.length, 1);
    assert.equal(steps[0].calls[0].name, 'shell');
    assert.equal(JSON.stringify(steps[0].calls[0].input), JSON.stringify({ command: 'npm test' }));
    assert.equal(steps[0].calls[0].pending, true);
  });

  it('Grok string content + user_query appears as a human timeline step (not dropped)', () => {
    const context = loadMessagesContext();
    // Live Grok shape: plain-string content; user_query then trailing MCP system-reminder
    const input = [
      { type: 'message', role: 'system', content: 'You are Grok.' },
      { type: 'message', role: 'user', content: '<user_info> Workspace Path: /tmp/proj </user_info>' },
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
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '我先從專案根目錄著手。' }],
      },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    const human = steps.filter(s => s.type === 'human');
    assert.ok(human.length >= 1, 'expected at least one human step');
    const queryStep = human.find(s => (s.humanText || '').includes('這個專案是做什麼的'));
    assert.ok(queryStep, 'user_query body must appear in a human step');
    assert.ok(!queryStep.humanText.includes('<user_query>'), 'user_query tags should be unwrapped');
  });

  it('normalizeOpenAIInput preserves plain-string message content', () => {
    const context = loadMessagesContext();
    const msgs = context.normalizeOpenAIInput([
      { type: 'message', role: 'user', content: '<user_query> hello </user_query>' },
    ]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content.length, 1);
    assert.equal(msgs[0].content[0].type, 'text');
    assert.match(msgs[0].content[0].text, /hello/);
  });

  it('getRequestTimelineMessages uses normalized input for Grok (not req.messages)', () => {
    const context = loadMessagesContext();
    const req = {
      model: 'grok-4.5',
      input: [
        { type: 'message', role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
        { type: 'message', role: 'user', content: '<user_query> 這個專案是做什麼的？ </user_query>' },
        { type: 'message', role: 'user', content: '<system-reminder> MCP servers connected </system-reminder>' },
      ],
    };
    const history = context.getRequestTimelineMessages(req);
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 3);
    assert.match(history[1].content[0].text, /這個專案是做什麼的/);
  });

  it('renderStepDetailHtml shows Grok human step (not No message)', () => {
    const context = loadMessagesContext();
    // Minimal stubs used by select/detail path
    context.escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    context.highlightCredentials = (s) => s;
    context.renderSingleMessage = (m) => {
      const t = Array.isArray(m.content)
        ? m.content.map(b => b.text || '').join('')
        : String(m.content || '');
      return '<pre class="msg">' + context.escapeHtml(t) + '</pre>';
    };
    context.selectedMessageIdx = 0;
    context.getSelectedStepSelection = () => ({ stepIdx: 1, sub: null });
    // Build steps like the live turn: user_info (sys), user_query (human), system-reminder (sys)
    const input = [
      { type: 'message', role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
      { type: 'message', role: 'user', content: '<user_query> 這個專案是做什麼的？分析一下整體架構 </user_query>' },
      { type: 'message', role: 'user', content: '<system-reminder> MCP servers connected: - pointer </system-reminder>' },
    ];
    // currentSteps is a top-level `let` in messages.js — a context property
    // won't shadow the lexical binding, so assign inside the vm instead.
    context.__grokSteps = context.buildMergedSteps(input, [], 'openai');
    vm.runInContext('currentSteps = __grokSteps;', context);
    // Step 1 should be the user_query human step after user_info sys-only step
    const humanIdx = context.__grokSteps.findIndex(
      s => s.type === 'human' && (s.humanText || '').includes('這個專案')
    );
    assert.ok(humanIdx >= 0, 'human user_query step exists');
    context.getSelectedStepSelection = () => ({ stepIdx: humanIdx, sub: null });
    const html = context.renderStepDetailHtml({ input, model: 'grok-4.5' }, null);
    assert.ok(!html.includes('No message'), 'detail must not be empty: ' + html.slice(0, 200));
    assert.ok(html.includes('這個專案是做什麼的'), 'detail shows user query body');
  });
});

describe('renderEditedBanner — intercept-edited badge (client render)', () => {
  function ctxWithStubs() {
    const context = loadMessagesContext();
    // escapeHtml lives in miller-columns.js (not loaded here); renderSingleMessage
    // is covered by its own tests. Stub both so this isolates renderEditedBanner's
    // own logic (badge + summary + original toggle).
    context.escapeHtml = (s) => String(s);
    context.renderSingleMessage = (m) => '<m>' + (m && m.content) + '</m>';
    return context;
  }

  it('renders nothing when the request was not edited', () => {
    const ctx = ctxWithStubs();
    assert.equal(ctx.renderEditedBanner({ edited: false }, 0), '');
    assert.equal(ctx.renderEditedBanner(null, 0), '');
    assert.equal(ctx.renderEditedBanner(undefined, 0), '');
  });

  it('renders the EDITED badge and the server-authoritative summary', () => {
    const ctx = ctxWithStubs();
    const html = ctx.renderEditedBanner({ edited: true, editSummary: ['user[2]: "say X" → "say BANANA"'] }, 2);
    assert.ok(html.includes('EDITED'), 'badge must be present');
    assert.ok(html.includes('say X') && html.includes('say BANANA'), 'summary line must be rendered');
    // No original supplied → no collapsible "Original before edit".
    assert.ok(!html.includes('Original before edit'));
  });

  it('shows the original-before-edit toggle only on the message that actually changed', () => {
    const ctx = ctxWithStubs();
    const req = {
      edited: true,
      editSummary: ['user[2]: "say X" → "say BANANA"'],
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'say BANANA' }],
      original: { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'say X' }] },
    };
    // Viewing the changed message (index 2): original toggle present.
    const changed = ctx.renderEditedBanner(req, 2);
    assert.ok(changed.includes('Original before edit'), 'changed message must offer the original');
    assert.ok(changed.includes('say X'), 'original content must render via renderSingleMessage');
    // Viewing an unchanged message (index 0): badge + summary, but NO misleading
    // "original" toggle (the content is identical).
    const unchanged = ctx.renderEditedBanner(req, 0);
    assert.ok(unchanged.includes('EDITED'), 'turn-level badge still shown on unchanged messages');
    assert.ok(!unchanged.includes('Original before edit'), 'unchanged message must not offer an identical original');
  });
});
