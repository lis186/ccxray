'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const { handleApiRoutes } = require('../server/routes/api');

function fakeRes() {
  let status = 0;
  let body = null;
  let headers = {};
  return {
    headersSent: false,
    status: () => status,
    body: () => body,
    writeHead: (s, h) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    end: (data) => { body = data; },
  };
}

function reset() {
  store.entries.length = 0;
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
}

describe('task-summary endpoint', () => {
  beforeEach(reset);

  it('returns 400 when task query param is missing', () => {
    const res = fakeRes();
    const handled = handleApiRoutes({ url: '/api/task-summary', method: 'GET' }, res);
    assert.equal(handled, true);
    assert.equal(res.status(), 400);
    const parsed = JSON.parse(res.body());
    assert.match(parsed.error, /task parameter required/);
  });

  it('aggregates tokens and cost for matching task', () => {
    store.entries.push(
      {
        id: '1',
        task: 'TASK-101',
        role: 'worker',
        cost: { cost: 0.015 },
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
          reasoning: 50,
          total: 1850,
        },
      },
      {
        id: '2',
        task: 'TASK-101',
        role: 'worker',
        cost: { cost: 0.025 },
        usage: {
          input_tokens: 2000,
          output_tokens: 400,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          reasoning: 100,
          total: 3700,
        },
      },
      {
        id: '3',
        task: 'OTHER-TASK',
        role: 'planner',
        cost: { cost: 0.05 },
        usage: { input_tokens: 5000, output_tokens: 1000 },
      }
    );

    const res = fakeRes();
    const handled = handleApiRoutes({ url: '/api/task-summary?task=TASK-101', method: 'GET' }, res);
    assert.equal(handled, true);
    assert.equal(res.status(), 200);

    const summary = JSON.parse(res.body());
    assert.equal(summary.task, 'TASK-101');
    assert.equal(summary.calls, 2);
    assert.equal(summary.cost_usd, 0.04);
    assert.equal(summary.tokens.input, 3000);
    assert.equal(summary.tokens.output, 600);
    assert.equal(summary.tokens.cache_read, 1500);
    assert.equal(summary.tokens.cache_create, 300);
    assert.equal(summary.tokens.reasoning, 150);
    assert.equal(summary.tokens.total, 5550);
    // Cache denom = 3000 + 1500 + 300 = 4800. Cache hit rate = 1500 / 4800 = 0.3125 -> 0.313
    assert.equal(summary.cache_hit_rate, 0.313);
  });

  it('works with /_api/task-summary prefix as well', () => {
    store.entries.push({
      id: '1',
      task: 'TASK-202',
      cost: { cost: 0.01 },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const res = fakeRes();
    const handled = handleApiRoutes({ url: '/_api/task-summary?task=TASK-202', method: 'GET' }, res);
    assert.equal(handled, true);
    assert.equal(res.status(), 200);
    const summary = JSON.parse(res.body());
    assert.equal(summary.task, 'TASK-202');
    assert.equal(summary.calls, 1);
  });
});
