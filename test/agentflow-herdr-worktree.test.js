'use strict';

// A dispatch record whose clone is a Herdr worktree (a linked `git worktree`
// beside or below the checkout, caller-chosen and possibly reused) matches the
// worker sessions that ran there exactly as an external-runner clone does
// (docs/agentflow-integration.md E1 + E3 `dispatch`, F11). Synthetic data only.
//
// Scope: this file covers ATTRIBUTION once a dispatch record already exists.
// It does not cover recording: the hooks that write dispatch records are not
// invoked here, so hook behaviour in a fresh linked worktree that has no
// `.agentflow` notebook (issue #711) is neither exercised nor verified by
// these tests.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attributeWorkers } = require('../server/agentflow/workers');
const { readDispatchRecords } = require('../server/agentflow/records');

const ROOT = '/work/repo';
const RUNNER = '/work/T/agentflow-external-runner-AAAA/clone';
const SIBLING = '/work/repo-feature-x';
const NESTED = '/work/repo/.worktrees/feature-x';

// Realistic epoch-millisecond timestamps, shared by records, notebook windows,
// turns and the report time so the disk-to-attribution contract is exercised.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const t = s => T0 + s * 1000;

const win = (id, start, end) => ({ id, start, end, startKind: 'matched' });
const NOTEBOOKS = [{ rel: '.agentflow/devlog.md', windows: [win('A-001', t(0), t(100)), win('A-002', t(100), t(200))] }];
const turn = (id, sid, cwd, at) => ({ id, sessionId: sid, cwd, receivedAt: at });
const rec = (ask, clone, started, finished) => ({ file: `x/${ask}`, scope: 'workspace', ask, stage: 'implement', model: 'm', effort: 'low', started, finished, clone });

// The common premise of agentflow-workers.test.js: a host of the notebook (S1)
// is active at the checkout root around each worker turn.
function run({ root = ROOT, turns, dispatch, notebooks = NOTEBOOKS, originOf = () => null }) {
  const hostTurns = turns.flatMap(e => [-1, 1].map(d => turn(`h${d}-${e.id}`, 'S1', root, e.receivedAt + d * 1000)));
  return attributeWorkers({ checkoutRoot: root, workspaceRel: '.agentflow', notebooks, hostOf: new Map([['S1', [0]]]),
    toolEvents: [], dispatch, completion: [], originOf, now: t(1000), turns: [...hostTurns, ...turns] });
}
const brief = r => r.runs.map(x => [x.clone, x.ask, x.status, x.evidence, x.labels.join(','), x.turns.map(t => t.id).join(',')]);

describe('dispatch records naming a Herdr worktree', () => {
  // Two runs in one reused clone, one per dispatch interval (F11), plus one
  // turn at the checkout root that must stay a host turn.
  const fixture = clone => run({
    turns: [turn('a', 'W1', clone, t(15)), turn('b', 'W1', clone, t(18)), turn('c', 'W2', clone, t(115))],
    dispatch: [rec('A-001', clone, t(10), t(20)), rec('A-002', clone, t(110), t(120))],
  });

  it('the external-runner clone baseline', () => {
    assert.deepEqual(brief(fixture(RUNNER)), [
      [RUNNER, 'A-001', 'unique', 'dispatch', '', 'a,b'],
      [RUNNER, 'A-002', 'unique', 'dispatch', '', 'c'],
    ]);
  });

  for (const [name, clone] of [['a sibling worktree', SIBLING], ['a worktree below the checkout', NESTED]]) {
    it(`${name} matches its worker sessions the same way`, () => {
      const got = brief(fixture(clone));
      assert.deepEqual(got, brief(fixture(RUNNER)).map(([, ...rest]) => [clone, ...rest]));
      const all = fixture(clone).runs.flatMap(r => r.turns);
      assert.ok(all.every(t => t.cwd === clone), 'host turns at the checkout root never join the run');
    });
  }

  it('a worktree turn outside every dispatch interval is not bound by dispatch', () => {
    const r = run({ turns: [turn('a', 'W1', SIBLING, t(15)), turn('z', 'W9', SIBLING, t(150))], dispatch: [rec('A-001', SIBLING, t(10), t(20))] });
    assert.deepEqual(r.runs.filter(x => x.evidence === 'dispatch').map(x => x.turns.map(t => t.id)), [['a']]);
    assert.ok(!r.runs.some(x => x.evidence === 'dispatch' && x.turns.some(t => t.id === 'z')));
  });

  it('a real linked worktree, its record read from disk, reached through a symlinked cwd', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-herdr-')));
    try {
      const repo = path.join(dir, 'repo');
      const wt = path.join(dir, 'repo-feature-x');
      const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo, stdio: 'pipe' });
      fs.mkdirSync(repo);
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'init');
      git('worktree', 'add', '-q', '-b', 'feature-x', wt);
      assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'a linked worktree, not a clone');
      const alias = path.join(dir, 'alias');
      fs.symlinkSync(wt, alias);

      const f = path.join(repo, '.agentflow', 'artifacts', 'A-001-build', 'dispatch', 'implement-dispatch.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ stage: 'implement', model: 'claude-sonnet-5', effort: 'low', started: t(10), finished: t(20), clone: { root: wt } }));
      const dispatch = readDispatchRecords(path.join(repo, '.agentflow'));
      assert.deepEqual(dispatch.map(x => [x.ask, x.clone, x.started, x.finished]), [['A-001', wt, t(10), t(20)]]);

      const r = run({ root: repo, turns: [turn('a', 'W1', wt, t(12)), turn('b', 'W1', alias, t(18))], dispatch });
      assert.deepEqual(r.runs.map(x => [x.clone, x.ask, x.status, x.evidence, x.stage, x.turns.map(t => t.id).join(',')]),
        [[wt, 'A-001', 'unique', 'dispatch', 'implement', 'a,b']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
