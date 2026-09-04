'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze } = require('../server/usage');
const { buildIndexLine } = require('../server/entry');

// Deterministic CLI fixture: an isolated CCXRAY_HOME with a known index so the
// e2e tests don't depend on the runner's real ~/.ccxray (which is empty in CI).
// Two sessions live under /work/*, one under /other/* so a `/work` prefix is a
// strict subset; session A is the costliest so its id leads topSessions.
const FIXTURE = [
  { id: '2026-06-01T10-00-00-000', ts: '10:00:00', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', provider: 'anthropic', agent: 'claude', model: 'claude-opus-4-6', msgCount: 10, toolCount: 5, toolCalls: { Bash: 3, Read: 2, Skill: 1 }, skillCalls: { 'superpowers:brainstorming': 1 }, isSubagent: false, cwd: '/work/project-alpha', receivedAt: 1717236000000, usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 }, cost: { cost: 0.50 }, title: 'Fix login bug', sysHash: 'a1', toolsHash: 'b1', coreHash: 'c1', toolFail: false, elapsed: '2.0' },
  { id: '2026-06-01T10-01-00-000', ts: '10:01:00', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', provider: 'anthropic', agent: 'claude', model: 'claude-opus-4-6', msgCount: 12, toolCount: 5, toolCalls: { Bash: 1 }, isSubagent: false, cwd: '/work/project-alpha', receivedAt: 1717236060000, usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 }, cost: { cost: 0.30 }, title: 'Fix login bug', sysHash: 'a1', toolsHash: 'b1', coreHash: 'c2', toolFail: false, elapsed: '1.5' },
  { id: '2026-06-02T10-00-00-000', ts: '10:00:00', sessionId: 'bbbbbbbb-5555-6666-7777-888888888888', provider: 'anthropic', agent: 'claude', model: 'claude-sonnet-4-6', msgCount: 6, toolCount: 3, toolCalls: { Read: 1 }, isSubagent: false, cwd: '/work/project-beta', receivedAt: 1717322400000, usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 150 }, cost: { cost: 0.20 }, title: 'Add tests', sysHash: 's1', toolsHash: 't1', coreHash: 'u1', toolFail: false, elapsed: '1.0' },
  { id: '2026-06-02T10-01-00-000', ts: '10:01:00', sessionId: 'bbbbbbbb-5555-6666-7777-888888888888', provider: 'anthropic', agent: 'claude', model: 'claude-sonnet-4-6', msgCount: 8, toolCount: 3, toolCalls: { Edit: 1 }, isSubagent: true, cwd: '/work/project-beta', receivedAt: 1717322460000, usage: { input_tokens: 40, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 }, cost: { cost: 0.10 }, title: 'Add tests', sysHash: 's1', toolsHash: 't1', coreHash: 'u1', toolFail: true, elapsed: '0.8' },
  { id: '2026-06-03T10-00-00-000', ts: '10:00:00', sessionId: 'cccccccc-9999-0000-1111-222222222222', provider: 'anthropic', agent: 'claude', model: 'claude-opus-4-6', msgCount: 4, toolCount: 2, toolCalls: { Bash: 1 }, isSubagent: false, cwd: '/other/project-gamma', receivedAt: 1717408800000, usage: { input_tokens: 30, output_tokens: 15, cache_creation_input_tokens: 50, cache_read_input_tokens: 60 }, cost: { cost: 0.05 }, title: 'Tweak config', sysHash: 'g1', toolsHash: 'h1', coreHash: 'i1', toolFail: false, elapsed: '0.5' },
];

const FIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-test-'));
fs.mkdirSync(path.join(FIX_HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(FIX_HOME, 'logs', 'index.ndjson'), FIXTURE.map(e => JSON.stringify(e)).join('\n') + '\n');
process.on('exit', () => { try { fs.rmSync(FIX_HOME, { recursive: true, force: true }); } catch {} });

const cli = (...args) => execFileSync(
  process.execPath, ['server/index.js', 'usage', ...args],
  { env: { ...process.env, CCXRAY_HOME: FIX_HOME, LOG_RETENTION_DAYS: '14' }, timeout: 10000 }
).toString();

const cliErr = (...args) => {
  try { cli(...args); return null; }
  catch (e) { return { code: e.status, stderr: e.stderr?.toString() || '', stdout: e.stdout?.toString() || '' }; }
};

const entry = (overrides = {}) => ({
  id: '2026-01-01T00-00-00-000', sessionId: 's1', provider: 'anthropic',
  agent: 'claude', model: 'claude-opus-4-6', msgCount: 10, toolCount: 3,
  toolCalls: { Bash: 2, Read: 1 }, isSubagent: false, receivedAt: 1000,
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 },
  cost: { cost: 0.5 }, sysHash: 'aaa', toolsHash: 'bbb', coreHash: 'ccc',
  toolFail: false, ...overrides,
});

const SYNTHETIC_RETENTION_NOW = new Date('2026-03-15T20:30:00.000Z');
const syntheticIndexEntry = (overrides = {}) => JSON.parse(buildIndexLine({
  id: '2026-03-16T04-30-00-000', ts: '04:30:00',
  sessionId: 'synthetic-session-0001', provider: 'synthetic-provider',
  agent: 'synthetic-agent', model: 'synthetic-model', msgCount: 1, toolCount: 0,
  toolCalls: {}, isSubagent: false, cwd: '/synthetic/project',
  receivedAt: SYNTHETIC_RETENTION_NOW.getTime(), usage: {
    input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  },
  cost: { cost: 0.01 }, title: 'Synthetic usage turn', sysHash: 'synthetic-sys',
  toolsHash: 'synthetic-tools', coreHash: 'synthetic-core', toolFail: false,
  ...overrides,
}));

function syntheticUsageHome(entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-retention-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return home;
}

function retentionCli(home, env, ...args) {
  return execFileSync(
    process.execPath, ['server/index.js', 'usage', ...args],
    { env: { ...process.env, CCXRAY_HOME: home, ...env }, timeout: 10000 },
  ).toString();
}

describe('usage analyze', () => {
  it('computes meta from entries', () => {
    const r = analyze([entry(), entry({ id: '2', receivedAt: 2000, sessionId: 's2' })]);
    assert.equal(r.meta.totalEntries, 2);
    assert.equal(r.meta.totalSessions, 2);
    assert.equal(r.meta.totalCost, 1);
  });

  it('counts live and imported copies with the same responseId once', () => {
    const imported = entry({
      id: 'imported-copy',
      responseId: 'msg_same_turn',
      imported: true,
      cost: { cost: 1.15 },
    });
    const live = entry({
      id: 'live-copy',
      responseId: 'msg_same_turn',
      agentKey: 'herdr:w1:p3',
      cost: { cost: 1.15 },
    });

    const r = analyze([imported, live]);

    assert.equal(r.meta.totalEntries, 1);
    assert.equal(r.meta.totalCost, 1.15);
    assert.equal(r.sessions.topSessions[0].turns, 1);
    assert.equal(imported.imported, true, 'analyze must not mutate caller entries');
  });

  it('computes model breakdown', () => {
    const r = analyze([entry(), entry({ model: 'claude-sonnet-4-6', cost: { cost: 0.1 } })]);
    assert.equal(r.models.length, 2);
    assert.equal(r.models[0].turns, 1);
  });

  it('aggregates tool calls — legacy per-session max, not cumulative sum (#427)', () => {
    // Both entries are legacy (no turnToolCalls), same session s1.
    // Default: { Bash: 2, Read: 1 }, override: { Bash: 3, Write: 1 }
    // Per-session max: Bash=3, Read=1, Write=1 = total 5 (not 7 from old sum)
    const r = analyze([entry(), entry({ toolCalls: { Bash: 3, Write: 1 } })]);
    assert.equal(r.tools.totalCalls, 5);
    assert.equal(r.tools.top[0].name, 'Bash');
    assert.equal(r.tools.top[0].count, 3);
  });

  it('caps tools.top at 7 by default; --tools lifts the cap', () => {
    const tools = {};
    for (let i = 0; i < 10; i++) tools['T' + i] = 10 - i;
    const e = entry({ toolCalls: tools });
    assert.equal(analyze([e]).tools.top.length, 7);
    assert.equal(analyze([e], { tools: true }).tools.top.length, 10);
  });

  it('computes hash stability within session', () => {
    const r = analyze([
      entry({ receivedAt: 1, sysHash: 'a', toolsHash: 'x', coreHash: 'p' }),
      entry({ receivedAt: 2, sysHash: 'b', toolsHash: 'x', coreHash: 'p' }),
      entry({ receivedAt: 3, sysHash: 'c', toolsHash: 'x', coreHash: 'q' }),
    ]);
    assert.equal(r.prompts.hashStability.sysHash.changeRate, 1);
    assert.equal(r.prompts.hashStability.sysHash.label, 'every-turn');
    assert.equal(r.prompts.hashStability.toolsHash.changeRate, 0);
    assert.equal(r.prompts.hashStability.toolsHash.label, 'never');
    assert.equal(r.prompts.hashStability.coreHash.changeRate, 0.5);
    assert.equal(r.prompts.hashStability.coreHash.label, 'frequent');
  });

  it('computes cache hit rate', () => {
    const r = analyze([entry()]);
    // 700 cache_read / (100 + 200 + 700) = 0.7
    assert.equal(r.cache.hitRate, 0.7);
  });

  it('counts subagent ratio', () => {
    const r = analyze([entry(), entry({ isSubagent: true, sessionId: 's2' })]);
    assert.equal(r.sessions.subagentRatio, 0.5);
  });

  it('handles entries with missing fields', () => {
    const r = analyze([{ id: 'x', receivedAt: 1000 }]);
    assert.equal(r.meta.totalEntries, 1);
    assert.equal(r.tools.totalCalls, 0);
    assert.equal(r.cache.hitRate, 0);
  });

  it('computes tool fail rate', () => {
    const r = analyze([entry(), entry({ toolFail: true })]);
    assert.equal(r.tools.failRate, 0.5);
  });

  it('tracks skill invocations and loads from the skillCalls field', () => {
    const r = analyze([
      entry({ skillCalls: { 'code-review': 1 } }),
      entry({ skillCalls: { 'code-review': 2, 'agmsg': 1 } }),
      entry({ skillCalls: { 'code-review': 1 }, sessionId: 's2' }),
    ]);
    assert.equal(r.skills.length, 2);
    const cr = r.skills.find(s => s.name === 'code-review');
    assert.equal(cr.invocations, 4); // 1 + 2 + 1
    assert.equal(cr.loads, 2);       // s1 + s2
    const ag = r.skills.find(s => s.name === 'agmsg');
    assert.equal(ag.invocations, 1);
    assert.equal(ag.loads, 1);
    // analyze() is pure: scope resolves only from an explicit scopeMap, never
    // the runner's installed skills.
    assert.equal(cr.scope, null);
  });

  it('resolves skill scope from an injected scopeMap (analyze stays pure)', () => {
    const r = analyze([entry({ skillCalls: { 'code-review': 1 } })], { scopeMap: { 'code-review': 'plugin' } });
    assert.equal(r.skills.find(s => s.name === 'code-review').scope, 'plugin');
  });

  it('shows legacy Skill as pre-tracking', () => {
    const r = analyze([entry({ toolCalls: { Skill: 3 } })]);
    assert.equal(r.skills.length, 1);
    assert.equal(r.skills[0].name, '(pre-tracking)');
    assert.equal(r.skills[0].invocations, 3);
    assert.equal(r.skills[0].loads, null);
  });

  it('excludes sentinel sessions from topSessions', () => {
    const r = analyze([
      entry({ sessionId: 'unknown', cost: { cost: 999 } }),
      entry({ sessionId: 'direct-api', cost: { cost: 888 } }),
      entry({ sessionId: 'real-session', cost: { cost: 1 } }),
    ]);
    const ids = r.sessions.topSessions.map(s => s.sessionId);
    assert.ok(!ids.includes('unknown'));
    assert.ok(!ids.includes('direct-api'));
    assert.ok(ids.includes('real-session'));
  });

  it('computes gap-vs-cache buckets', () => {
    const r = analyze([
      entry({ sessionId: 's1', receivedAt: 1000, elapsed: '1', usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } }),
      entry({ sessionId: 's1', receivedAt: 3000, elapsed: '1', usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } }),
    ]);
    assert.ok(r.gapCache.length > 0);
    assert.equal(r.gapCache[0].gap, '<30s');
    assert.equal(r.gapCache[0].turns, 1);
    assert.equal(r.gapCache[0].avgHitRate, 0.9);
  });

  it('analyze([]) returns a zeroed result with no NaN', () => {
    const r = analyze([]);
    assert.equal(r.meta.totalEntries, 0);
    assert.equal(r.sessions.subagentRatio, 0);
    assert.equal(r.tools.failRate, 0);
    assert.equal(r.cache.hitRate, 0);
    assert.deepEqual(r.gapCache, []);
  });

  it('gapVsCache skips non-finite gaps instead of crashing', () => {
    // missing/non-numeric receivedAt → NaN gap must be skipped (a NaN misses
    // even the max:Infinity bucket and would throw on the bucket lookup)
    const r = analyze([
      entry({ sessionId: 'g', receivedAt: undefined, elapsed: 'x' }),
      entry({ sessionId: 'g', receivedAt: undefined, elapsed: 'x' }),
    ]);
    assert.deepEqual(r.gapCache, []);
  });

  it('includes title in topSessions', () => {
    const r = analyze([
      entry({ sessionId: 'titled', title: 'Fix login bug' }),
      entry({ sessionId: 'titled', title: '↩ Bash' }),
    ]);
    const s = r.sessions.topSessions.find(s => s.sessionId === 'titled');
    assert.equal(s.title, 'Fix login bug');
  });
});

