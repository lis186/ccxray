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
const { gcShared } = require('../server/gc');

const DAY = 86400_000;
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

  it('dry-run prints a per-prefix summary and totals but no file list by default; --verbose lists every file; deletes nothing', async () => {
    shared('sys_aaaaaaaaaaaa.json'); shared('tools_bbbbbbbbbbbb.json');
    shared('openai_instructions_cccccccccccc.json'); shared('openai_tools_dddddddddddd.json');
    shared('openai_prompt_meta_cccccccccccc.json');
    const r = await run({ apply: false });
    assert.equal(r.applied, false);
    assert.equal(r.doomed.length, 5);
    const out = logs.join('\n');
    for (const prefix of ['sys_', 'tools_', 'openai_instructions_', 'openai_tools_', 'openai_prompt_meta_']) assert.ok(out.includes(prefix), prefix);
    assert.match(out, /total\s+5 files .*would delete 5/, 'totals row');
    assert.ok(!out.includes('sys_aaaaaaaaaaaa.json'), 'no per-file list without --verbose');
    assert.equal((await storage.listShared()).length, 5, 'nothing deleted');
    await run({ apply: false, verbose: true });
    const verbose = logs.join('\n');
    for (const f of ['sys_aaaaaaaaaaaa.json', 'tools_bbbbbbbbbbbb.json', 'openai_prompt_meta_cccccccccccc.json']) assert.ok(verbose.includes(`would delete ${f}`), f);
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

  it('unknown shared/ names are never deleted; stale .tmp- leftovers are', async () => {
    shared('mystery_abc.json'); shared('README.txt'); shared('sys_.json');
    shared('.tmp-1-ab-sys_x.json'); shared('.tmp-2-ab-sys_y.json', { ageDays: 1 });
    const r = await run({ apply: true });
    assert.deepEqual(r.doomed, ['.tmp-1-ab-sys_x.json']);
    assert.deepEqual((await storage.listShared()).sort(), ['.tmp-2-ab-sys_y.json', 'README.txt', 'mystery_abc.json', 'sys_.json']);
  });

  it('an unreadable _req aborts without deleting anything (unreadable ≠ unreferenced)', async () => {
    shared('sys_aaaaaaaaaaaa.json');
    // a directory named like a request file → EISDIR on read
    fs.mkdirSync(path.join(logsDir, '2026-01-01T00-00-00-000_req.json'));
    await assert.rejects(() => run({ apply: true }), { code: 'EISDIR' });
    assert.deepEqual(await storage.listShared(), ['sys_aaaaaaaaaaaa.json']);
    assert.ok(!fs.existsSync(path.join(logsDir, '.index-maintenance.lock')), 'lock released on failure');
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
