'use strict';

// A dispatch record whose clone is a Herdr worktree (a linked `git worktree`
// beside or below the checkout, caller-chosen and possibly reused) matches the
// worker sessions that ran there exactly as an external-runner clone does
// (docs/agentflow-integration.md E1 + E3 `dispatch`, F11). Synthetic data only.

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

const win = (id, start, end) => ({ id, start, end, startKind: 'matched' });
const NOTEBOOKS = [{ rel: '.agentflow/devlog.md', windows: [win('A-001', 0, 100), win('A-002', 100, 200)] }];
const turn = (id, sid, cwd, at) => ({ id, sessionId: sid, cwd, receivedAt: at });
const rec = (ask, clone, started, finished) => ({ file: `x/${ask}`, scope: 'workspace', ask, stage: 'implement', model: 'm', effort: 'low', started, finished, clone });

// The common premise of agentflow-workers.test.js: a host of the notebook (S1)
// is active at the checkout root around each worker turn.
function run({ root = ROOT, turns, dispatch, notebooks = NOTEBOOKS, originOf = () => null }) {
  const hostTurns = turns.flatMap(e => [-1, 1].map(d => turn(`h${d}-${e.id}`, 'S1', root, e.receivedAt + d)));
  return attributeWorkers({ checkoutRoot: root, workspaceRel: '.agentflow', notebooks, hostOf: new Map([['S1', [0]]]),
    toolEvents: [], dispatch, completion: [], originOf, now: 1000, turns: [...hostTurns, ...turns] });
}
const brief = r => r.runs.map(x => [x.clone, x.ask, x.status, x.evidence, x.labels.join(','), x.turns.map(t => t.id).join(',')]);

describe('dispatch records naming a Herdr worktree', () => {
  // Two runs in one reused clone, one per dispatch interval (F11), plus one
  // turn at the checkout root that must stay a host turn.
  const fixture = clone => run({
    turns: [turn('a', 'W1', clone, 15), turn('b', 'W1', clone, 18), turn('c', 'W2', clone, 115)],
    dispatch: [rec('A-001', clone, 10, 20), rec('A-002', clone, 110, 120)],
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
    const r = run({ turns: [turn('a', 'W1', SIBLING, 15), turn('z', 'W9', SIBLING, 150)], dispatch: [rec('A-001', SIBLING, 10, 20)] });
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
      fs.writeFileSync(f, JSON.stringify({ stage: 'implement', model: 'claude-sonnet-5', effort: 'low', started: 10, finished: 20, clone: { root: wt } }));
      const dispatch = readDispatchRecords(path.join(repo, '.agentflow'));
      assert.deepEqual(dispatch.map(x => [x.ask, x.clone]), [['A-001', wt]]);

      const r = run({ root: repo, turns: [turn('a', 'W1', wt, 12), turn('b', 'W1', alias, 18)], dispatch: [{ ...dispatch[0], started: 10, finished: 20 }] });
      assert.deepEqual(r.runs.map(x => [x.clone, x.ask, x.status, x.evidence, x.stage, x.turns.map(t => t.id).join(',')]),
        [[wt, 'A-001', 'unique', 'dispatch', 'implement', 'a,b']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
