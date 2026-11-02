'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMergedTurns, selectTurns, groupTurns, query, usageContract } = require('../server/usage-query');
const { run, parseArgs } = require('../server/usage');

const T = Date.parse('2026-06-01T10:00:00Z');
const iso = n => new Date(n).toISOString();
const turn = (id, extra = {}) => ({ id, receivedAt: T, sessionId: 'session-1',
  agentId: 'run-demo', cwd: '/tmp/proj', branch: 'main', model: 'dummy-model',
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


describe('version 1 usage query contract', () => {
  it('merges copies, excludes and counts scoped markers, and allowlists turn fields', async () => {
    await fixture([
      turn('proxy', { responseId: 'dummy-response', title: 'DUMMY private title',
        req: { prompt: 'DUMMY prompt' }, res: { response: 'DUMMY response' }, authorization: 'DUMMY secret' }),
      turn('import', { responseId: 'dummy-response', imported: true, agentId: null }),
      turn('null-agent', { agentId: null, branch: null, usage: {} }),
      { id: 'marker', agentId: 'run-demo', receivedAt: T },
      { id: 'outside-marker', receivedAt: T - 1 },
    ], async ({ home }) => {
      const args = ['--json', '--turns', '--from', iso(T), '--to', iso(T + 1), '--by', 'agent'];
      const result = await output(home, args);
      const r = JSON.parse(result.stdout);
      assert.equal(result.status, 0);
      assert.equal(r.schemaVersion, 1);
      assert.deepEqual(r.window, { from: iso(T), to: iso(T + 1) });
      assert.equal(r.coverage, 'unknown');
      assert.equal(r.totals.turns, 2);
      assert.equal(r.excludedMarkerRows, 1);
      assert.equal(r.nullAgentIdTurns, 1);
      assert.equal(r.nullBranchTurns, 1);
      assert.deepEqual(r.turns[1].sources, ['import', 'proxy']);
      assert.equal(r.turns[1].costConfidence, 'exact');
      assert.equal(r.groups.reduce((sum, g) => sum + g.turns, 0), r.totals.turns);
      assert.doesNotMatch(result.stdout, /DUMMY|authorization|"req"|"res"|"prompt"|"response"/);
      const plain = await output(home, ['--json', '--turns']);
      assert.doesNotMatch(plain.stdout, /DUMMY|authorization|"req"|"res"|"prompt"|"response"/);
      assert.deepEqual(Object.keys(r.turns[0]).sort(), ['id', 'sessionId', 'agentId', 'branch', 'cwd', 'provider', 'model', 'receivedAt', 'tokens', 'cost', 'costConfidence', 'costFold', 'sources'].sort());
      const filtered = JSON.parse((await output(home, [...args, '--agent-id', 'run-demo'])).stdout);
      assert.equal(filtered.totals.turns, 1);
      assert.equal(filtered.excludedMarkerRows, 1);
    });
  });

  it('matches a dummy Codex session token ledger and chooses one source', async () => {
    // DUMMY session counters and separately stored imported turn summaries.
    const session = require('./fixtures/usage/codex-session.json');
    const rows = session.importedTurns.map(({ id, ...usage }) => turn(id, {
      provider: 'openai', imported: true, sessionId: session.sessionId, usage,
    }));
    await fixture(rows, async ({ home }) => {
      const r = JSON.parse((await output(home, ['--json', '--turns', '--by', 'session'])).stdout);
      const u = session.sessionUsage;
      assert.equal(r.totals.tokens.input + r.totals.tokens.cacheRead, u.input_tokens);
      assert.equal(r.totals.tokens.cacheRead, u.cached_input_tokens);
      assert.equal(r.totals.tokens.output, u.output_tokens + u.reasoning_output_tokens);
      assert.equal(r.totals.tokens.reasoning, null);
      assert.equal(r.totals.reasoningKnownTurns, 0);
      assert.deepEqual(r.providerTotals.openai.tokens, r.totals.tokens);
    });
    await fixture([...rows, turn('proxy', { provider: 'openai', sessionId: 'dummy-codex',
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 17 } })], async ({ home }) => {
      const r = JSON.parse((await output(home, ['--json'])).stdout);
      assert.equal(r.totals.turns, 1);
      assert.equal(r.totals.tokens.input, 40);
      assert.equal(r.totals.tokens.cacheRead, 80);
      assert.equal(r.totals.tokens.output, 17);
      assert.equal(Object.hasOwn(r, 'turns'), false);
    });
  });

  it('returns empty groups and exit zero for no matches, empty indexes and missing logs', async () => {
    await fixture([turn('a')], async ({ home }) => {
      for (const extra of [[], ['--by', 'agent']]) {
        const result = await output(home, ['--json', '--turns', '--agent-id', 'missing', ...extra]);
        const r = JSON.parse(result.stdout);
        assert.equal(result.status, 0);
        assert.equal(r.schemaVersion, 1);
        assert.deepEqual(r.groups, []);
        assert.deepEqual(r.turns, []);
        assert.equal(r.totals.turns, 0);
        assert.equal(r.totals.tokens.reasoning, null);
        assert.equal(r.coverage, 'unknown');
      }
    });
    await fixture([], async ({ home }) => {
      const result = await output(home, ['--json', '--by', 'branch']);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout).groups, []);
      fs.unlinkSync(path.join(home, 'logs', 'index.ndjson'));
      assert.equal(JSON.parse((await output(home, ['--json'])).stdout).totals.turns, 0);
    });
  });

  it('carries a complete cost confidence fold and provider totals', () => {
    const r = usageContract([turn('exact'), turn('fallback', { cost: { cost: 2, confidence: 'fallback' } }),
      turn('unknown', { provider: 'openai', usage: {}, cost: null, thinkingTokens: 0 })]);
    assert.equal(r.totals.cost, 3);
    assert.deepEqual(r.totals.costFold, { count: 3, fallbackCost: 2, fallbackCount: 1, unknownCount: 1 });
    assert.equal(r.totals.reasoningKnownTurns, 3);
    assert.equal(r.providerTotals.openai.tokens.reasoning, 0);
  });

  it('excludes markers when resolving latest and costliest session aliases', async () => {
    await fixture([turn('call'), { id: 'marker', receivedAt: T + 1,
      sessionId: 'marker-session', cost: { cost: 999 } }], async ({ home }) => {
      for (const alias of ['latest', 'costliest']) {
        const r = JSON.parse((await output(home, ['--json', '--turns', '--session', alias])).stdout);
        assert.equal(r.totals.turns, 1);
        assert.equal(r.turns[0].sessionId, 'session-1');
      }
    });
  });

  it('refuses side effects and invalid turn flag combinations', () => {
    assert.throws(() => parseArgs(['--json', '--open']), /read-only/);
    assert.throws(() => parseArgs(['--turns']), /requires --json/);
  });
});

