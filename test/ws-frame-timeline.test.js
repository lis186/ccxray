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
