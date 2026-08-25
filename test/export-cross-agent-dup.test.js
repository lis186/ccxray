'use strict';

// Deterministic reproduction of the two GCS data-duplication defects observed on
// the real bucket (2026-08-25 audit):
//
//   A. Cross-agent_id double count — the same logical traffic (same responseIds,
//      same session_id) exported from two CCXRAY_HOMEs under two agent ids is
//      summed twice by a daily_latest-style fold, which dedups only WITHIN an
//      agent_id ((agent_id, dt) → max upload_seq). Real evidence: dt=2026-08-20
//      carried a1129d91 (seq 1..7) AND d0763ef3 (seq 1) with identical
//      session_count=25; ~$27K / 25% inflation across the bucket.
//      The session rows in the same objects carry session_id, so a session-level
//      cross-agent dedup CAN recover the true total — asserted here as the
//      contract the BQ-side fix depends on.
//
//   B. No-backfill breach via the importer race — first flush initializes the
//      cursor to the index tail ("No backfill"), but any historical lines
//      appended AFTER that (an importer scan still in flight, a later importer
//      wave, `import --once`) land past the cursor and are treated as new data:
//      their historical dts are uploaded wholesale. Real evidence: d0763ef3
//      uploaded 124 dts spanning 2026-03-01..08-21 all at seq 1.
//
// These are CHARACTERIZATION tests: they pin today's (defective) behavior with
// `assert` so the defect is mechanically demonstrated. When the fix lands, the
// two assertions marked DEFECT must be flipped — that flip is the fail-on-old /
// pass-on-new evidence required by docs/verification-principles.md.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { flushExport, _setUploader } = require('../server/export-sync');

// ── Harness (test/export-sync.test.js shape) ───────────────────────────

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-dup-test-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function writeIndex(home, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines);
}

function appendIndex(home, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), lines);
}

function makeEntry(overrides = {}) {
  const id = overrides.id || '2026-08-12T10-00-00-000';
  return {
    id,
    ts: id,
    sessionId: 'sess-shared-001',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    msgCount: 10,
    usage: { input_tokens: 50000, output_tokens: 2000 },
    cost: { cost: 0.15, confidence: 'exact' },
    maxContext: 200000,
    stopReason: 'end_turn',
    status: 200,
    cwd: '/Users/dev/myproject',
    ...overrides,
  };
}

const _ambientDisable = process.env.CCXRAY_EXPORT_DISABLE;
let _savedFlags = { disable: _ambientDisable };

function setupEnv(home, agentId) {
  process.env.TZ = 'Asia/Taipei';
  process.env.CCXRAY_HOME = home;
  process.env.CCXRAY_EXPORT_GCS_BUCKET = 'test-bucket';
  delete process.env.LOGS_DIR;
  delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
  delete process.env.CCXRAY_EXPORT_GCS_PREFIX;
  delete process.env.CCXRAY_EXPORT_CONFIG_DIRS;
  delete process.env.CCXRAY_EXPORT_CWD_ALLOWLIST;
  _savedFlags = { disable: process.env.CCXRAY_EXPORT_DISABLE };
  delete process.env.CCXRAY_EXPORT_DISABLE;
  process.env.CCXRAY_AGENT_ID = agentId;
  process.env.CCXRAY_USER_EMAIL = 'test@example.com';
  process.env.CCXRAY_TEAM = 'test-team';
  bustConfigCache();
}

function bustConfigCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server/config')) delete require.cache[k];
  }
}

function cleanupEnv() {
  delete process.env.CCXRAY_HOME;
  delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
  delete process.env.CCXRAY_AGENT_ID;
  delete process.env.CCXRAY_USER_EMAIL;
  delete process.env.CCXRAY_TEAM;
  if (_savedFlags.disable === undefined) delete process.env.CCXRAY_EXPORT_DISABLE;
  else process.env.CCXRAY_EXPORT_DISABLE = _savedFlags.disable;
  _savedFlags = {};
  _setUploader(null);
  bustConfigCache();
}

function collector(uploads) {
  return async (bucket, name, body) => {
    uploads.push({ name, records: body.trim().split('\n').map(l => JSON.parse(l)) });
  };
}

// BQ daily_latest-style fold: per (agent_id, dt) keep the max-upload_seq daily
// row, then sum cost_total across agent_ids. Mirrors ccxray-ops bq/ DDL.
function dailyLatestTotal(uploads, dt) {
  const latest = new Map(); // `${agent_id}\x00${dt}` → daily row
  for (const u of uploads) {
    for (const r of u.records) {
      if (r.type !== 'daily' || r.dt !== dt) continue;
      const key = `${r.agent_id}\x00${r.dt}`;
      const prev = latest.get(key);
      if (!prev || r.upload_seq > prev.upload_seq) latest.set(key, r);
    }
  }
  let total = 0;
  for (const r of latest.values()) total += r.cost_total;
  return { total, agentCount: latest.size };
}

