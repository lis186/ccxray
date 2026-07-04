'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { refreshCodex } = require('../server/adapters/codex-adapter');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
}

describe('codex-adapter', () => {
  let outDir;

  beforeEach(() => {
    outDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('extracts rate_limits from real fixture and writes unified snapshot', () => {
    const sessionsDir = path.join(__dirname, 'fixtures/codex-sessions');
    // #119: the adapter drops files older than CODEX_SCAN_MAX_AGE_MS (7 days),
    // and fixture mtime is the checkout date — touch so old working trees pass.
    const now = new Date();
    for (const f of fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))) {
      fs.utimesSync(path.join(sessionsDir, f), now, now);
    }
    refreshCodex(sessionsDir, outDir);

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);

    const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
    assert.equal(snap.provider, 'openai');
    assert.equal(snap.planType, 'prolite');
    assert.equal(typeof snap.fiveHour.usedPct, 'number');
    assert.equal(typeof snap.fiveHour.resetsAt, 'number');
    assert.ok(snap.fiveHour.resetsAt < 1e11, 'resetsAt should be epoch seconds');
    assert.equal(typeof snap.sevenDay.usedPct, 'number');
    assert.equal(typeof snap.sevenDay.resetsAt, 'number');
    assert.equal(typeof snap.updatedAt, 'number');
    assert.ok(snap.id);
    assert.ok(snap.label);
  });

  it('picks the most recent file by mtime', () => {
    const tmpSessions = makeTmpDir();
    try {
      const oldFile = path.join(tmpSessions, 'old.jsonl');
      const newFile = path.join(tmpSessions, 'new.jsonl');

      const line = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            plan_type: 'plus',
            primary: { used_percent: 10, window_minutes: 300, resets_at: 1780000000 },
            secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1780500000 },
          },
        },
      });

      fs.writeFileSync(oldFile, line + '\n');
      const pastTime = new Date(Date.now() - 60000);
      fs.utimesSync(oldFile, pastTime, pastTime);

      const newLine = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            plan_type: 'pro',
            primary: { used_percent: 50, window_minutes: 300, resets_at: 1780000000 },
            secondary: { used_percent: 60, window_minutes: 10080, resets_at: 1780500000 },
          },
        },
      });
      fs.writeFileSync(newFile, newLine + '\n');

      refreshCodex(tmpSessions, outDir);

      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);
      const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
      assert.equal(snap.planType, 'pro');
      assert.equal(snap.fiveHour.usedPct, 50);
    } finally {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  });

  it('does nothing when no sessions dir exists', () => {
    refreshCodex('/nonexistent/path/sessions', outDir);
    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 0);
  });

  it('does nothing when sessions have no rate_limits', () => {
    const tmpSessions = makeTmpDir();
    try {
      const line = JSON.stringify({
        type: 'event_msg',
        payload: { type: 'other_event', info: {} },
      });
      fs.writeFileSync(path.join(tmpSessions, 'session.jsonl'), line + '\n');

      refreshCodex(tmpSessions, outDir);
      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 0);
    } finally {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  });

  it('normalizes epoch milliseconds to seconds', () => {
    const tmpSessions = makeTmpDir();
    try {
      const line = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            plan_type: 'free',
            primary: { used_percent: 5, window_minutes: 300, resets_at: 1780000000000 },
            secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1780500000000 },
          },
        },
      });
      fs.writeFileSync(path.join(tmpSessions, 'session.jsonl'), line + '\n');

      refreshCodex(tmpSessions, outDir);

      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
      assert.ok(snap.fiveHour.resetsAt < 1e11, 'should be epoch seconds');
      assert.ok(snap.sevenDay.resetsAt < 1e11, 'should be epoch seconds');
    } finally {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  });

  it('handles session with only primary (no secondary)', () => {
    const tmpSessions = makeTmpDir();
    try {
      const line = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            plan_type: 'free',
            primary: { used_percent: 30, window_minutes: 300, resets_at: 1780000000 },
          },
        },
      });
      fs.writeFileSync(path.join(tmpSessions, 'session.jsonl'), line + '\n');

      refreshCodex(tmpSessions, outDir);

      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
      assert.equal(snap.fiveHour.usedPct, 30);
      assert.equal(snap.sevenDay, null);
    } finally {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  });

  it('finds .jsonl files in nested subdirectories (real codex layout)', () => {
    const tmpSessions = makeTmpDir();
    try {
      const nested = path.join(tmpSessions, '2026', '06', '11');
      fs.mkdirSync(nested, { recursive: true });

      const line = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            plan_type: 'plus',
            primary: { used_percent: 42, window_minutes: 300, resets_at: 1780000000 },
            secondary: { used_percent: 15, window_minutes: 10080, resets_at: 1780500000 },
          },
        },
      });
      fs.writeFileSync(path.join(nested, 'rollout-test.jsonl'), line + '\n');

      refreshCodex(tmpSessions, outDir);

      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);
      const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
      assert.equal(snap.planType, 'plus');
      assert.equal(snap.fiveHour.usedPct, 42);
    } finally {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  });
});
