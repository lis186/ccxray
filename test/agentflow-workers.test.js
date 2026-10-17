'use strict';

// External-worker fixtures of docs/agentflow-integration.md (F1-F33). The
// spec's common premise holds unless a case says otherwise. E4's reflog read is
// injected (`originOf`); the real `git reflog` read is tested in chains tests.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { attributeWorkers, combine } = require('../server/agentflow/workers');

const ROOT = '/work/repo';
const NB = '.agentflow/devlog.md';
const C1 = '/work/T/agentflow-external-runner-AAAA/clone';
const C2 = '/work/T/agentflow-external-runner-BBBB/clone';
const CHOSEN = '/work/chosen-clone';
const LAUNCH = '{"command":"node scripts/external-runner.js"}';
const result = clone => JSON.stringify({ working_directory: clone, stdin_closed: true, clone: { root: clone } });

const win = (id, start, end, startKind = 'matched') => ({ id, start, end, startKind });
const notebook = (rel, windows) => ({ rel, windows });
const turn = (id, sid, clone, at, extra = {}) => ({ id, sessionId: sid, cwd: clone, receivedAt: at, ...extra });
const tool = (id, origin, sessionId, input, inputAt, res, resultAt) => ({ id, origin, sessionId, input, inputAt, result: res, resultAt });

const NOTEBOOKS = [notebook(NB, [win('A-001', 0, 100), win('A-002', 100, 200), win('A-003', 200, 300)])];
const HOST = new Map([['S1', [0]], ['S2', [0]]]);
// The common premise: a host of the notebook (S1) is active around each worker
// turn. `hosts: false` leaves host activity to the case.
function run({ hosts = true, ...over } = {}) {
  const turns = over.turns || [];
  const hostTurns = hosts ? turns.filter(e => e.cwd !== ROOT).flatMap(e => [-1, 1].map(d => turn(`h${d}-${e.id}`, 'S1', ROOT, e.receivedAt + d))) : [];
  return attributeWorkers({ checkoutRoot: ROOT, workspaceRel: '.agentflow', notebooks: NOTEBOOKS, hostOf: HOST,
    toolEvents: [], dispatch: [], completion: [], originOf: () => null, now: 1000, ...over, turns: [...hostTurns, ...turns] });
}
const brief = r => r.runs.map(x => [x.clone, x.ask, x.status, x.evidence, x.labels.join(',')]);

