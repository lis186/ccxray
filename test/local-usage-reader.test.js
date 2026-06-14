'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readAllAccounts } = require('../server/local-usage-reader');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-reader-'));
}

describe('local-usage-reader', () => {
  it('reads snapshots from fixture directory', () => {
    const dir = path.join(__dirname, 'fixtures/ccxray-usage-status');
    const accounts = readAllAccounts(dir);
    assert.equal(accounts.length, 2);

    const codex = accounts.find(a => a.provider === 'openai');
    assert.ok(codex);
    assert.equal(codex.id, 'codex-default');
    assert.equal(codex.planType, 'prolite');
    assert.equal(codex.fiveHour.usedPct, 7);
    assert.equal(codex.fiveHour.leftPct, 93);
    assert.equal(codex.sevenDay.usedPct, 44);
    assert.equal(codex.sevenDay.leftPct, 56);
    assert.equal(codex.fresh, true);

    const claude = accounts.find(a => a.provider === 'anthropic');
    assert.ok(claude);
    assert.equal(claude.fiveHour.usedPct, 20);
  });

  it('returns empty array for nonexistent directory', () => {
    const accounts = readAllAccounts('/nonexistent/dir');
    assert.deepEqual(accounts, []);
  });

  it('returns empty array for empty directory', () => {
    const dir = makeTmpDir();
    try {
      const accounts = readAllAccounts(dir);
      assert.deepEqual(accounts, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks stale snapshots as not fresh', () => {
    const dir = makeTmpDir();
    try {
      const staleSnap = {
        id: 'codex-default',
        label: 'Codex',
        provider: 'openai',
        planType: 'plus',
        fiveHour: { usedPct: 10, resetsAt: 1780000000 },
        sevenDay: { usedPct: 20, resetsAt: 1780500000 },
        updatedAt: Math.floor(Date.now() / 1000) - 120,
      };
      fs.writeFileSync(path.join(dir, 'codex-default.json'), JSON.stringify(staleSnap));

      const accounts = readAllAccounts(dir);
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].fresh, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes resetLabel for future resetsAt', () => {
    const dir = makeTmpDir();
    try {
      const futureSnap = {
        id: 'test',
        label: 'Test',
        provider: 'openai',
        planType: 'plus',
        fiveHour: { usedPct: 10, resetsAt: Math.floor(Date.now() / 1000) + 3700 },
        sevenDay: null,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      fs.writeFileSync(path.join(dir, 'test.json'), JSON.stringify(futureSnap));

      const accounts = readAllAccounts(dir);
      assert.equal(accounts.length, 1);
      assert.ok(accounts[0].fiveHour.resetLabel.includes('h'), 'should contain hour unit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON files', () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'bad.json'), 'not json{{{');
      fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({
        id: 'good', label: 'Good', provider: 'openai', planType: 'plus',
        fiveHour: { usedPct: 5, resetsAt: 1780000000 }, sevenDay: null,
        updatedAt: Math.floor(Date.now() / 1000),
      }));

      const accounts = readAllAccounts(dir);
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, 'good');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
