'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readMergedTurns, selectTurns, aggregate, query } = require('../server/usage-query');

const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);
const MIN = 60 * 1000;

function mkLogs(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-query-'));
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return logsDir;
}

const usage = (input, output, read, write) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });

describe('readMergedTurns: merge before filter', () => {
  it('selects a pre-#640 proxy row (cwd null) by its imported twin\'s cwd, counted once', async () => {
    const logsDir = mkLogs([
      { id: 'p1', sessionId: 'S1', provider: 'anthropic', cwd: null, responseId: 'msg_1', receivedAt: T0, usage: usage(10, 5, 100, 0), cost: { cost: 0.5, confidence: 'exact' } },
      { id: 'i1', sessionId: 'S1', provider: 'anthropic', cwd: '/work/a', responseId: 'msg_1', receivedAt: T0 + 2000, imported: true, importSource: 'claude-code', usage: usage(10, 5, 100, 0), cost: { cost: 0.4, confidence: 'fallback' }, effort: 'high' },
    ]);
    const { turns } = await readMergedTurns({ from: T0 - MIN, to: T0 + MIN, logsDir });
    const sel = selectTurns(turns, { roots: ['/work/a'], from: T0 - MIN, to: T0 + MIN });
    assert.equal(sel.length, 1);
    assert.equal(sel[0].id, 'p1', 'the proxy observation is canonical');
    assert.equal(sel[0].cwd, '/work/a');
    assert.equal(sel[0].effort, 'high', 'fields only the import carried survive the merge');
    assert.deepEqual(sel[0].sources, ['import', 'proxy'], 'both sources saw the turn: it has a proxy twin');
  });

  it('merges a twin that lies just outside the requested range', async () => {
    const logsDir = mkLogs([
      { id: 'i1', sessionId: 'S1', provider: 'anthropic', cwd: '/work/a', responseId: 'msg_1', receivedAt: T0 - 2 * MIN, imported: true, usage: usage(1, 1, 0, 0), cost: { cost: 0.1 } },
      { id: 'p1', sessionId: 'S1', provider: 'anthropic', cwd: null, responseId: 'msg_1', receivedAt: T0 + 1000, usage: usage(1, 1, 0, 0), cost: { cost: 0.1 } },
    ]);
    const r = await query({ roots: ['/work/a'], from: T0, to: T0 + MIN }, { logsDir });
    assert.equal(r.calls, 1);
  });

  it('gives a proxy-only row with no twin its session\'s cwd', async () => {
    const logsDir = mkLogs([
      { id: 'i1', sessionId: 'S1', provider: 'anthropic', cwd: '/work/a', responseId: 'msg_1', receivedAt: T0, imported: true },
      { id: 'p1', sessionId: 'S1', provider: 'anthropic', cwd: null, responseId: 'msg_1', receivedAt: T0 + 500 },
      { id: 'p2', sessionId: 'S1', provider: 'anthropic', cwd: null, responseId: 'msg_suggestion', receivedAt: T0 + 30000 },
    ]);
    const { turns } = await readMergedTurns({ from: T0 - MIN, to: T0 + MIN, logsDir });
    const sel = selectTurns(turns, { roots: ['/work/a'] });
    assert.deepEqual(sel.map(e => e.id).sort(), ['p1', 'p2']);
    assert.equal(sel.find(e => e.id === 'p2').cwdFromSession, true);
    assert.deepEqual(sel.find(e => e.id === 'p2').sources, ['proxy']);
  });

  it('passes legacy rows without a responseId through as-is', async () => {
    const logsDir = mkLogs([
      { id: 'l1', sessionId: 'S1', provider: 'anthropic', cwd: '/work/a', receivedAt: T0 },
      { id: 'l2', sessionId: 'S1', provider: 'anthropic', cwd: '/work/a', receivedAt: T0 + 1 },
    ]);
    const { turns } = await readMergedTurns({ logsDir });
    assert.equal(turns.length, 2);
  });
});