describe('launch chains', () => {
  it('F1: concurrent coordinators each strongly launch a worker in A-001', () => {
    const r = run({
      turns: [turn('w1', 'W1', C1, 15), turn('w2', 'W2', C2, 25)],
      toolEvents: [tool('t1', 'h1', 'S1', LAUNCH, 10, result(C1), 20), tool('t2', 'h2', 'S2', LAUNCH, 20, result(C2), 30)],
    });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'launch-chain', ''], [C2, 'A-001', 'unique', 'launch-chain', '']]);
  });

  it('F5: a Task subagent launches and reads the runner; resolved to its host through lineage', () => {
    const r = run({ turns: [turn('w1', 'W1', C1, 115)], toolEvents: [tool('t', 'host/subagents/agent-a.jsonl', 'S1', LAUNCH, 110, result(C1), 120)] });
    assert.deepEqual(brief(r), [[C1, 'A-002', 'unique', 'launch-chain', '']]);
  });

  it('F12/F13: a caller-chosen clone found by reverse discovery; a background launch read later by its handle', () => {
    const r = run({
      turns: [turn('w1', 'W1', CHOSEN, 15), turn('w2', 'W2', C2, 215)],
      toolEvents: [tool('t1', 'h', 'S1', LAUNCH, 10, result(CHOSEN), 20),
        tool('t2', 'h', 'S1', `${LAUNCH} &`, 210, 'Command running in background with ID: bg9.', 211),
        tool('t3', 'h', 'S1', '{"bash_id":"bg9"}', 230, result(C2), 231)],
    });
    assert.deepEqual(brief(r), [[CHOSEN, 'A-001', 'unique', 'launch-chain', ''], [C2, 'A-003', 'unique', 'launch-chain', '']]);
  });

  it('F30: a wrapper summary whose `clone` key holds the clone path, in the runner-naming call, is a strong chain', () => {
    const r = run({ turns: [turn('w1', 'W1', C1, 15)], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 10, JSON.stringify({ summary: 'review done', clone: C1 }), 20)] });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'launch-chain', '']]);
  });

  it('F15: a truncated preview still naming the clone is a chain labelled `truncated`; one that does not leaves lower levels to decide', () => {
    const preview = p => `<persisted-output>…Preview: {"status":"completed"${p}`;
    const a = run({ turns: [turn('w1', 'W1', C1, 15)], toolEvents: [{ ...tool('t', 'h', 'S1', LAUNCH, 10, preview(`, "clone": {"root": "${C1}"`), 20), truncated: true }] });
    assert.deepEqual(brief(a), [[C1, 'A-001', 'unique', 'launch-chain', 'truncated']]);
    const b = run({ turns: [turn('w1', 'W1', C1, 15)], originOf: () => ROOT, toolEvents: [{ ...tool('t', 'h', 'S1', LAUNCH, 10, preview(''), 20), truncated: true }] });
    assert.deepEqual(brief(b), [[C1, 'A-001', 'unique', 'window', '']]);
  });

  it('counts checkout-unknown runs only while the reported notebook\'s hosts were active', () => {
    const r = run({ hosts: false, turns: [turn('h1', 'S1', ROOT, 10), turn('w1', 'W1', C1, 40), turn('h2', 'S1', ROOT, 60), turn('w2', 'W2', C2, 90)] });
    assert.deepEqual([r.runs.length, r.footer.checkoutUnknown, r.footer.matchedNoNotebook], [0, 1, 0]);
  });

  it('F4/F18: a result read with no launch is no chain; with no reflog the run is checkout unknown', () => {
    const r = run({ turns: [turn('w1', 'W1', C1, 15)], toolEvents: [tool('t', 'h', 'S1', '{"command":"cat saved.json"}', 30, result(C1), 31)] });
    assert.deepEqual(r.runs, []);
    assert.deepEqual([r.footer.checkoutUnknown, r.footer.matchedNoNotebook], [1, 0]);
  });

  it('F19: weak chains bind each run to its own launch, in time order across clones', () => {
    const r = run({
      turns: [turn('w1', 'W1', C2, 20), turn('w1b', 'W1', C2, 120), turn('w2', 'W2', C1, 130)],
      toolEvents: [tool('l1', 'h', 'S1', LAUNCH, 10, 'started', 11), tool('l2', 'h', 'S1', LAUNCH, 110, 'started', 111),
        tool('b1', 'h', 'S1', '{"command":"./show"}', 140, `${result(C2)} ${result(C1)}`, 141)],
    });
    assert.deepEqual(brief(r), [[C2, 'A-001', 'unique', 'launch-chain', 'weak'], [C1, 'A-002', 'unique', 'launch-chain', 'weak']]);
  });

  it('F27: a strong chain\'s launch never serves a weak chain', () => {
    const r = run({
      turns: [turn('w1', 'W1', C1, 15), turn('w2', 'W2', C2, 115)],
      toolEvents: [tool('l1', 'h', 'S1', LAUNCH, 10, result(C1), 20), tool('x', 'h', 'S1', '{"command":"./wrapper.sh"}', 110, result(C2), 120)],
      originOf: () => ROOT,
    });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'launch-chain', ''], [C2, 'A-002', 'unique', 'window', '']]);
  });

  it('F28: a weak binding consumes only its latest launch', () => {
    const r = run({
      turns: [turn('w1', 'W1', C1, 30), turn('w2', 'W2', C2, 60)],
      toolEvents: [tool('l1', 'h', 'S1', LAUNCH, 10, 'ok', 11), tool('l2', 'h', 'S1', LAUNCH, 20, 'ok', 21),
        tool('b', 'h', 'S1', '{"command":"./show"}', 70, `${result(C1)} ${result(C2)}`, 71)],
    });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'launch-chain', 'weak'], [C2, 'A-001', 'unique', 'launch-chain', 'weak']]);
  });

  it('F32: a launch more than 2 minutes before a run\'s first turn started some other worker', () => {
    const M = 60000;
    const nbs = [notebook(NB, [win('A-001', 0, 5 * M), win('A-002', 5 * M, 30 * M)])];
    const r = run({
      notebooks: nbs, originOf: () => ROOT,
      turns: [turn('w', 'W', C1, 11 * M), turn('w2', 'W', C1, 12 * M)],
      toolEvents: [tool('l', 'h', 'S1', LAUNCH, 1 * M, 'started', 1 * M + 1), tool('b', 'h', 'S1', '{"command":"./wrapper.sh status"}', 20 * M, result(C1), 20 * M + 1)],
    });
    assert.deepEqual(brief(r), [[C1, 'A-002', 'unique', 'window', '']]);
  });

  it('F29: a launch inside a `no local evidence` window leaves the Ask open: notebook-level unassigned', () => {
    const nbs = [notebook(NB, [win('A-001', 0, 100), win('A-002', 100, 200, 'no local evidence')])];
    const r = run({ notebooks: nbs, turns: [turn('w', 'W', C1, 115)], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 110, result(C1), 120)] });
    assert.deepEqual(brief(r), [[C1, undefined, 'unassigned', 'launch-chain', '']]);
  });
});

