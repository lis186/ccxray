'use strict';

// scripts/pipeline/validate-state.sh — read-only state normalizer + resolver。
// 餵 synthetic {issues,prs} fixture（--input），tsv 格式鎖 proposed 真值表。
// 不打網路、不碰 CCXRAY_HOME、不 mutate。

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pipeline', 'validate-state.sh');
const FIXTURE = path.join(__dirname, 'fixtures', 'pipeline', 'state-fixture.json');

function run(args) {
  return spawnSync(SCRIPT, args, { encoding: 'utf8' });
}
// tsv → map num → row object
function parseTsv(stdout) {
  const lines = stdout.trim().split('\n');
  const cols = lines[0].split('\t');
  const map = {};
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    cols.forEach((c, i) => (row[c] = cells[i]));
    map[row.num] = row;
  }
  return map;
}

describe('validate-state normalizer (fixture dry-run)', () => {
  let rows;
  let res;
  before(() => {
    res = run(['--input', FIXTURE, '--format', 'tsv']);
    rows = parseTsv(res.stdout);
  });

  it('untriaged + clean + lint-pass → untriaged', () => {
    assert.equal(rows['901'].parsed, 'untriaged');
    assert.equal(rows['901'].proposed, 'untriaged');
    assert.equal(rows['901'].illegal, '-');
  });

  it('untriaged + open PR (branch fix/NNN) → pr_open, links PR#', () => {
    assert.equal(rows['902'].proposed, 'pr_open');
    assert.equal(rows['902'].pr, '#801');
  });

  it('unmet blocker (blocker still open) → blocked', () => {
    assert.equal(rows['903'].proposed, 'blocked');
    assert.equal(rows['903'].blockers, '#999');
  });

  it('lint fail → needs_owner with reasons', () => {
    assert.equal(rows['904'].lint, 'fail');
    assert.equal(rows['904'].proposed, 'needs_owner');
    assert.match(rows['904'].action, /missing-blocked-by/);
  });

  it('ready label + open PR → illegal → needs_owner (never stays ready)', () => {
    assert.equal(rows['905'].parsed, 'ready');
    assert.match(rows['905'].illegal, /ready\+open-PR/);
    assert.equal(rows['905'].proposed, 'needs_owner');
  });

  it('multiple status labels → multiple-status illegal → needs_owner', () => {
    assert.match(rows['906'].illegal, /multiple-status/);
    assert.equal(rows['906'].proposed, 'needs_owner');
  });

  it('blocked label with a DECLARED blocker now resolved → stale-blocked illegal', () => {
    assert.match(rows['907'].illegal, /stale-blocked/);
    assert.equal(rows['907'].proposed, 'needs_owner');
  });

  it('「無」with a parenthetical mentioning #refs is NOT parsed as blockers', () => {
    // Blocked-by: 無（與 #999 平行）——#999 是註解，不是相依；舊碼會誤抓成 blocker
    assert.equal(rows['910'].blockers, '-');
    assert.equal(rows['910'].proposed, 'untriaged');
  });

  it('failure-budget blocked (blocked label, Blocked-by: 無) is NOT stale → stays blocked', () => {
    // 兩次失敗型 blocked 無相依宣告；舊碼誤判 stale-blocked→needs_owner，新碼須維持 blocked
    assert.equal(rows['908'].parsed, 'blocked');
    assert.equal(rows['908'].illegal, '-');
    assert.equal(rows['908'].proposed, 'blocked');
  });

  it('closing keyword in PR body links the issue (Closes #905)', () => {
    // #905 illegal reason references the PR discovered via body keyword (#802)
    assert.match(rows['905'].illegal, /#802/);
  });

  it('exit 1 when any illegal combo present', () => {
    assert.equal(res.status, 1);
  });

  it('never proposes ready for anything (ready is owner-only)', () => {
    for (const num of Object.keys(rows)) {
      assert.notEqual(rows[num].proposed, 'ready', `#${num} must not be auto-proposed ready`);
    }
  });

  it('md format renders dry-run header + no-mutate notice', () => {
    const r = run(['--input', FIXTURE, '--format', 'md']);
    assert.match(r.stdout, /Migration dry-run/);
    assert.match(r.stdout, /未寫入任何 label/);
  });

  it('clean input (no illegal combo) exits 0', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const clean = {
      issues: [{ number: 901, labels: [], body: 'Blocked-by: 無\nBlocks: 無\n\n驗收: 目標指標' }],
      prs: [],
    };
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'clean.json');
    fs.writeFileSync(p, JSON.stringify(clean));
    const r = run(['--input', p, '--format', 'tsv']);
    assert.equal(r.status, 0);
  });

  it('usage error on bad --format (exit 3)', () => {
    const r = run(['--input', FIXTURE, '--format', 'xml']);
    assert.equal(r.status, 3);
  });
});
