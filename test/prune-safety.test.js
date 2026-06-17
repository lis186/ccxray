'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { pruneLogs } = require('../server/restore');

describe('pruneLogs safety: empty/missing index', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-prune-safety-' + process.pid);
  let storage, origStorage, origRetention;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
    origStorage = config.storage;
    origRetention = config.LOG_RETENTION_DAYS;
    config.storage = storage;
    config.LOG_RETENTION_DAYS = 14;
  });

  after(() => {
    config.storage = origStorage;
    config.LOG_RETENTION_DAYS = origRetention;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
    store.entries.length = 0;
  });

  function seedOldFile(id) {
    fs.writeFileSync(path.join(tmpDir, `${id}_req.json`), '{}');
    fs.writeFileSync(path.join(tmpDir, `${id}_res.json`), '[]');
  }

  it('skips prune when index.ndjson is missing', async () => {
    // Old file that would normally be pruned (>14 days ago)
    seedOldFile('2020-01-01T00-00-00-000');

    await pruneLogs();

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    assert.ok(files.includes('2020-01-01T00-00-00-000_req.json'),
      'old _req.json must survive when index is missing');
    assert.ok(files.includes('2020-01-01T00-00-00-000_res.json'),
      'old _res.json must survive when index is missing');
  });

  it('skips prune when index.ndjson is empty', async () => {
    seedOldFile('2020-01-01T00-00-00-000');
    fs.writeFileSync(path.join(tmpDir, 'index.ndjson'), '');

    await pruneLogs();

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    assert.ok(files.includes('2020-01-01T00-00-00-000_req.json'),
      'old _req.json must survive when index is empty');
  });

  it('prunes normally when index has content', async () => {
    seedOldFile('2020-01-01T00-00-00-000');
    const indexLine = JSON.stringify({ id: '2026-06-01T00-00-00-000', sessionId: 's1', cwd: '/x' });
    fs.writeFileSync(path.join(tmpDir, 'index.ndjson'), indexLine + '\n');

    await pruneLogs();

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('2020'));
    assert.equal(files.length, 0, 'old unprotected files should be pruned when index is healthy');
  });
});
