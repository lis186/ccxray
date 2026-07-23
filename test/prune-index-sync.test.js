'use strict';

// #344: pruneLogs must sync index.ndjson + sessions.json with the _req/_res
// files it prunes, so a session card never survives without loadable turn data.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { pruneLogs, pruneIndexLines } = require('../server/restore');

// ── Pure decision function ──────────────────────────────────────────
describe('pruneIndexLines (pure)', () => {
  const L = (o) => JSON.stringify(o);

  it('drops a proxy line whose _req.json is gone; keeps one whose file survives', () => {
    const content = [
      L({ id: 'a', sessionId: 's1' }),          // file gone → drop
      L({ id: 'b', sessionId: 's1' }),          // file survives → keep
    ].join('\n');
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(['b']),
      protectedIds: new Set(),
    });
    assert.equal(dropped, 1);
    assert.deepEqual(keptLines.map(l => JSON.parse(l).id), ['b']);
  });

  it('keeps a protected (starred / in-memory) proxy line even with no file', () => {
    const content = L({ id: 'a', sessionId: 's1' });
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(),
      protectedIds: new Set(['a']),
    });
    assert.equal(dropped, 0);
    assert.equal(keptLines.length, 1);
  });

  it('keeps a standalone imported line (no files by design)', () => {
    const content = L({ id: 'i1', sessionId: 's1', imported: true, responseId: 'msg_solo' });
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(),
      protectedIds: new Set(),
    });
    assert.equal(dropped, 0);
    assert.equal(keptLines.length, 1);
  });

  it('drops an imported line orphaned by a pruned proxy twin (shared responseId, no survivor)', () => {
    const content = [
      L({ id: 'p1', sessionId: 's1', responseId: 'msg_x' }),               // proxy, file gone
      L({ id: 'i1', sessionId: 's1', imported: true, responseId: 'msg_x' }), // imported dup
    ].join('\n');
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(),      // p1 file gone
      protectedIds: new Set(),
    });
    assert.equal(dropped, 2, 'both the pruned proxy AND its orphaned imported twin drop');
    assert.equal(keptLines.length, 0);
  });

  it('keeps an imported dup when a proxy copy of the same responseId survives', () => {
    const content = [
      L({ id: 'p1', sessionId: 's1', responseId: 'msg_y' }),               // proxy, file survives
      L({ id: 'i1', sessionId: 's1', imported: true, responseId: 'msg_y' }), // imported dup
    ].join('\n');
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(['p1']),
      protectedIds: new Set(),
    });
    assert.equal(dropped, 0);
    assert.deepEqual(keptLines.map(l => JSON.parse(l).id).sort(), ['i1', 'p1']);
  });

  it('keeps unparseable / id-less lines verbatim', () => {
    const content = ['not json', L({ noId: true })].join('\n');
    const { keptLines, dropped } = pruneIndexLines(content, {
      survivingReqIds: new Set(),
      protectedIds: new Set(),
    });
    assert.equal(dropped, 0);
    assert.equal(keptLines.length, 2);
  });
});

// ── Integration: pruneLogs end-to-end ───────────────────────────────
describe('pruneLogs: index + sessions.json sync (#344)', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-prune-idx-' + process.pid);
  let storage, origStorage, origRetention, origLogsDir;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
    origStorage = config.storage;
    origRetention = config.LOG_RETENTION_DAYS;
    origLogsDir = config.LOGS_DIR;
    config.storage = storage;
    config.LOG_RETENTION_DAYS = 14;
    Object.defineProperty(config, 'LOGS_DIR', { value: tmpDir, writable: true, configurable: true });
  });

  after(() => {
    config.storage = origStorage;
    config.LOG_RETENTION_DAYS = origRetention;
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
    store.entries.length = 0;
  });

  const OLD = '2020-01-01';                                     // < cutoff → prunable
  const recentId = new Date().toISOString().slice(0, 10) + 'T10-00-00-000';

  function writeFiles(id) {
    fs.writeFileSync(path.join(tmpDir, `${id}_req.json`), '{"messages":[]}');
    fs.writeFileSync(path.join(tmpDir, `${id}_res.json`), '[]');
  }
  function writeIndex(lines) {
    fs.writeFileSync(path.join(tmpDir, 'index.ndjson'), lines.map(JSON.stringify).join('\n') + '\n');
  }
  function readIndexIds() {
    const raw = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l).id).sort();
  }

  it('drops ghost proxy lines + orphaned imported twin; keeps loadable + standalone imported', async () => {
    const ghostNoFile   = `${OLD}T00-00-00-001`;  // proxy, index line only (pre-existing ghost)
    const oldWithFile   = `${OLD}T00-00-00-002`;  // proxy, old files → pruned this run
    const importedSolo  = `${OLD}T00-00-00-003`;  // imported standalone → keep
    const importedOrphan = `${OLD}T00-00-00-004`; // imported dup of a pruned proxy → drop
    const oldTwinProxy  = `${OLD}T00-00-00-005`;  // proxy twin of importedOrphan → pruned
    const importedLive  = `${OLD}T00-00-00-006`;  // imported dup of a SURVIVING proxy → keep
    const recentProxy   = recentId;               // proxy, recent files → keep

    writeFiles(oldWithFile);
    writeFiles(oldTwinProxy);
    writeFiles(recentProxy);

    writeIndex([
      { id: ghostNoFile, sessionId: 'sA' },
      { id: oldWithFile, sessionId: 'sA' },
      { id: importedSolo, sessionId: 'sB', imported: true, responseId: 'msg_solo' },
      { id: importedOrphan, sessionId: 'sB', imported: true, responseId: 'msg_x' },
      { id: oldTwinProxy, sessionId: 'sA', responseId: 'msg_x' },
      { id: importedLive, sessionId: 'sC', imported: true, responseId: 'msg_y' },
      { id: recentProxy, sessionId: 'sC', responseId: 'msg_y', cost: { cost: 1.0 } },
    ]);

    await pruneLogs();

    const ids = readIndexIds();
    assert.deepEqual(ids, [importedSolo, importedLive, recentProxy].sort(),
      'only loadable proxy lines + standalone/live-backed imported lines survive');

    // Files: old with-file proxies deleted, recent kept.
    const files = fs.readdirSync(tmpDir);
    assert.ok(!files.includes(`${oldWithFile}_req.json`), 'old proxy _req.json pruned');
    assert.ok(!files.includes(`${oldTwinProxy}_req.json`), 'old twin proxy _req.json pruned');
    assert.ok(files.includes(`${recentProxy}_req.json`), 'recent proxy _req.json kept');

    // sessions.json rebuilt from the pruned index — session sA (all lines gone)
    // must be absent; sC (recentProxy) present.
    const sraw = fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf8');
    const sids = sraw.split('\n').filter(Boolean).map(l => JSON.parse(l).sid).sort();
    assert.deepEqual(sids, ['sB', 'sC'], 'sA (fully pruned) removed from sessions.json; sB/sC remain');
  });

  it('leaves index.ndjson untouched when nothing is dropped', async () => {
    writeFiles(recentId);
    writeIndex([{ id: recentId, sessionId: 'sOnly' }]);
    const before = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');

    await pruneLogs();

    const afterRaw = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    assert.equal(afterRaw, before, 'no ghost → index unchanged');
  });
});
