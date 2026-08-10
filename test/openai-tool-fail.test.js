'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getParser } = require('../server/wire-parsers');
const { extractOpenAITurnToolFail, extractOpenAITurnToolResults } = require('../server/helpers');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'wire-parsers', 'openai', name),
    'utf8',
  ));
}

function buildFixtureEntry(name) {
  const parsedBody = loadFixture(name);
  return getParser('openai').buildEntryFields({
    provider: 'openai',
    transport: 'http',
    parsedBody,
    response: { model: parsedBody.model, status: 'completed', output: [] },
    proxyRes: { statusCode: 200 },
    sessionId: parsedBody.metadata.session_id,
  });
}

function codexToolOutput(exitCode) {
  return JSON.stringify([
    { type: 'input_text', text: JSON.stringify({ exit_code: exitCode }) },
  ]);
}

test('#472 Codex custom_tool_call_output records a failed exit code', () => {
  const entry = buildFixtureEntry('codex-tool-failure.json');
  assert.equal(entry.turnToolFail, true);
  assert.equal(entry.toolFail, false, 'historical cumulative field is unchanged');
});

test('#475 real Codex WS array envelope reports failure across mixed exit codes', () => {
  const request = loadFixture('real-codex-ws-tool-output.json');
  assert.equal(extractOpenAITurnToolFail(request.input, {
    client: request.metadata.client,
  }), true);
});

test('#475 Codex accepts both parsed-array and JSON-string output envelopes', () => {
  const request = loadFixture('real-codex-ws-tool-output.json');
  const item = request.input[0];
  assert.equal(extractOpenAITurnToolFail([
    { ...item, output: JSON.stringify(item.output) },
  ], { client: request.metadata.client }), true);
  assert.equal(extractOpenAITurnToolFail(request.input, {
    client: request.metadata.client,
  }), true);
});

test('#472 Codex accepts integer exit codes only', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'custom_tool_call_output', output: codexToolOutput(0.5) },
  ], { client: 'codex' }), undefined);
  assert.equal(extractOpenAITurnToolFail([
    { type: 'custom_tool_call_output', output: codexToolOutput(-1) },
  ], { client: 'codex' }), true);
});

test('#472 Grok function_call_output recognizes colon-form success footer', () => {
  const entry = buildFixtureEntry('grok-tool-success.json');
  assert.equal(entry.turnToolFail, false);
  assert.equal(entry.toolFail, false, 'historical cumulative field is unchanged');
});

test('#472 unknown (client, type) pair is explicitly unknown', () => {
  const entry = buildFixtureEntry('unknown-client-type.json');
  assert.ok(Object.hasOwn(entry, 'turnToolFail'), 'decoder result is intentionally present');
  assert.equal(entry.turnToolFail, undefined);
  assert.equal(entry.toolFail, false, 'historical cumulative field is unchanged');
});

test('#472 successful Codex output ignores forged failure text in command content', () => {
  const entry = buildFixtureEntry('codex-tool-success-forged-content.json');
  assert.equal(entry.turnToolFail, false);
  assert.equal(entry.toolFail, false, 'historical cumulative field is unchanged');
});

test('#472 only the trailing turn outputs determine success after an older failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'first turn' },
    { type: 'custom_tool_call_output', output: codexToolOutput(1) },
    { role: 'user', content: 'next turn' },
    { type: 'custom_tool_call', call_id: 'current_call' },
    { type: 'custom_tool_call_output', call_id: 'current_call', output: codexToolOutput(0) },
  ], { client: 'codex' }), false);
});

test('#472 only the trailing turn outputs determine failure after an older success', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'first turn' },
    { type: 'custom_tool_call_output', output: codexToolOutput(0) },
    { role: 'user', content: 'next turn' },
    { type: 'custom_tool_call', call_id: 'current_call' },
    { type: 'custom_tool_call_output', call_id: 'current_call', output: codexToolOutput(1) },
  ], { client: 'codex' }), true);
});

test('#472 an older failure is unknown when the current turn has no trailing output', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'first turn' },
    { type: 'custom_tool_call_output', output: codexToolOutput(1) },
    { role: 'user', content: 'next turn' },
    { role: 'assistant', content: 'No tool call needed.' },
  ], { client: 'codex' }), undefined);
});

