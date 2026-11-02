'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMergedTurns, selectTurns, groupTurns, query } = require('../server/usage-query');
const { run, parseArgs } = require('../server/usage');

const T = Date.parse('2026-06-01T10:00:00Z');
const iso = n => new Date(n).toISOString();
const turn = (id, extra = {}) => ({ id, receivedAt: T, sessionId: 'session-1',
  agentId: 'herdr:w1:p1', cwd: '/tmp/proj', branch: 'main', model: 'dummy-model',
  usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
    output_tokens: 40, output_tokens_details: { reasoning_tokens: 5 } },
  cost: { cost: 1, confidence: 'exact' }, ...extra });

async function fixture(rows, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-group-'));
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  try { return await fn({ home, logsDir }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

async function output(home, argv) {
  const oldHome = process.env.CCXRAY_HOME;
  const oldLogsDir = process.env.LOGS_DIR;
  const oldLog = console.log, oldError = console.error, oldCode = process.exitCode;
  const lines = [], errors = [];
  process.env.CCXRAY_HOME = home;
  process.env.LOGS_DIR = path.join(home, 'logs');
  console.log = s => lines.push(s);
  console.error = s => errors.push(s);
  process.exitCode = 0;
  try {
    await run(argv);
    return { stdout: lines.join('\n'), stderr: errors.join('\n'), status: process.exitCode };
  } finally {
    console.log = oldLog; console.error = oldError; process.exitCode = oldCode;
    if (oldLogsDir === undefined) delete process.env.LOGS_DIR;
    else process.env.LOGS_DIR = oldLogsDir;
    if (oldHome === undefined) delete process.env.CCXRAY_HOME;
    else process.env.CCXRAY_HOME = oldHome;
  }
}

describe('usage grouping and attribution', () => {
  it('filters legacy attribution after merging the canonical row', async () => {
    await fixture([
      turn('proxy', { responseId: 'dummy-merge', branch: null, usage: { input_tokens: 1 } }),
      turn('import', { responseId: 'dummy-merge', imported: true, agentId: null }),
    ], async ({ home }) => {
      const plain = JSON.parse((await output(home, ['--json', '--agent-id', 'herdr:w1:p1'])).stdout);
      const grouped = JSON.parse((await output(home, ['--json', '--agent-id', 'herdr:w1:p1', '--by', 'agent'])).stdout);
      assert.equal(plain.cache.totalOutputTokens, grouped.groups[0].tokens.output);
      assert.match((await output(home, ['--agent-id', 'herdr:w1:p1', '--branch', 'main'])).stdout, /hit rate: 33\.3%/);
    });
  });

  it('excludes undated and nonfinite rows with only an upper time bound', async () => {
    await fixture([turn('dated'), turn('undated', { receivedAt: null }),
      turn('invalid', { receivedAt: 'invalid' })], async ({ home }) => {
      const result = JSON.parse((await output(home, ['--json', '--until', iso(T + 1)])).stdout);
      assert.equal(result.meta.totalEntries, 1);
      assert.match((await output(home, ['--until', iso(T + 1)])).stdout, /1 entries/);
    });
  });

  it('keeps zero reasoning evidence distinct from missing evidence', () => {
    assert.equal(groupTurns([turn('missing', { usage: {} })], 'agent')[0].tokens.reasoning, null);
    assert.equal(groupTurns([turn('zero', { thinkingTokens: 0 }), turn('missing', { usage: {} })], 'agent')[0].tokens.reasoning, 0);
  });

  it('rejects missing session, cwd and last values', () => {
    for (const flag of ['--session', '--cwd', '--last']) {
      assert.throws(() => parseArgs([flag]), /Missing value/);
      assert.throws(() => parseArgs([flag, '--json']), /Missing value/);
    }
  });

  it('preserves cost-only rows in text while JSON counts model calls', async () => {
    await fixture([
      turn('call'),
      { id: 'cost-only', receivedAt: T + 1, sessionId: 'legacy', cost: { cost: 2 } },
      { id: 'undated', sessionId: 'legacy', cost: { cost: 3 } },
    ], async ({ home }) => {
      const legacy = JSON.parse((await output(home, ['--json'])).stdout);
      assert.equal(legacy.meta.totalCost, 1);
      assert.equal(legacy.meta.totalEntries, 1);
      const text = (await output(home, [])).stdout;
      assert.match(text, /3 entries/);
      assert.match(text, /\$6\.00/);
      const grouped = JSON.parse((await output(home, ['--json', '--by', 'session'])).stdout);
      assert.deepEqual(grouped.groups.map(g => [g.key, g.turns, g.cost]), [['session-1', 1, 1]]);
    });
  });

  it('separates two agents in one cwd and preserves additive totals, tokens and confidence', () => {
    const rows = [turn('a'), turn('b', { agentId: 'herdr:w1:p2', cost: { cost: 2, confidence: 'fallback' } })];
    const agents = groupTurns(rows, 'agent');
    const [cwd] = groupTurns(rows, 'cwd');
    assert.deepEqual(agents.map(g => g.key), ['herdr:w1:p1', 'herdr:w1:p2']);
    assert.equal(agents.reduce((n, g) => n + g.turns, 0), cwd.turns);
    assert.equal(agents.reduce((n, g) => n + g.cost, 0), cwd.cost);
    for (const key of Object.keys(cwd.tokens)) assert.equal(agents.reduce((n, g) => n + g.tokens[key], 0), cwd.tokens[key]);
    assert.deepEqual(agents[0].tokens, { input: 10, output: 40, cacheRead: 20, cacheWrite: 30, reasoning: 5 });
    assert.deepEqual(agents[1].costFold, { count: 1, fallbackCount: 1, fallbackCost: 2, unknownCount: 0 });
    assert.deepEqual(agents[0].models, { 'dummy-model': 1 });
    assert.equal(agents[0].firstTs, iso(T));
    assert.equal(agents[0].lastTs, iso(T));
    assert.deepEqual(rows, [turn('a'), turn('b', { agentId: 'herdr:w1:p2', cost: { cost: 2, confidence: 'fallback' } })]);
  });

  it('splits a run switching recorded branches, counts nulls, and excludes markers', () => {
    const rows = [turn('a'), turn('b', { branch: 'feature' }),
      turn('c', { branch: null, agentId: null, cost: null }),
      { id: 'marker', agentId: null, branch: 'marker', receivedAt: T }];
    const branches = groupTurns(rows, 'branch');
    assert.deepEqual(branches.map(g => [g.key, g.turns]), [['feature', 1], ['main', 1], [null, 1]]);
    assert.equal(branches[2].costFold.unknownCount, 1);
    assert.equal(groupTurns(rows, 'agent').find(g => g.key === null).turns, 1);
    assert.equal(groupTurns(rows, 'session')[0].turns, 3);
  });

  it('uses inclusive start and exclusive end with exact agent and branch intersections', async () => {
    const rows = [turn('before', { receivedAt: T - 1 }), turn('start'),
      turn('middle', { receivedAt: T + 1, agentId: 'herdr:w1:p2' }), turn('end', { receivedAt: T + 2 })];
    const opts = { from: T, to: T + 2, agentIds: ['herdr:w1:p1'], branches: ['main'] };
    assert.deepEqual(selectTurns(rows, opts).map(e => e.id), ['start']);
    assert.equal(selectTurns(rows, { from: T, to: T }).length, 0);
    await fixture(rows, async ({ logsDir }) => assert.equal((await query(opts, { logsDir })).calls, 1));
  });

  it('merges Claude proxy and import before agent, branch, cwd and time filtering', async () => {
    await fixture([
      turn('proxy', { cwd: null, branch: null, responseId: 'dummy-response' }),
      turn('import', { agentId: null, imported: true, responseId: 'dummy-response', receivedAt: T - 1000 }),
    ], async ({ logsDir, home }) => {
      const { turns } = await readMergedTurns({ logsDir });
      const selected = selectTurns(turns, { roots: ['/tmp/proj'], agentIds: ['herdr:w1:p1'], branches: ['main'], from: T, to: T + 1 });
      assert.equal(selected.length, 1);
      assert.deepEqual(selected[0].sources, ['import', 'proxy']);
      assert.equal(groupTurns(selected, 'agent')[0].turns, 1);
      const result = JSON.parse((await output(home, ['--json', '--by', 'agent', '--agent-id', 'herdr:w1:p1', '--branch', 'main', '--cwd', '/tmp/proj', '--from', iso(T), '--to', iso(T + 1)])).stdout);
      assert.equal(result.groups[0].turns, 1);
    });
  });

  it('chooses the Codex source before grouping and filtering, including an out-of-window proxy', async () => {
    await fixture([
      turn('proxy', { provider: 'openai', receivedAt: T - 3600000 }),
      turn('import', { provider: 'openai', imported: true, agentId: 'herdr:w1:p2' }),
      turn('import-only', { provider: 'openai', imported: true, sessionId: 'session-2', agentId: 'herdr:w1:p2' }),
    ], async ({ home }) => {
      const result = JSON.parse((await output(home, ['--json', '--by', 'agent', '--agent-id', 'herdr:w1:p2', '--from', iso(T), '--to', iso(T + 1)])).stdout);
      assert.equal(result.groups.length, 1);
      assert.equal(result.groups[0].turns, 1);
    });
  });

  it('parses grouped JSON and renders text with explicit null counts and confidence', async () => {
    await fixture([turn('a'), turn('b', { agentId: null, branch: null, cost: null }), { id: 'marker', receivedAt: T }], async ({ home }) => {
      const json = await output(home, ['--json', '--by', 'branch']);
      assert.equal(json.status, 0);
      const result = JSON.parse(json.stdout);
      assert.equal(result.by, 'branch');
      assert.equal(result.nullAgentIdTurns, 1);
      assert.equal(result.nullBranchTurns, 1);
      assert.equal(result.groups.find(g => g.key === null).turns, 1);
      const text = (await output(home, ['--by', 'branch'])).stdout;
      assert.match(text, /\(null\): 1 turns · —/);
      assert.match(text, /Null agentId: 1 turns/);
      assert.match(text, /cacheWrite 30/);
    });
  });

  it('reprices stale costs through the existing read-time pricing helper', async () => {
    await fixture([turn('a', { model: 'claude-sonnet-4-6', cost: { cost: null, confidence: 'unknown' } })], async ({ home }) => {
      const r = JSON.parse((await output(home, ['--json', '--by', 'agent'])).stdout);
      assert.ok(r.groups[0].cost > 0);
      assert.equal(r.groups[0].costFold.unknownCount, 0);
    });
  });
});

describe('usage absolute window flags', () => {
  it('accepts aliases, timezone offsets, repeatable and comma-separated filters', () => {
    const a = parseArgs(['--since', '2026-06-01T18:00:00+08:00', '--until', iso(T + 1),
      '--agent-id', 'herdr:w1:p1,herdr:w1:p2', '--agent-id', 'herdr:w1:p3', '--branch', 'main,feature', '--branch', 'other']);
    assert.equal(a.since, T);
    assert.equal(a.to, T + 1);
    assert.equal(a.agentIds.length, 3);
    assert.deepEqual(a.branches, ['main', 'feature', 'other']);
    assert.ok(parseArgs(['--last', '7d']).since > 0);
  });

  it('rejects invalid timestamps, reversed windows, missing values, and conflicting flags with nonzero status', async () => {
    const invalid = [
      ['--from', 'tomorrow'], ['--from', '2026-02-30T00:00:00Z'], ['--to', '2026-06-01'],
      ['--from', '2026-06-01T00:00:00'], ['--from', '2026-06-01T24:00:00Z'],
      ['--from', iso(T + 1), '--to', iso(T)], ['--from'], ['--branch'], ['--agent-id', ','],
      ['--last', 'invalid'], ['--by', 'unknown'], ['--last', '7d', '--from', iso(T)], ['--until', iso(T), '--last', '7d'],
    ];
    for (const argv of invalid) {
      assert.throws(() => parseArgs(argv), /Invalid|Missing|Empty|Cannot combine|before/);
      const result = await output('/tmp/unused-usage-home', argv);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid|Missing|Empty|Cannot combine|before/);
    }
  });
});
