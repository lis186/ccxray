'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getParser } = require('../server/wire-parsers');
const { extractOpenAITurnToolFail } = require('../server/helpers');

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
