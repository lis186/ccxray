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
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'format.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'messages.js'), 'utf8'), context);
  return context;
}

function renderTimeline(context, steps) {
  context.escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  context.selectedTurnIdx = -1;
  context.allEntries = [];
  return context.renderStepListHtml(steps, null, null);
}

describe('dashboard timeline rendering helpers', () => {
  it('renders a Codex custom_tool_call + output as a named tool DOM row', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'show cwd' }] },
      { type: 'custom_tool_call', name: 'shell', call_id: 'call_custom', input: '{"command":"pwd"}' },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: '/tmp/project' },
    ];

    const steps = context.buildMergedSteps(input, [], 'openai');
    const html = renderTimeline(context, steps);

    assert.match(html, /<div class="tl-step-summary[^>]*data-tool="shell"/,
      'timeline must contain a tool-call DOM node');
    assert.match(html, />shell<\/span>/, 'tool name must be visible');
    assert.doesNotMatch(html, /data-unknown-tool-type/,
      'documented Codex custom tool types must not be marked unknown');
  });

  it('marks only fictional tool types unknown when compared with documented Codex types', () => {
    const context = loadMessagesContext();
    const customSteps = context.buildMergedSteps([
      { type: 'custom_tool_call', name: 'shell', call_id: 'call_custom', input: '{"command":"pwd"}' },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: '/tmp/project' },
    ], [], 'openai');
    const futureSteps = context.buildMergedSteps([
      { type: 'future_tool_call_output', call_id: 'call_future', name: 'future_shell', output: 'future result' },
    ], [], 'openai');

    const customHtml = renderTimeline(context, customSteps);
    const futureHtml = renderTimeline(context, futureSteps);

    assert.match(customHtml, /data-tool="shell"/, 'documented custom tool block must render');
    assert.doesNotMatch(customHtml, /data-unknown-tool-type/,
      'documented custom tool types must not be marked unknown');
    assert.match(futureHtml, /data-tool="future_shell"/, 'fictional tool block must render');
    assert.match(futureHtml, /data-unknown-tool-type="future_tool_call_output"/,
      'fictional tool types must remain marked unknown');
  });

  it('normalizes all three OpenAI request items without collapsing custom tool items', () => {
    const context = loadMessagesContext();
    const normalized = context.normalizeOpenAIInput([
      { type: 'message', role: 'user', content: 'run it' },
      { type: 'custom_tool_call', name: 'shell', call_id: 'call_custom', input: '{"command":"pwd"}' },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: '/tmp/project' },
    ]);

    assert.equal(normalized.length, 3, '3 request items must normalize to 3 timeline messages');
  });

  it('renders a fictional future_tool_call_output with raw data and an unknown-type badge', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'future_tool_call_output', call_id: 'call_future', name: 'future_shell', output: 'future result' },
    ];

    const steps = context.buildMergedSteps(input, [], 'openai');
    const html = renderTimeline(context, steps);
    const toolGroups = steps.filter(step => step.type === 'tool-group');

    assert.equal(toolGroups.length, 1, 'unknown output must become a generic tool block');
    assert.match(html, /data-tool="future_shell"/, 'generic tool DOM node must exist');
    assert.match(html, /data-unknown-tool-type="future_tool_call_output"/);
    assert.match(html, /未知 type: future_tool_call_output/);
    assert.deepEqual(JSON.parse(JSON.stringify(toolGroups[0].calls[0].rawItems)), input);

    context.renderToolDetail = (call) => '<div class="tool-detail">' + context.escapeHtml(call.name) + '</div>';
    context.selectedMessageIdx = 0;
    context.getSelectedStepSelection = () => ({ stepIdx: 0, sub: 0 });
    context.__futureSteps = steps;
    vm.runInContext('currentSteps = __futureSteps;', context);
    const detailHtml = context.renderStepDetailHtml({ input }, null);
    assert.match(detailHtml, /data-unknown-tool-raw="1"/, 'generic detail must render a raw-data block');
    assert.match(detailHtml, /future_tool_call_output/);
    assert.match(detailHtml, /future result/);
  });

  it('pairs computer_call with its output in one unknown tool block', () => {
    const context = loadMessagesContext();
    const input = [
      {
        type: 'computer_call',
        call_id: 'call_computer',
        action: { type: 'click', x: 120, y: 80 },
        input: { action: { type: 'click', x: 120, y: 80 } },
      },
      { type: 'computer_call_output', call_id: 'call_computer', output: 'screenshot-1' },
    ];

    const steps = context.buildMergedSteps(input, [], 'openai');
    const toolGroups = steps.filter(step => step.type === 'tool-group');
    const html = renderTimeline(context, steps);

    assert.equal(toolGroups.length, 1, 'call and output must share one tool block');
    assert.equal(toolGroups[0].calls.length, 1);
    assert.equal(toolGroups[0].calls[0].toolUseId, 'call_computer');
    assert.equal(toolGroups[0].calls[0].pending, false, 'matched output must resolve the call');
    assert.equal(toolGroups[0].calls[0].result, 'screenshot-1');
    assert.deepEqual(JSON.parse(JSON.stringify(toolGroups[0].calls[0].input)), {
      action: { type: 'click', x: 120, y: 80 },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(toolGroups[0].calls[0].rawItems.map(item => item.type))), [
      'computer_call',
      'computer_call_output',
    ]);
    assert.match(html, /data-unknown-tool-type="computer_call"/);
  });

  it('pairs local_shell_call with its output in one unknown tool block', () => {
    const context = loadMessagesContext();
    const input = [
      {
        type: 'local_shell_call',
        call_id: 'call_shell',
        input: { command: 'pwd' },
      },
      { type: 'local_shell_call_output', call_id: 'call_shell', output: '/tmp/project' },
    ];

    const steps = context.buildMergedSteps(input, [], 'openai');
    const toolGroups = steps.filter(step => step.type === 'tool-group');
    const call = toolGroups[0]?.calls[0];
    const html = renderTimeline(context, steps);

    assert.equal(toolGroups.length, 1, 'call and output must share one tool block');
    assert.equal(toolGroups[0].calls.length, 1);
    assert.equal(call.toolUseId, 'call_shell');
    assert.equal(call.pending, false, 'matched output must resolve the call');
    assert.equal(call.result, '/tmp/project');
    assert.deepEqual(JSON.parse(JSON.stringify(call.input)), { command: 'pwd' });
    assert.deepEqual(JSON.parse(JSON.stringify(call.rawItems.map(item => item.type))), [
      'local_shell_call',
      'local_shell_call_output',
    ]);
    assert.match(html, /data-unknown-tool-type="local_shell_call"/);
  });

  it('does not classify non-call Responses items as tools', () => {
    const context = loadMessagesContext();

    for (const type of ['message', 'reasoning', 'mcp_list_tools']) {
      assert.equal(context.getOpenAIToolItemKind(type), null, type + ' must not be classified as a tool');
    }
  });

  it('keeps Anthropic tool_use and Grok function_call timeline items unchanged', () => {
    const context = loadMessagesContext();
    const anthropic = context.buildMergedSteps([], [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
    ], 'anthropic');
    const grok = context.buildMergedSteps([
      { type: 'message', role: 'user', content: 'show cwd' },
      { type: 'function_call', name: 'shell', call_id: 'call_grok', arguments: '{"command":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_grok', output: '/tmp/project' },
    ], [], 'openai');

    assert.deepEqual(JSON.parse(JSON.stringify(anthropic[0].calls[0])), {
      name: 'Bash', preview: 'pwd', input: { command: 'pwd' }, result: null,
      isError: false, errorSummary: '', toolUseId: 'tu_1', pending: true,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(grok[1].calls[0])), {
      name: 'shell', preview: 'pwd', input: { command: 'pwd' }, result: '/tmp/project',
      isError: false, errorSummary: '', toolUseId: 'call_grok', pending: false,
    });
    assert.doesNotMatch(renderTimeline(context, anthropic), /data-unknown-tool-type/);
    assert.doesNotMatch(renderTimeline(context, grok), /data-unknown-tool-type/);
  });

  it('assembles custom_tool_call input delta/done events into the rendered tool input', () => {
    const context = loadMessagesContext();
    const wsEvents = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'call_stream', call_id: 'call_stream', type: 'custom_tool_call', name: 'shell' },
      },
      { type: 'response.custom_tool_call_input.delta', item_id: 'call_stream', delta: '{"command":"' },
      { type: 'response.custom_tool_call_input.delta', item_id: 'call_stream', delta: 'npm test"}' },
      { type: 'response.custom_tool_call_input.done', item_id: 'call_stream', input: '{"command":"ignored duplicate"}' },
    ];
    const steps = context.buildMergedSteps([], wsEvents, 'openai');
    const sseSteps = context.buildMergedSteps([], wsEvents.map(event => ({ type: event.type, data: event })), 'openai');

    assert.equal(steps[0].calls[0].name, 'shell');
    assert.deepEqual(JSON.parse(JSON.stringify(steps[0].calls[0].input)), { command: 'npm test' });
    assert.deepEqual(JSON.parse(JSON.stringify(sseSteps)), JSON.parse(JSON.stringify(steps)),
      'flat WebSocket and data-wrapped HTTP SSE events must render identically');
    assert.match(renderTimeline(context, steps), /data-tool="shell"/);

    const freeform = context.buildMergedSteps([], [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'call_raw', type: 'custom_tool_call', name: 'shell' } },
      { type: 'response.custom_tool_call_input.delta', item_id: 'call_raw', delta: 'echo not-json' },
    ], 'openai');
    assert.deepEqual(JSON.parse(JSON.stringify(freeform[0].calls[0].input)), { input: 'echo not-json' },
      'freeform custom-tool input must remain visible when it is not JSON');
  });

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

  it('includes output_tokens in occupancy total (#253 ctxUsed = in+out)', () => {
    const context = loadMessagesContext();
    const html = context.renderMinimapHtml(curSteps(), null, -1, 1000000, { input_tokens: 500, output_tokens: 1000 });
    const m = html.match(/data-total-tokens="(\d+)"/);
    assert.ok(m, 'data-total-tokens attribute should exist');
    assert.equal(Number(m[1]), 1500);
  });

  it('carries imported-window provenance into the classic minimap label', () => {
    const context = loadMessagesContext();
    const html = context.renderMinimapHtml(curSteps(), null, -1, 1000000,
      { input_tokens: 170000, output_tokens: 0 }, '?');
    assert.match(html, /minimap-usage">17% · 1M\?<\/div>/,
      'an imported-only 1M denominator must retain the same ? marker as its session card');
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