describe('dispatch and completion', () => {
  const rec = (ask, clone, started, finished, extra = {}) => ({ file: `x/${ask}`, scope: 'workspace', ask, stage: 'implement', model: 'm', effort: 'low', started, finished, clone, ...extra });

  it('F11: one reused clone, two dispatch intervals, two runs', () => {
    const r = run({ turns: [turn('a', 'W1', CHOSEN, 15), turn('b', 'W2', CHOSEN, 115)], dispatch: [rec('A-001', CHOSEN, 10, 20), rec('A-002', CHOSEN, 110, 120)] });
    assert.deepEqual(brief(r), [[CHOSEN, 'A-001', 'unique', 'dispatch', ''], [CHOSEN, 'A-002', 'unique', 'dispatch', '']]);
    assert.equal(r.runs[0].stage, 'implement');
  });

  it('F21: a run keeps all its turns in the dispatching Ask, past the next Ask\'s start', () => {
    const r = run({ turns: [turn('a', 'W', C1, 90), turn('b', 'W', C1, 130)], dispatch: [rec('A-001', C1, 80, 140)] });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'dispatch', '']]);
    assert.equal(r.runs[0].turns.length, 2);
  });

  it('F23: dispatch says A-002, an overlapping strong chain says A-003: one run, evidence conflict', () => {
    const r = run({ turns: [turn('a', 'W', C1, 205)], dispatch: [rec('A-002', C1, 199, 230)], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 201, result(C1), 220)] });
    assert.deepEqual(brief(r), [[C1, 'A-002', 'unique', 'dispatch', 'evidence conflict']]);
  });

  it('a worker\'s native subagent in its own worktree belongs to the worker\'s run (Lineage)', () => {
    const r = run({ turns: [turn('a', 'W', C1, 15), turn('b', 'W', `${C1}/.claude/worktrees/agent-1`, 16, { subagentId: 'x' })],
      dispatch: [rec('A-001', C1, 10, 20)] });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'dispatch', '']]);
    assert.deepEqual(r.runs[0].turns.map(t => t.id), ['a', 'b']);
  });

  it('a turn inside the chain alone stays in the run the chain and an overlapping dispatch form', () => {
    // The chain [10,30] holds the first turn alone; the dispatch [20,40] joins it
    // only at the second turn, after the first was filed.
    const r = run({ turns: [turn('a', 'W', C1, 15), turn('b', 'W', C1, 25), turn('c', 'W', C1, 35)],
      dispatch: [rec('A-001', C1, 20, 40)], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 10, result(C1), 30)] });
    assert.deepEqual(brief(r), [[C1, 'A-001', 'unique', 'dispatch', '']]);
    assert.deepEqual(r.runs[0].turns.map(t => t.id), ['a', 'b', 'c']);
  });

  it('F16: in a shared workspace dispatch fixes the Ask only; a valid completion record fixes the notebook', () => {
    const nbs = [notebook(NB, [win('A-001', 0, 100)]), notebook('.agentflow/notes.md', [win('A-001', 0, 100)])];
    const host = new Map([['S1', [0, 1]]]);
    const r = run({ notebooks: nbs, hostOf: host, turns: [turn('a', 'W', C1, 15)], dispatch: [rec('A-001', C1, 10, 20)],
      completion: [{ valid: true, notebook: '.agentflow/notes.md', ask: 'A-001', clones: [C1] }] });
    assert.deepEqual(r.runs.map(x => [x.notebook, x.ask, x.status, x.evidence]), [['.agentflow/notes.md', 'A-001', 'unique', 'dispatch']]);
  });

  it('a shared-workspace Ask cannot be combined with a weaker notebook that does not contain it', () => {
    const nbs = [
      { rel: '.agentflow/a.devlog.md', asks: [{ id: 'A-001' }], windows: [win('A-001', 0, 40)] },
      { rel: '.agentflow/b.devlog.md', asks: [{ id: 'A-001' }, { id: 'A-002' }], windows: [win('A-001', 0, 40), win('A-002', 40, 100)] },
    ];
    const host = new Map([['S1', [0]]]);
    const r = run({ notebooks: nbs, hostOf: host,
      turns: [turn('a', 'W', C1, 52)],
      dispatch: [rec('A-002', C1, 49, 60)],
      toolEvents: [tool('t', 'h', 'S1', LAUNCH, 50, result(C1), 55)],
    });
    assert.deepEqual(r.runs.map(x => [x.notebook, x.ask, x.status, x.labels]), [
      ['.agentflow/a.devlog.md', undefined, 'unassigned', ['evidence conflict']],
    ]);
  });

  it('a dispatch naming a missing feature notebook remains in the no-notebook footer', () => {
    const r = run({ turns: [turn('a', 'W', C1, 15)], dispatch: [
      { ...rec('A-001', C1, 10, 20), scope: 'features/missing' },
    ] });
    assert.equal(r.runs.length, 0);
    assert.equal(r.footer.matchedNoNotebook, 1);
  });

  it('a dispatch Ask that exists in no candidate notebook, left open by every level, is an evidence conflict', () => {
    const stale = run({ turns: [turn('a', 'W', C1, 15)], dispatch: [rec('A-009', C1, 10, 20)] });
    assert.deepEqual(brief(stale), [[C1, undefined, 'unassigned', 'dispatch', 'evidence conflict']]);
    // A weaker level that fills the Ask resolves the run; nothing conflicts.
    const filled = run({ turns: [turn('a', 'W', C1, 15)], dispatch: [rec('A-009', C1, 10, 20)],
      toolEvents: [tool('t', 'h', 'S1', LAUNCH, 9, result(C1), 20)] });
    assert.deepEqual(brief(filled), [[C1, 'A-001', 'unique', 'dispatch', '']]);
  });

  it('completion binds only a run wholly inside its Ask\'s window (the E7 known limit)', () => {
    const c = [{ valid: true, notebook: NB, ask: 'A-001', clones: [C1] }];
    assert.deepEqual(brief(run({ turns: [turn('a', 'W', C1, 15)], completion: c })), [[C1, 'A-001', 'unique', 'completion', '']]);
    const long = run({ turns: [turn('a', 'W', C1, 90), turn('b', 'W', C1, 110)], completion: c });
    assert.deepEqual([long.runs.length, long.footer.checkoutUnknown], [0, 1]);
  });

  it('F31: a time-less record is evidence for a clone with one run, and none for a reused clone', () => {
    const one = run({ turns: [turn('a', 'W', C1, 15)], dispatch: [rec('A-001', C1, null, null, { stage: 'cross-check' })] });
    assert.deepEqual(one.runs.map(x => [x.ask, x.evidence, x.stage]), [['A-001', 'dispatch', 'cross-check']]);
    const reused = run({ turns: [turn('a', 'W1', C1, 15), turn('b', 'W2', C1, 115)], dispatch: [rec('A-001', C1, null, null)], originOf: () => ROOT });
    assert.deepEqual(brief(reused), [[C1, 'A-001', 'unique', 'window', '']]);
    assert.equal(reused.footer.checkoutUnknown, 1, 'the later run of the reused clone');
  });
});

