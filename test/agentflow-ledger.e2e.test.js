'use strict';

// A hand-written ledger for one fixture that reaches every bucket of the
// report, derived from docs/agentflow-integration.md before the report was
// run. Each index turn is assigned to exactly one bucket, and the report must
// account for every turn the ledger keeps (conservation): nothing lost, nothing
// counted twice. The report carries no turn ids, so buckets are compared by
// their call counts. Nothing real is read: everything lives in a temp dir.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-ledger-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const REPO = path.join(BASE, 'repo');
const HOME = path.join(BASE, 'ccxray-home');
const CLAUDE = path.join(BASE, 'claude', 'projects');
const CODEX = path.join(BASE, 'codex', 'sessions');
const S1 = '11111111-0000-0000-0000-000000000001';
const S2 = '22222222-0000-0000-0000-000000000002';
const S9 = '99999999-0000-0000-0000-000000000009';
const C1 = path.join(BASE, 'T', 'agentflow-external-runner-C1', 'clone');
const C2 = path.join(BASE, 'T', 'agentflow-external-runner-C2', 'clone');
const C3 = path.join(BASE, 'T', 'agentflow-external-runner-C3', 'clone');
const C4 = path.join(BASE, 'T', 'agentflow-external-runner-C4', 'clone');
const CHOSEN = path.join(BASE, 'chosen-clone');
const t = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(t(s)).toISOString();

// Notebook N (reported): A-001 [50, 720) = stamp 600 + 2 min tail; A-002
// [800, 1920). Notebook M of the same workspace: A-001 opens at 1000, still open.
// S1 is a host of both (prompt-match in each); S2 of N only (bare `agf`, F33).
// turn  at    bucket                       why
// s1    30    setup                        before N's first start
// h1    60    A-001 host                   prompt-match; launches C1
// d1    70    (not in report)              dispatch A-001 [60, 140]; N and M share the
//                                          workspace, so no notebook (E3) and no
//                                          reflog for `window`: matched no notebook
// w1    90    A-001 external               strong chain from h1
// e1    100   (not in report)              S9 has no notebook evidence
// d2    120   external runs, ambiguous     inside both dispatch intervals (E2)
// h2    120   A-001 host
// w3    130   footer checkout unknown      no chain, no record, clone gone
// u1    740   notebook-level unassigned    between A-001's tail and A-002; launches C2
// s2    745   notebook-level unassigned    S2, same gap; launches C4
// w2    760   external runs, ambiguous     launch in no window, S1 hosts N and M (E6.2)
// w4    765   external runs, unassigned    launch in no window, S2 hosts N only (E6.4)
// h3    850   A-002 host                   prompt-match
// d3    850   (not in report)              as d1, dispatch A-002 [100, 900]
// off   860   footer below the root        host cwd under the checkout root
// amb   1010  A-002 ambiguous              inside N's A-002 and M's A-001
// o1    2000  (not in report)              inside M's window only
const LEDGER = {
  'A-001': { host: 2, external: 1 }, 'A-002': { host: 1, external: 0, ambiguous: 1 },
  setup: 1, unassigned: 2, workersUnassigned: 1, workersAmbiguous: 2, offRootTurns: 1,
  footer: { matchedNoNotebook: 2, checkoutUnknown: 1 },
  outside: ['e1', 'o1', 'w3', 'd1', 'd3'],
};

fs.mkdirSync(path.join(REPO, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO]);
fs.writeFileSync(path.join(REPO, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }));
fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', '+ build the parser', '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+ wire the parser in', '',
  '# ← Reply / A-002', '', '* _2026-06-01 10:30:00 +0000 (claude/unknown)_', '', 'done', '',
].join('\n'));
fs.writeFileSync(path.join(REPO, '.agentflow', 'notes.devlog.md'), ['# → Ask / A-001', '', '+ write the notes', ''].join('\n'));
const dispatch = (dir, started, finished) => {
  const d = path.join(REPO, '.agentflow', 'artifacts', dir, 'dispatch');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'implement-dispatch.json'), JSON.stringify({ stage: 'implement', model: 'claude-test', effort: 'low', started: iso(started), finished: iso(finished), clone: CHOSEN }));
};
dispatch('A-001-parser', 60, 140);
dispatch('A-002-wire', 100, 900);

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 0 };
const row = (id, sessionId, s, cwd) => ({ id, sessionId, provider: 'anthropic', model: 'claude-test', receivedAt: t(s), cwd, responseId: `msg_${id}`, imported: true, usage, cost: { cost: 0.5, confidence: 'exact' } });
const ROWS = [
  row('s1', S1, 30, REPO), row('h1', S1, 60, REPO), row('h2', S1, 120, REPO), row('u1', S1, 740, REPO), row('h3', S1, 850, REPO),
  row('off', S1, 860, path.join(REPO, 'src')), row('amb', S1, 1010, REPO), row('o1', S1, 2000, REPO),
  row('e1', S9, 100, REPO), row('s2', S2, 745, REPO), row('w4', 'worker-4', 765, C4),
  row('w1', 'worker-1', 90, C1), row('w2', 'worker-2', 760, C2), row('w3', 'worker-3', 130, C3),
  row('d1', 'worker-d', 70, CHOSEN), row('d2', 'worker-d', 120, CHOSEN), row('d3', 'worker-d', 850, CHOSEN),
];
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), ROWS.map(r => JSON.stringify(r)).join('\n') + '\n');

