'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalStorage } = require('../server/storage/local');

describe('per-session entry cap during restore', () => {
  const config = require('../server/config');
  const store = require('../server/store');
  const { restoreFromLogs } = require('../server/restore');
  const tmpDir = path.join(os.tmpdir(), 'ccxray-session-cap-' + Date.now());
  let realStorage, realRestoreDays;

  before(async () => {
    realStorage = config.storage;
    realRestoreDays = config.RESTORE_DAYS;
    config.RESTORE_DAYS = 0; // disable date filter
    const tmpStorage = createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    config.RESTORE_DAYS = realRestoreDays;
    store.entries.length = 0;
    store.entryIndex.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps oversized sessions to 1 entry + truncated flag', async () => {
    store.entries.length = 0;
    store.entryIndex.clear();

    const CAP = store.SESSION_ENTRY_CAP; // 500 default

    // Build index: 3 normal sessions (each 10 entries) + 1 oversized (CAP + 100 entries)
    const indexLines = [];

    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 10; i++) {
        const h = String(s).padStart(2, '0');
        const m = String(i).padStart(2, '0');
        indexLines.push(JSON.stringify({
          id: `2026-07-18T${h}-${m}-00-000`,
          sessionId: `normal-sess-${s}`,
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          isSSE: true, status: 200,
          receivedAt: Date.now(),
        }));
      }
    }

    for (let i = 0; i < CAP + 100; i++) {
      const m = String(i % 60).padStart(2, '0');
      const h = String(10 + Math.floor(i / 60)).padStart(2, '0');
      indexLines.push(JSON.stringify({
        id: `2026-07-18T${h}-${m}-${String(i).padStart(2, '0')}-000`,
        sessionId: 'oversized-sess',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        isSSE: true, status: 200,
        receivedAt: Date.now(),
      }));
    }

    await config.storage.appendIndex(indexLines.join('\n') + '\n');

    await restoreFromLogs();

    // Normal sessions: all entries loaded
    for (let s = 0; s < 3; s++) {
      const count = store.entries.filter(e => e.sessionId === `normal-sess-${s}`).length;
      assert.equal(count, 10, `normal-sess-${s} should have all 10 entries`);
    }

    // Oversized session: only 1 entry loaded + truncated
    const oversizedEntries = store.entries.filter(e => e.sessionId === 'oversized-sess');
    assert.equal(oversizedEntries.length, 1, 'oversized session should have exactly 1 entry');
    assert.equal(oversizedEntries[0].truncated, true, 'should be marked truncated');
    assert.equal(oversizedEntries[0].totalEntryCount, CAP + 100, 'should have total count');

    // entryIndex consistency (ADR 0003)
    for (const e of store.entries) {
      assert.equal(store.entryIndex.get(e.id), e, `entryIndex must contain ${e.id}`);
    }
  });

  it('sessions at exactly cap are NOT truncated', async () => {
    store.entries.length = 0;
    store.entryIndex.clear();

    const CAP = store.SESSION_ENTRY_CAP;
    const indexLines = [];

    for (let i = 0; i < CAP; i++) {
      indexLines.push(JSON.stringify({
        id: `2026-07-18T20-${String(i % 60).padStart(2, '0')}-${String(i).padStart(3, '0')}-000`,
        sessionId: 'exactly-cap-sess',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        isSSE: true, status: 200,
        receivedAt: Date.now(),
      }));
    }

    await config.storage.appendIndex(indexLines.join('\n') + '\n');
    await restoreFromLogs();

    const entries = store.entries.filter(e => e.sessionId === 'exactly-cap-sess');
    assert.equal(entries.length, CAP, `should load all ${CAP} entries`);
    assert.equal(entries[0].truncated, undefined, 'should not be truncated');
  });
});