// Schema manifests are deliberately literal: changing the contract requires a
// new version entry and migration notes, rather than updating an unversioned snapshot.
const V1_FIELDS = {
  root: ['schemaVersion', 'window', 'coverage', 'sourceCoverage', 'excludedMarkerRows',
    'nullAgentIdTurns', 'nullBranchTurns', 'totals', 'providerTotals', 'by', 'groups', 'turns'],
  summary: ['turns', 'tokens', 'reasoningKnownTurns', 'cost', 'costFold', 'models', 'firstTs', 'lastTs'],
  turn: ['id', 'sessionId', 'agentId', 'branch', 'cwd', 'provider', 'model', 'receivedAt',
    'tokens', 'cost', 'costConfidence', 'costFold', 'sources'],
};
const keys = value => Object.keys(value).sort();
it('Scenario 1: schemaVersion pins the complete stable field set', async () => {
  const manifests = { 1: V1_FIELDS };
  await fixture([turn('a')], async ({ home }) => {
    const r = JSON.parse((await output(home, ['--json', '--turns', '--by', 'agent'])).stdout);
    assert.equal(r.schemaVersion, 1);
    const manifest = manifests[r.schemaVersion];
    const contract = usageContract([turn('a')], { turns: true, by: 'agent' });
    assert.deepEqual(keys(contract), [...manifest.root].sort());
    assert.deepEqual(keys(r.totals), [...manifest.summary].sort());
    assert.deepEqual(keys(r.providerTotals.anthropic), [...manifest.summary].sort());
    assert.deepEqual(keys(r.groups[0]), [...manifest.summary, 'key'].sort());
    assert.deepEqual(keys(r.turns[0]), [...manifest.turn].sort());
    assert.deepEqual(keys(r.window), ['from', 'to']);
    assert.deepEqual(keys(r.sourceCoverage), ['import', 'proxy']);
    assert.deepEqual(keys(r.totals.tokens), ['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning']);
    assert.deepEqual(keys(r.totals.costFold), ['count', 'fallbackCost', 'fallbackCount', 'unknownCount']);
    const noTurns = JSON.parse((await output(home, ['--json'])).stdout);
    assert.equal(noTurns.schemaVersion, r.schemaVersion);
    assert.equal(Object.hasOwn(noTurns, 'turns'), false);
  });
});

