'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOpenAIResponseSummary } = require('../server/forward');

test('T8: WS entry restore must not flip isSSE to true', () => {
  const meta = {
    id: 'X', provider: 'openai', isSSE: false,
    responseMetadata: { transport: 'websocket', capture: 'transport-only' },
    usage: { input_tokens: 1 }, model: 'gpt-5.5',
  };
  const resData = [{ type: 'response.completed', data: { response: { status: 'completed' } } }];
  const { summary } = normalizeOpenAIResponseSummary(meta, resData);
  assert.equal(summary.isSSE, false, 'WS entry must stay isSSE:false');
  assert.equal(summary.responseMetadata.transport, 'websocket');
});

test('T8: non-WS OpenAI SSE restore still normalizes isSSE to true', () => {
  const meta = {
    id: 'Y', provider: 'openai', isSSE: false,
    usage: null, model: null,
  };
  const resData = [{ type: 'response.completed', data: { response: { id: 'r1', object: 'response', model: 'gpt-5.5', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } }];
  const { summary } = normalizeOpenAIResponseSummary(meta, resData);
  assert.equal(summary.isSSE, true, 'SSE entry should still be normalized to isSSE:true');
});
