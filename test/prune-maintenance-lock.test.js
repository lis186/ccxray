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
const { acquireMaintenanceLock, releaseMaintenanceLock, maintenanceLockHolder, isPidAlive } = require('../server/maintenance-lock');

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

  it('EACCES (or any non-ENOENT read error) on the lock file means an unknown live holder', () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const eio = Object.assign(new Error('io'), { code: 'EIO' });
    for (const err of [eacces, eio]) {
      const holder = maintenanceLockHolder(config.storage, { readFileSync: () => { throw err; } });
      assert.deepEqual(holder, { pid: null, op: 'unknown' }, err.code);
    }
    const enoent = Object.assign(new Error('none'), { code: 'ENOENT' });
    assert.equal(maintenanceLockHolder(config.storage, { readFileSync: () => { throw enoent; } }), null, 'ENOENT = no lock');
  });

  it('EPERM from kill(pid, 0) means the holder is alive; ESRCH means dead', () => {
    const kill = code => () => { throw Object.assign(new Error(code), { code }); };
    assert.equal(isPidAlive(4242, kill('EPERM')), true);
    assert.equal(isPidAlive(4242, kill('ESRCH')), false);
    assert.equal(isPidAlive(4242, () => true), true);
    fs.writeFileSync(path.join(dir, '.index-maintenance.lock'), JSON.stringify({ pid: 4242, token: 't', op: 'migrate-logs' }));
    const holder = maintenanceLockHolder(config.storage, { kill: kill('EPERM') });
    assert.equal(holder.op, 'migrate-logs', 'foreign-owned live holder is held');
    assert.equal(maintenanceLockHolder(config.storage, { kill: kill('ESRCH') }), null);
  });

  it('a real unreadable lock file (chmod 000) blocks prune', async function () {
    if (process.getuid && process.getuid() === 0) return; // root reads anything
    const lock = path.join(dir, '.index-maintenance.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't', op: 'migrate-logs' }));
    fs.chmodSync(lock, 0);
    try {
      await pruneLogs({ retentionDays: 1 });
      assert.ok(fs.existsSync(path.join(dir, OLD_ID + '_req.json')), 'prune skipped');
    } finally { fs.chmodSync(lock, 0o600); }
  });
});
