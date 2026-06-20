'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getParser } = require('../server/wire-parsers');
const { INDEX_FIELDS, buildIndexLine } = require('../server/entry');

function loadFixture(...segments) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wire-parsers', ...segments), 'utf8'));
}

test('openai.buildEntryFields yields canonical fields incl. non-null maxContext/cost/stopReason', () => {
  const events = loadFixture('openai', 'sse-events.json');
  const ctx = {
    provider: 'openai',
    transport: 'sse',
    parsedBody: { model: 'gpt-5.5', input: [{ role: 'user', content: 'hello' }], tools: [{ name: 'shell' }] },
    events,
    proxyRes: { statusCode: 200 },
    sessionId: 's1',
    sessionInferred: false,
    isSubagent: false,
    sysHash: 'sh', toolsHash: 'th', coreHash: 'ch',
    cwd: '/project',
  };
  const f = getParser('openai').buildEntryFields(ctx);
  assert.equal(f.provider, 'openai');
  assert.equal(f.agent, 'codex');
  assert.ok(f.maxContext > 0, 'maxContext must be non-null');
  assert.ok(f.cost !== null && f.cost !== undefined, 'cost must be computed');
  assert.equal(typeof f.stopReason, 'string');
  assert.ok('responseMetadata' in f);
  assert.equal(f.model, 'gpt-5.5');
  assert.equal(f.msgCount, 1);
  assert.equal(f.toolCount, 1);
  assert.equal(f.sessionId, 's1');
  assert.equal(f.sysHash, 'sh');
  assert.equal(f.cwd, '/project');
});

test('openai entry → buildIndexLine → parsed-back keeps cost/maxContext/stopReason/responseMetadata', () => {
  const events = loadFixture('openai', 'sse-events.json');
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'sse',
    parsedBody: { model: 'gpt-5.5', input: [{}], tools: [] },
    events, proxyRes: { statusCode: 200 }, sessionId: 's',
  });
  const entry = { id: 'X', ts: 't', elapsed: '1.0', status: 200, isSSE: true, receivedAt: 1, ...f };
  const back = JSON.parse(buildIndexLine(entry));
  assert.equal(back.maxContext, f.maxContext);
  assert.deepStrictEqual(back.cost, f.cost);
  assert.equal(back.stopReason, f.stopReason);
  assert.ok('responseMetadata' in back);
});

test('anthropic.buildEntryFields yields canonical fields', () => {
  const parsedBody = loadFixture('anthropic', 'turn1_req.json');
  const usage = { input_tokens: 500, output_tokens: 100, total_tokens: 600 };
  const f = getParser('anthropic').buildEntryFields({
    provider: 'anthropic', transport: 'sse', parsedBody,
    proxyRes: { statusCode: 200 }, usage,
    sessionId: 'abc123', sessionInferred: false,
    sysHash: 'sh', toolsHash: 'th', coreHash: 'ch',
    cwd: '/proj', stopReason: 'end_turn', startTime: Date.now(),
    title: 'Test turn', thinkingDuration: 1.5, thinkingStripped: false,
    isSubagent: false, toolFail: false,
  });
  assert.equal(f.provider, 'anthropic');
  assert.equal(f.agent, 'claude');
  assert.equal(f.model, 'claude-sonnet-4-20250514');
  assert.equal(f.msgCount, 3);
  assert.equal(f.toolCount, 2);
  assert.equal(f.sysHash, 'sh');
  assert.equal(f.coreHash, 'ch');
  assert.equal(f.stopReason, 'end_turn');
  assert.equal(f.thinkingDuration, 1.5);
  assert.equal(f.thinkingStripped, false);
  assert.ok(f.cost !== null, 'cost computed');
  assert.ok(f.maxContext > 0, 'maxContext inferred');
});