describe('usage retention disclosure', () => {
  it('warns all-time despite only surviving post-cutoff data (fail-on-old differential)', () => {
    const result = analyze([syntheticIndexEntry()], {
      env: { LOG_RETENTION_DAYS: '14' }, now: SYNTHETIC_RETENTION_NOW,
    });
    const expectedCutoff = new Date(SYNTHETIC_RETENTION_NOW);
    expectedCutoff.setDate(expectedCutoff.getDate() - 14);
    const expectedCutoffDate = expectedCutoff
      .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })
      .slice(0, 10);

    assert.equal(result.meta.retentionDays, 14);
    assert.equal(result.meta.retentionCutoff, expectedCutoffDate);
    assert.ok(result.meta.timeRange.from > `${expectedCutoffDate}T00:00:00.000Z`, 'surviving data is newer than the cutoff');
    assert.match(result.meta.retentionWarning, /older history may have been removed by retention/i);
    assert.match(result.meta.retentionWarning, /lower bound/i);
  });

  it('warns only when a requested --last start has a Taipei date before the cutoff', () => {
    const base = { env: { LOG_RETENTION_DAYS: '14' }, now: SYNTHETIC_RETENTION_NOW };
    const atCutoff = analyze([syntheticIndexEntry()], {
      ...base, since: Date.parse('2026-03-01T16:00:00.000Z'), // 2026-03-02 in Taipei
    });
    const beforeCutoff = analyze([syntheticIndexEntry()], {
      ...base, since: Date.parse('2026-03-01T15:59:59.999Z'), // 2026-03-01 in Taipei
    });

    assert.equal(Object.hasOwn(atCutoff.meta, 'retentionWarning'), false);
    assert.match(beforeCutoff.meta.retentionWarning, /reliable retention window/i);
  });

  it('keeps retentionDays but disables the cutoff warning when retention is disabled', () => {
    const result = analyze([syntheticIndexEntry()], {
      env: { LOG_RETENTION_DAYS: '0' }, now: SYNTHETIC_RETENTION_NOW,
    });

    assert.equal(result.meta.retentionDays, 0);
    assert.equal(result.meta.retentionCutoff, null);
    assert.equal(Object.hasOwn(result.meta, 'retentionWarning'), false);
  });

  it('publishes a malformed retention setting as null without a cutoff or warning', () => {
    const result = analyze([syntheticIndexEntry()], {
      env: { LOG_RETENTION_DAYS: 'not-a-number' }, now: SYNTHETIC_RETENTION_NOW,
    });
    assert.equal(result.meta.retentionDays, null);
    assert.equal(result.meta.retentionCutoff, null);
    assert.equal(Object.hasOwn(result.meta, 'retentionWarning'), false);

    const home = syntheticUsageHome([syntheticIndexEntry()]);
    try {
      const json = JSON.parse(retentionCli(home, { LOG_RETENTION_DAYS: 'not-a-number' }, '--json'));
      assert.equal(Object.hasOwn(json.meta, 'retentionDays'), true);
      assert.equal(json.meta.retentionDays, null);
      assert.equal(json.meta.retentionCutoff, null);
      assert.equal(Object.hasOwn(json.meta, 'retentionWarning'), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders the same retention warning in JSON and the human time-range line', () => {
    const now = Date.now();
    const home = syntheticUsageHome([syntheticIndexEntry({
      id: '2099-01-01T00-00-00-000', receivedAt: now - 1000,
    })]);
    try {
      const json = JSON.parse(retentionCli(home, { LOG_RETENTION_DAYS: '14' }, '--json'));
      const human = retentionCli(home, { LOG_RETENTION_DAYS: '14' });
      const currentWindowJson = JSON.parse(retentionCli(home, { LOG_RETENTION_DAYS: '14' }, '--json', '--last', '1h'));
      const currentWindowHuman = retentionCli(home, { LOG_RETENTION_DAYS: '14' }, '--last', '1h');
      const disabledJson = JSON.parse(retentionCli(home, { LOG_RETENTION_DAYS: '0' }, '--json'));
      const disabledHuman = retentionCli(home, { LOG_RETENTION_DAYS: '0' });

      assert.match(json.meta.retentionWarning, /lower bound/i);
      assert.match(human, /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} — Requested range reaches past the reliable retention window; older history may have been removed by retention, so totals are a LOWER BOUND\./);
      assert.ok(human.includes(json.meta.retentionWarning), 'human output must render the JSON warning verbatim');
      assert.equal(Object.hasOwn(currentWindowJson.meta, 'retentionWarning'), false);
      assert.doesNotMatch(currentWindowHuman, /lower bound/i);
      assert.equal(disabledJson.meta.retentionDays, 0);
      assert.equal(Object.hasOwn(disabledJson.meta, 'retentionWarning'), false);
      assert.doesNotMatch(disabledHuman, /lower bound/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('usage parseArgs', () => {
  it('--last with an invalid duration exits 1 instead of silently ignoring it', () => {
    const r = cliErr('--json', '--last', '7x');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid --last duration/);
  });

  it('--last 0d matches nothing and exits 1', () => {
    const r = cliErr('--json', '--last', '0d');
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error, 'no matching entries');
  });

  it('--last 9999d includes all entries', () => {
    const out = cli('--json', '--last', '9999d');
    const r = JSON.parse(out);
    assert.ok(r.meta.totalEntries > 0);
  });

  it('--cwd with no match exits 1', () => {
    const r = cliErr('--json', '--cwd', '/nonexistent/path/xyz');
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error, 'no matching entries');
  });

  it('--cwd with broad prefix returns subset', () => {
    const all = JSON.parse(cli('--json'));
    // /work matches project-alpha + project-beta (4 turns) but not /other/project-gamma
    const out = cli('--json', '--cwd', '/work');
    const r = JSON.parse(out);
    assert.equal(r.meta.totalEntries, 4);
    assert.ok(r.meta.totalEntries < all.meta.totalEntries);
  });

  it('--cwd bare name is a case-insensitive substring match', () => {
    const r = JSON.parse(cli('--json', '--cwd', 'ALPHA'));
    assert.equal(r.meta.totalEntries, 2); // /work/project-alpha
  });

  it('--cwd strips a leading ./ before substring matching', () => {
    const r = JSON.parse(cli('--json', '--cwd', './project-beta'));
    assert.equal(r.meta.totalEntries, 2); // /work/project-beta
  });

  it('--cwd absolute prefix is path-bound (no sibling-dir bleed)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cwdbound-'));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    const lines = [
      { id: 'a', sessionId: 's-in', receivedAt: 2, cwd: '/work/proj', cost: { cost: 1 } },
      { id: 'b', sessionId: 's-sib', receivedAt: 1, cwd: '/work/proj-sibling', cost: { cost: 1 } },
    ];
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const r = JSON.parse(execFileSync(
        process.execPath, ['server/index.js', 'usage', '--json', '--cwd', '/work/proj'],
        { env: { ...process.env, CCXRAY_HOME: home }, timeout: 10000 },
      ).toString());
      assert.equal(r.meta.totalEntries, 1); // /work/proj only, not /work/proj-sibling
      assert.equal(r.sessions.topSessions[0].sessionId, 's-in');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--cwd expands ~ to home for prefix matching', () => {
    // stored cwds are absolute, so a literal ~/… prefix must be expanded first.
    // Use a throwaway $HOME so the test never touches the real home directory.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    const ccxrayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cwd-'));
    fs.mkdirSync(path.join(ccxrayHome, 'logs'), { recursive: true });
    const projCwd = path.join(fakeHome, 'demo-proj');
    fs.writeFileSync(path.join(ccxrayHome, 'logs', 'index.ndjson'),
      JSON.stringify({ id: 'i', sessionId: 's', receivedAt: 1, cwd: projCwd, cost: { cost: 1 } }) + '\n');
    try {
      const r = JSON.parse(execFileSync(
        process.execPath, ['server/index.js', 'usage', '--json', '--cwd', '~/demo-proj'],
        { env: { ...process.env, HOME: fakeHome, CCXRAY_HOME: ccxrayHome }, timeout: 10000 },
      ).toString());
      assert.equal(r.meta.totalEntries, 1);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(ccxrayHome, { recursive: true, force: true });
    }
  });

  it('--cwd comma-separated matches union of paths', () => {
    const r = cliErr('--json', '--cwd', '/no/match/a,/no/match/b');
    assert.equal(r.code, 1);
    // both paths tried, neither matched
    const err = JSON.parse(r.stdout);
    assert.equal(err.error, 'no matching entries');
  });

  it('--cwd repeated flag accumulates', () => {
    const r = cliErr('--json', '--cwd', '/no/match/a', '--cwd', '/no/match/b');
    assert.equal(r.code, 1);
  });

  it('--last and --cwd combine — no match exits 1', () => {
    const r = cliErr('--json', '--last', '9999d', '--cwd', '/nonexistent');
    assert.equal(r.code, 1);
  });

  it('empty result from --session + --cwd names both filters in the hint', () => {
    const r = cliErr('--json', '--session', 'aaaaaaaa', '--cwd', '/no/such/dir');
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.match(err.hint, /--session/);
    assert.match(err.hint, /--cwd/);
  });

  it('--last and --session combine', () => {
    const all = JSON.parse(cli('--json'));
    if (!all.sessions.topSessions?.length) return;
    const sid = all.sessions.topSessions[0].sessionId;
    const out = cli('--json', '--last', '9999d', '--session', sid);
    const r = JSON.parse(out);
    assert.equal(r.meta.totalSessions, 1);
  });

  it('--session accepts prefix match', () => {
    const all = JSON.parse(cli('--json'));
    if (!all.sessions.topSessions?.length) return;
    const sid = all.sessions.topSessions[0].sessionId;
    const prefix = sid.slice(0, 8);
    const out = cli('--json', '--session', prefix);
    const r = JSON.parse(out);
    assert.ok(r.meta.totalEntries > 0);
  });

  it('--session latest resolves by receivedAt, not file order', () => {
    // newest-by-receivedAt is the FIRST line; the last line is older — file
    // order would pick the wrong session under hub concurrency / restoration.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-latest-'));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    const lines = [
      { id: 'x1', sessionId: 'newest-sess', receivedAt: 5000, cost: { cost: 0.1 } },
      { id: 'x2', sessionId: 'older-sess', receivedAt: 1000, cost: { cost: 0.1 } },
    ];
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const r = JSON.parse(execFileSync(
        process.execPath, ['server/index.js', 'usage', '--json', '--session', 'latest'],
        { env: { ...process.env, CCXRAY_HOME: home }, timeout: 10000 },
      ).toString());
      assert.equal(r.meta.totalSessions, 1);
      assert.equal(r.sessions.topSessions[0].sessionId, 'newest-sess');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--session latest is scoped by --cwd (alias resolved after filtering)', () => {
    // global latest is /other/project-gamma; within /work the latest is session bbbb…
    const r = JSON.parse(cli('--json', '--session', 'latest', '--cwd', '/work'));
    assert.equal(r.meta.totalSessions, 1);
    assert.equal(r.sessions.topSessions[0].sessionId, 'bbbbbbbb-5555-6666-7777-888888888888');
  });

  it('--session costliest is scoped by --cwd (alias resolved after filtering)', () => {
    // global costliest is session aaaa ($0.80); restricted to /work/project-beta it's bbbb
    const r = JSON.parse(cli('--json', '--session', 'costliest', '--cwd', '/work/project-beta'));
    assert.equal(r.meta.totalSessions, 1);
    assert.equal(r.sessions.topSessions[0].sessionId, 'bbbbbbbb-5555-6666-7777-888888888888');
  });

  it('--session costliest resolves after responseId deduplication', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-costliest-dedup-'));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    const lines = [
      { id: 'imported', responseId: 'msg_duplicate', imported: true, sessionId: 'duplicated-session', receivedAt: 1, cost: { cost: 1 } },
      { id: 'live', responseId: 'msg_duplicate', agentKey: 'herdr:w1:p1', sessionId: 'duplicated-session', receivedAt: 2, cost: { cost: 1 } },
      { id: 'actual', responseId: 'msg_actual', sessionId: 'actual-costliest', receivedAt: 3, cost: { cost: 1.5 } },
    ];
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const r = JSON.parse(execFileSync(
        process.execPath, ['server/index.js', 'usage', '--json', '--session', 'costliest'],
        { env: { ...process.env, CCXRAY_HOME: home }, timeout: 10000 },
      ).toString());
      assert.equal(r.meta.totalSessions, 1);
      assert.equal(r.sessions.topSessions[0].sessionId, 'actual-costliest');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('usage CLI', () => {
  it('--help prints usage and exits 0', () => {
    const out = cli('--help');
    assert.ok(out.includes('--json'));
    assert.ok(out.includes('--session'));
    assert.ok(out.includes('--tools'));
  });

  it('--json outputs valid JSON', () => {
    const out = cli('--json');
    const r = JSON.parse(out);
    assert.ok(r.meta);
    assert.ok(r.sessions);
    assert.ok(r.models);
    assert.ok(r.tools);
    assert.ok(r.cache);
  });

  it('--json output is under 5KB', () => {
    const out = cli('--json');
    assert.ok(Buffer.byteLength(out) < 5120, `JSON output ${Buffer.byteLength(out)} bytes exceeds 5KB`);
  });

  it('--session with nonexistent id exits 1', () => {
    const r = cliErr('--session', 'nonexistent-session-id-xyz');
    assert.equal(r.code, 1);
  });

  it('--json --session combined works', () => {
    const out = cli('--json');
    const r = JSON.parse(out);
    if (r.sessions.topSessions.length) {
      const sid = r.sessions.topSessions[0].sessionId;
      const filtered = JSON.parse(cli('--json', '--session', sid));
      assert.equal(filtered.meta.totalSessions, 1);
    }
  });

  it('no args outputs human-readable text', () => {
    const out = cli();
    assert.ok(out.includes('ccxray usage'));
    assert.ok(out.includes('Sessions'));
    assert.ok(out.includes('Models'));
    assert.ok(out.includes('Cache'));
  });

  it('bad CCXRAY_HOME exits 1 with JSON error', () => {
    try {
      execFileSync(process.execPath, ['server/index.js', 'usage', '--json'], {
        env: { ...process.env, CCXRAY_HOME: '/tmp/no-such-ccxray-dir-' + process.pid },
        timeout: 5000,
      });
      assert.fail('should have exited 1');
    } catch (e) {
      assert.equal(e.status, 1);
      const r = JSON.parse(e.stdout.toString());
      assert.equal(r.error, 'no logs found');
    }
  });
});