const runnerResult = clone => JSON.stringify({ status: 'completed', working_directory: clone, stdin_closed: true, clone: { root: clone } });
const user = (uuid, sid, s, content) => ({ type: 'user', uuid, sessionId: sid, cwd: REPO, timestamp: iso(s), message: { role: 'user', content } });
const assistant = (id, sid, s, content) => ({ type: 'assistant', uuid: `a-${id}`, sessionId: sid, cwd: REPO, timestamp: iso(s), message: { id: `msg_${id}`, role: 'assistant', content } });
const launch = (id, sid, s, tu) => assistant(id, sid, s, [{ type: 'tool_use', id: tu, name: 'Bash', input: { command: 'node scripts/external-runner.js' } }]);
const proj = path.join(CLAUDE, REPO.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
const write = (sid, lines) => fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.map(r => JSON.stringify(r)).join('\n') + '\n');
write(S1, [
  user('p1', S1, 50, 'build the parser'),
  launch('h1', S1, 60, 'tu1'),
  user('r1', S1, 110, [{ type: 'tool_result', tool_use_id: 'tu1', content: runnerResult(C1) }]),
  launch('u1', S1, 740, 'tu2'),
  user('r2', S1, 790, [{ type: 'tool_result', tool_use_id: 'tu2', content: runnerResult(C2) }]),
  user('p2', S1, 800, 'wire the parser in'),
  user('p3', S1, 1000, 'write the notes'),
]);
write(S2, [
  assistant('s2', S2, 745, [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'agf status && node scripts/external-runner.js' } }]),
  user('r3', S2, 790, [{ type: 'tool_result', tool_use_id: 'tu3', content: runnerResult(C4) }]),
]);
write(S9, [assistant('e1', S9, 100, [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }])]);

function report(...args) {
  const env = { ...process.env, CCXRAY_HOME: HOME, CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX };
  delete env.LOGS_DIR;
  return spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'agentflow', 'report', ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 20000 });
}

describe('agentflow report ledger (e2e)', () => {
  const r = report('--json');
  const out = r.status === 0 ? JSON.parse(r.stdout) : null;
  const calls = x => (x ? x.calls : 0);
  const ask = id => out.asks.find(a => a.id === id);
  const kind = (a, k) => a.executors.filter(x => x.kind === k).reduce((n, x) => n + x.total.calls, 0);

  it('runs', () => assert.equal(r.status, 0, r.stderr));

  it('puts every turn in the bucket the ledger gives it', () => {
    const got = {
      'A-001': { host: kind(ask('A-001'), 'host'), external: kind(ask('A-001'), 'external') },
      'A-002': { host: kind(ask('A-002'), 'host'), external: kind(ask('A-002'), 'external'), ambiguous: calls(ask('A-002').ambiguous) },
      setup: calls(out.setup), unassigned: calls(out.unassigned),
      workersUnassigned: calls(out.workersUnassigned), workersAmbiguous: calls(out.workersAmbiguous),
      offRootTurns: out.footer.offRootTurns,
      footer: { matchedNoNotebook: out.footer.matchedNoNotebook, checkoutUnknown: out.footer.checkoutUnknown }, outside: LEDGER.outside,
    };
    assert.deepEqual(got, LEDGER);
    assert.equal(calls(ask('A-001').ambiguous), 0);
  });

  it('accounts for every index turn exactly once (conservation)', () => {
    const inReport = out.asks.reduce((n, a) => n + a.executors.reduce((m, x) => m + x.total.calls, 0) + calls(a.ambiguous), 0)
      + calls(out.setup) + calls(out.unassigned) + calls(out.workersUnassigned) + calls(out.workersAmbiguous) + out.footer.offRootTurns;
    assert.equal(inReport + LEDGER.outside.length, ROWS.length);
  });
});
