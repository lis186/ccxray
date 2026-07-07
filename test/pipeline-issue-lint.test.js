'use strict';

// scripts/pipeline/issue-lint.sh — pre-flight lint hard gates。
// 純 synthetic body 經 stdin（--input -），不打網路、不碰 CCXRAY_HOME。
// hard gate: G1 Blocked-by / G2 可驗收訊號。exit 0=pass 1=fail 3=usage。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pipeline', 'issue-lint.sh');

function lint(body, args = ['--input', '-']) {
  return spawnSync(SCRIPT, args, { input: body, encoding: 'utf8' });
}
// 末行機器摘要 RESULT|pass| 或 RESULT|fail|reasons
function resultLine(stdout) {
  return stdout.trim().split('\n').filter((l) => l.startsWith('RESULT|')).pop() || '';
}

describe('issue-lint hard gates', () => {
  it('well-formed body passes (exit 0)', () => {
    const r = lint('Blocked-by: 無\nBlocks: #200\n\n## 驗收\n- 目標指標: before/after 中位數 ≥5 次\n');
    assert.equal(r.status, 0);
    assert.equal(resultLine(r.stdout), 'RESULT|pass|');
  });

  it('missing Blocked-by fails (exit 1)', () => {
    const r = lint('## 現況\nprose\n## 修法\n驗收: fail-on-old\n');
    assert.equal(r.status, 1);
    assert.match(resultLine(r.stdout), /^RESULT\|fail\|.*missing-blocked-by/);
  });

  it('no acceptance signal fails (exit 1)', () => {
    const r = lint('Blocked-by: #150\nBlocks: 無\n\njust prose about the change\n');
    assert.equal(r.status, 1);
    assert.match(resultLine(r.stdout), /no-acceptance-signal/);
  });

  it('both hard gates missing → both reasons', () => {
    const r = lint('just some free text with no structure at all\n');
    assert.equal(r.status, 1);
    const line = resultLine(r.stdout);
    assert.match(line, /missing-blocked-by/);
    assert.match(line, /no-acceptance-signal/);
  });

  it('missing Blocks is advisory only, not a hard fail', () => {
    const r = lint('Blocked-by: 無\n\n驗收: old-fail / new-pass 差異證據\n');
    assert.equal(r.status, 0, 'missing Blocks must not fail the gate');
    assert.match(r.stdout, /⚠ A1/);
  });

  it('checked risk checklist emits advisory', () => {
    const r = lint('Blocked-by: 無\nBlocks: 無\n\n- [x] 修法跨 3 個以上模組\n\n驗收: 目標指標\n');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /⚠ A2/);
  });

  it('Blocked-by must be near the top, not buried deep', () => {
    // 25 lines of filler then a Blocked-by — should NOT count (開頭區塊 = 前 20 行)
    const filler = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
    const r = lint(`${filler}\nBlocked-by: #1\n\n驗收: 目標指標\n`);
    assert.equal(r.status, 1);
    assert.match(resultLine(r.stdout), /missing-blocked-by/);
  });

  it('usage error with no args (exit 3)', () => {
    const r = spawnSync(SCRIPT, [], { encoding: 'utf8' });
    assert.equal(r.status, 3);
  });

  it('unknown flag (exit 3)', () => {
    const r = spawnSync(SCRIPT, ['--bogus'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
  });

  it('non-numeric issue number (exit 3)', () => {
    const r = spawnSync(SCRIPT, ['abc'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
  });
});
