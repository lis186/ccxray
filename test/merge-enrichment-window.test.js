'use strict';

// #388: when store.registerOrMerge returns merged=true, the canonical (post-merge)
// entry must still be fed to sessionIdx.updateFromEntry so that enrichment fields
// (beta1m, maxContext) from the merged-away copy reach the session-index window fold.
// Without this fix, the session window stays at 200K instead of 1M.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

describe('#388 merge enrichment reaches session-index window fold', () => {
  let tmpDir, origLogsDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-388-'));
    await fsp.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpDir, 'logs'), writable: true, configurable: true });
  });

  afterEach(async () => {
    // #388 codex R1: flush/cancel the pending timer BEFORE restoring LOGS_DIR,
    // otherwise the delayed flush can write test data to the real sessions.json.
    const si = require('../server/session-index');
    await si.flush();
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/session-index')];
    delete require.cache[require.resolve('../server/store')];
  });

  // ── Structural contract: forward.js must not gate updateFromEntry on !merged ──
  // This is the fail-on-old test. Old code has `if (!merged) sessionIdx.updateFromEntry(entry)`;
  // new code calls `sessionIdx.updateFromEntry(canonical)` unconditionally.
  it('#388 fail-on-old: forward.js must not gate updateFromEntry on !merged', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/forward.js'), 'utf8');
    const gatedPattern = /if\s*\(\s*!merged\s*\)\s*sessionIdx\.updateFromEntry/;
    assert.equal(gatedPattern.test(src), false,
      'forward.js must call updateFromEntry unconditionally after merge — the !merged guard hides enrichment (#388)');
  });

  // ── Behavioral: merged enrichment propagates when caller does the right thing ──
  it('merged-away copy carrying beta1m propagates to session window via canonical', () => {
    const si = require('../server/session-index');
    const store = require('../server/store');
    const sid = 'test-session-388';
    const rid = 'msg_01_merge_test';

    // First copy — no beta1m, maxContext=200000
    const entryA = {
      id: '2026-07-31T10-00-00-000', ts: '10:00:00', responseId: rid,
      sessionId: sid, receivedAt: 1000, elapsed: '2.0',
      maxContext: 200000, beta1m: undefined,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { cost: 0.01 },
    };
    const resultA = store.registerOrMerge(entryA);
    assert.equal(resultA.merged, false, 'first copy registers as canonical');
    si.updateFromEntry(entryA);
    assert.equal(si.sessionWindow(sid), 200000, 'window starts at 200K');

    // Second copy — same responseId, carries beta1m=true + maxContext=1000000
    const entryB = {
      id: '2026-07-31T10-00-01-000', ts: '10:00:01', responseId: rid,
      sessionId: sid, receivedAt: 2000, elapsed: '1.0',
      maxContext: 1000000, beta1m: true,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { cost: 0.01 },
    };
    const resultB = store.registerOrMerge(entryB);
    assert.equal(resultB.merged, true, 'second copy merges into canonical');

    // Simulate NEW forward.js: always feed canonical to session-index
    si.updateFromEntry(resultB.canonical);

    assert.equal(si.sessionWindow(sid), 1000000, 'window folds to 1M after merge enrichment');
    assert.equal(si.get(sid).beta1m, true, 'beta1m propagated to session');
    assert.equal(si.get(sid).count, 1, 'count stays 1 — rid dedup prevents double-count');
  });
});
