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

test('wire parsers persist context usage provenance, including explicit zero', () => {
  const anthropic = getParser('anthropic');
  const base = {
    provider: 'anthropic', transport: 'sse',
    parsedBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    proxyRes: { statusCode: 200 }, sessionId: 's',
  };
  const explicitZero = anthropic.buildEntryFields({
    ...base, usage: { input_tokens: 0, output_tokens: 0 }, contextUsageKnown: true,
  });
  assert.equal(explicitZero.contextUsageKnown, true);
  assert.equal(JSON.parse(buildIndexLine({ id: 'zero', ...explicitZero })).contextUsageKnown, true);

  const absent = anthropic.buildEntryFields({ ...base, usage: null, contextUsageKnown: false });
  assert.equal(absent.contextUsageKnown, false);
  assert.equal(JSON.parse(buildIndexLine({ id: 'absent', ...absent })).contextUsageKnown, false);

  const openai = getParser('openai');
  const openaiZero = openai.buildEntryFields({
    provider: 'openai', transport: 'http', parsedBody: { model: 'gpt-5.5', input: [] },
    response: { model: 'gpt-5.5', usage: { input_tokens: 0, output_tokens: 0 } },
    proxyRes: { statusCode: 200 }, sessionId: 's',
  });
  assert.equal(openaiZero.contextUsageKnown, true);
  assert.equal(JSON.parse(buildIndexLine({ id: 'openai-zero', ...openaiZero })).contextUsageKnown, true);
});

test('#475 OpenAI parser and index carry call/result facts for read-time pairing (fail-on-old)', () => {
  const parsedBody = {
    model: 'gpt-5.5',
    metadata: { client: 'codex' },
    input: [{
      type: 'custom_tool_call_output',
      call_id: 'call_previous',
      output: JSON.stringify([{ type: 'input_text', text: JSON.stringify({ exit_code: 1 }) }]),
    }],
  };
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'http', parsedBody,
    response: {
      model: 'gpt-5.5', status: 'completed',
      output: [{ type: 'function_call', name: 'exec_command', call_id: 'call_next' }],
    },
    proxyRes: { statusCode: 200 }, sessionId: 's',
  });
  assert.deepEqual(f.turnToolCallIds, { call_next: 'Bash' });
  assert.deepEqual(f.turnToolResults, [{ callId: 'call_previous', eligible: true, toolFail: true }]);
  assert.ok(INDEX_FIELDS.includes('turnToolCallIds'));
  assert.ok(INDEX_FIELDS.includes('turnToolResults'));
  const back = JSON.parse(buildIndexLine({ id: 'X', ts: 't', status: 200, isSSE: false, receivedAt: 1, ...f }));
  assert.deepEqual(back.turnToolCallIds, f.turnToolCallIds);
  assert.deepEqual(back.turnToolResults, f.turnToolResults);
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

test('#339: anthropic beta1m persists to index line only when true (add-only, monotone signal)', () => {
  // The authoritative 1M-window header must survive to disk so restore/cold-load can
  // derive a per-session context% denominator instead of re-inferring from incomplete
  // facts. Fail-on-old: before #339, buildEntryFields consumed ctx.beta1m (fed
  // inferMaxContext) but never returned it, so back.beta1m was undefined here.
  assert.ok(INDEX_FIELDS.includes('beta1m'), 'beta1m is an index field');
  const base = {
    provider: 'anthropic', transport: 'sse',
    parsedBody: { model: 'claude-opus-4-6', system: [{ type: 'text', text: 'x' }], messages: [{ role: 'user', content: 'go' }] },
    proxyRes: { statusCode: 200 }, usage: { input_tokens: 79000, output_tokens: 10 },
    sessionId: 's1', sessionInferred: false, stopReason: 'end_turn',
  };
  const withHeader = getParser('anthropic').buildEntryFields({ ...base, beta1m: true });
  assert.equal(withHeader.beta1m, true, 'beta1m returned on the entry when the header was present');
  const backTrue = JSON.parse(buildIndexLine({ id: 'A', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...withHeader }));
  assert.equal(backTrue.beta1m, true, 'beta1m persisted to the index line');

  // Absent header → no beta1m key on the line (monotone OR-fold treats absent as no signal;
  // avoids a false:… field on every 200K turn).
  const noHeader = getParser('anthropic').buildEntryFields({ ...base, beta1m: false });
  assert.equal(noHeader.beta1m, undefined, 'no beta1m field when header absent/false');
  const backNone = JSON.parse(buildIndexLine({ id: 'B', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...noHeader }));
  assert.ok(!('beta1m' in backNone), 'index line carries no beta1m key when the header was absent');

  // Guard (#211 over-claim): a 1M header riding on a non-1M-capable model must NOT persist —
  // the gate mirrors getMaxContext's `beta1m && SUPPORTS_1M`, so beta1m on the log always
  // means a genuine 1M window, never a stray client flag on a haiku turn.
  const nonCapable = getParser('anthropic').buildEntryFields({
    ...base, beta1m: true,
    parsedBody: { model: 'claude-haiku-4-5', system: [{ type: 'text', text: 'x' }], messages: [{ role: 'user', content: 'go' }] },
  });
  assert.equal(nonCapable.beta1m, undefined, 'beta1m not persisted for a non-1M-capable model even with the header');
});

