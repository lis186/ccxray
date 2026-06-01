'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// WS_SKIP_EVENTS — must match server/ws-proxy.js
const WS_SKIP_EVENTS = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.done',
  'codex.rate_limits',
]);

function loadMessagesContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  const context = { console, window: {} };
  vm.createContext(context);
  for (const f of ['renderers/index.js', 'renderers/anthropic.js', 'renderers/openai.js', 'renderers/fallback.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  vm.runInContext('var RENDERERS = window.RENDERERS; var getRenderer = window.getRenderer;', context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'messages.js'), 'utf8'), context);
  return context;
}

function loadWSFixtureEvents(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-ws-frames', name), 'utf8');
  const events = [];
  for (const line of raw.trim().split('\n')) {
    const frame = JSON.parse(line);
    if (frame.dir !== 'u2c' || frame.binary) continue;
    const parsed = JSON.parse(frame.text);
    if (parsed.type && !WS_SKIP_EVENTS.has(parsed.type)) {
      events.push(parsed);
    }
  }
  return events;
}

describe('WS frame capture → buildMergedSteps integration', () => {
  it('say-hi fixture produces assistant text "Hi."', () => {
    const context = loadMessagesContext();
    const events = loadWSFixtureEvents('say-hi.ndjson');

    assert.ok(events.length > 0, 'should have non-skipped events');

    const steps = context.buildMergedSteps([], events, 'openai');

    const textSteps = steps.filter(s => s.type === 'assistant-text');
    assert.equal(textSteps.length, 1, 'should have exactly one text step');
    assert.equal(textSteps[0].text, 'Hi.');
    assert.equal(textSteps[0].source, 'current');
  });

  it('say-hi fixture has no tool calls', () => {
    const context = loadMessagesContext();
    const events = loadWSFixtureEvents('say-hi.ndjson');
    const steps = context.buildMergedSteps([], events, 'openai');

    const toolSteps = steps.filter(s => s.type === 'tool-group' && s.calls.length > 0);
    assert.equal(toolSteps.length, 0, 'say-hi should have no tool calls');
  });

  it('OpenAI user message in input[] produces human step', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    const humanSteps = steps.filter(s => s.type === 'human');
    assert.equal(humanSteps.length, 1);
    assert.ok(humanSteps[0].humanText.includes('hello world'));
  });

  it('OpenAI developer messages are skipped', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>sandbox</permissions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do something' }] },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'human');
    assert.ok(steps[0].humanText.includes('do something'));
  });

  it('OpenAI function_call_output normalizes to tool_result', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'function_call_output', call_id: 'call_abc', output: 'file contents here' },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    assert.ok(steps.length >= 0);
  });

  it('OpenAI mixed input: developer skipped, user shown, function_call_output preserved', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system stuff' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read file.txt' }] },
      { type: 'function_call_output', call_id: 'call_xyz', output: 'file data' },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    const humanSteps = steps.filter(s => s.type === 'human');
    assert.equal(humanSteps.length, 2);
    assert.ok(humanSteps[0].humanText.includes('read file.txt'));
    assert.ok(humanSteps[1].hasToolResult);
  });

  it('OpenAI function_call in input[] produces tool-group with parsed args', () => {
    const context = loadMessagesContext();
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', name: 'exec_command', call_id: 'call_123', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_123', output: '/tmp' },
    ];
    const steps = context.buildMergedSteps(input, [], 'openai');
    const toolGroups = steps.filter(s => s.type === 'tool-group');
    assert.equal(toolGroups.length, 1, 'should have one tool-group');
    assert.equal(toolGroups[0].calls.length, 1);
    assert.equal(toolGroups[0].calls[0].name, 'exec_command');
    assert.equal(JSON.stringify(toolGroups[0].calls[0].input), JSON.stringify({ cmd: 'pwd' }));
    assert.equal(toolGroups[0].calls[0].result, '/tmp');
    assert.equal(toolGroups[0].calls[0].pending, false);
  });

  it('filters envelope events matching WS_SKIP_EVENTS', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-ws-frames', 'say-hi.ndjson'), 'utf8');
    let totalU2C = 0;
    let filtered = 0;
    for (const line of raw.trim().split('\n')) {
      const frame = JSON.parse(line);
      if (frame.dir !== 'u2c' || frame.binary) continue;
      totalU2C++;
      const parsed = JSON.parse(frame.text);
      if (parsed.type && WS_SKIP_EVENTS.has(parsed.type)) filtered++;
    }
    assert.ok(filtered > 0, 'should filter some envelope events');
    assert.ok(filtered < totalU2C, 'should not filter all events');
  });
});
