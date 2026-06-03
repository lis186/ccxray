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
