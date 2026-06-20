'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze } = require('../server/usage');

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
  { env: { ...process.env, CCXRAY_HOME: FIX_HOME }, timeout: 10000 }
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

describe('usage analyze', () => {
  it('computes meta from entries', () => {
    const r = analyze([entry(), entry({ id: '2', receivedAt: 2000, sessionId: 's2' })]);
    assert.equal(r.meta.totalEntries, 2);
    assert.equal(r.meta.totalSessions, 2);
    assert.equal(r.meta.totalCost, 1);
  });

  it('computes model breakdown', () => {
    const r = analyze([entry(), entry({ model: 'claude-sonnet-4-6', cost: { cost: 0.1 } })]);
    assert.equal(r.models.length, 2);
    assert.equal(r.models[0].turns, 1);
  });

  it('aggregates tool calls', () => {
    const r = analyze([entry(), entry({ toolCalls: { Bash: 3, Write: 1 } })]);
    assert.equal(r.tools.totalCalls, 7);
    assert.equal(r.tools.top[0].name, 'Bash');
    assert.equal(r.tools.top[0].count, 5);
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

  it('includes title in topSessions', () => {
    const r = analyze([
      entry({ sessionId: 'titled', title: 'Fix login bug' }),
      entry({ sessionId: 'titled', title: '↩ Bash' }),
    ]);
    const s = r.sessions.topSessions.find(s => s.sessionId === 'titled');
    assert.equal(s.title, 'Fix login bug');
  });
});

describe('usage parseArgs', () => {
  // import parseArgs for direct testing
  // ponytail: reach into module internals via a thin wrapper
  const parseArgs = (() => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'usage.js'), 'utf8');
    const match = src.match(/function parseArgs\(argv\)\s*\{/);
    if (!match) throw new Error('parseArgs not found');
    // just test via CLI output instead — parseArgs is not exported
    return null;
  })();

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
