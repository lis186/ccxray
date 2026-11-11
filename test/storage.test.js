'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalStorage } = require('../server/storage/local');
const { createStorage } = require('../server/storage');

// #344: the write-tracking wrapper serializes appendIndex against an exclusive
// index rewrite (pruneLogs), so a concurrent append can't be dropped by the
// rewrite's rename.
describe('storage exclusive index lock (#344)', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-lock-' + process.pid);
  let storage, origHome;

  before(async () => {
    origHome = process.env.CCXRAY_HOME;
    process.env.CCXRAY_HOME = tmpDir;
    storage = createStorage();
    await storage.init();
  });
  after(() => {
    if (origHome === undefined) delete process.env.CCXRAY_HOME; else process.env.CCXRAY_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appendIndex dispatched while exclusive is held completes only after release', async () => {
    const order = [];
    const release = storage.beginExclusive();
    const appendDone = storage.appendIndex('LOCKED\n').then(() => order.push('append'));
    await new Promise(r => setTimeout(r, 30));
    order.push('still-held'); // the append must not have run yet
    release();
    await appendDone;
    assert.deepEqual(order, ['still-held', 'append'], 'append is parked until release');
  });

  it('drain() does not wait on appends parked behind the exclusive gate (no deadlock)', async () => {
    const release = storage.beginExclusive();
    let done = false;
    const parked = storage.appendIndex('PARKED\n').then(() => { done = true; });
    // drain must resolve even though a parked append is outstanding.
    await storage.drain();
    assert.equal(done, false, 'parked append has not run; drain returned anyway');
    release();
    await parked;
    assert.equal(done, true);
  });
});

describe('storage/local', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-test-' + Date.now());
  let storage;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init creates directory', () => {
    assert.ok(fs.existsSync(tmpDir));
  });

  it('write and read round-trip', async () => {
    await storage.write('test-001', '_req.json', '{"hello":"world"}');
    const data = await storage.read('test-001', '_req.json');
    assert.equal(data, '{"hello":"world"}');
  });

  it('read throws for missing file', async () => {
    await assert.rejects(
      () => storage.read('nonexistent', '_req.json'),
      { code: 'ENOENT' }
    );
  });

  it('list returns written files', async () => {
    await storage.write('test-002', '_res.json', '[]');
    const files = await storage.list();
    assert.ok(files.includes('test-001_req.json'));
    assert.ok(files.includes('test-002_res.json'));
  });

  it('stat returns mtimeMs', async () => {
    const stat = await storage.stat('test-001', '_req.json');
    assert.ok(typeof stat.mtimeMs === 'number');
    assert.ok(stat.mtimeMs > 0);
  });

  it('stat throws for missing file', async () => {
    await assert.rejects(
      () => storage.stat('nonexistent', '_req.json'),
      { code: 'ENOENT' }
    );
  });

  it('write overwrites existing', async () => {
    await storage.write('test-001', '_req.json', '{"updated":true}');
    const data = await storage.read('test-001', '_req.json');
    assert.equal(data, '{"updated":true}');
  });

  describe('index methods', () => {
    it('readIndex returns empty string when no index exists', async () => {
      const content = await storage.readIndex();
      assert.equal(content, '');
    });

    it('appendIndex and readIndex round-trip', async () => {
      await storage.appendIndex('{"id":"a"}\n');
      await storage.appendIndex('{"id":"b"}\n');
      const content = await storage.readIndex();
      assert.equal(content, '{"id":"a"}\n{"id":"b"}\n');
    });
  });

  describe('shared methods', () => {
    it('writeSharedIfAbsent creates file', async () => {
      await storage.writeSharedIfAbsent('sys_abc123.json', '{"v":1}');
      const content = await storage.readShared('sys_abc123.json');
      assert.equal(content, '{"v":1}');
    });

    it('writeSharedIfAbsent is idempotent — does not overwrite', async () => {
      await storage.writeSharedIfAbsent('sys_idem.json', '{"v":"original"}');
      await storage.writeSharedIfAbsent('sys_idem.json', '{"v":"overwrite"}');
      const content = await storage.readShared('sys_idem.json');
      assert.equal(content, '{"v":"original"}');
    });

    // #775: a torn write at the final path used to block every later write
    // (EEXIST → skip), leaving the corrupt file forever.
    for (const [label, torn] of [['truncated JSON', '{"v":'], ['zero-byte', '']]) {
      it(`writeSharedIfAbsent replaces a ${label} file`, async () => {
        const name = `sys_torn_${label.replace(/\W/g, '')}.json`;
        fs.writeFileSync(path.join(tmpDir, 'shared', name), torn);
        // fresh adapter: nothing memoized as verified
        const fresh = createLocalStorage(tmpDir);
        await fresh.writeSharedIfAbsent(name, '{"v":"good"}');
        assert.equal(await fresh.readShared(name), '{"v":"good"}');
      });
    }

    it('writeSharedIfAbsent leaves no tmp file behind and a valid file is not rewritten', async () => {
      const name = 'sys_notmp.json';
      await storage.writeSharedIfAbsent(name, '{"v":1}');
      const before = fs.statSync(path.join(tmpDir, 'shared', name)).ino;
      await createLocalStorage(tmpDir).writeSharedIfAbsent(name, '{"v":2}');
      assert.equal(fs.statSync(path.join(tmpDir, 'shared', name)).ino, before, 'valid file kept (no rename over it)');
      assert.equal(await storage.readShared(name), '{"v":1}');
      assert.deepEqual((await storage.listShared()).filter(f => f.startsWith('.tmp-')), []);
    });

    it('a failed write never leaves a truncated file at the final path', async () => {
      const name = 'sys_atomic.json';
      // data that makes writeFile throw mid-flight (non-string/Buffer)
      await assert.rejects(() => storage.writeSharedIfAbsent(name, { not: 'a string' }));
      assert.ok(!fs.existsSync(path.join(tmpDir, 'shared', name)));
      assert.deepEqual((await storage.listShared()).filter(f => f.startsWith('.tmp-')), []);
    });

    it('readShared throws ENOENT for missing file', async () => {
      await assert.rejects(
        () => storage.readShared('missing.json'),
        { code: 'ENOENT' }
      );
    });

    it('listShared returns created shared files', async () => {
      const files = await storage.listShared();
      assert.ok(files.includes('sys_abc123.json'));
      assert.ok(files.includes('sys_idem.json'));
    });

    it('listShared returns empty array when shared/ does not exist', async () => {
      const freshDir = path.join(os.tmpdir(), 'ccxray-test-fresh-' + Date.now());
      const fresh = createLocalStorage(freshDir);
      await fresh.init();
      try {
        const files = await fresh.listShared();
        assert.deepEqual(files, []);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });
});
