'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Module = require('module');

const { flushExport, _setUploader } = require('../server/export-sync');

// ── Helpers ────────────────────────────────────────────────────────────

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-test-'));
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return home;
}

function writeIndex(home, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines);
}

function makeEntry(overrides = {}) {
  const id = overrides.id || '2026-08-12T10-00-00-000';
  return {
    id,
    ts: id,
    sessionId: 'sess-001',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    msgCount: 10,
    usage: { input_tokens: 50000, output_tokens: 2000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000 },
    cost: { cost: 0.15, confidence: 'exact' },
    maxContext: 200000,
    stopReason: 'end_turn',
    status: 200,
    cwd: '/Users/dev/myproject',
    ...overrides,
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function entryForDt(dt, overrides = {}) {
  return makeEntry({ id: `${dt}T10-00-00-000`, ...overrides });
}

function loadMergeEntryForTest() {
  const filename = path.join(__dirname, '../server/export-sync.js');
  const source = fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.__testMergeEntry = mergeEntry;\n';
  const localModule = { exports: {} };
  const localRequire = Module.createRequire(filename);
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  run(localModule.exports, localRequire, localModule, filename, path.dirname(filename));
  return localModule.exports.__testMergeEntry;
}

// Set up env + uploader mock before each test
// Save ambient suppression state at module load, before any test clears it.
// Without this, the first test's afterEach(cleanup) deletes an inherited
// CCXRAY_EXPORT_DISABLE without knowing its original value.
const _ambientDisable = process.env.CCXRAY_EXPORT_DISABLE;
const _ambientTz = process.env.TZ;
let _home, _uploads, _savedFlags = { disable: _ambientDisable, tz: _ambientTz };
function setup(entries, envOverrides = {}) {
  _home = mkHome();
  _uploads = [];
  writeIndex(_home, entries);

  // Env — TZ must match the server that generates entry ids (Asia/Taipei)
  const savedFlags = { disable: process.env.CCXRAY_EXPORT_DISABLE, tz: process.env.TZ };
  process.env.TZ = 'Asia/Taipei';
  process.env.CCXRAY_HOME = _home;
  process.env.CCXRAY_EXPORT_GCS_BUCKET = 'test-bucket';
  delete process.env.LOGS_DIR;
  delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
  delete process.env.CCXRAY_EXPORT_GCS_PREFIX;
  delete process.env.CCXRAY_EXPORT_CONFIG_DIRS;
  // Ambient suppression flags must not leak in: layer 1 (CCXRAY_EXPORT_DISABLE)
  // deliberately overrides an injected seam, so running the safety-conscious
  // `CCXRAY_EXPORT_DISABLE=1 npm test` would turn every flush below into a no-op and
  // fail this suite for the wrong reason (codex review round 2, 2026-08-21).
  // Saved into _savedFlags and restored in cleanup(): under --test-isolation=none a later
  // file would otherwise inherit weakened safety settings (codex review round 5).
  _savedFlags = savedFlags;
  delete process.env.CCXRAY_EXPORT_DISABLE;
  process.env.CCXRAY_AGENT_ID = 'test-agent-001';
  process.env.CCXRAY_USER_EMAIL = 'test@example.com';
  process.env.CCXRAY_TEAM = 'test-team';

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  _setUploader(async (bucket, name, body) => {
    _uploads.push({ bucket, name, body, records: body.trim().split('\n').map(l => JSON.parse(l)) });
  });

  // Pre-create cursor so it's not a first-run (unless test wants first-run)
  if (!envOverrides._skipCursor) {
    fs.writeFileSync(path.join(_home, 'export-cursor.json'),
      JSON.stringify({ lastId: null, seq: {}, partial: false, cutoffDt: '2026-01-01', floorV: 1 }) + '\n');
  }
}

function cleanup() {
  const home = _home;
  _home = null;
  delete process.env.CCXRAY_HOME;
  delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
  delete process.env.LOGS_DIR;
  delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
  delete process.env.CCXRAY_EXPORT_GCS_PREFIX;
  delete process.env.CCXRAY_EXPORT_CONFIG_DIRS;
  delete process.env.CCXRAY_AGENT_ID;
  delete process.env.CCXRAY_USER_EMAIL;
  delete process.env.CCXRAY_TEAM;
  // Restore what setup() cleared, so a later file under --test-isolation=none does not
  // inherit weakened safety settings.
  if (_savedFlags.disable === undefined) delete process.env.CCXRAY_EXPORT_DISABLE;
  else process.env.CCXRAY_EXPORT_DISABLE = _savedFlags.disable;
  if (_savedFlags.tz === undefined) delete process.env.TZ;
  else process.env.TZ = _savedFlags.tz;
  _savedFlags = {};
  _setUploader(null);
  if (home) fs.rmSync(home, { recursive: true, force: true });
  // Bust require cache for config (it caches LOGS_DIR at require time)
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server/config')) delete require.cache[k];
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('export-sync', () => {
  afterEach(cleanup);

  it('zero-regression: no bucket → no-op', async () => {
    _home = mkHome();
    process.env.CCXRAY_HOME = _home;
    delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
    _setUploader(async () => { throw new Error('should not upload'); });
    await flushExport(); // must not throw
  });

  it('T4: unset config-dir control leaves normal export unchanged', async () => {
    setup([makeEntry()]);
    await flushExport();
    assert.equal(_uploads.length, 1, 'unset tombstone variable must not suppress export');
    assert.ok(_uploads[0].records.some(r => r.type === 'daily'));
  });

  it('first-run: cursor init to tail, no upload', async () => {
    const liveDt = daysAgoUtc(14);
    setup([entryForDt(liveDt)], { _skipCursor: true });
    const before = todayUtc();
    await flushExport();
    const after = todayUtc();
    assert.equal(_uploads.length, 0, 'no upload on first run');
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, `${liveDt}T10-00-00-000`);
    assert.equal(cursor.partial, true);
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
  });

  it('first-run: empty index writes today UTC as the cutoff floor', async () => {
    setup([], { _skipCursor: true });
    const before = todayUtc();
    await flushExport();
    const after = todayUtc();
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, null);
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
  });

  it('first-run: old imported tail still writes today UTC as the cutoff floor', async () => {
    const oldDt = daysAgoUtc(170);
    const oldId = `${oldDt}T10-00-00-000`;
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    const before = todayUtc();
    await flushExport();
    const after = todayUtc();
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, oldId);
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
  });

  it('missing cursor.lastId rescans but uploads only dates at or above the floor', async () => {
    setup([
      makeEntry({ id: '2026-07-31T10-00-00-000' }),
      makeEntry({ id: '2026-08-01T10-00-00-000', msgCount: 11 }),
      makeEntry({ id: '2026-08-02T10-00-00-000', msgCount: 12 }),
    ], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: 'cursor-id-no-longer-in-index', seq: {}, partial: false,
      cutoffDt: '2026-08-01', floorV: 1,
    }) + '\n');

    await flushExport();

    const dts = _uploads.map(u => u.records.find(r => r.type === 'daily').dt).sort();
    assert.deepEqual(dts, ['2026-08-01', '2026-08-02']);
  });

  it('date equal to cutoffDt remains eligible for upload', async () => {
    setup([
      makeEntry({ id: '2026-07-31T10-00-00-000' }),
      makeEntry({ id: '2026-08-01T10-00-00-000', msgCount: 11 }),
    ], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: '2026-08-01', floorV: 1,
    }) + '\n');

    await flushExport();

    const dts = _uploads.map(u => u.records.find(r => r.type === 'daily').dt);
    assert.deepEqual(dts, ['2026-08-01']);
  });

  it('legacy cursor migrates to today UTC and skips older dates', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const migrated = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(migrated.cutoffDt));
    assert.equal(migrated.floorV, 1);
    assert.equal(_uploads.length, 0, 'older dates are skipped during migration');

    fs.appendFileSync(path.join(_home, 'logs', 'index.ndjson'),
      JSON.stringify(makeEntry({ id: `${migrated.cutoffDt}T10-00-00-000`, msgCount: 11 })) + '\n');
    await flushExport();

    const dts = _uploads.map(u => u.records.find(r => r.type === 'daily').dt);
    assert.deepEqual(dts, [migrated.cutoffDt]);
  });

  it('legacy cursor with an old derived cutoffDt is re-stamped to today', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: oldDt,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
    assert.equal(_uploads.length, 0, 'the old derived date remains below the repaired floor');
  });

  it('malformed cutoffDt is fail-closed and re-stamped to today', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: 'garbage', floorV: 1,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
    assert.equal(_uploads.length, 0, 'the old date remains below the repaired floor');
  });

  it('non-string cutoffDt is fail-closed and re-stamped to today', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: 123, floorV: 1,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
    assert.equal(_uploads.length, 0, 'the old date remains below the repaired floor');
  });

  it('impossible cutoffDt 2026-99-99 is fail-closed and re-stamped to today', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: '2026-99-99', floorV: 1,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
    assert.equal(_uploads.length, 0, 'the old date remains below the repaired floor');
  });

  it('impossible cutoffDt 0000-00-00 is fail-closed and re-stamped to today', async () => {
    const oldDt = daysAgoUtc(170);
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null, seq: {}, partial: false, cutoffDt: '0000-00-00', floorV: 1,
    }) + '\n');

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
    assert.equal(_uploads.length, 0, 'the old date remains below the repaired floor');
  });

  it('corrupt cursor is moved aside before first-run re-initialization', async () => {
    const oldDt = daysAgoUtc(170);
    const oldId = `${oldDt}T10-00-00-000`;
    setup([entryForDt(oldDt, { imported: true })], { _skipCursor: true });
    const corruptBody = '{not-json\n';
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), corruptBody);

    const before = todayUtc();
    await flushExport();
    const after = todayUtc();

    const sidecars = fs.readdirSync(_home)
      .filter(name => /^export-cursor\.json\.corrupt-\d+$/.test(name));
    assert.equal(sidecars.length, 1);
    assert.equal(fs.readFileSync(path.join(_home, sidecars[0]), 'utf8'), corruptBody);
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, oldId);
    assert.equal(cursor.partial, true);
    assert.ok([before, after].includes(cursor.cutoffDt));
    assert.equal(cursor.floorV, 1);
  });

  it('seq entries below the floor are pruned on the next cursor write', async () => {
    setup([entryForDt('2026-08-02')], { _skipCursor: true });
    fs.writeFileSync(path.join(_home, 'export-cursor.json'), JSON.stringify({
      lastId: null,
      seq: { '2026-07-31': 7, '2026-08-02': 3 },
      partial: false,
      cutoffDt: '2026-08-01',
      floorV: 1,
    }) + '\n');

    await flushExport();

    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.deepEqual(cursor.seq, { '2026-08-02': 4 });
  });

  it('daily schema: all required fields present', async () => {
    setup([makeEntry()]);
    await flushExport();
    assert.equal(_uploads.length, 1);
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.ok(daily, 'daily record exists');

    // Required fields
    for (const f of [
      'type', '_summary_schema_version', 'agent_id', 'dt', 'upload_seq', 'summary_id',
      'cost_total', 'models', 'context_utilization', 'compaction_count',
      'tool_usage', 'tool_sources', 'skill_usage', 'tool_fail_count',
      'duplicate_tool_call_count', 'credential_flag', 'error_count', 'stop_reasons',
      'session_count', 'turn_count', 'subagent_turn_count', 'cwd_repos',
    ]) {
      assert.ok(f in daily, `missing field: ${f}`);
    }
    assert.equal(daily._summary_schema_version, 2);
    assert.equal(daily.agent_id, 'test-agent-001');
    assert.equal(daily.dt, '2026-08-12');
    assert.equal(daily.turn_count, 1);
    assert.equal(daily.session_count, 1);
  });

  it('session schema: all required fields + model_primary', async () => {
    setup([
      makeEntry({ model: 'claude-sonnet-4-6' }),
      makeEntry({ id: '2026-08-12T10-01-00-000', model: 'claude-opus-4-6', msgCount: 12 }),
      makeEntry({ id: '2026-08-12T10-02-00-000', model: 'claude-sonnet-4-6', msgCount: 14 }),
    ]);
    await flushExport();
    const sess = _uploads[0].records.find(r => r.type === 'session');
    assert.ok(sess);
    assert.equal(sess.session_id, 'sess-001');
    assert.equal(sess.model_primary, 'claude-sonnet-4-6'); // 2 sonnet vs 1 opus
    assert.equal(sess.turn_count, 3);
    for (const f of ['type', '_summary_schema_version', 'agent_id', 'dt', 'session_id',
      'cost_total', 'turn_count', 'model_primary', 'flags', 'summary_id', 'models',
      'imported_turn_count', 'inferred_turn_count', 'import_sources', 'session_id_kind']) {
      assert.ok(f in sess, `missing field: ${f}`);
    }
    assert.equal(sess._summary_schema_version, 2);
  });

  it('payload canary: no prompt/credential/path in output', async () => {
    const decoys = {
      id: '2026-08-12T10-00-00-000',
      sessionId: 'sess-001',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      title: 'SECRET: my-secret-prompt-title',
      cwd: '/Users/secretuser/private-repo/.git/parent',
      hasCredential: false,
      sysHash: 'abc123',
      toolsHash: 'def456',
      coreHash: 'ghi789',
      convId: 'conv-secret',
      usage: { input_tokens: 1000, output_tokens: 100 },
      cost: { cost: 0.01, confidence: 'exact' },
      maxContext: 200000,
      status: 200,
    };
    setup([decoys]);
    await flushExport();
    const payload = _uploads[0].body;
    assert.ok(!payload.includes('SECRET'), 'no title leaked');
    assert.ok(!payload.includes('/Users/secretuser'), 'no absolute path leaked');
    assert.ok(!payload.includes('abc123'), 'no sysHash leaked');
    assert.ok(!payload.includes('def456'), 'no toolsHash leaked');
    assert.ok(!payload.includes('ghi789'), 'no coreHash leaked');
    assert.ok(!payload.includes('conv-secret'), 'no convId leaked');
  });

  it('no timestamp leak: only dt and upload_seq', async () => {
    const receivedAt = new Date('2026-08-12T00:00:00Z').getTime();
    setup([makeEntry({ receivedAt, elapsed: '5.2' })]);
    await flushExport();
    const payload = _uploads[0].body;
    assert.ok(!payload.includes(String(receivedAt)), 'no receivedAt epoch');
    assert.ok(!payload.includes('receivedAt'), 'no receivedAt field name');
    // dt and upload_seq are allowed
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.ok(daily.dt);
    assert.equal(typeof daily.upload_seq, 'number');
  });

  it('session flags: credential_leak, runaway, tool_fail_spike', async () => {
    // credential_leak
    setup([makeEntry({ hasCredential: true })]);
    await flushExport();
    let sess = _uploads[0].records.find(r => r.type === 'session');
    assert.ok(sess.flags.includes('credential_leak'));
    cleanup();

    // tool_fail_spike (>50% turns have turnToolFail)
    setup([
      makeEntry({ turnToolFail: true }),
      makeEntry({ id: '2026-08-12T10-01-00-000', turnToolFail: true, msgCount: 12 }),
      makeEntry({ id: '2026-08-12T10-02-00-000', turnToolFail: false, msgCount: 14 }),
    ]);
    await flushExport();
    sess = _uploads[0].records.find(r => r.type === 'session');
    assert.ok(sess.flags.includes('tool_fail_spike'));
  });

  it('cursor continuation: upload_seq increments, no upload if no new data', async () => {
    setup([makeEntry()]);
    await flushExport();
    assert.equal(_uploads.length, 1);
    const seq1 = _uploads[0].records.find(r => r.type === 'daily').upload_seq;

    // Second flush with no new data → no upload
    _uploads = [];
    await flushExport();
    assert.equal(_uploads.length, 0);

    // Add new data
    const indexPath = path.join(_home, 'logs', 'index.ndjson');
    fs.appendFileSync(indexPath, JSON.stringify(makeEntry({ id: '2026-08-12T11-00-00-000', msgCount: 12 })) + '\n');
    await flushExport();
    assert.equal(_uploads.length, 1);
    const seq2 = _uploads[0].records.find(r => r.type === 'daily').upload_seq;
    assert.ok(seq2 > seq1, `upload_seq must increment: ${seq2} > ${seq1}`);
  });

  it('name truncation + email filter', async () => {
    const longName = 'A'.repeat(100);
    setup([makeEntry({
      turnToolCalls: { [longName]: 5, 'user@email.com': 3, 'normal-tool': 2 },
    })]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    const keys = Object.keys(daily.tool_usage);
    assert.ok(!keys.some(k => k.length > 64), 'no name > 64 chars');
    assert.ok(!keys.some(k => k.includes('@')), 'no email-like names');
    assert.ok(keys.includes('normal-tool'));
    assert.equal(daily.tool_usage['normal-tool'], 2);
  });

  it('context utilization buckets with cache tokens in numerator', async () => {
    // input=50000, cache_read=30000, cache_creation=5000, maxContext=200000
    // total = 85000 / 200000 = 42.5% → 40-80 bucket
    setup([makeEntry()]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.context_utilization['40-80'], 1);
    assert.equal(daily.context_utilization['0-40'], 0);
    assert.equal(daily.context_utilization['80+'], 0);
  });

  it('compaction count via msgCount drop', async () => {
    setup([
      makeEntry({ msgCount: 10 }),
      makeEntry({ id: '2026-08-12T10-01-00-000', msgCount: 20 }),
      makeEntry({ id: '2026-08-12T10-02-00-000', msgCount: 8 }), // drop = compaction
      makeEntry({ id: '2026-08-12T10-03-00-000', msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.compaction_count, 1);
  });

  it('cost confidence fold: mixed when some fallback', async () => {
    setup([
      makeEntry({ cost: { cost: 0.10, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', cost: { cost: 0.05, confidence: 'fallback' }, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.cost_confidence, 'mixed');
  });

  it('lock: concurrent flush skipped', async () => {
    setup([makeEntry()]);
    // Manually create lock
    const lockPath = path.join(_home, 'export.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'held', acquiredAt: Date.now() }), { flag: 'wx' });
    await flushExport();
    assert.equal(_uploads.length, 0, 'skipped due to lock');
    fs.unlinkSync(lockPath);
  });

  it('turnToolCalls null-vs-empty: {} contributes zero, null uses fallback', async () => {
    setup([
      // Entry with turnToolCalls = {} → zero tool calls (parsed, no tools)
      makeEntry({ turnToolCalls: {}, toolCalls: { Bash: 5 } }),
      // Entry with turnToolCalls = null → legacy, falls back to toolCalls per-tool max
      makeEntry({ id: '2026-08-12T10-01-00-000', turnToolCalls: null, toolCalls: { Read: 3 }, msgCount: 12 }),
      // Entry with real turnToolCalls
      makeEntry({ id: '2026-08-12T10-02-00-000', turnToolCalls: { Edit: 2 }, msgCount: 14 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.ok(!('Bash' in daily.tool_usage), 'Bash from {} entry should not appear');
    assert.equal(daily.tool_usage.Read, 3, 'Read from legacy fallback');
    assert.equal(daily.tool_usage.Edit, 2, 'Edit from real turnToolCalls');
  });

  it('per-model breakdown includes cost', async () => {
    setup([
      makeEntry({ model: 'claude-sonnet-4-6', cost: { cost: 0.15, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', model: 'claude-opus-4-6', cost: { cost: 1.20, confidence: 'exact' }, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.ok(daily.models['claude-sonnet-4-6']);
    assert.equal(daily.models['claude-sonnet-4-6'].cost, 0.15);
    assert.equal(daily.models['claude-opus-4-6'].cost, 1.20);
    assert.ok(Math.abs(daily.cost_total - 1.35) < 0.001);
  });

  it('session per-model breakdown includes the complete ADR 0017 confidence fold', async () => {
    setup([
      makeEntry({ model: 'model-a', cost: { cost: 0.10, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', model: 'model-a', msgCount: 12,
        cost: { cost: 0.20, confidence: 'fallback' } }),
      makeEntry({ id: '2026-08-12T10-02-00-000', model: 'model-a', msgCount: 14,
        cost: { cost: null, confidence: 'unknown' } }),
      makeEntry({ id: '2026-08-12T10-03-00-000', model: 'model-b', msgCount: 16,
        cost: { cost: 0.30, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-04-00-000', model: 'model-c', msgCount: 18,
        cost: { cost: 0.40, confidence: 'unknown' } }),
      makeEntry({ id: '2026-08-12T10-05-00-000', model: 'model-d', msgCount: 20,
        cost: 0.50 }),
    ]);
    await flushExport();

    const sess = _uploads[0].records.find(r => r.type === 'session');
    assert.ok(sess.models, 'session models breakdown exists');
    assert.equal(sess.models['model-a'].turns, 3);
    assert.ok(Math.abs(sess.models['model-a'].cost - 0.30) < 0.000001);
    assert.equal(sess.models['model-a'].fallback_cost, 0.20);
    assert.equal(sess.models['model-a'].fallback_count, 1);
    assert.equal(sess.models['model-a'].unknown_count, 1);
    assert.deepEqual(sess.models['model-b'], {
      turns: 1,
      cost: 0.30,
      fallback_cost: 0,
      fallback_count: 0,
      unknown_count: 0,
    });
    assert.equal(sess.models['model-c'].unknown_count, 1);
    assert.equal(sess.models['model-d'].unknown_count, 0);
  });

  it('session provenance counts and classifies sentinel ids from the shared provider helper', async () => {
    setup([
      makeEntry({ sessionId: 'sess-provenance', imported: true, importSource: 'claude-code' }),
      makeEntry({ id: '2026-08-12T10-01-00-000', sessionId: 'sess-provenance', msgCount: 12,
        imported: true, importSource: 'codex', sessionInferred: true }),
      makeEntry({ id: '2026-08-12T10-02-00-000', sessionId: 'sess-provenance', msgCount: 14,
        imported: false, sessionInferred: false }),
      makeEntry({ id: '2026-08-12T10-03-00-000', sessionId: 'grok-raw', msgCount: 16 }),
    ]);
    await flushExport();

    const sessions = _uploads[0].records.filter(r => r.type === 'session');
    const provenance = sessions.find(r => r.session_id === 'sess-provenance');
    const sentinel = sessions.find(r => r.session_id === 'grok-raw');
    assert.equal(provenance.imported_turn_count, 2);
    assert.equal(provenance.inferred_turn_count, 1);
    assert.deepEqual(provenance.import_sources, ['claude-code', 'codex']);
    assert.equal(provenance.session_id_kind, 'explicit');
    assert.equal(sentinel.session_id_kind, 'sentinel');
  });

  it('responseId merge makes importSource a commutative, associative set union', () => {
    const mergeEntry = loadMergeEntryForTest();
    const sourceSet = entry => {
      const source = entry.importSource;
      const values = Array.isArray(source) ? source : [source];
      return [...new Set(values.filter(value => typeof value === 'string' && value))].sort();
    };
    const provenance = entry => ({ imported: entry.imported, importSources: sourceSet(entry) });
    const importedCopy = (source, responseId = 'msg_provenance_algebra') => makeEntry({
      responseId,
      imported: true,
      importSource: source,
    });

    // Different values are deliberate: identical sources cannot detect the old
    // first-spread-wins implementation. This matrix keeps the assertion about
    // the merge algebra while exercising both source orders.
    for (const [leftSource, rightSource] of [
      ['claude-code', 'codex'],
      ['codex', 'other-importer'],
      ['other-importer', 'claude-code'],
    ]) {
      const left = importedCopy(leftSource);
      const right = importedCopy(rightSource);
      const forward = mergeEntry(left, right);
      const reverse = mergeEntry(right, left);
      const expected = { imported: true, importSources: [leftSource, rightSource].sort() };
      assert.deepEqual(provenance(forward), expected);
      assert.deepEqual(provenance(reverse), expected);
      assert.deepEqual(provenance(forward), provenance(reverse));
    }

    const a = importedCopy('claude-code', 'msg_provenance_associative');
    const b = importedCopy('codex', 'msg_provenance_associative');
    const c = importedCopy('other-importer', 'msg_provenance_associative');
    const leftFold = mergeEntry(mergeEntry(a, b), c);
    const rightFold = mergeEntry(a, mergeEntry(b, c));
    assert.deepEqual(provenance(leftFold), provenance(rightFold));
    assert.deepEqual(provenance(leftFold), {
      imported: true,
      importSources: ['claude-code', 'codex', 'other-importer'],
    });

    // Idempotence is checked after one normalization into the carried sorted
    // array shape, so a second fold cannot add a duplicate source.
    assert.deepEqual(mergeEntry(leftFold, leftFold), leftFold);

    // ADR 0012: a real proxy observation clears both provenance fields in either
    // argument order, even when the imported twin came from a different source.
    const proxy = makeEntry({
      responseId: 'msg_provenance_proxy',
      imported: undefined,
      importSource: undefined,
    });
    for (const imported of [importedCopy('claude-code', 'msg_provenance_proxy'),
      importedCopy('codex', 'msg_provenance_proxy')]) {
      assert.deepEqual(provenance(mergeEntry(proxy, imported)), {
        imported: undefined,
        importSources: [],
      });
      assert.deepEqual(provenance(mergeEntry(imported, proxy)), {
        imported: undefined,
        importSources: [],
      });
    }
  });

  it('export aggregate counts an imported response id once while preserving both sources', async () => {
    setup([
      makeEntry({ responseId: 'msg_import_sources_once', imported: true, importSource: 'claude-code' }),
      makeEntry({ id: '2026-08-12T10-00-01-000', responseId: 'msg_import_sources_once',
        imported: true, importSource: 'codex' }),
    ]);
    await flushExport();
    const session = _uploads[0].records.find(r => r.type === 'session');
    assert.equal(session.imported_turn_count, 1);
    assert.deepEqual(session.import_sources, ['claude-code', 'codex']);
  });

  it('OpenAI entries: toolCalls summed directly (not per-tool max)', async () => {
    setup([
      makeEntry({ provider: 'openai', toolCalls: { shell: 3 } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', provider: 'openai', toolCalls: { shell: 2 }, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.tool_usage.shell, 5, 'OpenAI toolCalls summed directly');
  });

  it('partial_day flag on first flush after cursor init', async () => {
    const home = mkHome();
    process.env.CCXRAY_HOME = home;
    process.env.CCXRAY_EXPORT_GCS_BUCKET = 'test-bucket';
    process.env.CCXRAY_AGENT_ID = 'test-agent-001';
    delete process.env.LOGS_DIR;
    // Save and restore ambient DISABLE — this test bypasses setup()/cleanup() and manages
    // its own env, but afterEach(cleanup) still runs. Without saving, cleanup deletes the
    // ambient value and later files under --test-isolation=none lose the safety flag.
    const savedDisable = process.env.CCXRAY_EXPORT_DISABLE;
    _savedFlags = { disable: savedDisable, tz: process.env.TZ };
    delete process.env.CCXRAY_EXPORT_DISABLE;
    _uploads = [];
    _setUploader(async (bucket, name, body) => {
      _uploads.push({ bucket, name, body, records: body.trim().split('\n').map(l => JSON.parse(l)) });
    });

    writeIndex(home, [makeEntry()]);

    // First run: init cursor
    await flushExport();
    assert.equal(_uploads.length, 0);
    const cutoffDt = JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8')).cutoffDt;

    // Add new entry
    fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'),
      JSON.stringify(makeEntry({ id: `${cutoffDt}T11-00-00-000`, msgCount: 12 })) + '\n');

    // Second flush: should have partial_day = true for the first date
    await flushExport();
    assert.equal(_uploads.length, 1);
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.partial_day, true);
  });

  it('multi-date aggregation: separate uploads per date', async () => {
    // Use receivedAt for timezone-safe UTC date partitioning
    setup([
      makeEntry({ id: '2026-08-11T23-00-00-000', sessionId: 'sess-day1',
        receivedAt: new Date('2026-08-11T15:00:00Z').getTime() }), // dt=2026-08-11
      makeEntry({ id: '2026-08-12T10-00-00-000', sessionId: 'sess-day2',
        receivedAt: new Date('2026-08-12T02:00:00Z').getTime() }), // dt=2026-08-12
      makeEntry({ id: '2026-08-12T11-00-00-000', sessionId: 'sess-day2', msgCount: 12,
        receivedAt: new Date('2026-08-12T03:00:00Z').getTime() }),
    ]);
    await flushExport();
    assert.equal(_uploads.length, 2, 'one upload per date');
    const dts = _uploads.map(u => u.records.find(r => r.type === 'daily').dt).sort();
    assert.deepEqual(dts, ['2026-08-11', '2026-08-12']);
    // Verify per-date seq tracking
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.seq['2026-08-11'], 1);
    assert.equal(cursor.seq['2026-08-12'], 1);
    // GCS path includes dt= partition
    assert.ok(_uploads[0].name.includes('dt='));
  });

  it('lock staleness recovery: stale lock from dead pid is cleaned up', async () => {
    setup([makeEntry()]);
    const lockPath = path.join(_home, 'export.lock');
    // Create a stale lock with a dead PID (PID 1 is init, but use a large fake PID)
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999999, token: 'stale', acquiredAt: Date.now() - 10 * 60_000,
    }), { flag: 'wx' });
    await flushExport();
    assert.equal(_uploads.length, 1, 'stale lock was recovered');
  });

  it('#1 responseId dedup: duplicate entries counted once', async () => {
    setup([
      makeEntry({ responseId: 'msg_001', cost: { cost: 0.15, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-00-01-000', responseId: 'msg_001', cost: { cost: 0.15, confidence: 'exact' } }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.turn_count, 1, 'duplicate counted once');
    assert.ok(Math.abs(daily.cost_total - 0.15) < 0.001, 'cost not doubled');
  });

  it('#9 null cost counts as unknown confidence (no double-count)', async () => {
    // 2 entries: one exact, one null-cost. If null-cost double-counted as 2 unknowns,
    // the fold would see 1 exact + 2 unknown = mixed. Correct: 1 exact + 1 unknown = mixed.
    // Regression: with only null-cost entries, double-count made total=2 instead of 1.
    setup([
      makeEntry({ cost: { cost: null, confidence: 'unknown' } }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.cost_confidence, 'unknown', 'single null-cost → unknown');
    cleanup();

    // Mixed: 1 exact + 1 legacy numeric = mixed
    setup([
      makeEntry({ cost: { cost: 0.10, confidence: 'exact' } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', cost: 42, msgCount: 12 }),
    ]);
    await flushExport();
    const daily2 = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily2.cost_confidence, 'mixed', 'exact + legacy → mixed');
  });

  it('#10+R3 duplicateToolCalls values summed', async () => {
    setup([
      makeEntry({ duplicateToolCalls: { Read: 2, Bash: 3 } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', duplicateToolCalls: null, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.duplicate_tool_call_count, 5, 'sum of map values, not count of entries');
  });

  it('#11 WS status 101 is not an error', async () => {
    setup([
      makeEntry({ status: 101 }),
      makeEntry({ id: '2026-08-12T10-01-00-000', status: 500, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.error_count, 1, '101 excluded, 500 counted');
  });

  it('foldConfidence: prefix-only returns mixed, not exact', async () => {
    setup([
      makeEntry({ cost: { cost: 0.10, confidence: 'prefix' } }),
      makeEntry({ id: '2026-08-12T10-01-00-000', cost: { cost: 0.05, confidence: 'prefix' }, msgCount: 12 }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.cost_confidence, 'mixed', 'prefix-only is not exact');
  });

  it('#1 responseId field-wise merge enriches canonical', async () => {
    setup([
      makeEntry({ responseId: 'msg_001', cost: null, usage: null, model: 'claude-sonnet-4-6',
        toolSources: { call1: 'local' } }),
      makeEntry({ id: '2026-08-12T10-00-01-000', responseId: 'msg_001',
        cost: { cost: 0.15, confidence: 'exact' },
        usage: { input_tokens: 1000, output_tokens: 500 },
        model: null, toolSources: null }),
    ]);
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.turn_count, 1, 'merged into one turn');
    assert.ok(Math.abs(daily.cost_total - 0.15) < 0.001, 'cost from enriching copy');
    assert.equal(daily.models['claude-sonnet-4-6']?.turns, 1, 'model from canonical');
    assert.ok(daily.tool_sources.local >= 1, 'toolSources from canonical');
  });

  it('#6 malformed lock file is recovered', async () => {
    setup([makeEntry()]);
    const lockPath = path.join(_home, 'export.lock');
    fs.writeFileSync(lockPath, 'NOT VALID JSON{{{{', { flag: 'wx' });
    await flushExport();
    assert.equal(_uploads.length, 1, 'malformed lock recovered');
  });

  it('#2 cross-midnight cumulative fields fold into home date only', async () => {
    setup([
      makeEntry({ id: '2026-08-11T23-00-00-000', sessionId: 'sess-cross',
        receivedAt: new Date('2026-08-11T15:00:00Z').getTime(),
        skillCalls: { mySkill: 3 }, toolSources: { call1: 'local', call2: 'local' } }),
      makeEntry({ id: '2026-08-12T10-00-00-000', sessionId: 'sess-cross', msgCount: 12,
        receivedAt: new Date('2026-08-12T02:00:00Z').getTime(),
        skillCalls: { mySkill: 5 }, toolSources: { call1: 'local', call2: 'local', call3: 'network' } }),
    ]);
    await flushExport();
    const dailies = _uploads.map(u => u.records.find(r => r.type === 'daily'));
    const day1 = dailies.find(d => d.dt === '2026-08-11');
    const day2 = dailies.find(d => d.dt === '2026-08-12');
    assert.ok(day1, 'day1 exists');
    assert.equal(day1.skill_usage.mySkill, 5, 'session max folds into home date');
    if (day2) {
      assert.equal(day2.skill_usage?.mySkill || 0, 0, 'no double-count on day2');
    }
  });
});
