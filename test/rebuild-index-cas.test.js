'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rebuild-cas-home-'));
process.env.CCXRAY_HOME = TEST_HOME;
process.env.CCXRAY_EXPORT_DISABLE = '1';

const hub = require('../server/hub');
const importer = require('../server/importer');
const { createLocalStorage } = require('../server/storage/local');
const { rebuildIndex, reimportEntries } = require('../server/rebuild-index');

const tempDirs = [TEST_HOME];
let realReadHubLock;

describe('rebuild-index CAS and maintenance lock', () => {
  before(() => {
    realReadHubLock = hub.readHubLock;
    hub.readHubLock = () => null;
  });

  after(() => {
    hub.readHubLock = realReadHubLock;
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  async function fixture(indexLines = []) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rebuild-cas-'));
    tempDirs.push(logsDir);
    const storage = createLocalStorage(logsDir);
    await storage.init();
    const indexPath = path.join(logsDir, 'index.ndjson');
    if (indexLines.length > 0) {
      fs.writeFileSync(indexPath, indexLines.map(line => JSON.stringify(line)).join('\n') + '\n');
    }
    return { storage, indexPath };
  }

  function ageIndex(indexPath) {
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(indexPath, old, old);
  }

  function writeRecoveredTurn(logsDir, id = '2026-09-01T10-00-00-000') {
    fs.writeFileSync(path.join(logsDir, `${id}_req.json`), JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'recover this turn' }],
      metadata: { session_id: 'recovered-session' },
    }));
    fs.writeFileSync(path.join(logsDir, `${id}_res.json`), JSON.stringify([
      { type: 'message_start', message: { id: 'msg_recovered', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    ]));
    return id;
  }

  function readIndex(indexPath) {
    if (!fs.existsSync(indexPath)) return [];
    return fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  function appendDuringRead(storage, line) {
    let appended = false;
    return {
      ...storage,
      readIndexLines() {
        const source = storage.readIndexLines();
        return (async function* () {
          for await (const sourceLine of source) {
            if (!appended) {
              appended = true;
              await storage.appendIndex(JSON.stringify(line) + '\n');
            }
            yield sourceLine;
          }
        })();
      },
    };
  }

  it('CAS detects a concurrent append and preserves the appended line', async () => {
    const { storage, indexPath } = await fixture([{ id: 'existing', sessionId: 'old' }]);
    const recoveredId = writeRecoveredTurn(storage.location);
    ageIndex(indexPath);
    const concurrentLine = { id: 'concurrent-append', sessionId: 'live' };

    const result = await rebuildIndex({
      apply: true,
      storage: appendDuringRead(storage, concurrentLine),
      log: () => {},
    });

    assert.deepEqual(result, { refused: true, reason: 'index-changed' });
    const ids = readIndex(indexPath).map(line => line.id);
    assert.ok(ids.includes('concurrent-append'));
    assert.ok(!ids.includes(recoveredId), 'the refused rewrite must not partially apply');
  });

  it('CAS allows a normal rebuild', async () => {
    const { storage, indexPath } = await fixture([{ id: 'existing', sessionId: 'old' }]);
    const recoveredId = writeRecoveredTurn(storage.location);
    ageIndex(indexPath);

    const result = await rebuildIndex({ apply: true, storage, log: () => {} });

    assert.equal(result.applied, true);
    assert.ok(readIndex(indexPath).some(line => line.id === recoveredId));
  });

  it('creates an absent index with a link-based commit', async () => {
    const { storage, indexPath } = await fixture();
    const recoveredId = writeRecoveredTurn(storage.location);

    const result = await rebuildIndex({ apply: true, storage, log: () => {} });

    assert.equal(result.applied, true);
    assert.ok(readIndex(indexPath).some(line => line.id === recoveredId));
  });

  it('refuses an index written recently by a likely recording server', async () => {
    const { storage, indexPath } = await fixture([{ id: 'recent', sessionId: 'live' }]);
    const logs = [];
    const result = await rebuildIndex({
      apply: true,
      storage,
      log: message => logs.push(message),
    });

    assert.equal(result.refused, true);
    assert.match(logs.join('\n'), /appears to be recording/);
  });

  it('maintenance lock serializes live commands and reclaims dead locks', async () => {
    const live = await fixture([{ id: 'existing', sessionId: 'old' }]);
    writeRecoveredTurn(live.storage.location, '2026-09-01T10-01-00-000');
    ageIndex(live.indexPath);
    const lockPath = path.join(live.storage.location, '.index-maintenance.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'live', op: 'reimport', startedAt: new Date().toISOString() }));

    const refused = await rebuildIndex({ apply: true, storage: live.storage, log: () => {} });
    assert.equal(refused.refused, true);
    assert.equal(refused.reason, 'maintenance-locked');

    const reclaimed = await fixture([{ id: 'existing', sessionId: 'old' }]);
    const recoveredId = writeRecoveredTurn(reclaimed.storage.location, '2026-09-01T10-02-00-000');
    ageIndex(reclaimed.indexPath);
    const reclaimedLockPath = path.join(reclaimed.storage.location, '.index-maintenance.lock');
    let deadPid = process.pid + 1;
    while (hub.isPidAlive(deadPid)) deadPid++;
    fs.writeFileSync(reclaimedLockPath, JSON.stringify({ pid: deadPid, token: 'dead', op: 'reimport', startedAt: new Date().toISOString() }));

    const proceeded = await rebuildIndex({ apply: true, storage: reclaimed.storage, log: () => {} });
    assert.equal(proceeded.applied, true);
    assert.ok(readIndex(reclaimed.indexPath).some(line => line.id === recoveredId));
    assert.equal(fs.existsSync(reclaimedLockPath), false);
  });

  it('aborts reimport before scanAndImport when CAS detects an append', async () => {
    const { storage, indexPath } = await fixture([{ id: 'imported-old', imported: true, sessionId: 'old' }]);
    ageIndex(indexPath);
    const oldScanAndImport = importer.scanAndImport;
    let scanned = false;
    importer.scanAndImport = async () => {
      scanned = true;
      return { imported: 1, skipped: 0 };
    };
    const originalImportDisable = process.env.CCXRAY_IMPORT_DISABLE;
    process.env.CCXRAY_IMPORT_DISABLE = '0';
    try {
      const result = await reimportEntries({
        storage: appendDuringRead(storage, { id: 'live-append', sessionId: 'live' }),
        log: () => {},
      });
      assert.deepEqual(result, { refused: true, reason: 'index-changed' });
    } finally {
      importer.scanAndImport = oldScanAndImport;
      if (originalImportDisable === undefined) delete process.env.CCXRAY_IMPORT_DISABLE;
      else process.env.CCXRAY_IMPORT_DISABLE = originalImportDisable;
    }
    assert.equal(scanned, false);
    assert.deepEqual(readIndex(indexPath).map(line => line.id), ['imported-old', 'live-append']);
  });
});
