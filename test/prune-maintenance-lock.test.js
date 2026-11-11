'use strict';

// #776 (codex r1): startup pruneLogs must honor the ADR 0021 maintenance lock, so a
// server started while migrate-logs / rebuild-index --apply runs cannot prune or
// rewrite logs underneath it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { pruneLogs } = require('../server/restore');
const { acquireMaintenanceLock, releaseMaintenanceLock, maintenanceLockHolder } = require('../server/maintenance-lock');

const OLD_ID = '2020-01-01T00-00-00-001';
let dir, realStorage, out, origLog;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-prune-lock-'));
  realStorage = config.storage;
  config.storage = createLocalStorage(dir);
  await config.storage.init();
  store.entries.length = 0;
  fs.writeFileSync(path.join(dir, OLD_ID + '_req.json'), '{}');
  fs.writeFileSync(path.join(dir, OLD_ID + '_res.json'), '[]');
  fs.writeFileSync(path.join(dir, 'index.ndjson'), JSON.stringify({ id: OLD_ID, sessionId: 's1', cwd: '/x' }) + '\n');
  out = [];
  origLog = console.log;
  console.log = (...a) => out.push(a.join(' '));
});
afterEach(() => {
  console.log = origLog;
  config.storage = realStorage;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pruneLogs vs maintenance lock (#776)', () => {
  it('prunes normally when no lock is held (control)', async () => {
    await pruneLogs({ retentionDays: 1 });
    assert.ok(!fs.existsSync(path.join(dir, OLD_ID + '_req.json')));
  });

  it('skips with a log line while a live process holds the lock', async () => {
    const lock = acquireMaintenanceLock(config.storage, 'migrate-logs', () => {});
    try {
      assert.equal(maintenanceLockHolder(config.storage).op, 'migrate-logs');
      await pruneLogs({ retentionDays: 1 });
    } finally { releaseMaintenanceLock(lock); }
    assert.ok(fs.existsSync(path.join(dir, OLD_ID + '_req.json')), 'req survives');
    assert.ok(fs.existsSync(path.join(dir, OLD_ID + '_res.json')), 'res survives');
    assert.match(out.join('\n'), /Skipping prune: index maintenance \(migrate-logs, pid \d+\) holds the maintenance lock/);
  });

  it('a stale lock of a dead pid does not block prune', async () => {
    fs.writeFileSync(path.join(dir, '.index-maintenance.lock'), JSON.stringify({ pid: 999999, token: 't', op: 'migrate-logs' }));
    assert.equal(maintenanceLockHolder(config.storage), null);
    await pruneLogs({ retentionDays: 1 });
    assert.ok(!fs.existsSync(path.join(dir, OLD_ID + '_req.json')));
  });

  it('an unreadable lock file fails closed (treated as held)', async () => {
    fs.writeFileSync(path.join(dir, '.index-maintenance.lock'), 'not json');
    await pruneLogs({ retentionDays: 1 });
    assert.ok(fs.existsSync(path.join(dir, OLD_ID + '_req.json')));
  });
});
