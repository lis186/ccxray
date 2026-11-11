'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
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

    // #775 (write-once): the request path never touches an existing final file.
    // A torn file is left alone and warned about once; reads treat it as missing;
    // `ccxray gc --apply` repairs it offline (test/gc.test.js).
    for (const [label, torn] of [['truncated JSON', '{"v":'], ['zero-byte', '']]) {
      it(`writeSharedIfAbsent leaves a ${label} final untouched, warns once, and readShared treats it as missing`, async () => {
        const name = `sys_torn_${label.replace(/\W/g, '')}.json`;
        const fp = path.join(tmpDir, 'shared', name);
        fs.writeFileSync(fp, torn);
        const warnings = [];
        const realErr = console.error;
        console.error = (...a) => warnings.push(a.join(' '));
        try {
          const fresh = createLocalStorage(tmpDir);
          await fresh.writeSharedIfAbsent(name, '{"v":"good"}');
          await createLocalStorage(tmpDir).writeSharedIfAbsent(name, '{"v":"good"}');
          await fresh.writeSharedIfAbsent(name, '{"v":"good"}'); // same adapter again: no second warning
        } finally { console.error = realErr; }
        assert.equal(fs.readFileSync(fp, 'utf8'), torn, 'corrupt final not repaired or replaced on the hot path');
        assert.equal(warnings.filter(w => w.includes(name)).length, 2, 'one warning per adapter+filename, not per write');
        assert.deepEqual((await storage.listShared()).filter(f => f.startsWith('.tmp-') || f.startsWith('.corrupt-')), []);
        await assert.rejects(() => createLocalStorage(tmpDir).readShared(name), { code: 'ENOENT' }, 'corrupt reads as missing');
        assert.equal(await createLocalStorage(tmpDir).checkShared(name), 'corrupt');
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

    // #775 round 2: barrier-controlled races. Two adapters on one dir stand in for
    // two writers (processes); the tmp-file write is held until both have
    // already passed their "is it valid?" check, then released one at a time.
    describe('concurrent writers', () => {
      const realWriteFile = fs.promises.writeFile;
      let arrived, gates, releaseByData;
      function installBarrier() {
        arrived = []; gates = []; releaseByData = new Map();
        fs.promises.writeFile = async function (p, ...rest) {
          if (path.basename(String(p)).startsWith('.tmp-')) {
            let release;
            gates.push(new Promise(r => { release = r; }));
            arrived.push(release);
            releaseByData.set(String(rest[0]), release); // arrival order is not guaranteed: key by writer
            await gates[gates.length - 1];
          }
          return realWriteFile.call(this, p, ...rest);
        };
      }
      const waitArrived = async n => { for (let i = 0; i < 4000 && arrived.length < n; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(arrived.length, n); };
      // Release anything still parked so a failed assertion cannot leave a pending promise behind.
      const afterEach_ = () => { fs.promises.writeFile = realWriteFile; arrived.forEach(r => r()); };

      it('two writers on a MISSING file: the first valid file is never clobbered', async () => {
        installBarrier();
        try {
          const name = 'sys_racemissing.json', fp = path.join(tmpDir, 'shared', name);
          const a = createLocalStorage(tmpDir), b = createLocalStorage(tmpDir);
          const pa = a.writeSharedIfAbsent(name, '{"w":"A"}');
          const pb = b.writeSharedIfAbsent(name, '{"w":"B"}');
          await waitArrived(2); // both saw "missing"
          releaseByData.get('{"w":"A"}')(); await pa;
          assert.equal(fs.readFileSync(fp, 'utf8'), '{"w":"A"}');
          const ino = fs.statSync(fp).ino;
          releaseByData.get('{"w":"B"}')(); await pb;
          assert.equal(fs.readFileSync(fp, 'utf8'), '{"w":"A"}', 'late writer must not replace the valid file');
          assert.equal(fs.statSync(fp).ino, ino);
          assert.deepEqual((await a.listShared()).filter(f => f.startsWith('.tmp-')), []);
        } finally { afterEach_(); }
      });

      it('same-process writers of one name coalesce into one in-flight write (first data wins)', async () => {
        installBarrier();
        try {
          const name = 'sys_coalesce.json';
          const a = createLocalStorage(tmpDir);
          const p1 = a.writeSharedIfAbsent(name, '{"w":1}');
          const p2 = a.writeSharedIfAbsent(name, '{"w":2}');
          assert.strictEqual(p1, p2, 'one promise per filename');
          await waitArrived(1);
          arrived[0](); await Promise.all([p1, p2]);
          assert.equal(arrived.length, 1, 'a single tmp write');
          assert.equal(await a.readShared(name), '{"w":1}');
        } finally { afterEach_(); }
      });
    });

    // #775 round 3: rename-aside repair, no-replace restore, no-hard-link fallback.
    describe('corrupt repair and quarantine restore races', () => {
      const fsp = fs.promises;
      const originals = { rename: fsp.rename, link: fsp.link };
      let parked = [];
      afterEach(() => { fsp.rename = originals.rename; fsp.link = originals.link; parked.forEach(r => r()); parked = []; });
      const shared = n => path.join(tmpDir, 'shared', n);
      const leftovers = async a => (await a.listShared()).filter(f => f.startsWith('.tmp-') || f.startsWith('.corrupt-'));
      it('without hard links (link → EPERM) a missing file is published by atomic rename — never a copy — and a valid or corrupt final is left alone', async () => {
        fsp.link = async () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
        const copies = [];
        const realCopy = fsp.copyFile;
        fsp.copyFile = async (...a) => { copies.push(a); return realCopy.apply(fsp, a); };
        try {
          const a = createLocalStorage(tmpDir);
          await a.writeSharedIfAbsent('sys_nolinkmissing.json', '{"v":1}');
          assert.equal(await a.readShared('sys_nolinkmissing.json'), '{"v":1}');
          await createLocalStorage(tmpDir).writeSharedIfAbsent('sys_nolinkmissing.json', '{"v":2}');
          assert.equal(fs.readFileSync(shared('sys_nolinkmissing.json'), 'utf8'), '{"v":1}', 'valid file kept');
          fs.writeFileSync(shared('sys_nolinkcorrupt.json'), '{"v"');
          await createLocalStorage(tmpDir).writeSharedIfAbsent('sys_nolinkcorrupt.json', '{"v":3}');
          assert.equal(fs.readFileSync(shared('sys_nolinkcorrupt.json'), 'utf8'), '{"v"', 'corrupt file left alone');
          assert.deepEqual(copies, [], 'no copy into a final pathname');
          assert.deepEqual(await leftovers(a), []);
        } finally { fsp.copyFile = realCopy; }
      });

      it('without hard links a quarantined file is restored by atomic rename (never a partial copy)', async () => {
        const name = 'sys_nolinkrestore.json';
        const trash = path.join(tmpDir, 'shared', '.gc-trash-2026-03-01T00-00-00-000Z');
        fs.mkdirSync(trash, { recursive: true });
        fs.writeFileSync(path.join(trash, name), '{"q":"nolink"}');
        fsp.link = async () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
        const realCopy = fsp.copyFile; let copied = false;
        fsp.copyFile = async (...a) => { copied = true; return realCopy.apply(fsp, a); };
        try {
          assert.equal(await createLocalStorage(tmpDir).readShared(name), '{"q":"nolink"}');
        } finally { fsp.copyFile = realCopy; }
        assert.equal(copied, false);
        assert.equal(fs.readFileSync(shared(name), 'utf8'), '{"q":"nolink"}');
        assert.ok(!fs.existsSync(path.join(trash, name)), 'moved, not copied');
      });

      it('a corrupt final with a valid quarantine copy: readShared/statShared serve the copy and do NOT overwrite the final', async () => {
        const name = 'sys_corruptfinal.json';
        const trash = path.join(tmpDir, 'shared', '.gc-trash-2026-03-02T00-00-00-000Z');
        fs.mkdirSync(trash, { recursive: true });
        fs.writeFileSync(path.join(trash, name), '{"q":"good"}');
        fs.writeFileSync(shared(name), '{"q":');
        const r = createLocalStorage(tmpDir);
        assert.equal(await r.readShared(name), '{"q":"good"}');
        assert.equal(fs.readFileSync(shared(name), 'utf8'), '{"q":', 'final untouched');
        assert.ok(fs.existsSync(path.join(trash, name)), 'quarantine copy stays');
        assert.ok((await r.statShared(name)).size > 0);
        assert.equal(fs.readFileSync(shared(name), 'utf8'), '{"q":');
      });

      it('a corrupt quarantine copy is never served or restored (newest VALID copy wins)', async () => {
        const name = 'sys_validnewest.json';
        for (const [ts, body] of [['2026-03-03T00-00-00-000Z', '{"q":"older-valid"}'], ['2026-03-04T00-00-00-000Z', '{"q":']]) {
          const d = path.join(tmpDir, 'shared', `.gc-trash-${ts}`);
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, name), body);
        }
        assert.equal(await createLocalStorage(tmpDir).readShared(name), '{"q":"older-valid"}');
        assert.equal(fs.readFileSync(shared(name), 'utf8'), '{"q":"older-valid"}');
      });

      it('quarantine restore is no-replace: a writer that creates the final file between the reader ENOENT and the restore keeps its content', async () => {
        const name = 'sys_restorerace.json';
        const trash = path.join(tmpDir, 'shared', '.gc-trash-2026-01-01T00-00-00-000Z');
        fs.mkdirSync(trash, { recursive: true });
        fs.writeFileSync(path.join(trash, name), '{"old":"quarantined"}');
        let injected = false;
        fsp.link = async function (src, dst, ...rest) {
          if (!injected && String(src).includes('.gc-trash-')) {
            injected = true;
            fs.writeFileSync(String(dst), '{"new":"writer"}'); // the writer wins the race
          }
          return originals.link.call(this, src, dst, ...rest);
        };
        const reader = createLocalStorage(tmpDir);
        assert.equal(await reader.readShared(name), '{"new":"writer"}');
        assert.equal(fs.readFileSync(shared(name), 'utf8'), '{"new":"writer"}', 'not overwritten by older quarantined data');
        assert.ok(fs.existsSync(path.join(trash, name)), 'trash copy left for purge');
      });

      it('a normal restore moves the file back and removes the trash copy', async () => {
        const name = 'sys_restoreok.json';
        const trash = path.join(tmpDir, 'shared', '.gc-trash-2026-01-02T00-00-00-000Z');
        fs.mkdirSync(trash, { recursive: true });
        fs.writeFileSync(path.join(trash, name), '{"q":1}');
        assert.equal(await createLocalStorage(tmpDir).readShared(name), '{"q":1}');
        assert.ok(!fs.existsSync(path.join(trash, name)));
        assert.ok(fs.existsSync(shared(name)));
      });
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
