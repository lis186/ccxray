'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-prune-safety-home-'));
process.env.CCXRAY_HOME = TEST_HOME;

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { pruneLogs, sweepOrphanedPruneTmpFiles } = require('../server/restore');

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
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
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

  function exitedPid() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', '']);
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid));
    });
  }

  function liveChild() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => resolve(child));
    });
  }

  async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }

  function seedUntouchedNeighbors(extra = []) {
    const filenames = ['index.ndjson', 'index.ndjson.bak', 'sessions.json', ...extra];
    for (const filename of filenames) {
      fs.writeFileSync(path.join(tmpDir, filename), filename === 'index.ndjson' ? '' : 'synthetic neighbor');
    }
    return { filenames, before: new Map(filenames.map(filename => [filename, fs.statSync(path.join(tmpDir, filename))])) };
  }

  function assertNeighborsUntouched({ filenames, before }) {
    for (const filename of filenames) {
      const after = fs.statSync(path.join(tmpDir, filename));
      assert.equal(after.size, before.get(filename).size, `${filename} size`);
      assert.equal(after.mtimeMs, before.get(filename).mtimeMs, `${filename} mtime`);
    }
  }

  it('removes a fresh prune tmp whose owner exited even when index is missing', async () => {
    const pid = await exitedPid();
    const tmpPath = path.join(tmpDir, `index.ndjson.prune-${pid}.tmp`);
    fs.writeFileSync(tmpPath, 'synthetic interrupted prune');

    await pruneLogs();

    assert.equal(fs.existsSync(tmpPath), false);
  });

  it('sweeps before the retention-disabled early return', async () => {
    const pid = await exitedPid();
    const tmpPath = path.join(tmpDir, `index.ndjson.prune-${pid}.tmp`);
    fs.writeFileSync(tmpPath, 'synthetic interrupted prune');
    config.LOG_RETENTION_DAYS = 0;

    try {
      await pruneLogs();
    } finally {
      config.LOG_RETENTION_DAYS = 14;
    }

    assert.equal(fs.existsSync(tmpPath), false);
  });

  it('keeps a prune tmp whose distinct owner is alive', async () => {
    const child = await liveChild();
    try {
      assert.notEqual(child.pid, process.pid);
      const tmpPath = path.join(tmpDir, `index.ndjson.prune-${child.pid}.tmp`);
      fs.writeFileSync(tmpPath, 'synthetic live prune');
      const neighbors = seedUntouchedNeighbors();

      await pruneLogs();

      assert.equal(fs.existsSync(tmpPath), true);
      assertNeighborsUntouched(neighbors);
    } finally {
      await stopChild(child);
    }
  });

  it('sweeps a prune tmp named with the current process PID', async () => {
    const tmpPath = path.join(tmpDir, `index.ndjson.prune-${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, 'synthetic interrupted prune');

    await pruneLogs();

    assert.equal(fs.existsSync(tmpPath), false);
  });

  it('keeps a prune tmp when the ownership probe is EPERM', () => {
    const tmpPath = path.join(tmpDir, 'index.ndjson.prune-12345.tmp');
    fs.writeFileSync(tmpPath, 'synthetic inaccessible live prune');
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    const neighbors = seedUntouchedNeighbors();

    sweepOrphanedPruneTmpFiles(tmpDir, () => { throw eperm; });

    assert.equal(fs.existsSync(tmpPath), true);
    assertNeighborsUntouched(neighbors);
  });

  it('sweeps only dead numeric prune tmps and leaves neighbors untouched', async () => {
    const pid = await exitedPid();
    const tmpPath = path.join(tmpDir, `index.ndjson.prune-${pid}.tmp`);
    fs.writeFileSync(tmpPath, 'synthetic interrupted prune');
    const neighbors = seedUntouchedNeighbors([
      'index.ndjson.prune-abc.tmp',
      `index.ndjson.rebuild-${pid}.tmp`,
      `index.ndjson.reimport-${pid}.tmp`,
    ]);

    await pruneLogs();

    assert.equal(fs.existsSync(tmpPath), false);
    assertNeighborsUntouched(neighbors);
  });

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