describe('fillSessionCwd', () => {
  const { fillSessionCwd } = require('../server/usage-query');
  const permutations = a => a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
  const filled = rows => Object.fromEntries(fillSessionCwd(structuredClone(rows)).filter(e => e.cwdFromSession).map(e => [e.id, e.cwd]));

  it('takes the session\'s host cwd past a shell cd and unflagged agent-worktree rows, in any input order', () => {
    const rows = [
      { id: 'h1', sessionId: 'S', cwd: '/r', receivedAt: 1000 },
      { id: 'h2', sessionId: 'S', cwd: '/r', receivedAt: 9000 },
      { id: 'cd', sessionId: 'S', cwd: '/r/.agents/skills/agentflow/scripts', receivedAt: 3000 },
      // legacy imported subagent rows: no isSubagent, agentKey or subagentId
      ...[2500, 2600, 2700, 2800].map((t, i) => ({ id: 'w' + i, sessionId: 'S', cwd: '/r/.claude/worktrees/agent-x', receivedAt: t })),
      { id: 'p1', sessionId: 'S', cwd: null, receivedAt: 3100 },
      { id: 'p2', sessionId: 'S', cwd: null, receivedAt: 2700 },
    ];
    for (const p of permutations(rows.slice(-5))) {
      assert.deepEqual(filled([...rows.slice(0, -5), ...p]), { p1: '/r', p2: '/r' });
    }
    assert.deepEqual(filled([...rows].reverse()), { p1: '/r', p2: '/r' });
  });

  it('keeps a linked-worktree host in its own checkout when one turn ran at the repository root', () => {
    assert.deepEqual(filled([
      { id: 'h1', sessionId: 'S', cwd: '/r/.worktrees/x', receivedAt: 1000 },
      { id: 'h2', sessionId: 'S', cwd: '/r/.worktrees/x', receivedAt: 2000 },
      { id: 'up', sessionId: 'S', cwd: '/r', receivedAt: 3000 },
      { id: 'p', sessionId: 'S', cwd: null, receivedAt: 3100 },
    ]), { p: '/r/.worktrees/x' });
  });

  it('ignores flagged subagent rows and breaks ties by the earliest-seen cwd', () => {
    assert.deepEqual(filled([
      { id: 's1', sessionId: 'S', cwd: '/b', receivedAt: 1, isSubagent: true },
      { id: 's2', sessionId: 'S', cwd: '/b', receivedAt: 2, subagentId: 'agent-1' },
      { id: 'b', sessionId: 'S', cwd: '/b', receivedAt: 5 },
      { id: 'a', sessionId: 'S', cwd: '/a', receivedAt: 4 },
      { id: 'p', sessionId: 'S', cwd: null, receivedAt: 6 },
    ]), { p: '/a' });
  });

  it('leaves a session with no observed cwd unfilled', () => {
    assert.deepEqual(filled([{ id: 'p', sessionId: 'S', cwd: null, receivedAt: 1 }]), {});
  });
});

describe('readMergedTurns: Codex one source per session', () => {
  it('reads a session from the proxy when the proxy recorded it, else from the import', async () => {
    const logsDir = mkLogs([
      { id: 'cp1', sessionId: 'C1', provider: 'openai', cwd: '/work/a', receivedAt: T0 },
      { id: 'cp2', sessionId: 'C1', provider: 'openai', cwd: '/work/a', receivedAt: T0 + 1000 },
      { id: 'ci1', sessionId: 'C1', provider: 'openai', cwd: '/work/a', receivedAt: T0 + 10, imported: true },
      { id: 'ci2', sessionId: 'C1', provider: 'openai', cwd: '/work/a', receivedAt: T0 + 1010, imported: true },
      { id: 'ci3', sessionId: 'C2', provider: 'openai', cwd: '/work/a', receivedAt: T0 + 2000, imported: true },
    ]);
    const { turns, codexSources } = await readMergedTurns({ logsDir });
    assert.deepEqual(turns.map(e => e.id).sort(), ['ci3', 'cp1', 'cp2']);
    assert.deepEqual(codexSources, { C1: 'proxy', C2: 'import' });
  });
});

describe('selectTurns', () => {
  const turns = [
    { id: 'a', sessionId: 'S1', cwd: '/work/a', receivedAt: T0 },
    { id: 'b', sessionId: 'S1', cwd: '/work/a/.worktrees/x', receivedAt: T0 },
    { id: 'c', sessionId: 'S2', cwd: '/work/a', receivedAt: T0 + MIN },
  ];
  it('matches roots exactly, not linked worktrees beneath them', () => {
    assert.deepEqual(selectTurns(turns, { roots: ['/work/a/'] }).map(e => e.id), ['a', 'c']);
  });
  it('uses a half-open time range and an optional session filter', () => {
    assert.deepEqual(selectTurns(turns, { from: T0, to: T0 + MIN }).map(e => e.id), ['a', 'b']);
    assert.deepEqual(selectTurns(turns, { sessions: ['S2'] }).map(e => e.id), ['c']);
  });
});