// Locks the agent-facing contract documented in docs/usage.md: the exact key
// set and field types of every section, plus the multi-cwd and error shapes.
// Exact-key assertions (not just "key exists") fail on BOTH a removed field and
// an accidentally-leaked extra one. A deliberate shape change must update this
// test AND docs/usage.md in the same commit — that coupling is the point.
describe('usage --json shape contract', () => {
  const sameKeys = (o, expected) => assert.deepEqual(Object.keys(o).sort(), [...expected].sort());

  it('single-scope object has exactly the documented top-level keys', () => {
    sameKeys(JSON.parse(cli('--json')), ['meta', 'sessions', 'models', 'tools', 'skills', 'prompts', 'cache', 'gapCache']);
  });

  it('meta has the documented shape', () => {
    const { meta } = JSON.parse(cli('--json'));
    sameKeys(meta, ['totalEntries', 'totalSessions', 'totalCost', 'retentionDays', 'retentionCutoff', 'retentionWarning', 'timeRange']);
    assert.equal(typeof meta.totalEntries, 'number');
    assert.equal(typeof meta.totalSessions, 'number');
    assert.equal(typeof meta.totalCost, 'number');
    assert.equal(typeof meta.retentionDays, 'number');
    assert.equal(typeof meta.retentionCutoff, 'string');
    assert.equal(typeof meta.retentionWarning, 'string');
    sameKeys(meta.timeRange, ['from', 'to']);
    // ISO strings here (every fixture entry has receivedAt); null only when absent.
    assert.equal(typeof meta.timeRange.from, 'string');
    assert.equal(typeof meta.timeRange.to, 'string');
  });

  it('sessions + topSessions[] have the documented shape', () => {
    const { sessions } = JSON.parse(cli('--json'));
    sameKeys(sessions, ['count', 'byProvider', 'subagentRatio', 'turnDistribution', 'topSessions']);
    assert.equal(typeof sessions.count, 'number');
    assert.equal(typeof sessions.byProvider, 'object');
    assert.equal(typeof sessions.subagentRatio, 'number');
    sameKeys(sessions.turnDistribution, ['min', 'median', 'p75', 'max']);
    assert.ok(Array.isArray(sessions.topSessions) && sessions.topSessions.length <= 10);
    for (const s of sessions.topSessions) {
      sameKeys(s, ['sessionId', 'turns', 'cost', 'costAgg', 'durationMin', 'title', 'model', 'provider']);
      // INVARIANT(ADR 0017): `costAgg` travels WITH `cost` — a consumer of this
      // JSON cannot see the turns, so it cannot re-derive the confidence fold,
      // and rendering `cost` without it is the unmarked-fabrication path.
      sameKeys(s.costAgg, ['count', 'fallbackCount', 'fallbackCost', 'unknownCount']);
      for (const k of ['count', 'fallbackCount', 'fallbackCost', 'unknownCount']) {
        assert.equal(typeof s.costAgg[k], 'number', `costAgg.${k} must be a number`);
      }
      assert.equal(typeof s.sessionId, 'string');
      assert.equal(typeof s.turns, 'number');
      assert.equal(typeof s.cost, 'number');
      assert.equal(typeof s.durationMin, 'number');
      assert.ok(s.title === null || typeof s.title === 'string');
      assert.equal(typeof s.model, 'string'); // dominant model, not a map
      assert.equal(typeof s.provider, 'string');
    }
  });

  it('models[] have the documented shape (≤10)', () => {
    const { models } = JSON.parse(cli('--json'));
    assert.ok(Array.isArray(models) && models.length <= 10);
    for (const m of models) {
      sameKeys(m, ['model', 'turns', 'cost', 'costShare']);
      assert.equal(typeof m.model, 'string');
      assert.equal(typeof m.turns, 'number');
      assert.equal(typeof m.cost, 'number');
      assert.equal(typeof m.costShare, 'number');
    }
  });

  it('tools + tools.top[] have the documented shape (default cap 7)', () => {
    const { tools } = JSON.parse(cli('--json'));
    sameKeys(tools, ['totalCalls', 'top', 'failRate']);
    assert.equal(typeof tools.totalCalls, 'number');
    assert.equal(typeof tools.failRate, 'number');
    assert.ok(Array.isArray(tools.top) && tools.top.length <= 7);
    for (const t of tools.top) {
      sameKeys(t, ['name', 'count']);
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.count, 'number');
    }
  });

  it('skills[] have the documented shape (loads/scope nullable)', () => {
    const { skills } = JSON.parse(cli('--json'));
    assert.ok(Array.isArray(skills));
    for (const s of skills) {
      sameKeys(s, ['name', 'invocations', 'loads', 'scope']);
      assert.equal(typeof s.name, 'string');
      assert.equal(typeof s.invocations, 'number');
      assert.ok(s.loads === null || typeof s.loads === 'number');
      assert.ok(s.scope === null || typeof s.scope === 'string');
    }
  });

  it('prompts.hashStability has the three documented hashes', () => {
    const { prompts } = JSON.parse(cli('--json'));
    sameKeys(prompts, ['hashStability']);
    sameKeys(prompts.hashStability, ['sysHash', 'toolsHash', 'coreHash']);
    for (const h of Object.values(prompts.hashStability)) {
      sameKeys(h, ['changeRate', 'pairs', 'label']);
      assert.equal(typeof h.changeRate, 'number');
      assert.equal(typeof h.pairs, 'number');
      assert.equal(typeof h.label, 'string');
    }
  });

  it('cache has the documented shape (all numeric)', () => {
    const { cache } = JSON.parse(cli('--json'));
    sameKeys(cache, ['hitRate', 'totalInputTokens', 'totalOutputTokens', 'totalCacheReadTokens']);
    for (const v of Object.values(cache)) assert.equal(typeof v, 'number');
  });

  it('gapCache[] have the documented shape (≤5 buckets)', () => {
    const { gapCache } = JSON.parse(cli('--json'));
    assert.ok(Array.isArray(gapCache) && gapCache.length <= 5);
    for (const b of gapCache) {
      sameKeys(b, ['gap', 'turns', 'avgHitRate', 'medianHitRate']);
      assert.equal(typeof b.gap, 'string');
      assert.equal(typeof b.turns, 'number');
      assert.equal(typeof b.avgHitRate, 'number');
      assert.equal(typeof b.medianHitRate, 'number');
    }
  });

  it('multi-cwd mode returns an array of the documented row shape, cost-desc', () => {
    const rows = JSON.parse(cli('--json', '--cwd', '/work,/other'));
    assert.ok(Array.isArray(rows) && rows.length > 0);
    for (const row of rows) {
      sameKeys(row, ['cwd', 'cost', 'sessions', 'turns', 'cacheHit']);
      assert.equal(typeof row.cwd, 'string');
      assert.equal(typeof row.cost, 'number');
      assert.equal(typeof row.sessions, 'number');
      assert.equal(typeof row.turns, 'number');
      assert.equal(typeof row.cacheHit, 'number');
    }
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].cost >= rows[i].cost);
  });

  it('error object is exactly { error, hint }', () => {
    const r = cliErr('--json', '--cwd', '/no/such/dir/at/all');
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    sameKeys(err, ['error', 'hint']);
    assert.equal(typeof err.error, 'string');
    assert.equal(typeof err.hint, 'string');
  });
});

