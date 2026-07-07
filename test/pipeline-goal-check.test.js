'use strict';

// scripts/pipeline/goal-check.sh — 四合法終態把關。
// synthetic {issue,prs} 經 --input；T4 用 PIPELINE_SOLUTIONS_DIR 指向 temp。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pipeline', 'goal-check.sh');

function run(bundle, { solutionsDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-'));
  const p = path.join(dir, 'in.json');
  fs.writeFileSync(p, JSON.stringify(bundle));
  const env = { ...process.env };
  if (solutionsDir) env.PIPELINE_SOLUTIONS_DIR = solutionsDir;
  return spawnSync(SCRIPT, ['--input', p], { encoding: 'utf8', env });
}

describe('goal-check terminal states', () => {
  it('T1: linked open PR (branch fix/NNN) → exit 0', () => {
    const r = run({
      issue: { number: 300, labels: [], comments: [] },
      prs: [{ number: 50, headRefName: 'fix/300-x', body: '' }],
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T1:evidence-PR\(#50\)/);
  });

  it('T2: pipeline:blocked + trusted comment → exit 0', () => {
    const r = run({
      issue: {
        number: 301,
        labels: [{ name: 'pipeline:blocked' }],
        comments: [{ authorAssociation: 'OWNER', body: 'tried A and B, blocked on upstream' }],
      },
      prs: [],
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T2:blocked/);
  });

  it('T2 rejects a trivial comment with no tried-path evidence (blocked + "ack") → exit 1', () => {
    const r = run({
      issue: {
        number: 311,
        labels: [{ name: 'pipeline:blocked' }],
        comments: [{ authorAssociation: 'OWNER', body: 'ack' }],
      },
      prs: [],
    });
    assert.equal(r.status, 1, 'a bare comment must not satisfy T2 blocked evidence');
  });

  it('T3: needs-owner + structured block {reason,requiredOwnerAction,runId} → exit 0', () => {
    const r = run({
      issue: {
        number: 302,
        labels: [{ name: 'pipeline:needs-owner' }],
        comments: [{ authorAssociation: 'OWNER', body: 'reason: root cause X\nrequiredOwnerAction: pick A/B\nrunId: run-1' }],
      },
      prs: [],
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T3:needs-owner-structured/);
  });

  it('T4: needs-owner + solutions ref that exists on disk → exit 0', () => {
    const sol = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-'));
    fs.writeFileSync(path.join(sol, '303-cpu.md'), '# root cause');
    const r = run(
      {
        issue: {
          number: 303,
          labels: [{ name: 'pipeline:needs-owner' }],
          comments: [{ authorAssociation: 'OWNER', body: '設計見 docs/solutions/303-cpu.md' }],
        },
        prs: [],
      },
      { solutionsDir: sol },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /T4:diagnostic/);
  });

  it('T4 but solutions file missing → not terminal → exit 1', () => {
    const sol = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-'));
    const r = run(
      {
        issue: {
          number: 305,
          labels: [{ name: 'pipeline:needs-owner' }],
          comments: [{ authorAssociation: 'OWNER', body: 'docs/solutions/nope.md' }],
        },
        prs: [],
      },
      { solutionsDir: sol },
    );
    assert.equal(r.status, 1);
  });

  it('untrusted comment cannot satisfy T3/T4 (forgery guard)', () => {
    const sol = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-'));
    fs.writeFileSync(path.join(sol, 'x.md'), 'x');
    const r = run(
      {
        issue: {
          number: 306,
          labels: [{ name: 'pipeline:needs-owner' }],
          comments: [{ authorAssociation: 'NONE', body: 'reason: x\nrequiredOwnerAction: y\nrunId: z\ndocs/solutions/x.md' }],
        },
        prs: [],
      },
      { solutionsDir: sol },
    );
    assert.equal(r.status, 1, 'untrusted author must not satisfy any terminal state');
  });

  it('no terminal state → exit 1 with gap report', () => {
    const r = run({ issue: { number: 304, labels: [], comments: [] }, prs: [] });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /未達任何合法終態/);
  });

  it('usage error on missing issue/input → exit 3', () => {
    const r = spawnSync(SCRIPT, [], { encoding: 'utf8' });
    assert.equal(r.status, 3);
  });
});
