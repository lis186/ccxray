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
});

describe('buildMinimapBlocks — current-turn token estimate', () => {
  const curSteps = () => ([
    { type: 'tool-group', source: 'current', thinking: 'x'.repeat(300), calls: [], msgIndices: [] },
    { type: 'assistant-text', source: 'current', text: 'y'.repeat(100), msgIndices: [] },
  ]);

  it('splits real output_tokens across current-turn steps by text length instead of tokens:1', () => {
    const context = loadMessagesContext();
    const blocks = context.buildMinimapBlocks(curSteps(), null, { output_tokens: 1000 });
    assert.equal(blocks.length, 2);
    // 300:100 text-length ratio → 750:250 of 1000 output_tokens.
    assert.equal(blocks[0].tokens, 750);
    assert.equal(blocks[1].tokens, 250);
    // The bug: both were 1 (fabricated fallback). Guard against regression.
    assert.ok(blocks[0].tokens > 1 && blocks[1].tokens > 1);
  });

  it('falls back to tokens:1 only when no output_tokens is available (legacy/no-usage)', () => {
    const context = loadMessagesContext();
    assert.equal(context.buildMinimapBlocks(curSteps(), null, undefined)[0].tokens, 1);
    assert.equal(context.buildMinimapBlocks(curSteps(), null, { output_tokens: 0 })[1].tokens, 1);
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
