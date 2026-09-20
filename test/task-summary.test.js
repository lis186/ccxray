'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const { handleApiRoutes } = require('../server/routes/api');
const { summarizeTask, matchesProject, parseSessionSpecs } = require('../server/task-summary');

function fakeRes() {
  let status = 0;
  let body = null;
  return {
    headersSent: false,
    status: () => status,
    body: () => body,
    writeHead: (s) => { status = s; },
    end: (data) => { body = data; },
  };
}

function get(url) {
  const res = fakeRes();
  const handled = handleApiRoutes({ url, method: 'GET' }, res);
  return { handled, status: res.status(), json: res.body() ? JSON.parse(res.body()) : null };
}

// Canonical usage as the store holds it: the four token fields are disjoint.
function entry(overrides) {
  return {
    id: String(Math.random()),
    task: 'TASK-101',
    role: 'implementation',
    agent: 'claude',
    model: 'claude-sonnet-5',
    sessionId: 's1',
    cost: { cost: 0.01 },
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ...overrides,
  };
}

describe('summarizeTask', () => {
  it('sums disjoint canonical token fields into a per-entry total', () => {
    const s = summarizeTask([
      entry({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } }),
      entry({ usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } }),
    ], { task: 'TASK-101' });
    assert.deepEqual(s.tokens, { input: 3000, output: 600, cache_read: 1500, cache_create: 300, reasoning: 0, total: 5400 });
    // 1500 / (3000 + 1500 + 300)
    assert.equal(s.cache_hit_rate, 0.313);
  });

  it('does not compound running totals across entries', () => {
    // Regression: the first cut added the *cumulative* input/output sums to the
    // total on every entry that lacked a provider total, so N entries grew
    // quadratically. Three identical entries must total exactly 3x one entry.
    const one = summarizeTask([entry()], { task: 'TASK-101' }).tokens.total;
    const three = summarizeTask([entry(), entry(), entry()], { task: 'TASK-101' }).tokens.total;
    assert.equal(one, 180);
    assert.equal(three, 540);
  });

  it('ignores a provider total_tokens that double-counts cached input', () => {
    const s = summarizeTask([
      entry({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, total_tokens: 99999 } }),
    ], { task: 'TASK-101' });
    assert.equal(s.tokens.total, 1020);
  });

  it('reports reasoning tokens without adding them to the total', () => {
    const s = summarizeTask([
      entry({ agent: 'codex', usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { reasoning_tokens: 70 } } }),
    ], { task: 'TASK-101' });
    assert.equal(s.tokens.reasoning, 70);
    assert.equal(s.tokens.total, 100);
  });

  it('breaks the task down by role and can filter to one role', () => {
    const entries = [
      entry({ role: 'implementation', cost: { cost: 0.02 } }),
      entry({ role: 'cross-check', agent: 'codex', model: 'gpt-5.4', cost: { cost: 0.03 } }),
      entry({ role: 'cross-check', agent: 'grok', model: 'grok-4', cost: { cost: 0.04 } }),
      entry({ role: undefined, cost: { cost: 0.005 } }),
    ];
    const all = summarizeTask(entries, { task: 'TASK-101' });
    assert.equal(all.calls, 4);
    assert.equal(all.cost_usd, 0.095);
    assert.equal(all.by_role['cross-check'].calls, 2);
    assert.equal(all.by_role['cross-check'].cost_usd, 0.07);
    assert.equal(all.by_role.unattributed.calls, 1);
    assert.deepEqual(all.agents, ['claude', 'codex', 'grok']);
    assert.deepEqual(all.models, ['claude-sonnet-5', 'gpt-5.4', 'grok-4']);

    const only = summarizeTask(entries, { task: 'TASK-101', role: 'cross-check' });
    assert.equal(only.calls, 2);
    assert.equal(only.role, 'cross-check');
    assert.deepEqual(Object.keys(only.by_role), ['cross-check']);
  });

  it('prefers per-turn tool fields over cumulative ones', () => {
    const s = summarizeTask([
      entry({ turnToolCalls: { Bash: 2, Edit: 1 }, toolCalls: { Bash: 40 }, skillCalls: { agentflow: 1 }, turnToolFail: true }),
      entry({ turnToolCalls: { Bash: 3, Read: 4 }, turnToolFail: false, toolFail: true }),
    ], { task: 'TASK-101' });
    assert.deepEqual(s.tools, { Bash: 5, Edit: 1, Read: 4 });
    assert.deepEqual(s.skills, { agentflow: 1 });
    assert.equal(s.tool_failures, 1);
  });

  it('separates the same task id across projects', () => {
    // Agentflow numbers Asks per notebook: A-001 exists in every project.
    const entries = [
      entry({ task: 'A-001', taskProject: 'ipadpos' }),
      entry({ task: 'A-001', taskProject: 'ipadpos-web' }),
      entry({ task: 'A-001', taskProject: undefined, cwd: '/Users/x/dev/ipadpos' }),
    ];
    assert.equal(summarizeTask(entries, { task: 'A-001' }).calls, 3);
    // Declared project matches exactly — 'ipadpos' must not swallow 'ipadpos-web'.
    // The undeclared entry falls back to the cwd substring rule.
    assert.equal(summarizeTask(entries, { task: 'A-001', project: 'ipadpos' }).calls, 2);
    assert.equal(summarizeTask(entries, { task: 'A-001', project: 'ipadpos-web' }).calls, 1);
  });

  it('matchesProject keeps an entry that declares nothing and has no cwd', () => {
    assert.equal(matchesProject({}, 'anything'), true);
    assert.equal(matchesProject({ cwd: '/a/b' }, 'zzz'), false);
  });

  it('matches an undeclared entry by whole cwd path segment, never by substring', () => {
    // Found in independent review: `cwd.includes(project)` let `ipadpos` count
    // a worker whose cwd was .../ipadpos-web.
    assert.equal(matchesProject({ cwd: '/Users/x/dev/ipadpos' }, 'ipadpos'), true);
    assert.equal(matchesProject({ cwd: '/Users/x/dev/ipadpos/sub/dir' }, 'ipadpos'), true);
    assert.equal(matchesProject({ cwd: '/Users/x/dev/ipadpos-web' }, 'ipadpos'), false);
    assert.equal(matchesProject({ cwd: '/Users/x/dev/my-ipadpos' }, 'ipadpos'), false);
    assert.equal(matchesProject({ cwd: 'C:\\dev\\ipadpos\\clone' }, 'ipadpos'), true);
    const entries = [
      entry({ task: 'A-9', taskProject: undefined, cwd: '/dev/ipadpos' }),
      entry({ task: 'A-9', taskProject: undefined, cwd: '/dev/ipadpos-web' }),
    ];
    assert.equal(summarizeTask(entries, { task: 'A-9', project: 'ipadpos' }).calls, 1);
  });

  it('returns a zeroed summary for an unknown task', () => {
    const s = summarizeTask([entry()], { task: 'NOPE' });
    assert.equal(s.calls, 0);
    assert.equal(s.cost_usd, 0);
    assert.equal(s.cache_hit_rate, 0);
    assert.equal(s.first_ts, null);
  });

  it('unions session-selected entries, deduplicates by id, and skips another task', () => {
    const shared = entry({ id: 'shared', receivedAt: 110, role: 'implementation' });
    const labelOnly = entry({ id: 'label-only', receivedAt: 10, role: 'implementation' });
    const sessionEntries = [
      entry({ id: 'shared', task: undefined, sessionId: 'host-1', receivedAt: 110, role: 'review' }),
      entry({ id: 'host-only', task: undefined, sessionId: 'host-1', receivedAt: 120, role: 'review' }),
      entry({ id: 'other-task', task: 'OTHER', sessionId: 'host-1', receivedAt: 130 }),
      entry({ id: 'outside', task: undefined, sessionId: 'host-1', receivedAt: 500 }),
    ];
    const specs = [
      { session: 'host-1', from: 100, to: 200 },
      { session: 'never-seen', from: 100, to: 200 },
    ];

    const summary = summarizeTask([shared, labelOnly], {
      task: 'TASK-101', sessionEntries, sessionSpecs: specs,
    });

    assert.equal(summary.calls, 3);
    assert.equal(summary.by_role.coordinator.calls, 2);
    assert.equal(summary.by_role.implementation.calls, 1);
    assert.equal(summary.coordinator.calls, 2);
    assert.deepEqual(summary.coordinator.sessions, [
      { session: 'host-1', from: 100, to: 200, calls: 2 },
      { session: 'never-seen', from: 100, to: 200, calls: 0 },
    ]);
  });

  it('uses only session-selected entries for role=coordinator', () => {
    const summary = summarizeTask([
      entry({ id: 'label', role: 'implementation' }),
      entry({ id: 'label-coordinator', role: 'coordinator' }),
    ], {
      task: 'TASK-101',
      sessionEntries: [entry({ id: 'host', task: undefined, sessionId: 'host-1', receivedAt: 100 })],
      sessionSpecs: [{ session: 'host-1', from: 100, to: 100 }],
      role: 'coordinator',
    });
    assert.equal(summary.calls, 1);
    assert.deepEqual(Object.keys(summary.by_role), ['coordinator']);
    assert.equal(summary.by_role.coordinator.calls, 1);
  });

  it('keeps every other role filter on labelled entries only', () => {
    const summary = summarizeTask([
      entry({ id: 'label', role: 'implementation' }),
      entry({ id: 'other-role', role: 'cross-check' }),
    ], {
      task: 'TASK-101',
      role: 'implementation',
      sessionEntries: [entry({ id: 'host', task: undefined, sessionId: 'host-1', receivedAt: 100 })],
      sessionSpecs: [{ session: 'host-1', from: 100, to: 100 }],
    });
    assert.equal(summary.calls, 1);
    assert.deepEqual(Object.keys(summary.by_role), ['implementation']);
    assert.equal(summary.coordinator.calls, 0);
  });
});