// Session-level cross-agent fold: latest object per (agent_id, dt), then dedup
// session rows by session_id ACROSS agent_ids.
function sessionDedupTotal(uploads, dt) {
  const latestSeqByAgent = new Map();
  for (const u of uploads) {
    for (const r of u.records) {
      if (r.type !== 'daily' || r.dt !== dt) continue;
      const prev = latestSeqByAgent.get(r.agent_id) || 0;
      if (r.upload_seq > prev) latestSeqByAgent.set(r.agent_id, r.upload_seq);
    }
  }
  const bySession = new Map(); // session_id → cost_total
  for (const u of uploads) {
    const daily = u.records.find(r => r.type === 'daily' && r.dt === dt);
    if (!daily || latestSeqByAgent.get(daily.agent_id) !== daily.upload_seq) continue;
    for (const r of u.records) {
      if (r.type !== 'session' || r.dt !== dt) continue;
      bySession.set(r.session_id, r.cost_total);
    }
  }
  let total = 0;
  for (const c of bySession.values()) total += c;
  return total;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('cross-agent_id duplication (GCS audit 2026-08-25)', () => {
  afterEach(cleanupEnv);

  it('daily_latest fold double-counts the same traffic exported from two homes; session_id fold does not', async () => {
    const sharedTurns = [
      makeEntry({ id: '2026-08-12T10-00-00-000', responseId: 'msg_r1' }),
      makeEntry({ id: '2026-08-12T11-00-00-000', responseId: 'msg_r2' }),
      makeEntry({ id: '2026-08-12T12-00-00-000', responseId: 'msg_r3' }),
    ];
    const trueCost = 3 * 0.15;
    const uploads = [];

    // Machine/home A — e.g. the primary CCXRAY_HOME
    const homeA = mkHome();
    writeIndex(homeA, sharedTurns);
    setupEnv(homeA, 'agent-A');
    // non-first-run cursor with a null lastId → whole index counts as new
    fs.writeFileSync(path.join(homeA, 'export-cursor.json'),
      JSON.stringify({ lastId: null, seq: {}, partial: false }) + '\n');
    _setUploader(collector(uploads));
    await flushExport();
    cleanupEnv();

    // Machine/home B — a second home that saw the SAME turns (importer copies
    // the same ~/.claude transcripts into every home; or a reset home)
    const homeB = mkHome();
    writeIndex(homeB, sharedTurns);
    setupEnv(homeB, 'agent-B');
    fs.writeFileSync(path.join(homeB, 'export-cursor.json'),
      JSON.stringify({ lastId: null, seq: {}, partial: false }) + '\n');
    _setUploader(collector(uploads));
    await flushExport();

    assert.equal(uploads.length, 2, 'each home uploads one object for the dt');

    const { total, agentCount } = dailyLatestTotal(uploads, '2026-08-12');
    assert.equal(agentCount, 2, 'the fold sees two distinct agent_ids');
    // DEFECT (characterization): the daily_latest-style fold cannot see across
    // agent_ids, so the same three turns are billed twice. A fix must make this
    // equal `trueCost` — flip this assertion when it lands.
    assert.ok(Math.abs(total - 2 * trueCost) < 1e-9,
      `daily_latest-style fold double-counts: got ${total}, defect shape is ${2 * trueCost}`);

    // CONTRACT: session rows carry session_id, so a session-level cross-agent
    // dedup recovers the true total. The BQ-side fix depends on this property —
    // if this assertion breaks, cross-agent dedup becomes impossible.
    const sessTotal = sessionDedupTotal(uploads, '2026-08-12');
    assert.ok(Math.abs(sessTotal - trueCost) < 1e-9,
      `session_id-level fold must recover the true total: got ${sessTotal}, want ${trueCost}`);
  });
});

describe('no-backfill breach: historical lines appended after cursor init', () => {
  afterEach(cleanupEnv);

  it('an importer wave landing after first-run cursor init is uploaded wholesale (historical dts leak)', async () => {
    const home = mkHome();
    // Live traffic present at first flush
    writeIndex(home, [
      makeEntry({ id: '2026-08-12T10-00-00-000', responseId: 'msg_live1', sessionId: 'sess-live' }),
    ]);
    setupEnv(home, 'agent-fresh');
    const uploads = [];
    _setUploader(collector(uploads));

    // First flush: initializes cursor to index tail, uploads nothing ("No backfill")
    await flushExport();
    assert.equal(uploads.length, 0, 'first run must not upload');

    // Importer wave arrives AFTER cursor init: months-old transcripts appended
    // to the index (append order, ids carry their original historical dates)
    appendIndex(home, [
      makeEntry({ id: '2026-03-05T10-00-00-000', responseId: 'msg_old1', sessionId: 'sess-old', imported: true }),
      makeEntry({ id: '2026-03-05T11-00-00-000', responseId: 'msg_old2', sessionId: 'sess-old', imported: true }),
    ]);

    await flushExport();

    const dts = new Set();
    for (const u of uploads) for (const r of u.records) if (r.type === 'daily') dts.add(r.dt);
    // DEFECT (characterization): the no-backfill promise is breached — the
    // historical dt is exported because the cursor only knows line position,
    // not a date floor. A fix must keep 2026-03-05 OUT of this set — flip this
    // assertion when it lands.
    assert.ok(dts.has('2026-03-05'),
      `historical dt leaks today (defect shape); uploaded dts: ${[...dts].join(', ')}`);
  });
});