test('anthropic Skill message → buildEntryFields → buildIndexLine persists clean toolCalls + skillCalls', () => {
  // full write-path guard: a Skill tool_use must surface as a plain Skill key in
  // toolCalls AND as a per-name entry in the persisted skillCalls index field.
  const parsedBody = {
    model: 'claude-opus-4-6',
    system: [{ type: 'text', text: 'cc_version=1.0.0; x' }],
    tools: [{ name: 'Skill' }, { name: 'Bash' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', name: 'Skill', input: { skill: 'code-review' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ]},
    ],
  };
  const f = getParser('anthropic').buildEntryFields({
    provider: 'anthropic', transport: 'sse', parsedBody,
    proxyRes: { statusCode: 200 }, usage: { input_tokens: 10, output_tokens: 5 },
    sessionId: 's1', sessionInferred: false, stopReason: 'end_turn',
  });
  assert.deepEqual(f.toolCalls, { Skill: 1, Bash: 1 });
  assert.deepEqual(f.skillCalls, { 'code-review': 1 });
  // survives the INDEX_FIELDS projection onto an index line
  assert.ok(INDEX_FIELDS.includes('skillCalls'));
  const back = JSON.parse(buildIndexLine({ id: 'X', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...f }));
  assert.deepEqual(back.toolCalls, { Skill: 1, Bash: 1 });
  assert.deepEqual(back.skillCalls, { 'code-review': 1 });
});

test('T9: anthropic.registerPromptVersion returns coreHash', () => {
  const longB2 = 'You are Claude Code, Anthropic\'s official CLI for Claude. ' + 'x'.repeat(600);
  const parsedBody = {
    model: 'claude-sonnet-4-20250514',
    system: [
      { type: 'text', text: 'System config cc_version=1.0.30; block' },
      { type: 'text', text: 'Block 1 instructions' },
      { type: 'text', text: longB2, cache_control: { type: 'ephemeral' } },
    ],
    messages: [],
  };
  const out = getParser('anthropic').registerPromptVersion({ parsedBody });
  assert.ok(out && typeof out.coreHash === 'string' && out.coreHash.length > 0);
});

test('T9: openai.registerPromptVersion returns coreHash', () => {
  const out = getParser('openai').registerPromptVersion({
    parsedBody: { instructions: 'You are a helpful coding assistant.', model: 'gpt-5.5' },
  });
  assert.ok(out && typeof out.coreHash === 'string' && out.coreHash.length > 0);
});

// ── B1: WS stopReason from terminal response status ──

test('WS stopReason: completed terminal status', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'completed',
    sessionId: 'ws1', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, 'completed');
});

test('WS stopReason: incomplete terminal status', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'incomplete',
    sessionId: 'ws2', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, 'incomplete');
});

test('WS stopReason: failed terminal status', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'failed',
    sessionId: 'ws3', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, 'failed');
});

test('WS stopReason: cancelled terminal status', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'cancelled',
    sessionId: 'ws4', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, 'cancelled');
});

test('WS stopReason: no terminal status falls back to wsCloseReason', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: null,
    sessionId: 'ws5', wsCloseReason: 'idle timeout', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, 'idle timeout');
});

test('WS stopReason: no terminal status, no close reason → null', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {}, responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: null,
    sessionId: 'ws6', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.stopReason, null);
});

// ── B2: WS title from input summary ──

test('WS title: extracts user input text', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: { input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'say hello world' }] },
    ] },
    responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'completed',
    sessionId: 'ws7', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.title, 'say hello world');
});

test('WS title: fallback when no input', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: {},
    responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'gpt-5.5', lastResponseStatus: 'completed',
    sessionId: 'ws8', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.title, 'Codex WebSocket session');
});

test('anthropic: goal verifier (session_id, no cwd) is NOT marked subagent', () => {
  const parsedBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Is the task complete?' }],
    metadata: { session_id: 'abc-123' },
  };
  const f = getParser('anthropic').buildEntryFields({
    provider: 'anthropic', transport: 'sse', parsedBody,
    proxyRes: { statusCode: 200 },
    usage: { input_tokens: 50, output_tokens: 10 },
    sessionId: 'abc-123', sessionInferred: false,
    stopReason: 'end_turn', startTime: Date.now(),
  });
  assert.equal(f.isSubagent, false, 'verifier with session_id should not be subagent');
  assert.equal(f.model, 'claude-haiku-4-5-20251001');
});

test('anthropic: bare request (no session_id, no cwd) IS marked subagent', () => {
  const parsedBody = {
    model: 'claude-opus-4-6',
    max_tokens: 8096,
    messages: [{ role: 'user', content: 'Do a task' }],
  };
  const f = getParser('anthropic').buildEntryFields({
    provider: 'anthropic', transport: 'sse', parsedBody,
    proxyRes: { statusCode: 200 },
    usage: { input_tokens: 50, output_tokens: 10 },
    sessionId: 's-inferred', sessionInferred: true,
    stopReason: 'end_turn', startTime: Date.now(),
  });
  assert.equal(f.isSubagent, true, 'bare request without session_id or cwd should be subagent');
});

test('anthropic entry → buildIndexLine round-trip preserves key fields', () => {
  const parsedBody = loadFixture('anthropic', 'turn1_req.json');
  const usage = { input_tokens: 500, output_tokens: 100, total_tokens: 600 };
  const f = getParser('anthropic').buildEntryFields({
    provider: 'anthropic', transport: 'sse', parsedBody,
    proxyRes: { statusCode: 200 }, usage,
    sessionId: 's', stopReason: 'end_turn', startTime: 1,
    title: 'T', thinkingDuration: null, thinkingStripped: true,
  });
  const entry = { id: 'A', ts: 't', elapsed: '2.0', status: 200, isSSE: true, receivedAt: 1, ...f };
  const back = JSON.parse(buildIndexLine(entry));
  assert.equal(back.provider, 'anthropic');
  assert.equal(back.stopReason, 'end_turn');
  assert.equal(back.thinkingStripped, true);
  assert.equal(back.coreHash, f.coreHash);
});
