'use strict';

// #195 — client-side stream timing derivation (TTFT / streamMs / output tok/s).
//
// Fixtures are SYNTHETIC: the `_ts` values are hand-authored monotonically
// increasing numbers arranged in real SSE event order (message_start →
// content_block_start/delta → message_delta → message_stop). No real log is
// embedded. output_tokens is carried on message_delta.usage exactly as the
// Anthropic wire does.
//
// old-fail/new-pass: on pre-#195 code `computeStreamTiming` does not exist, so
// every `context.computeStreamTiming(...)` call throws → suite FAILS; with the
// derivation present the same assertions PASS.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

// Canonical Anthropic turn: thinking then text, output_tokens on message_delta.
// message_start @1000, first content delta (thinking) @1120, message_stop @2000.
function anthropicTurn() {
  return [
    { type: 'message_start', _ts: 1000, message: { usage: { input_tokens: 1200, output_tokens: 0 } } },
    { type: 'content_block_start', _ts: 1050, index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', _ts: 1120, index: 0, delta: { type: 'thinking_delta', thinking: 'Let me…' } },
    { type: 'content_block_delta', _ts: 1200, index: 0, delta: { type: 'thinking_delta', thinking: ' check.' } },
    { type: 'content_block_stop', _ts: 1300, index: 0 },
    { type: 'content_block_start', _ts: 1350, index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', _ts: 1360, index: 1, delta: { type: 'text_delta', text: 'Hi.' } },
    { type: 'content_block_stop', _ts: 1500, index: 1 },
    { type: 'message_delta', _ts: 1520, delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 250 } },
    { type: 'message_stop', _ts: 2000 },
  ];
}

describe('#195 stream timing — target metrics (Anthropic)', () => {
  it('derives TTFT / streamMs / output tok-per-sec matching hand-computed values', () => {
    const ctx = loadMessagesContext();
    const t = ctx.computeStreamTiming(anthropicTurn(), 'anthropic');
    assert.ok(t, 'expected a timing object');
    // TTFT = first content delta (thinking @1120) − message_start (@1000)
    assert.equal(t.ttftMs, 120);
    // streamMs = message_stop (@2000) − message_start (@1000)
    assert.equal(t.streamMs, 1000);
    // output_tokens (250) read from message_delta.usage
    assert.equal(t.outputTokens, 250);
    // tok/s = 250 ÷ (1000 ms / 1000) = 250.0
    assert.ok(Math.abs(t.outTokPerSec - 250) <= 0.1, `outTokPerSec=${t.outTokPerSec}`);
  });

  it('anchors TTFT on the first text delta when there is no thinking', () => {
    const ctx = loadMessagesContext();
    const res = [
      { type: 'message_start', _ts: 1000 },
      { type: 'content_block_start', _ts: 1040, index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', _ts: 1080, index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_stop', _ts: 1200, index: 0 },
      { type: 'message_delta', _ts: 1210, delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop', _ts: 1500 },
    ];
    const t = ctx.computeStreamTiming(res, 'anthropic');
    assert.equal(t.ttftMs, 80);   // 1080 − 1000
    assert.equal(t.streamMs, 500); // 1500 − 1000
  });

  it('keeps ttftMs ≤ streamMs (temporal monotonicity — first token cannot precede open nor follow close)', () => {
    const ctx = loadMessagesContext();
    const t = ctx.computeStreamTiming(anthropicTurn(), 'anthropic');
    assert.ok(t.ttftMs >= 0, 'ttftMs must be non-negative');
    assert.ok(t.ttftMs <= t.streamMs, `ttftMs (${t.ttftMs}) must be ≤ streamMs (${t.streamMs})`);
  });
});

describe('#195 stream timing — degenerate guards (no NaN/Infinity, structured-empty)', () => {
  it('returns null tok/s when streamMs is 0 (no divide-by-zero)', () => {
    const ctx = loadMessagesContext();
    const res = [
      { type: 'message_start', _ts: 1000 },
      { type: 'content_block_start', _ts: 1000, index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', _ts: 1000, index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'message_delta', _ts: 1000, delta: {}, usage: { output_tokens: 5 } },
      { type: 'message_stop', _ts: 1000 },
    ];
    const t = ctx.computeStreamTiming(res, 'anthropic');
    assert.equal(t.streamMs, 0);
    assert.equal(t.outTokPerSec, null);
    assert.ok(!Number.isNaN(t.outTokPerSec) && t.outTokPerSec !== Infinity);
  });

  it('returns null TTFT when no content delta frame is present', () => {
    const ctx = loadMessagesContext();
    const res = [
      { type: 'message_start', _ts: 1000 },
      { type: 'message_delta', _ts: 1900, delta: {}, usage: { output_tokens: 3 } },
      { type: 'message_stop', _ts: 2000 },
    ];
    const t = ctx.computeStreamTiming(res, 'anthropic');
    assert.equal(t.ttftMs, null);
    assert.equal(t.streamMs, 1000);
  });

  it('returns null streamMs and null tok/s when message_stop is missing', () => {
    const ctx = loadMessagesContext();
    const res = [
      { type: 'message_start', _ts: 1000 },
      { type: 'content_block_start', _ts: 1040, index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', _ts: 1080, index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', _ts: 1200, delta: {}, usage: { output_tokens: 9 } },
    ];
    const t = ctx.computeStreamTiming(res, 'anthropic');
    assert.equal(t.ttftMs, 80);
    assert.equal(t.streamMs, null);
    assert.equal(t.outTokPerSec, null);
  });

  it('returns null for empty / non-array res', () => {
    const ctx = loadMessagesContext();
    assert.equal(ctx.computeStreamTiming([], 'anthropic'), null);
    assert.equal(ctx.computeStreamTiming(null, 'anthropic'), null);
    assert.equal(ctx.computeStreamTiming(undefined, 'anthropic'), null);
  });
});

describe('#195 stream timing — provider-neutral contract', () => {
  it('derives the same metrics from OpenAI/Codex frames once _ts is present (#204 forward-compat)', () => {
    const ctx = loadMessagesContext();
    // Simulates a WS transport that HAS stamped _ts (what #204 will add).
    const res = [
      { type: 'response.created', _ts: 500, response: {} },
      { type: 'response.output_text.delta', _ts: 590, delta: 'Hel' },
      { type: 'response.output_text.delta', _ts: 700, delta: 'lo' },
      { type: 'response.completed', _ts: 1500, response: { usage: { output_tokens: 100 } } },
    ];
    const t = ctx.computeStreamTiming(res, 'openai');
    assert.equal(t.ttftMs, 90);    // 590 − 500
    assert.equal(t.streamMs, 1000); // 1500 − 500
    assert.equal(t.outputTokens, 100);
    assert.ok(Math.abs(t.outTokPerSec - 100) <= 0.1, `outTokPerSec=${t.outTokPerSec}`);
    assert.ok(t.ttftMs <= t.streamMs);
  });

  it('degrades to all-null (no NaN) for Codex WS frames lacking _ts today (#204 scope)', () => {
    const ctx = loadMessagesContext();
    // Current codex WS: events pushed verbatim, no _ts stamped.
    const res = [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.completed', response: { usage: { output_tokens: 40 } } },
    ];
    const t = ctx.computeStreamTiming(res, 'openai');
    assert.equal(t.ttftMs, null);
    assert.equal(t.streamMs, null);
    assert.equal(t.outTokPerSec, null);
    // output_tokens is still recoverable (not _ts-gated), but no rate without timing.
    assert.equal(t.outputTokens, 40);
  });
});
