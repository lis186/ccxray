'use strict';
// #775 — offline `ccxray gc` of unreferenced shared/ files. Hermetic: every
// fixture lives in a temp logs dir; the real ~/.ccxray is never read.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-gc-home-'));
process.env.CCXRAY_HOME = TEST_HOME;
process.env.CCXRAY_EXPORT_DISABLE = '1';

const hub = require('../server/hub');
const { createLocalStorage } = require('../server/storage/local');
const { gcShared, purgeTrash } = require('../server/gc');

const DAY = 86400_000;
const trashNameNow = () => new Date().toISOString().replace(/[:.]/g, '-');
const tempDirs = [TEST_HOME];
let realReadHubLock;

describe('ccxray gc (#775)', () => {
  before(() => { realReadHubLock = hub.readHubLock; hub.readHubLock = () => null; });
  after(() => {
    hub.readHubLock = realReadHubLock;
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  let logsDir, storage, logs;
  const quiet = () => { logs = []; return m => logs.push(m); };
  // A port nothing listens on: bind then release.
  const freePort = () => new Promise(res => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });

  beforeEach(async () => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-gc-'));
    tempDirs.push(logsDir);
    storage = createLocalStorage(logsDir);
    await storage.init();
  });

  function shared(name, { ageDays = 30, content = '{"x":1}' } = {}) {
    const p = path.join(logsDir, 'shared', name);
    fs.writeFileSync(p, content);
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(p, t, t);
    return p;
  }
  const indexLine = o => fs.appendFileSync(path.join(logsDir, 'index.ndjson'), JSON.stringify(o) + '\n');
  const run = async (opts = {}) => gcShared({ storage, log: quiet(), port: await freePort(), ...opts });
  const runPurge = async (opts = {}) => purgeTrash({ storage, log: quiet(), port: await freePort(), ...opts });
  const sharedPath = name => path.join(logsDir, 'shared', name);
  const trashDirs = () => fs.readdirSync(path.join(logsDir, 'shared')).filter(n => n.startsWith('.gc-trash-'));
  const oldTrash = (ts, names) => { // a quarantine dir stamped `ts`, holding `names`
    const d = path.join(logsDir, 'shared', `.gc-trash-${ts}`);
    fs.mkdirSync(d, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(d, n), '{"q":1}');
    return d;
  };

  it('dry-run prints a per-prefix summary and totals but no file list by default; --verbose lists every file; deletes nothing', async () => {
    shared('sys_aaaaaaaaaaaa.json'); shared('tools_bbbbbbbbbbbb.json');
    shared('openai_instructions_cccccccccccc.json'); shared('openai_tools_dddddddddddd.json');
    shared('openai_prompt_meta_cccccccccccc.json');
    const r = await run({ apply: false });
    assert.equal(r.applied, false);
    assert.equal(r.doomed.length, 5);
    const out = logs.join('\n');
    for (const prefix of ['sys_', 'tools_', 'openai_instructions_', 'openai_tools_', 'openai_prompt_meta_']) assert.ok(out.includes(prefix), prefix);
    assert.match(out, /total\s+5 files .*would quarantine 5/, 'totals row');
    assert.ok(!out.includes('sys_aaaaaaaaaaaa.json'), 'no per-file list without --verbose');
    assert.equal((await storage.listShared()).length, 5, 'nothing deleted');
    await run({ apply: false, verbose: true });
    const verbose = logs.join('\n');
    for (const f of ['sys_aaaaaaaaaaaa.json', 'tools_bbbbbbbbbbbb.json', 'openai_prompt_meta_cccccccccccc.json']) assert.ok(verbose.includes(`would quarantine ${f}`), f);
    assert.equal((await storage.listShared()).length, 5, 'still nothing deleted');
  });

  it('--apply deletes only unrooted, older-than-grace files', async () => {
    shared('sys_aaaaaaaaaaaa.json'); shared('tools_bbbbbbbbbbbb.json');
    shared('sys_keepkeepkeep.json'); shared('sys_youngyoungyou.json', { ageDays: 1 });
    indexLine({ id: 'x', sysHash: 'keepkeepkeep' });
    const r = await run({ apply: true });
    assert.ok(!logs.join('\n').includes('sys_aaaaaaaaaaaa.json'), 'apply summary only, no per-file list');
    assert.deepEqual(r.doomed.sort(), ['sys_aaaaaaaaaaaa.json', 'tools_bbbbbbbbbbbb.json']);
    assert.deepEqual((await storage.listShared()).sort(), ['sys_keepkeepkeep.json', 'sys_youngyoungyou.json']);
  });

  it('a file referenced only by an index line survives (sys and tools)', async () => {
    shared('sys_idxonlyidxon.json'); shared('tools_idxonlyidxon.json');
    indexLine({ id: 'a', sysHash: 'idxonlyidxon', toolsHash: 'idxonlyidxon' });
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed, []);
    assert.equal((await storage.listShared()).length, 2);
  });

  it('a torn index line still roots the hashes it names', async () => {
    shared('sys_tornlinetorn.json');
    fs.appendFileSync(path.join(logsDir, 'index.ndjson'), '{"id":"x","sysHash":"tornlinetorn","mod');
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed, []);
  });

  it('a file referenced only by a _req.received.json survives; _req.json too', async () => {
    shared('sys_recvonlyrecv.json'); shared('tools_recvonlyrecv.json'); shared('sys_reqonlyreqon.json');
    fs.writeFileSync(path.join(logsDir, '2026-01-01T00-00-00-000_req.received.json'), JSON.stringify({ sysHash: 'recvonlyrecv', toolsHash: 'recvonlyrecv' }));
    fs.writeFileSync(path.join(logsDir, '2026-01-01T00-00-01-000_req.json'), JSON.stringify({ sysHash: 'reqonlyreqon' }));
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed, []);
    assert.equal((await storage.listShared()).length, 3);
  });

  it('a file newer than 7 days survives even when unreferenced', async () => {
    shared('sys_freshfreshfr.json', { ageDays: 6.9 }); shared('sys_staleStaleSt.json', { ageDays: 7.1 });
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed, ['sys_staleStaleSt.json']);
    assert.deepEqual(await storage.listShared(), ['sys_freshfreshfr.json']);
  });

  it('openai_prompt_meta follows the rooted state of its instructions hash', async () => {
    shared('openai_instructions_rootedrooted.json'); shared('openai_prompt_meta_rootedrooted.json');
    shared('openai_instructions_orphanorphan.json'); shared('openai_prompt_meta_orphanorphan.json');
    indexLine({ id: 'o', sysHash: 'rootedrooted' });
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed.sort(), ['openai_instructions_orphanorphan.json', 'openai_prompt_meta_orphanorphan.json']);
  });

  it('unknown shared/ names are never deleted; only exact generated .tmp- debris is', async () => {
    shared('mystery_abc.json'); shared('README.txt'); shared('sys_.json');
    shared('.tmp-123-0123456789ab-sys_x.json');                        // ours, stale → deleted
    shared('.tmp-124-0123456789ab-openai_prompt_meta_y.json');         // ours, stale → deleted
    shared('.tmp-125-0123456789ab-sys_young.json', { ageDays: 1 });    // ours but young
    shared('.tmp-manual-notes.json');                                  // not the pattern
    shared('.tmp-1-ab-sys_x.json');                                    // bad nonce
    shared('.tmp-126-0123456789ab-mystery.json');                      // unrecognized inner name
    shared('.tmp-127-0123456789ab-sys_x.txt');                         // wrong extension
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed.sort(), ['.tmp-123-0123456789ab-sys_x.json', '.tmp-124-0123456789ab-openai_prompt_meta_y.json']);
    assert.deepEqual((await storage.listShared()).sort(), [
      '.tmp-125-0123456789ab-sys_young.json', '.tmp-126-0123456789ab-mystery.json', '.tmp-127-0123456789ab-sys_x.txt',
      '.tmp-1-ab-sys_x.json', '.tmp-manual-notes.json', 'README.txt', 'mystery_abc.json', 'sys_.json',
    ].sort());
  });

  it('an unreadable _req aborts without deleting anything (unreadable ≠ unreferenced)', async () => {
    shared('sys_aaaaaaaaaaaa.json');
    // a directory named like a request file → EISDIR on read
    fs.mkdirSync(path.join(logsDir, '2026-01-01T00-00-00-000_req.json'));
    await assert.rejects(() => run({ apply: true }), { code: 'EISDIR' });
    assert.deepEqual(await storage.listShared(), ['sys_aaaaaaaaaaaa.json']);
    assert.ok(!fs.existsSync(path.join(logsDir, '.index-maintenance.lock')), 'lock released on failure');
  });

  describe('quarantine (--apply) and purge', () => {
    it('--apply moves doomed files into shared/.gc-trash-<UTC ts>/ (not unlinked) and listShared hides the dir', async () => {
      shared('sys_aaaaaaaaaaaa.json', { content: '{"a":1}' }); shared('tools_bbbbbbbbbbbb.json');
      const now = Date.UTC(2026, 10, 11, 10, 0, 0, 123);
      const r = await run({ apply: true, now: now + 40 * DAY * 0 });
      assert.equal(r.trashDir, '.gc-trash-2026-11-11T10-00-00-123Z');
      assert.deepEqual(trashDirs(), ['.gc-trash-2026-11-11T10-00-00-123Z']);
      assert.equal(fs.readFileSync(path.join(logsDir, 'shared', r.trashDir, 'sys_aaaaaaaaaaaa.json'), 'utf8'), '{"a":1}');
      assert.ok(!fs.existsSync(sharedPath('sys_aaaaaaaaaaaa.json')));
      assert.deepEqual(await storage.listShared(), [], 'listShared never returns quarantine dirs');
      assert.match(logs.join('\n'), /Nothing is freed yet/);
    });

    it('a quarantined file that is read after gc is transparently restored (readShared and statShared)', async () => {
      shared('sys_aaaaaaaaaaaa.json', { content: '{"a":1}' }); shared('tools_bbbbbbbbbbbb.json', { content: '{"b":1}' });
      await run({ apply: true });
      assert.ok(!fs.existsSync(sharedPath('sys_aaaaaaaaaaaa.json')));
      const reader = createLocalStorage(logsDir); // any build/process: only the on-disk layout matters
      assert.equal(await reader.readShared('sys_aaaaaaaaaaaa.json'), '{"a":1}');
      assert.ok(fs.existsSync(sharedPath('sys_aaaaaaaaaaaa.json')), 'moved back to shared/');
      assert.ok((await reader.statShared('tools_bbbbbbbbbbbb.json')).size > 0);
      assert.ok(fs.existsSync(sharedPath('tools_bbbbbbbbbbbb.json')));
      await assert.rejects(() => reader.readShared('sys_neverexisted.json'), { code: 'ENOENT' });
    });

    it('two readers racing to restore the same file both get it (loser just reads the restored file)', async () => {
      shared('sys_aaaaaaaaaaaa.json', { content: '{"a":1}' });
      await run({ apply: true });
      const [x, y] = await Promise.all([createLocalStorage(logsDir).readShared('sys_aaaaaaaaaaaa.json'), createLocalStorage(logsDir).readShared('sys_aaaaaaaaaaaa.json')]);
      assert.equal(x, '{"a":1}'); assert.equal(y, '{"a":1}');
    });

    it('restore probes the newest quarantine dir first', async () => {
      oldTrash('2026-01-01T00-00-00-000Z', ['sys_dupdupdupdup.json']);
      const d2 = oldTrash('2026-02-01T00-00-00-000Z', []);
      fs.writeFileSync(path.join(d2, 'sys_dupdupdupdup.json'), '{"newer":1}');
      assert.equal(await createLocalStorage(logsDir).readShared('sys_dupdupdupdup.json'), '{"newer":1}');
    });

    it('re-scans roots appended during the scan: a hash an index line or a fresh _req names just before the move is NOT quarantined', async () => {
      shared('sys_lateindexlate.json'); shared('tools_latereqlatere.json'); shared('sys_stillunrefer.json');
      const r = await run({
        apply: true,
        onScanned: async () => { // a writer lands between the scan and the move
          indexLine({ id: 'late', sysHash: 'lateindexlate' });
          fs.writeFileSync(path.join(logsDir, '2026-11-11T00-00-00-000_req.json'), JSON.stringify({ toolsHash: 'latereqlatere' }));
        },
      });
      assert.deepEqual(r.doomed, ['sys_stillunrefer.json']);
      assert.deepEqual((await storage.listShared()).sort(), ['sys_lateindexlate.json', 'tools_latereqlatere.json']);
    });

    it('--dry-run also reports already-quarantined bytes and how much is purgeable', async () => {
      oldTrash('2020-01-01T00-00-00-000Z', ['sys_x1.json', 'sys_x2.json']);
      shared('sys_aaaaaaaaaaaa.json');
      await run({ apply: false });
      assert.match(logs.join('\n'), /already quarantined: 1 dir\(s\), 2 files \(14 B\); 1 older than 7d/);
    });

    it('--purge deletes only quarantine dirs older than 7 days; unparseable .gc-trash-* names are never purged', async () => {
      oldTrash('2020-01-01T00-00-00-000Z', ['sys_x1.json']);
      const fresh = trashNameNow();
      oldTrash(fresh, ['sys_y1.json']);
      fs.mkdirSync(path.join(logsDir, 'shared', '.gc-trash-manual'));
      const r = await runPurge();
      assert.deepEqual(r.purged, ['.gc-trash-2020-01-01T00-00-00-000Z']);
      assert.deepEqual(trashDirs().sort(), [`.gc-trash-${fresh}`, '.gc-trash-manual'].sort());
      assert.ok(!fs.existsSync(path.join(logsDir, '.index-maintenance.lock')));
    });

    it('--purge --dry-run lists what it would purge and deletes nothing', async () => {
      oldTrash('2020-01-01T00-00-00-000Z', ['sys_x1.json']);
      const r = await runPurge({ dryRun: true });
      assert.deepEqual(r.purged, ['.gc-trash-2020-01-01T00-00-00-000Z']);
      assert.match(logs.join('\n'), /would purge .gc-trash-2020/);
      assert.equal(trashDirs().length, 1);
    });

    it('--purge refuses with a live listener / hub / held lock; --purge --dry-run only warns', async () => {
      oldTrash('2020-01-01T00-00-00-000Z', ['sys_x1.json']);
      const srv = net.createServer().listen(0, '127.0.0.1');
      await new Promise(r => srv.on('listening', r));
      const port = srv.address().port;
      try {
        const r = await purgeTrash({ storage, log: quiet(), port });
        assert.equal(r.reason, 'listener');
        const d = await purgeTrash({ storage, log: quiet(), port, dryRun: true });
        assert.equal(d.refused, undefined);
        assert.match(logs.join('\n'), /a server is running/);
      } finally { await new Promise(r => srv.close(r)); }
      hub.readHubLock = () => ({ pid: process.pid, port: 5577 });
      try { assert.equal((await runPurge()).reason, 'hub-running'); } finally { hub.readHubLock = () => null; }
      const lockPath = path.join(fs.realpathSync(logsDir), '.index-maintenance.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 't', op: 'rebuild-index' }));
      assert.equal((await runPurge()).reason, 'maintenance-locked');
      assert.equal(trashDirs().length, 1, 'nothing purged by any refused run');
    });
  });

  describe('live server / lock', () => {
    it('--apply refuses while a live hub is registered; --dry-run warns and continues', async () => {
      shared('sys_aaaaaaaaaaaa.json');
      hub.readHubLock = () => ({ pid: process.pid, port: 5577 });
      try {
        const r = await run({ apply: true });
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'hub-running');
        assert.match(logs.join('\n'), /hub is running/);
        assert.equal((await storage.listShared()).length, 1);

        const d = await run({ apply: false });
        assert.equal(d.refused, undefined);
        assert.equal(d.applied, false);
        assert.deepEqual(d.doomed, ['sys_aaaaaaaaaaaa.json']);
        assert.match(logs.join('\n'), /a server is running; results may change before --apply/);
      } finally { hub.readHubLock = () => null; }
      assert.equal((await storage.listShared()).length, 1);
    });

    it('--apply refuses while a listener holds the configured port (no hub.json: standalone/--port server); --dry-run warns and continues', async () => {
      shared('sys_aaaaaaaaaaaa.json');
      const srv = net.createServer().listen(0, '127.0.0.1');
      await new Promise(r => srv.on('listening', r));
      const port = srv.address().port;
      try {
        const r = await gcShared({ storage, log: quiet(), apply: true, port });
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'listener');
        assert.match(logs.join('\n'), /listening on/);
        assert.equal((await storage.listShared()).length, 1);

        const d = await gcShared({ storage, log: quiet(), apply: false, port });
        assert.equal(d.refused, undefined);
        assert.deepEqual(d.doomed, ['sys_aaaaaaaaaaaa.json']);
        assert.match(logs.join('\n'), /a server is running; results may change before --apply/);
      } finally { await new Promise(r => srv.close(r)); }
      assert.equal((await storage.listShared()).length, 1, 'dry-run deleted nothing');
    });

    it('--apply refuses while the ADR 0021 maintenance lock is held; --dry-run neither refuses nor takes the lock', async () => {
      shared('sys_aaaaaaaaaaaa.json');
      const lockPath = path.join(fs.realpathSync(logsDir), '.index-maintenance.lock');
      const held = JSON.stringify({ pid: process.pid, token: 't', op: 'rebuild-index' });
      fs.writeFileSync(lockPath, held);
      const r = await run({ apply: true });
      assert.equal(r.refused, true);
      assert.equal(r.reason, 'maintenance-locked');
      assert.match(logs.join('\n'), /already running/);
      assert.equal((await storage.listShared()).length, 1);

      const d = await run({ apply: false });
      assert.equal(d.refused, undefined);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), held, "someone else's lock is left alone");
    });

    it('--apply releases its own maintenance lock after a run; --dry-run never creates one', async () => {
      const lockPath = path.join(fs.realpathSync(logsDir), '.index-maintenance.lock');
      await run({ apply: false });
      assert.ok(!fs.existsSync(lockPath));
      await run({ apply: true });
      assert.ok(!fs.existsSync(lockPath));
    });
  });
});
