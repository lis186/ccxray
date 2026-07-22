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

  it('#333: rebuild counts cost once per responseId, keeps raw entry count', () => {
    const si = require('../server/session-index');
    // 3 duplicate copies of ONE turn (same responseId) + 1 distinct turn — the
    // shared-log shape. Cost must be counted once per responseId (ADR mandatory);
    // count stays raw so reconcile's raw-line comparison doesn't perpetually drift.
    const lines = [
      JSON.stringify({ id: 't1a', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 1 }),
      JSON.stringify({ id: 't1b', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 2 }),
      JSON.stringify({ id: 't1c', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 3 }),
      JSON.stringify({ id: 't2', sessionId: 'sess-x', responseId: 'msg_01B', cost: { cost: 0.01 }, receivedAt: 4 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-x');
    assert.ok(Math.abs(s.totalCost - 0.06) < 1e-9, `cost once per responseId: expected 0.06, got ${s.totalCost}`);
    assert.equal(s.count, 4, 'count stays raw (best-effort) so reconcile does not thrash');
  });

  it('#333: cost dedup keeps the MAX per responseId (poor copy logged first)', () => {
    const si = require('../server/session-index');
    // A partial copy (output 0, cost ~0) logged before the complete copy must not
    // pin the session total to the cheap value (codex round-3 M3).
    const lines = [
      JSON.stringify({ id: 'p1', sessionId: 'sess-z', responseId: 'msg_01A', cost: { cost: 0.001 }, receivedAt: 1 }),
      JSON.stringify({ id: 'p2', sessionId: 'sess-z', responseId: 'msg_01A', cost: { cost: 0.01 }, receivedAt: 2 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-z');
    assert.ok(Math.abs(s.totalCost - 0.01) < 1e-9, `expected max 0.01, got ${s.totalCost}`);
  });

  it('#333: a line without responseId still counts its cost (legacy/exempt)', () => {
    const si = require('../server/session-index');
    const lines = [
      JSON.stringify({ id: 'l1', sessionId: 'sess-y', cost: { cost: 0.1 }, receivedAt: 1 }),
      JSON.stringify({ id: 'l2', sessionId: 'sess-y', cost: { cost: 0.2 }, receivedAt: 2 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-y');
    assert.ok(Math.abs(s.totalCost - 0.3) < 1e-9, 'no responseId ⇒ no dedup, both cost counted');
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

  it('reconcile detects session-count drift and rebuilds', async () => {
    const si = require('../server/session-index');
    // Seed sessions.json with 2 sessions
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    si.updateFromEntry({ sessionId: 'sb', id: 't2', model: 'x', cost: { cost: 2 }, receivedAt: 2 });
    await si.flush();
    assert.equal(si.size(), 2);

    // index.ndjson has 3 sessions
    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sb', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
      JSON.stringify({ id: 't3', sessionId: 'sc', model: 'x', cost: { cost: 3 }, receivedAt: 3 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.ok(drifted, 'should detect session-count drift');
    assert.equal(si.size(), 3, 'should rebuild with 3 sessions');
  });

  it('reconcile detects entry-count drift and rebuilds', async () => {
    const si = require('../server/session-index');
    // Seed with 1 session / 1 entry
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    await si.flush();
    assert.equal(si.getAll()[0].count, 1);

    // index.ndjson has same 1 session but 2 entries
    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sa', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.ok(drifted, 'should detect entry-count drift');
    assert.equal(si.getAll()[0].count, 2, 'should rebuild with correct count');
  });

  it('reconcile passes when counts match', () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    si.updateFromEntry({ sessionId: 'sb', id: 't2', model: 'x', cost: { cost: 2 }, receivedAt: 2 });

    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sb', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.equal(drifted, false, 'should not detect drift');
    assert.equal(si.size(), 2, 'should keep existing sessions');
  });
});
