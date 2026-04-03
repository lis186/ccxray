'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalStorage } = require('../server/storage/local');

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
      await storage.writeSharedIfAbsent('sys_idem.json', 'original');
      await storage.writeSharedIfAbsent('sys_idem.json', 'overwrite');
      const content = await storage.readShared('sys_idem.json');
      assert.equal(content, 'original');
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