test('the raw context-* beta persists alongside its interpretation (fail-on-old)', () => {
  // beta1m is what ccxray concluded; ctxBeta is what it observed. Persisting the
  // observation keeps a tier we do not interpret yet legible, and lets a restore
  // re-derive the window without the header being on the wire again. Unlike
  // beta1m it is NOT gated on capability — an observation is not a claim.
  assert.ok(INDEX_FIELDS.includes('ctxBeta'), 'ctxBeta is an index field');
  const base = {
    provider: 'anthropic', transport: 'sse',
    parsedBody: { model: 'claude-haiku-4-5', system: [{ type: 'text', text: 'x' }], messages: [{ role: 'user', content: 'go' }] },
    proxyRes: { statusCode: 200 }, usage: { input_tokens: 10, output_tokens: 10 },
    sessionId: 's1', sessionInferred: false, stopReason: 'end_turn',
  };
  const seen = getParser('anthropic').buildEntryFields({ ...base, beta1m: true, ctxBeta: 'context-1m-2025-08-07' });
  assert.equal(seen.ctxBeta, 'context-1m-2025-08-07', 'observation kept even on a model that cannot serve it');
  assert.equal(seen.beta1m, undefined, 'the conclusion is still gated on capability');
  const line = JSON.parse(buildIndexLine({ id: 'C', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...seen }));
  assert.equal(line.ctxBeta, 'context-1m-2025-08-07', 'ctxBeta persisted to the index line');

  const none = getParser('anthropic').buildEntryFields({ ...base, beta1m: false });
  assert.equal(none.ctxBeta, undefined, 'no ctxBeta field when the header was absent');
  const bare = JSON.parse(buildIndexLine({ id: 'D', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...none }));
  assert.ok(!('ctxBeta' in bare), 'index line carries no ctxBeta key when the header was absent');
});

test('anthropic convId: stable across turns of one conversation, distinct across instances, null for no text', () => {
  const base = { provider: 'anthropic', transport: 'sse', proxyRes: { statusCode: 200 }, usage: { input_tokens: 1, output_tokens: 1 }, sessionId: 's1' };
  const mk = (messages) => getParser('anthropic').buildEntryFields({ ...base, parsedBody: { model: 'claude-sonnet-4-6', messages } });
  const kick = [{ role: 'user', content: [{ type: 'text', text: 'shared reminder' }, { type: 'text', text: 'task A' }] }];
  const turn2 = [...kick, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'go on' }];
  const otherKick = [{ role: 'user', content: [{ type: 'text', text: 'shared reminder' }, { type: 'text', text: 'task B' }] }];
  const a1 = mk(kick), a2 = mk(turn2), b1 = mk(otherKick);
  assert.ok(a1.convId && /^[0-9a-f]{8}$/.test(a1.convId));
  assert.equal(a1.convId, a2.convId, 'same conversation keeps its convId as history grows');
  assert.notEqual(a1.convId, b1.convId, 'different task prompts → different convId');
  // no text in messages[0] → null (never md5(''))
  assert.equal(mk([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }]).convId, null);
  assert.equal(mk([]).convId, null);
  // survives the INDEX_FIELDS projection
  assert.ok(INDEX_FIELDS.includes('convId'));
  const back = JSON.parse(buildIndexLine({ id: 'X', ts: 't', status: 200, isSSE: true, receivedAt: 1, ...a1 }));
  assert.equal(back.convId, a1.convId);
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

test('WS title: Grok fallback uses wireDisplayName', () => {
  const f = getParser('openai').buildEntryFields({
    provider: 'openai', transport: 'websocket',
    parsedBody: { model: 'grok-4.5' },
    responseEvents: [],
    proxyRes: { statusCode: 101 },
    lastModel: 'grok-4.5', lastResponseStatus: 'completed',
    sessionId: 'ws-grok', wsCloseReason: '', wsErrorMessage: null,
  });
  assert.equal(f.title, 'Grok WebSocket session');
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
