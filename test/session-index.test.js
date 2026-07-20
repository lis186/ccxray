'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

describe('session-index', () => {
  let tmpDir, origLogsDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-si-'));
    await fsp.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    // Point LOGS_DIR at our temp dir
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpDir, 'logs'), writable: true, configurable: true });
  });

  afterEach(async () => {
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    // Clear module cache so each test gets fresh state
    delete require.cache[require.resolve('../server/session-index')];
  });

  it('updateFromEntry + flush + load round-trip', async () => {
    const si = require('../server/session-index');
    si.updateFromEntry({
      sessionId: 'abc-123', id: '2026-07-15T09-00-00-000', model: 'claude-opus-4-6',
      cwd: '/home/user/project', cost: { cost: 1.5 }, receivedAt: 1000000,
      provider: 'anthropic', agent: 'claude', title: 'Test session',
    });
    si.updateFromEntry({
      sessionId: 'abc-123', id: '2026-07-15T09-10-00-000', model: 'claude-opus-4-6',
      cwd: '/home/user/project', cost: { cost: 0.5 }, receivedAt: 2000000,
      provider: 'anthropic', agent: 'claude',
    });
    assert.equal(si.size(), 1);
    const all = si.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sid, 'abc-123');
    assert.equal(all[0].count, 2);
    assert.equal(all[0].totalCost, 2.0);
    assert.equal(all[0].firstId, '2026-07-15T09-00-00-000');
    assert.equal(all[0].lastId, '2026-07-15T09-10-00-000');
    assert.equal(all[0].title, 'Test session');

    await si.flush();
    const config = require('../server/config');
    const raw = await fsp.readFile(path.join(config.LOGS_DIR, 'sessions.json'), 'utf8');
    assert.ok(raw.includes('abc-123'));

    // Clear and reload
    delete require.cache[require.resolve('../server/session-index')];
    const si2 = require('../server/session-index');
    const loaded = await si2.loadSessionIndex();
    assert.ok(loaded);
    assert.equal(si2.size(), 1);
    const reloaded = si2.getAll()[0];
    assert.equal(reloaded.count, 2);
    assert.equal(reloaded.totalCost, 2.0);
  });

  it('rebuildFromIndexContent', () => {
    const si = require('../server/session-index');
    const lines = [
      JSON.stringify({ id: '2026-07-10T01-00-00-000', sessionId: 'sess-a', model: 'opus', cwd: '/a', cost: { cost: 1 }, receivedAt: 100 }),
      JSON.stringify({ id: '2026-07-10T02-00-00-000', sessionId: 'sess-a', model: 'opus', cwd: '/a', cost: { cost: 2 }, receivedAt: 200 }),
      JSON.stringify({ id: '2026-07-10T03-00-00-000', sessionId: 'sess-b', model: 'sonnet', cwd: '/b', cost: { cost: 0.5 }, receivedAt: 300 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    assert.equal(si.size(), 2);
    const a = si.getAll().find(s => s.sid === 'sess-a');
    assert.equal(a.count, 2);
    assert.equal(a.totalCost, 3);
    const b = si.getAll().find(s => s.sid === 'sess-b');
    assert.equal(b.count, 1);
  });

  it('loadSessionIndex returns false when file missing', async () => {
    const si = require('../server/session-index');
    const loaded = await si.loadSessionIndex();
    assert.equal(loaded, false);
  });

  it('setTitle updates existing session', async () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's1', id: 't1', model: 'x', receivedAt: 1 });
    si.setTitle('s1', 'My Title');
    assert.equal(si.getAll()[0].title, 'My Title');
  });

  it('multiple sessions', () => {
    const si = require('../server/session-index');
    for (let i = 0; i < 5; i++) {
      si.updateFromEntry({ sessionId: `s-${i}`, id: `2026-07-${10+i}T00-00-00-000`, model: 'opus', receivedAt: i * 1000 });
    }
    assert.equal(si.size(), 5);
  });
});
