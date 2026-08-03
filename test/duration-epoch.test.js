'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

describe('#426 duration: firstReceivedAt epoch-ms min-fold', () => {
  let tmpDir, origLogsDir, origCcxrayHome;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-dur-'));
    await fsp.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    origCcxrayHome = process.env.CCXRAY_HOME;
    process.env.CCXRAY_HOME = tmpDir;
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpDir, 'logs'), writable: true, configurable: true });
  });

  afterEach(async () => {
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    if (origCcxrayHome === undefined) delete process.env.CCXRAY_HOME;
    else process.env.CCXRAY_HOME = origCcxrayHome;
    await fsp.rm(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/session-index')];
  });

  it('_upsert tracks firstReceivedAt as min of positive receivedAt values', () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's1', id: 'a', receivedAt: 1000 });
    si.updateFromEntry({ sessionId: 's1', id: 'b', receivedAt: 500 });
    si.updateFromEntry({ sessionId: 's1', id: 'c', receivedAt: 2000 });
    const s = si.get('s1');
    assert.equal(s.firstReceivedAt, 500, 'should be the minimum');
    assert.equal(s.lastReceivedAt, 2000, 'should be the maximum');
  });

  it('null/zero receivedAt does not poison firstReceivedAt', () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's1', id: 'a', receivedAt: null });
    si.updateFromEntry({ sessionId: 's1', id: 'b', receivedAt: 0 });
    si.updateFromEntry({ sessionId: 's1', id: 'c', receivedAt: 1000 });
    const s = si.get('s1');
    assert.equal(s.firstReceivedAt, 1000, 'null/zero must not set firstReceivedAt');
  });

  it('schema migration forces rebuild when firstReceivedAt is missing', async () => {
    const config = require('../server/config');
    const logsDir = path.join(tmpDir, 'logs');
    // Write a sessions.json missing firstReceivedAt but having maxContext + fallbackCount
    const old = { sid: 's1', firstId: 'x', lastId: 'y', count: 1, model: 'm', cwd: '/', totalCost: 0, fallbackCost: 0, fallbackCount: 0, unknownCount: 0, title: null, firstPrompt: null, lastReceivedAt: 0, provider: 'anthropic', agent: 'claude', maxContext: 200000 };
    await fsp.writeFile(path.join(logsDir, 'sessions.json'), JSON.stringify(old) + '\n');
    // Make sessions.json newer than index so the stale check doesn't interfere
    const indexPath = path.join(logsDir, 'index.ndjson');
    await fsp.writeFile(indexPath, '');
    const now = new Date();
    await fsp.utimes(indexPath, now, new Date(now.getTime() - 10000));
    const si = require('../server/session-index');
    const loaded = await si.loadSessionIndex();
    assert.equal(loaded, false, 'should reject sessions.json missing firstReceivedAt');
  });

  it('rebuild from index lines populates firstReceivedAt', () => {
    const si = require('../server/session-index');
    const metas = [
      { sessionId: 's1', id: 'a', receivedAt: 3000, model: 'm' },
      { sessionId: 's1', id: 'b', receivedAt: 1000, model: 'm' },
      { sessionId: 's1', id: 'c', receivedAt: 5000, model: 'm' },
    ];
    si.rebuildFromMetas(metas);
    const s = si.get('s1');
    assert.equal(s.firstReceivedAt, 1000);
    assert.equal(s.lastReceivedAt, 5000);
  });

  it('mixed proxy+importer IDs: duration comes from epoch, not ID parsing', () => {
    const si = require('../server/session-index');
    // Simulate: importer entry (UTC id, earlier lexicographically) and proxy entry (Taipei id)
    // Same real moment: 2026-08-02T14:31:57 UTC = 2026-08-02T22:31:57 Taipei
    const importerEntry = {
      sessionId: 's1',
      id: '2026-08-02T14-31-57-24',  // UTC format (importer)
      receivedAt: 1722608117024,       // the real epoch ms
      model: 'm',
    };
    const proxyEntry = {
      sessionId: 's1',
      id: '2026-08-02T22-31-57-822',  // Taipei format (proxy)
      receivedAt: 1722608117822,        // ~800ms later (same real moment)
      model: 'm',
    };
    const laterEntry = {
      sessionId: 's1',
      id: '2026-08-03T02-26-21-750',
      receivedAt: 1722622381750,
      model: 'm',
    };
    si.updateFromEntry(importerEntry);
    si.updateFromEntry(proxyEntry);
    si.updateFromEntry(laterEntry);
    const s = si.get('s1');
    // Duration from epoch: ~3.96h, not ~11.9h (the 8h-offset bug)
    const durationH = (s.lastReceivedAt - s.firstReceivedAt) / 3600000;
    assert.ok(durationH < 5, `duration ${durationH.toFixed(2)}h should be <5h, not ~12h`);
    assert.ok(durationH > 0, 'duration should be positive');
    // firstId is still the lexicographic min (importer wins) — preserved for display
    assert.equal(s.firstId, '2026-08-02T14-31-57-24');
  });

  it('firstReceivedAt persists through flush (no underscore prefix)', async () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's1', id: 'a', receivedAt: 42000 });
    await si.flush();
    const config = require('../server/config');
    const raw = await fsp.readFile(path.join(config.LOGS_DIR, 'sessions.json'), 'utf8');
    const obj = JSON.parse(raw.trim());
    assert.equal(obj.firstReceivedAt, 42000, 'firstReceivedAt must be in persisted JSON');
  });
});
