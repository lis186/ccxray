'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const config = require('../server/config');
const { handleApiRoutes } = require('../server/routes/api');
const taskIndex = require('../server/task-index');

function fakeRes() {
  let status = 0;
  let body = null;
  let headers = {};
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    headersSent: false,
    status: () => status,
    body: () => body,
    headers: () => headers,
    done,
    writeHead: (s, h) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    end: (data) => { body = data; resolveDone(); },
  };
}

const realReadIndexLines = config.storage.readIndexLines;
const realReadIndexLinesFrom = config.storage.readIndexLinesFrom;

// The endpoint reads index.ndjson, so tests feed rows through the storage seam
// rather than store.entries.
function stubIndex(rows) {
  config.storage.readIndexLinesFrom = undefined;
  config.storage.readIndexLines = () => (async function* () {
    for (const row of rows) yield typeof row === 'string' ? row : JSON.stringify(row);
  })();
}

function stubIndexFailure(message) {
  config.storage.readIndexLinesFrom = undefined;
  config.storage.readIndexLines = () => (async function* () {
    throw new Error(message);
    // eslint-disable-next-line no-unreachable
    yield '';
  })();
}

function reset() {
  store.entries.length = 0;
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
  config.storage.readIndexLines = realReadIndexLines;
  config.storage.readIndexLinesFrom = realReadIndexLinesFrom;
  taskIndex.reset();
}

async function get(url) {
  const res = fakeRes();
  const handled = handleApiRoutes({ url, method: 'GET' }, res);
  assert.equal(handled, true);
  await res.done;
  return res;
}