// INVARIANT(ADR 0017): the human `costliest sessions` row is an aggregate cost
// display, so it renders through the shared fold-aware helper. It used to print
// a bare `$2` beside a --json payload that carried the fold — the same number,
// one honest and one not.
describe('usage human output marks aggregate cost confidence', () => {
  const homeWith = entries => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-human-'));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return home;
  };
  const humanCli = (home, ...args) => execFileSync(
    process.execPath, ['server/index.js', 'usage', ...args],
    { env: { ...process.env, CCXRAY_HOME: home }, timeout: 10000 },
  ).toString();

  it('marks an all-fallback session with ~ and an unpriced one with +', () => {
    const fallbackHome = homeWith([1, 2, 3, 4].map(i => entry({
      id: `fb-${i}`, responseId: `msg_fb_${i}`, sessionId: 's-fallback',
      receivedAt: 1717236000000 + i * 1000, cost: { cost: 0.5, confidence: 'fallback' },
    })));
    assert.match(humanCli(fallbackHome, '--last', '9999d'), /~\$/,
      'an all-fallback costliest-session row must carry the fabrication marker');

    // One priced turn plus one that contributed nothing: the total is a lower
    // bound, which `+` is the only thing on the row that says.
    const unknownHome = homeWith([
      entry({ id: 'uk-1', responseId: 'msg_uk_1', sessionId: 's-unknown', receivedAt: 1717236001000, cost: { cost: 0.5, confidence: 'exact' } }),
      entry({ id: 'uk-2', responseId: 'msg_uk_2', sessionId: 's-unknown', receivedAt: 1717236002000, cost: { cost: null, confidence: 'unknown' } }),
    ]);
    assert.match(humanCli(unknownHome, '--last', '9999d'), /\$0\.50\+/,
      'an excluded turn must show the total is a lower bound');
  });
});