describe('window (E4)', () => {
  it('F2/F22: a recordless, chainless worker bound by its clone origin; another checkout\'s clone is not', () => {
    const noPath = [tool('t', 'h', 'S1', '{"command":"./wrapper.sh review"}', 10, '{"summary":"review done"}', 20)];
    assert.deepEqual(brief(run({ turns: [turn('a', 'W', C1, 15)], toolEvents: noPath, originOf: () => ROOT })), [[C1, 'A-001', 'unique', 'window', '']]);
    // F22 / #649: bound to the other checkout, so reported only under its
    // notebook and not counted here as `checkout unknown`.
    const other = run({ turns: [turn('a', 'W', C1, 15)], originOf: () => '/work/other-checkout/' });
    assert.deepEqual([other.runs.length, other.footer.checkoutUnknown, other.footer.matchedNoNotebook], [0, 0, 0]);
    const unknown = run({ turns: [turn('a', 'W', C1, 15)], originOf: () => null });
    assert.deepEqual([unknown.runs.length, unknown.footer.checkoutUnknown], [0, 1]);
  });

  it('F26: only the earliest run of a reused clone is bound by its reflog', () => {
    const r = run({ turns: [turn('a', 'W1', CHOSEN, 15), turn('b', 'W2', CHOSEN, 115)], toolEvents: [tool('t', 'h', 'S1', '{"command":"ls"}', 1, result(CHOSEN), 2)], originOf: () => ROOT });
    assert.deepEqual(brief(r), [[CHOSEN, 'A-001', 'unique', 'window', '']]);
    assert.equal(r.footer.checkoutUnknown, 1);
  });

  it('several open windows make the Ask ambiguous; the notebook is still fixed', () => {
    const nbs = [notebook(NB, [win('A-001', 0, 100), win('A-002', 50, 150)])];
    const r = run({ notebooks: nbs, turns: [turn('a', 'W', C1, 60)], originOf: () => ROOT });
    assert.deepEqual(r.runs.map(x => [x.notebook, x.status]), [[NB, 'ambiguous']]);
  });
});