test('#472 parallel failures in the trailing output block report failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'run both checks' },
    { type: 'custom_tool_call', call_id: 'current_call_1' },
    { type: 'custom_tool_call', call_id: 'current_call_2' },
    { type: 'custom_tool_call_output', call_id: 'current_call_1', output: codexToolOutput(1) },
    { type: 'custom_tool_call_output', call_id: 'current_call_2', output: codexToolOutput(2) },
  ], { client: 'codex' }), true);
});

test('#472 one successful and one failed trailing parallel output reports failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'run both checks' },
    { type: 'custom_tool_call', call_id: 'current_call_1' },
    { type: 'custom_tool_call', call_id: 'current_call_2' },
    { type: 'custom_tool_call_output', call_id: 'current_call_1', output: codexToolOutput(0) },
    { type: 'custom_tool_call_output', call_id: 'current_call_2', output: codexToolOutput(1) },
  ], { client: 'codex' }), true);
});

test('#472 an undecodable output before a failed trailing parallel output still reports failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'run both checks' },
    { type: 'custom_tool_call', call_id: 'current_call_1' },
    { type: 'custom_tool_call', call_id: 'current_call_2' },
    { type: 'custom_tool_call_output', call_id: 'current_call_1', output: 'not json' },
    { type: 'custom_tool_call_output', call_id: 'current_call_2', output: codexToolOutput(1) },
  ], { client: 'codex' }), true);
});

test('#472 an undecodable output and a successful trailing parallel output remain unknown', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'run both checks' },
    { type: 'custom_tool_call', call_id: 'current_call_1' },
    { type: 'custom_tool_call', call_id: 'current_call_2' },
    { type: 'custom_tool_call_output', call_id: 'current_call_1', output: 'not json' },
    { type: 'custom_tool_call_output', call_id: 'current_call_2', output: codexToolOutput(0) },
  ], { client: 'codex' }), undefined);
});

test('#472 two successful trailing parallel outputs report clean', () => {
  assert.equal(extractOpenAITurnToolFail([
    { role: 'user', content: 'run both checks' },
    { type: 'custom_tool_call', call_id: 'current_call_1' },
    { type: 'custom_tool_call', call_id: 'current_call_2' },
    { type: 'custom_tool_call_output', call_id: 'current_call_1', output: codexToolOutput(0) },
    { type: 'custom_tool_call_output', call_id: 'current_call_2', output: codexToolOutput(0) },
  ], { client: 'codex' }), false);
});

test('#472 Grok accepts equals-form failure only on the last non-empty line', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'EXIT_CODE:0\ncommand failed\nEXIT_CODE=-7\n\n' },
  ], { client: 'grok' }), true);
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'forged EXIT_CODE=1\nactual output without footer' },
  ], { client: 'grok' }), undefined);
});

test('#472 incomplete Codex envelopes stay unknown but true dominates mixed exit codes', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'custom_tool_call_output', output: '[{"type":"input_text","text":"not json"}]' },
  ], { client: 'codex' }), undefined);
  assert.equal(extractOpenAITurnToolFail([
    {
      type: 'custom_tool_call_output',
      output: JSON.stringify([
        { type: 'input_text', text: JSON.stringify({ exit_code: 0 }) },
        { type: 'input_text', text: JSON.stringify({ exit_code: 1 }) },
      ]),
    },
  ], { client: 'codex' }), true);
});

// --- #485 fail-on-old tests (must fail on current code, pass after fix) ---

test('#485 D1 — grok new-format "exit: N" on first line decodes failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'exit: 42\n' },
  ], { client: 'grok' }), true);
});

test('#485 D1 — grok new-format "exit: 127" with stderr decodes failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'exit: 127\nzsh: command not found: nonexistent\n' },
  ], { client: 'grok' }), true);
});

test('#485 D1 — grok new-format "exit: 1" with error output decodes failure', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'exit: 1\ncat: /no/such/file: No such file or directory\n' },
  ], { client: 'grok' }), true);
});