describe('task-summary endpoint', () => {
  beforeEach(reset);
  after(reset);

  it('returns 400 when task query param is missing', () => {
    const res = fakeRes();
    const handled = handleApiRoutes({ url: '/api/task-summary', method: 'GET' }, res);
    assert.equal(handled, true);
    assert.equal(res.status(), 400);
    const parsed = JSON.parse(res.body());
    assert.match(parsed.error, /task parameter required/);
  });

  it('aggregates tokens and cost for matching task', async () => {
    stubIndex([
      {
        id: '1',
        task: 'TASK-101',
        role: 'worker',
        cost: { cost: 0.015 },
        turnToolCalls: { Bash: 2, Edit: 1 },
        skillCalls: { agentflow: 1 },
        turnToolFail: true,
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
        turnToolCalls: { Bash: 3, ReadFile: 4 },
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
      },
    ]);
    // A stale in-memory row must not reach the answer: the durable index is the
    // only source.
    store.entries.push({ id: 'stale', task: 'TASK-101', cost: { cost: 99 }, usage: { input_tokens: 99 } });

    const res = await get('/api/task-summary?task=TASK-101');
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
    assert.deepEqual(summary.tools, { Bash: 5, Edit: 1, ReadFile: 4 });
    assert.equal(summary.tool_failures, 1);
    assert.deepEqual(summary.skills, { agentflow: 1 });
  });

  it('works with /_api/task-summary prefix as well', async () => {
    stubIndex([{ id: '1', task: 'TASK-202', cost: { cost: 0.01 }, usage: { input_tokens: 100, output_tokens: 50 } }]);

    const res = await get('/_api/task-summary?task=TASK-202');
    assert.equal(res.status(), 200);
    const summary = JSON.parse(res.body());
    assert.equal(summary.task, 'TASK-202');
    assert.equal(summary.calls, 1);
  });

  it('counts turns past the in-memory entry cap', async () => {
    const rows = [];
    for (let i = 0; i < 6000; i += 1) {
      rows.push({ id: `row-${i}`, task: 'LONG-RUN', usage: { input_tokens: 1, total: 1 } });
    }
    stubIndex(rows);

    const summary = JSON.parse((await get('/api/task-summary?task=LONG-RUN')).body());
    // store.js caps the in-memory array at MAX_ENTRIES (5000); reading it would
    // have silently answered 5000.
    assert.equal(summary.calls, 6000);
    assert.equal(summary.tokens.input, 6000);
  });

  it('folds duplicate rows of one response instead of dropping copies', async () => {
    stubIndex([
      // Proxy copy: carries the usage/cost, but the skill evidence landed only
      // on the imported copy. Collapsing to one copy would lose the other's.
      { id: 'a1', responseId: 'resp-1', task: 'DUP', cost: { cost: 0.01 }, usage: { input_tokens: 100, total: 100 } },
      { id: 'a2', responseId: 'resp-1', task: 'DUP', imported: true, skillCalls: { agentflow: 1 } },
      { id: 'b1', responseId: 'resp-2', task: 'DUP', cost: { cost: 0.02 }, usage: { input_tokens: 200, total: 200 } },
    ]);

    const summary = JSON.parse((await get('/api/task-summary?task=DUP')).body());
    assert.equal(summary.calls, 2);
    assert.equal(summary.tokens.input, 300);
    // Costed once per response, never summed across copies (ADR 0017).
    assert.equal(summary.cost_usd, 0.03);
    // Survives only if the copies were folded rather than deduped away.
    assert.deepEqual(summary.skills, { agentflow: 1 });
  });

  it('matches a task whose name contains characters JSON escapes', async () => {
    stubIndex([{ id: '1', task: 'quote"task', usage: { input_tokens: 5, total: 5 } }]);

    const summary = JSON.parse((await get(`/api/task-summary?task=${encodeURIComponent('quote"task')}`)).body());
    assert.equal(summary.calls, 1);
  });

  it('derives a missing total per entry instead of from the running sum', async () => {
    stubIndex([
      { id: '1', task: 'NO-TOTAL', usage: { input_tokens: 100 } },
      { id: '2', task: 'NO-TOTAL', usage: { input_tokens: 100 } },
      { id: '3', task: 'NO-TOTAL', usage: { input_tokens: 100 } },
    ]);

    const summary = JSON.parse((await get('/api/task-summary?task=NO-TOTAL')).body());
    // The previous fallback added the accumulators, yielding 100 + 200 + 300 = 600.
    assert.equal(summary.tokens.total, 300);
  });

  it('reads OpenAI-wire totals and reasoning from their own field names', async () => {
    stubIndex([
      {
        id: '1',
        task: 'CODEX',
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          total_tokens: 1100,
          output_tokens_details: { reasoning_tokens: 40 },
        },
      },
    ]);

    const summary = JSON.parse((await get('/api/task-summary?task=CODEX')).body());
    assert.equal(summary.tokens.total, 1100);
    assert.equal(summary.tokens.reasoning, 40);
  });

  it('filters on the recorded project, keeping turns run from disposable clones', async () => {
    stubIndex([
      {
        id: 'host',
        task: 'T',
        project: 'ipadpos-v3-claude',
        cwd: '/Users/dev/ipadpos-v3-claude',
        usage: { input_tokens: 10, total: 10 },
      },
      {
        // A delegated turn: the clone path never contains the project name, so a
        // cwd substring test dropped it.
        id: 'worker',
        task: 'T',
        project: 'ipadpos-v3-claude',
        cwd: '/var/folders/xx/agentflow-external-runner-AbCdEf-clone',
        usage: { input_tokens: 20, total: 20 },
      },
      { id: 'other', task: 'T', project: 'ipadpos-v3-codex', usage: { input_tokens: 500, total: 500 } },
      // No project recorded at all — must not be admitted by a project query.
      { id: 'untagged', task: 'T', usage: { input_tokens: 700, total: 700 } },
    ]);

    const summary = JSON.parse((await get('/api/task-summary?task=T&project=ipadpos-v3-claude')).body());
    assert.equal(summary.calls, 2);
    assert.equal(summary.tokens.input, 30);
    assert.equal(summary.project, 'ipadpos-v3-claude');
  });

  it('fails loudly when the index cannot be read', async () => {
    stubIndexFailure('index unreadable');

    const res = await get('/api/task-summary?task=ANY');
    // Answering 200 with zeros would be indistinguishable from a task that never ran.
    assert.equal(res.status(), 500);
    assert.match(JSON.parse(res.body()).error, /index unreadable/);
  });
});
