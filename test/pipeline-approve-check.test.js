'use strict';

// scripts/pipeline/approve-check.sh — owner 簽核標記驗證（防偽造/防誤判/防自簽）。
// synthetic comments 經 --input；不打網路、不碰 CCXRAY_HOME。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pipeline', 'approve-check.sh');

function withInput(obj, extraArgs) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apv-')), 'in.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return spawnSync(SCRIPT, ['--input', p, ...extraArgs], { encoding: 'utf8' });
}

describe('approve-check owner sign-off', () => {
  it('OWNER + line-start marker + token → exit 0', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'OWNER', body: 'ok\nAPPROVE-DESIGN run-abc\nthx' }] },
      ['--marker', 'APPROVE-DESIGN'],
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /token=run-abc/);
  });

  it('prose mention mid-line (in backticks) is NOT a sign-off → exit 1', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'OWNER', body: '簽核原語：`APPROVE-DESIGN <runId>` 僅 OWNER 有效' }] },
      ['--marker', 'APPROVE-DESIGN'],
    );
    assert.equal(r.status, 1);
  });

  it('marker at line-start INSIDE a fenced code block is NOT a sign-off → exit 1', () => {
    // 文件示例：OWNER 在 ``` 內貼 `APPROVE-DESIGN <runId>` 當範例，不得當真簽核
    const body = 'Usage example:\n```\nAPPROVE-DESIGN <runId>\n```\nDo not treat this as approval.';
    const r = withInput({ comments: [{ authorAssociation: 'OWNER', body }] }, ['--marker', 'APPROVE-DESIGN']);
    assert.equal(r.status, 1);
  });

  it('non-owner author with valid marker → exit 1 (forgery guard)', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'CONTRIBUTOR', body: 'APPROVE-DESIGN run-x' }] },
      ['--marker', 'APPROVE-DESIGN'],
    );
    assert.equal(r.status, 1);
  });

  it('--exclude-run matching the comment runId → exit 1 (self-sign guard)', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'OWNER', body: 'APPROVE-DESIGN run-abc' }] },
      ['--marker', 'APPROVE-DESIGN', '--exclude-run', 'run-abc'],
    );
    assert.equal(r.status, 1);
  });

  it('--exclude-run not matching → still valid → exit 0', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'OWNER', body: 'APPROVE-DESIGN run-new' }] },
      ['--marker', 'APPROVE-DESIGN', '--exclude-run', 'run-old'],
    );
    assert.equal(r.status, 0);
  });

  it('ACCEPT-EXCEPTION marker from OWNER with reason → exit 0', () => {
    const r = withInput(
      { comments: [{ authorAssociation: 'OWNER', body: 'ACCEPT-EXCEPTION batch tracker aggregate waived' }] },
      ['--marker', 'ACCEPT-EXCEPTION'],
    );
    assert.equal(r.status, 0);
  });

  it('no comments → exit 1', () => {
    const r = withInput({ comments: [] }, ['--marker', 'APPROVE-DESIGN']);
    assert.equal(r.status, 1);
  });

  it('invalid marker → usage error exit 3', () => {
    const r = withInput({ comments: [] }, ['--marker', 'BOGUS']);
    assert.equal(r.status, 3);
  });

  it('missing marker → usage error exit 3', () => {
    const r = withInput({ comments: [] }, []);
    assert.equal(r.status, 3);
  });
});