describe('aggregate', () => {
  it('sums tokens and cost with an ADR 0017 fold, models and effort by call count', () => {
    const r = aggregate([
      { model: 'm1', effort: 'high', receivedAt: T0, usage: usage(10, 20, 60, 30), cost: { cost: 1, confidence: 'exact' }, turnDurationMs: 4000 },
      { model: 'm1', effort: 'low', receivedAt: T0 + MIN, usage: usage(0, 5, 0, 0), cost: { cost: 0.5, confidence: 'fallback' } },
      { model: 'm2', receivedAt: T0 + 2 * MIN, usage: usage(0, 0, 0, 0), cost: { cost: null, confidence: 'unknown' }, turnDurationMs: 1000 },
    ]);
    assert.equal(r.calls, 3);
    assert.deepEqual(r.tokens, { input: 10, output: 25, cacheRead: 60, cacheWrite: 30 });
    assert.equal(r.cost, 1.5);
    assert.deepEqual(r.costFold, { fallbackCost: 0.5, fallbackCount: 1, unknownCount: 1, count: 3 });
    assert.deepEqual(r.models, { m1: 2, m2: 1 });
    assert.deepEqual(r.effort, { high: 1, low: 1, unknown: 1 });
    assert.equal(r.readShare, 60 / 100);
    assert.equal(r.durationMs, 5000);
    assert.equal(r.durationEstimated, false);
  });

  it('does not count a row with neither a model nor usage as a call', () => {
    const r = aggregate([{ model: 'm1', receivedAt: T0, usage: usage(1, 1, 0, 0), cost: { cost: 0.1 } }, { receivedAt: T0 + 1, cost: null }]);
    assert.equal(r.calls, 1);
    assert.equal(r.costFold.count, 1);
  });

  it('estimates executor time first-to-last when no turn carries turnDurationMs', () => {
    const r = aggregate([{ model: 'm', receivedAt: T0 }, { model: 'm', receivedAt: T0 + 90000 }]);
    assert.equal(r.durationMs, 90000);
    assert.equal(r.durationEstimated, true);
    assert.equal(r.readShare, null);
  });
});

describe('require purity', () => {
  // Samples after a short wait so a timer or price fetch started a tick later
  // is caught too; the sampling timer itself has fired by then.
  function probe(modules) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-query-pure-'));
    process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
    const script = `
      const before = process.getActiveResourcesInfo();
      for (const m of ${JSON.stringify(modules)}) require(m);
      // A timer still counts itself inside its own callback; sample one turn later.
      setTimeout(() => setImmediate(() => {
        // Sample before touching process.stdout, whose getter opens a pipe handle.
        const after = process.getActiveResourcesInfo();
        process.stdout.write(JSON.stringify({ before, after }));
        process.exit(0);
      }), 50);
    `;
    const env = { ...process.env, CCXRAY_HOME: home };
    delete env.LOGS_DIR;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
    return { ...out, files: fs.readdirSync(home) };
  }

  it('loading usage-query and the agentflow modules starts no handles and writes nothing', () => {
    const r = probe(['usage-query', 'agentflow/cli', 'agentflow/notebook', 'agentflow/evidence', 'agentflow/windows', 'agentflow/host', 'agentflow/discover', 'agentflow/completeness', 'agentflow/report', 'agentflow/runner', 'agentflow/chains', 'agentflow/records', 'agentflow/workers']
      .map(m => path.join(__dirname, '../server', m)));
    assert.deepEqual(r.after, r.before);
    assert.deepEqual(r.files, []);
  });

  it('the probe does catch a module that starts a timer on require', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-query-timer-'));
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(dir, 'timer.js'), 'setInterval(() => {}, 60000);');
    const r = probe([path.join(dir, 'timer.js')]);
    assert.ok(r.after.includes('Timeout'), r.after.join(', '));
  });
});