describe('E2 and lineage', () => {
  it('same-level intervals with different targets make only their shared turns ambiguous', () => {
    const rec = (ask, s, f) => ({ scope: 'workspace', ask, started: s, finished: f, clone: CHOSEN });
    const r = run({ turns: [turn('a', 'W', CHOSEN, 12), turn('b', 'W', CHOSEN, 18), turn('c', 'W', CHOSEN, 25)], dispatch: [rec('A-001', 10, 20), rec('A-002', 15, 30)] });
    assert.deepEqual(r.ambiguousTurns.map(t => t.id), ['b']);
    assert.deepEqual(r.runs.map(x => [x.ask, x.turns.map(t => t.id).join()]), [['A-001', 'a'], ['A-002', 'c']]);
  });

  it('a clashing dispatch whose feature notebook is missing adds no notebook to the ambiguous candidates', () => {
    const FB = '.agentflow/features/b/b.devlog.md';
    const nbs = [notebook(NB, [win('A-001', 0, 100)]), notebook(FB, [win('A-001', 0, 100)])];
    const rec = (scope, s, f) => ({ scope, ask: 'A-001', started: s, finished: f, clone: CHOSEN });
    const r = run({ notebooks: nbs, turns: [turn('a', 'W', CHOSEN, 15)], dispatch: [rec('features/missing', 10, 20), rec('features/b', 10, 20)] });
    assert.deepEqual(r.ambiguousTurns.map(t => t.candidateNotebooks), [[FB]]);
  });

  it('dispatches that clash but name no existing notebook leave their turns to the no-notebook footer', () => {
    const rec = (scope, s, f) => ({ scope, ask: 'A-001', started: s, finished: f, clone: CHOSEN });
    const r = run({ turns: [turn('a', 'W', CHOSEN, 15)], dispatch: [rec('features/gone', 10, 20), rec('features/missing', 10, 20)] });
    assert.deepEqual(r.ambiguousTurns, []);
    assert.deepEqual(r.runs, []);
    assert.equal(r.footer.matchedNoNotebook, 1);
  });

  it('F6: a proxy-inferred parent is ignored and counted', () => {
    const r = run({ turns: [turn('a', 'W', C1, 15, { parentSessionId: 'W-sibling' })], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 10, result(C1), 20)] });
    assert.equal(r.runs[0].status, 'unique');
    assert.equal(r.runs[0].turns.length, 1, 'each turn counted once');
    assert.equal(r.footer.heuristicParentIgnored, 1);
  });

  it('never treats the checkout root as a clone (F25), even when a record names it', () => {
    const r = run({ turns: [turn('h', 'S1', ROOT, 15)], toolEvents: [tool('t', 'h', 'S1', LAUNCH, 10, result(ROOT), 20)],
      dispatch: [{ scope: 'workspace', ask: 'A-001', started: 10, finished: 20, clone: ROOT }] });
    assert.deepEqual(r.runs, []);
  });
});

describe('combine', () => {
  it('fixes agreeing dimensions, marks disagreeing ones ambiguous, and never fills from a conflicting pair', () => {
    assert.deepEqual(combine({ 'launch-chain': [{ notebook: 'N', ask: 'A-1' }, { notebook: 'N', ask: 'A-2' }] }).fixed, { notebook: 'N', ask: undefined });
    const c = combine({ dispatch: [{ notebook: undefined, ask: 'A-1' }], 'launch-chain': [{ notebook: 'M', ask: 'A-2' }] });
    assert.deepEqual([c.fixed, c.labels], [{ notebook: undefined, ask: 'A-1' }, ['evidence conflict']]);
  });
});