describe('parseSessionSpecs', () => {
  it('parses closed and open-ended inclusive intervals', () => {
    assert.deepEqual(parseSessionSpecs(['host-1@100-200', 'host-2@300-'], 999), [
      { session: 'host-1', from: 100, to: 200 },
      { session: 'host-2', from: 300, to: 999 },
    ]);
  });

  it('ignores malformed, reversed, and non-numeric specs', () => {
    assert.deepEqual(parseSessionSpecs([
      '', 'host-1', '@100-200', 'host-1@-200', 'host-1@100',
      'host-1@abc-200', 'host-1@100-xyz', 'host-1@200-100',
      'host-1@100.5-200', 'host-1@100-200-300',
    ], 999), []);
  });

  it('bounds parsing to the first 32 session parameters', () => {
    const specs = parseSessionSpecs(
      Array.from({ length: 33 }, (_, i) => `host-${i}@${i}-${i}`),
      999,
    );
    assert.equal(specs.length, 32);
    assert.equal(specs.at(-1).session, 'host-31');
  });
});

describe('client-supplied labels cannot reach Object.prototype', () => {
  // Found in independent review: `byRole[roleKey]` with roleKey 'constructor'
  // read Object.prototype.constructor, `+=` threw, and the proxy process died
  // on a GET. Tool names come off the wire too, so they get the same guard.
  const hostile = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype'];

  it('aggregates hostile role names as ordinary own properties', () => {
    const s = summarizeTask(hostile.map(role => entry({ role, turnToolCalls: Object.fromEntries(hostile.map(n => [n, 2])) })), { task: 'TASK-101' });
    assert.equal(s.calls, hostile.length);
    assert.deepEqual(Object.keys(s.by_role).sort(), [...hostile].sort());
    for (const name of hostile) {
      assert.equal(s.by_role[name].calls, 1, name);
      assert.equal(s.tools[name], 2 * hostile.length, name);
    }
    assert.equal(Object.getPrototypeOf(s.by_role), Object.prototype);
    assert.equal(Object.getPrototypeOf(s.tools), Object.prototype);
    // Serialises with the hostile keys as data, not as prototype surgery.
    const round = JSON.parse(JSON.stringify(s));
    assert.equal(round.by_role.__proto__.calls, 1);
    assert.equal(round.tools.constructor, 2 * hostile.length);
  });

  it('serves a hostile role through the real route without throwing', () => {
    store.entries.length = 0;
    store.entries.push(entry({ task: 'POISON', role: 'constructor' }), entry({ task: 'POISON', role: '__proto__' }));
    const r = get('/_api/task-summary?task=POISON');
    assert.equal(r.status, 200);
    assert.equal(r.json.calls, 2);
    assert.equal(r.json.by_role.constructor.calls, 1);
    const filtered = get('/_api/task-summary?task=POISON&role=constructor');
    assert.equal(filtered.json.calls, 1);
    store.entries.length = 0;
  });
});