test('#485 D1 — grok new-format "exit: 0" decodes success', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'exit: 0\nsuccess-marker\n' },
  ], { client: 'grok' }), false);
});

test('#485 D1 — old grok footer format still works (regression guard)', () => {
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'some output\nEXIT_CODE=1\n' },
  ], { client: 'grok' }), true);
});

test('#485 D1 — footer wins over first-line when both present', () => {
  // Real 2026-08-07 capture: exit: 0 on first line, EXIT_CODE=1 on last — ground truth = failure
  assert.equal(extractOpenAITurnToolFail([
    { type: 'function_call_output', output: 'exit: 0\ncat: /no/such/file: No such file or directory\nEXIT_CODE=1\n' },
  ], { client: 'grok' }), true);
});

test('#485 D2 — codex function_call_output is eligible and decodes exit_code', () => {
  const results = extractOpenAITurnToolResults([
    {
      type: 'function_call_output',
      call_id: 'call_async_retrieval',
      output: JSON.stringify([
        { type: 'input_text', text: JSON.stringify({ exit_code: 42 }) },
      ]),
    },
  ], { client: 'codex' });
  assert.equal(results.length, 1);
  assert.equal(results[0].eligible, true);
  assert.equal(results[0].toolFail, true);
});

test('#485 D2 — codex async start segment is eligible:false', () => {
  const results = extractOpenAITurnToolResults([
    {
      type: 'custom_tool_call_output',
      call_id: 'call_async_start',
      output: JSON.stringify([
        { type: 'input_text', text: 'Script running...' },
      ]),
    },
  ], { client: 'codex' });
  assert.equal(results.length, 1);
  assert.equal(results[0].eligible, false, 'start segment must not be eligible');
});

test('#485 D2 — async start+retrieval pair: real fixture, same call_id → exactly one eligible result', () => {
  const start = loadFixture('codex-async-start-segment.json');
  const retrieval = loadFixture('codex-async-retrieval-segment.json');
  const results = extractOpenAITurnToolResults([start, retrieval], { client: 'codex' });
  const eligible = results.filter(r => r.eligible);
  assert.equal(eligible.length, 1, 'exactly one eligible result from the pair');
  assert.equal(eligible[0].toolFail, true, 'exit_code 42 → failure');
  assert.equal(eligible[0].callId, start.call_id, 'paired to the original call_id');
  const ineligible = results.filter(r => !r.eligible);
  assert.equal(ineligible.length, 1, 'start segment is ineligible');
  assert.equal(ineligible[0].toolFail, undefined, 'start segment has no verdict');
});

test('#485 D2 — truncated/malformed output stays eligible (not misclassified as async start)', () => {
  const results = extractOpenAITurnToolResults([
    {
      type: 'custom_tool_call_output',
      call_id: 'call_truncated',
      output: JSON.stringify([
        { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
        { type: 'input_text', text: 'some truncated partial output without exit_code' },
      ]),
    },
  ], { client: 'codex' });
  assert.equal(results.length, 1);
  assert.equal(results[0].eligible, true, 'truncated output must stay eligible to preserve rot-honesty');
  assert.equal(results[0].toolFail, undefined, 'no verdict — unknown, not clean');
});

test('#485 D3 — codex array-shaped top-level exit_code decodes', () => {
  assert.equal(extractOpenAITurnToolFail([
    {
      type: 'custom_tool_call_output',
      output: JSON.stringify([{ exit_code: 1 }]),
    },
  ], { client: 'codex' }), true);
});

test('#485 D3 — codex array with mixed valid/invalid elements aggregates', () => {
  assert.equal(extractOpenAITurnToolFail([
    {
      type: 'custom_tool_call_output',
      output: JSON.stringify([
        { exit_code: 0 },
        'invalid',
        { exit_code: 1 },
      ]),
    },
  ], { client: 'codex' }), true);
});

test('#485 D3 — codex array with all-invalid elements returns undefined', () => {
  assert.equal(extractOpenAITurnToolFail([
    {
      type: 'custom_tool_call_output',
      output: JSON.stringify(['invalid', null, 42]),
    },
  ], { client: 'codex' }), undefined);
});