it('Scenario 2: source coverage distinguishes missing observations from zero usage', async () => {
  await fixture([turn('proxy', { usage: {} })], async ({ home }) => {
    const r = JSON.parse((await output(home, ['--json'])).stdout);
    assert.equal(r.coverage, 'unknown');
    assert.deepEqual(r.sourceCoverage, { proxy: 'observed', import: 'not-observed' });
    assert.equal(Object.hasOwn(r.providerTotals, 'openai'), false);
    const empty = JSON.parse((await output(home, ['--json', '--agent-id', 'missing'])).stdout);
    assert.equal(empty.totals.turns, 0);
    assert.equal(empty.coverage, 'unknown');
    assert.deepEqual(empty.sourceCoverage, { proxy: 'not-observed', import: 'not-observed' });
  });
  await fixture([turn('proxy', { responseId: 'copy' }),
    turn('import', { responseId: 'copy', imported: true })], async ({ home }) => {
    const r = JSON.parse((await output(home, ['--json'])).stdout);
    assert.deepEqual(r.sourceCoverage, { proxy: 'observed', import: 'observed' });
    assert.equal(r.totals.turns, 1);
  });
});

it('Scenario 3: documented schema and compatibility rules match version 1', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/usage-query-contract.md'), 'utf8');
  const schema = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(keys(schema.properties), [...V1_FIELDS.root].sort());
  assert.deepEqual(schema.required.sort(), V1_FIELDS.root.filter(k => k !== 'turns').sort());
  assert.deepEqual(schema.$defs.turn.required.sort(), [...V1_FIELDS.turn].sort());
  assert.deepEqual(schema.$defs.summary.required.sort(), [...V1_FIELDS.summary].sort());
  assert.match(doc, /Any field addition, removal, rename, type or semantic change requires a new schema version/);
  assert.match(doc, /not-observed.*never.*zero/);
  assert.match(doc, /index.ndjson.*internal/);
});

it('Scenario 5: main integration preserves grouping and resolves all four review follow-ups', async () => {
  await fixture([
    turn('proxy', { responseId: 'copy', branch: null }),
    turn('import', { responseId: 'copy', agentId: null, imported: true }),
    turn('undated', { receivedAt: null }),
    turn('codex', { sessionId: 'codex', provider: 'openai', imported: true, usage: {} }),
  ], async ({ home }) => {
    const flags = ['--json', '--agent-id', 'run-demo', '--branch', 'main', '--to', iso(T + 1)];
    const plain = JSON.parse((await output(home, flags)).stdout);
    const grouped = JSON.parse((await output(home, [...flags, '--by', 'agent'])).stdout);
    assert.equal(plain.totals.turns, 2); // merged response + import-only Codex; no undated row
    assert.equal(grouped.groups[0].turns, plain.totals.turns);
    const codex = JSON.parse((await output(home, ['--json', '--session', 'codex'])).stdout);
    assert.equal(codex.totals.tokens.reasoning, null);
    const result = await output(home, ['--json', '--by', 'agent', '--agent-id', 'missing']);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).groups, []);
  });
});