describe('cost confidence', () => {
  it('classifies priced, unknown, fallback, and usage-less calls instead of summing zeros silently', () => {
    const s = summarizeTask([
      entry({ role: 'w', cost: { cost: 0.5, confidence: 'exact' } }),
      entry({ role: 'w', cost: { cost: 0.25, confidence: 'fallback' } }),
      entry({ role: 'w', cost: { cost: null, confidence: 'unknown', warning: 'Unknown model' } }),
      entry({ role: 'w', cost: null, usage: null }),
    ], { task: 'TASK-101' });
    assert.equal(s.calls, 4);
    assert.equal(s.cost_usd, 0.75);
    assert.deepEqual(s.cost_confidence, { priced: 2, unknown: 1, fallback: 1, no_usage: 1 });
    assert.deepEqual(s.by_role.w.cost_confidence, { priced: 2, unknown: 1, fallback: 1, no_usage: 1 });
    assert.equal(s.by_role.w.cost_usd, 0.75);
  });

  it('reports all-priced summaries as fully priced', () => {
    const s = summarizeTask([entry(), entry()], { task: 'TASK-101' });
    assert.deepEqual(s.cost_confidence, { priced: 2, unknown: 0, fallback: 0, no_usage: 0 });
  });
});

describe('task-summary endpoint', () => {
  beforeEach(() => { store.entries.length = 0; });

  it('returns 400 when the task query param is missing or blank', () => {
    for (const url of ['/api/task-summary', '/_api/task-summary?task=%20']) {
      const r = get(url);
      assert.equal(r.handled, true);
      assert.equal(r.status, 400);
      assert.match(r.json.error, /task parameter required/);
    }
  });

  it('serves both path spellings and applies role and project filters', () => {
    store.entries.push(
      entry({ task: 'A-7', role: 'implementation', taskProject: 'pos' }),
      entry({ task: 'A-7', role: 'cross-check', taskProject: 'pos' }),
      entry({ task: 'A-7', role: 'cross-check', taskProject: 'other' }),
    );
    assert.equal(get('/api/task-summary?task=A-7').json.calls, 3);
    const r = get('/_api/task-summary?task=A-7&role=cross-check&project=pos');
    assert.equal(r.status, 200);
    assert.equal(r.json.calls, 1);
    assert.equal(r.json.project, 'pos');
  });

  it('discloses the in-memory window it summarized', () => {
    store.entries.push(entry({ task: 'A-8' }));
    const r = get('/_api/task-summary?task=A-8');
    assert.equal(r.json.coverage.entries_in_memory, 1);
    assert.equal(r.json.coverage.max_entries, store.MAX_ENTRIES);
  });
});
