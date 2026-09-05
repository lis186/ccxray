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
    accountEmail: 'test@example.com',
    accountDomain: 'example.com',
    ...overrides,
  };
}

// This is the account-bearing index shape covered by #616's live index
// contract. Values are synthetic; mixed-account cases copy this sample and
// rewrite only the account identity fields.
const ACCOUNT_INDEX_SAMPLE = Object.freeze({
  id: '2026-08-12T10-00-00-000',
  ts: '2026-08-12T10-00-00-000',
  sessionId: 'sample-session-001',
  provider: 'anthropic',
  agent: 'claude',
  model: 'claude-sonnet-4-6',
  msgCount: 10,
  toolCount: 0,
  toolCalls: {},
  skillCalls: {},
  isSubagent: false,
  sessionInferred: false,
  cwd: '/tmp/export-domain-fixture',
  isSSE: false,
  usage: { input_tokens: 50000, output_tokens: 2000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000 },
  cost: { cost: 0.15, confidence: 'exact' },
  maxContext: 200000,
  stopReason: 'end_turn',
  status: 200,
  receivedAt: Date.parse('2026-08-12T02:00:00Z'),
  responseId: 'msg-export-domain-sample',
  turnToolCalls: {},
  accountEmail: 'sample@example.com',
  accountDomain: 'example.com',
});

function sampledAccountEntry(overrides = {}) {
  return {
    ...ACCOUNT_INDEX_SAMPLE,
    usage: { ...ACCOUNT_INDEX_SAMPLE.usage },
    cost: { ...ACCOUNT_INDEX_SAMPLE.cost },
    ...overrides,
  };
}

// Controlled pre-#612 output for the same single-account sample, generated
// from HEAD in a disposable worktree with CCXRAY_EXPORT_CWD_ALLOWLIST unset.
// Schema v3's intentional version/session-user_email additions are normalized
// away below so this remains a pre-filter aggregation-value baseline.
const PRE_FILTER_SINGLE_ACCOUNT_V2_PAYLOAD = [
  '{"type":"daily","_summary_schema_version":2,"agent_id":"test-agent-001","user_email":"configured@identity.test","team":"test-team","dt":"2026-08-12","local_date":null,"tz":null,"provider":"anthropic","upload_seq":1,"summary_id":"<summary-id>","partial_day":false,"cost_total":0.15,"models":{"claude-sonnet-4-6":{"turns":1,"input":50000,"output":2000,"cache_read":30000,"cache_creation":5000,"thinking_turns":0,"beta1m_turns":0,"cost":0.15}},"context_utilization":{"0-40":0,"40-80":1,"80+":0},"compaction_count":0,"tool_usage":{},"tool_sources":{},"skill_usage":{},"tool_defined_count":0,"tool_used_count":0,"tool_fail_count":0,"duplicate_tool_call_count":0,"credential_flag":false,"error_count":0,"stop_reasons":{"end_turn":1},"session_count":1,"turn_count":1,"subagent_turn_count":0,"cwd_repos":[],"cost_confidence":"exact","first_turn_context_pct_median":0.425,"distinct_sys_hash_count":0,"distinct_tools_hash_count":0}',
  '{"type":"session","_summary_schema_version":2,"agent_id":"test-agent-001","dt":"2026-08-12","session_id":"sample-session-001","cost_total":0.15,"turn_count":1,"model_primary":"claude-sonnet-4-6","cwd":null,"flags":[],"summary_id":"<summary-id>","imported_turn_count":0,"inferred_turn_count":0,"session_id_kind":"explicit","models":{"claude-sonnet-4-6":{"turns":1,"cost":0.15,"fallback_cost":0,"fallback_count":0,"unknown_count":0}},"import_sources":[],"turn_set_size":1,"turn_set_hash":"7c3fab05511e0e6e","turn_set_basis":"responseId","cost_confidence":"exact"}',
].join('\n') + '\n';

function normalizeV3PayloadToV2(payload) {
  const rows = payload.trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    row._summary_schema_version = 2;
    row.summary_id = '<summary-id>';
    if (row.type === 'session') delete row.user_email;
  }
  return rows.map(JSON.stringify).join('\n') + '\n';
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
const _ambientDomains = process.env.CCXRAY_EXPORT_DOMAINS;
let _home, _uploads, _savedFlags = { disable: _ambientDisable, tz: _ambientTz, domains: _ambientDomains };
function setup(entries, envOverrides = {}) {
  _home = mkHome();
  _uploads = [];
  writeIndex(_home, entries);

  // Env — TZ must match the server that generates entry ids (Asia/Taipei)
  const savedFlags = {
    disable: process.env.CCXRAY_EXPORT_DISABLE,
    tz: process.env.TZ,
    domains: process.env.CCXRAY_EXPORT_DOMAINS,
  };
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
  process.env.CCXRAY_EXPORT_DOMAINS = 'example.com';

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
  delete process.env.CCXRAY_EXPORT_DOMAINS;
  delete process.env.CCXRAY_AGENT_ID;
  delete process.env.CCXRAY_USER_EMAIL;
  delete process.env.CCXRAY_TEAM;
  // Restore what setup() cleared, so a later file under --test-isolation=none does not
  // inherit weakened safety settings.
  if (_savedFlags.disable === undefined) delete process.env.CCXRAY_EXPORT_DISABLE;
  else process.env.CCXRAY_EXPORT_DISABLE = _savedFlags.disable;
  if (_savedFlags.tz === undefined) delete process.env.TZ;
  else process.env.TZ = _savedFlags.tz;
  if (_savedFlags.domains === undefined) delete process.env.CCXRAY_EXPORT_DOMAINS;
  else process.env.CCXRAY_EXPORT_DOMAINS = _savedFlags.domains;
  _savedFlags = {};
  _setUploader(null);
  if (home) fs.rmSync(home, { recursive: true, force: true });
  // Bust require cache for config (it caches LOGS_DIR at require time)
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server/config')) delete require.cache[k];
  }
}

async function captureExportLogs(fn) {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
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

  it('filters a mixed-account index day, resolves one email, and reports both exclusions', async () => {
    // The first row is the #616 account-bearing index sample. The other rows
    // retain that production-shaped record and synthesize only account identity.
    setup([
      sampledAccountEntry({
        accountEmail: 'allowed@example.com', accountDomain: 'example.com',
        cost: { cost: 0.10, confidence: 'exact' },
      }),
      sampledAccountEntry({
        id: '2026-08-12T10-01-00-000', ts: '2026-08-12T10-01-00-000',
        responseId: 'msg-export-domain-mismatch', accountEmail: 'other@outside.test', accountDomain: 'outside.test',
        cost: { cost: 0.20, confidence: 'exact' },
      }),
      sampledAccountEntry({
        id: '2026-08-12T10-02-00-000', ts: '2026-08-12T10-02-00-000',
        responseId: 'msg-export-domain-no-account', accountEmail: undefined, accountDomain: undefined,
        cost: { cost: 0.30, confidence: 'exact' },
      }),
    ], {
      CCXRAY_USER_EMAIL: undefined,
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });

    const logs = await captureExportLogs(flushExport);
    assert.equal(_uploads.length, 1);
    const daily = _uploads[0].records.find(row => row.type === 'daily');
    const session = _uploads[0].records.find(row => row.type === 'session');
    assert.deepEqual(
      { turn_count: daily.turn_count, cost_total: daily.cost_total, user_email: daily.user_email },
      { turn_count: 1, cost_total: 0.10, user_email: 'allowed@example.com' },
    );
    assert.equal(session.turn_count, 1);
    assert.equal(session.user_email, 'allowed@example.com');
    assert.ok(logs.includes('[ccxray export] exported files=1 rows=2 dt=2026-08-12 user_email=allowed@example.com excluded_turns=no-account:1 domain-mismatch:1'));
  });

  it('uses an explicit user email for every summary row', async () => {
    setup([sampledAccountEntry({ accountEmail: 'observed@example.com', accountDomain: 'example.com' })], {
      CCXRAY_USER_EMAIL: 'configured@identity.test',
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });

    await flushExport();

    assert.deepEqual(
      _uploads[0].records.map(row => row.user_email),
      ['configured@identity.test', 'configured@identity.test'],
    );
  });

  it('hard-fails without an allowed account email and leaves the cursor untouched', async () => {
    setup([
      sampledAccountEntry({ accountEmail: undefined, accountDomain: undefined }),
      sampledAccountEntry({
        id: '2026-08-12T10-01-00-000', ts: '2026-08-12T10-01-00-000',
        responseId: 'msg-export-no-allowed-email', accountEmail: 'other@outside.test', accountDomain: 'outside.test',
      }),
    ], {
      CCXRAY_USER_EMAIL: undefined,
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });
    const cursorPath = path.join(_home, 'export-cursor.json');
    const beforeCursor = fs.readFileSync(cursorPath, 'utf8');

    const logs = await captureExportLogs(flushExport);

    assert.equal(_uploads.length, 0, 'hard failure must not upload');
    assert.equal(fs.readFileSync(cursorPath, 'utf8'), beforeCursor, 'hard failure must not advance the cursor');
    assert.ok(logs.includes('[ccxray export] hard-failed files=0 rows=0 dt=none user_email=unresolved excluded_turns=no-account:1 domain-mismatch:1 email_candidates=0'));
  });

  it('hard-fails before initializing a first-run cursor', async () => {
    setup([sampledAccountEntry({ accountEmail: undefined, accountDomain: undefined })], {
      CCXRAY_USER_EMAIL: undefined,
      CCXRAY_EXPORT_DOMAINS: 'example.com',
      _skipCursor: true,
    });

    await captureExportLogs(flushExport);

    assert.equal(fs.existsSync(path.join(_home, 'export-cursor.json')), false);
  });

  it('hard-fails when more than one allowed account email is observed', async () => {
    setup([
      sampledAccountEntry({ accountEmail: 'first@example.com', accountDomain: 'example.com' }),
      sampledAccountEntry({
        id: '2026-08-12T10-01-00-000', ts: '2026-08-12T10-01-00-000',
        responseId: 'msg-export-second-allowed-email', accountEmail: 'second@example.com', accountDomain: 'example.com',
      }),
    ], {
      CCXRAY_USER_EMAIL: undefined,
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });
    const cursorPath = path.join(_home, 'export-cursor.json');
    const beforeCursor = fs.readFileSync(cursorPath, 'utf8');

    const logs = await captureExportLogs(flushExport);

    assert.equal(_uploads.length, 0, 'ambiguous identity must not upload');
    assert.equal(fs.readFileSync(cursorPath, 'utf8'), beforeCursor, 'ambiguous identity must not advance the cursor');
    assert.ok(logs.includes('[ccxray export] hard-failed files=0 rows=0 dt=none user_email=unresolved excluded_turns=no-account:0 domain-mismatch:0 email_candidates=2'));
  });

  it('preserves a proxy account observation while responseId duplicates merge', async () => {
    setup([
      sampledAccountEntry({ accountEmail: undefined, accountDomain: undefined }),
      sampledAccountEntry({
        id: '2026-08-12T10-00-01-000', ts: '2026-08-12T10-00-01-000',
        accountEmail: 'merged@example.com', accountDomain: 'example.com',
      }),
    ], {
      CCXRAY_USER_EMAIL: undefined,
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });

    const logs = await captureExportLogs(flushExport);

    const daily = _uploads[0].records.find(row => row.type === 'daily');
    assert.equal(daily.turn_count, 1, 'responseId still represents one turn');
    assert.equal(daily.user_email, 'merged@example.com');
    assert.ok(logs.includes('[ccxray export] exported files=1 rows=2 dt=2026-08-12 user_email=merged@example.com excluded_turns=no-account:0 domain-mismatch:0'));
  });

  it('keeps a single-account fixture bit-identical to its pre-filter aggregation baseline', async () => {
    setup([sampledAccountEntry({
      accountEmail: 'single@example.com', accountDomain: 'example.com', cwd: undefined,
    })], {
      CCXRAY_USER_EMAIL: 'configured@identity.test',
      CCXRAY_EXPORT_DOMAINS: 'example.com',
    });
    await flushExport();

    assert.equal(normalizeV3PayloadToV2(_uploads[0].body), PRE_FILTER_SINGLE_ACCOUNT_V2_PAYLOAD);
  });

  it('uses a fresh object name when a crashed upload is retried', async () => {
    setup([sampledAccountEntry()]);
    await flushExport();
    const firstName = _uploads[0].name;

    // Model the crash window after the object was accepted but before its
    // checkpoint persisted: the retry sees the same index and upload sequence.
    fs.writeFileSync(path.join(_home, 'export-cursor.json'),
      JSON.stringify({ lastId: null, seq: {}, partial: false, cutoffDt: '2026-01-01', floorV: 1 }) + '\n');
    _uploads = [];
    await flushExport();
    const retryName = _uploads[0].name;

    assert.match(firstName, /^summaries\/dt=2026-08-12\/test-agent-001--1--[0-9a-f]{8}\.jsonl$/);
    assert.notEqual(retryName, firstName, 'retry must not attempt to overwrite the accepted object');
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

  // 13b bridge: the row-13b render test (test/status.test.js D3) hand-writes its cursor,
  // so a schema drift in the production writer would leave it green while the real
  // cross-level scenario breaks. This test closes that seam: the cursor is written by
  // the PRODUCTION flush and read by the PRODUCTION status reader.
  it('13b bridge: the status home line reads a cursor the production flush wrote', async () => {
    const liveDt = daysAgoUtc(14);
    setup([entryForDt(liveDt)], { _skipCursor: true });
    await flushExport(); // first run: production writeCursor initializes to the index tail
    const { inspectHomeStatus, renderProcessStatus } = require('../server/status');
    const report = {
      exportState: 'refused',
      exportReason: 'config-dirs-retired',
      configWarnings: [],
      identity: { kind: 'hub', pid: process.pid, port: 5577, home: _home, logsDir: path.join(_home, 'logs') },
    };
    const homeLine = inspectHomeStatus(report).line;
    assert.match(homeLine, /current \(partial/, `production-written cursor must read as current; line: ${homeLine}`);
    assert.doesNotMatch(homeLine, /refused/);
    const processLine = renderProcessStatus(report);
    assert.match(processLine, /refused/);
    assert.doesNotMatch(processLine, /current/);
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
    assert.equal(daily._summary_schema_version, 3);
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
      'imported_turn_count', 'inferred_turn_count', 'import_sources', 'session_id_kind', 'user_email']) {
      assert.ok(f in sess, `missing field: ${f}`);
    }
    assert.equal(sess._summary_schema_version, 3);
  });

  it('schema v3 is additive: session gains user_email and legacy summary fields remain', async () => {
    setup([sampledAccountEntry({ accountEmail: 'account@example.com', accountDomain: 'example.com' })], {
      CCXRAY_USER_EMAIL: 'configured@identity.test',
    });
    await flushExport();
    const daily = _uploads[0].records.find(row => row.type === 'daily');
    const session = _uploads[0].records.find(row => row.type === 'session');
    const dailyV2Fields = [
      'type', '_summary_schema_version', 'agent_id', 'user_email', 'team', 'dt', 'local_date', 'tz',
      'provider', 'upload_seq', 'summary_id', 'partial_day', 'cost_total', 'models',
      'context_utilization', 'compaction_count', 'tool_usage', 'tool_sources', 'skill_usage',
      'tool_defined_count', 'tool_used_count', 'tool_fail_count', 'duplicate_tool_call_count',
      'credential_flag', 'error_count', 'stop_reasons', 'session_count', 'turn_count',
      'subagent_turn_count', 'cwd_repos', 'cost_confidence', 'first_turn_context_pct_median',
      'distinct_sys_hash_count', 'distinct_tools_hash_count',
    ];
    const sessionV2Fields = [
      'type', '_summary_schema_version', 'agent_id', 'dt', 'session_id', 'cost_total', 'turn_count',
      'model_primary', 'cwd', 'flags', 'summary_id', 'imported_turn_count', 'inferred_turn_count',
      'session_id_kind', 'models', 'import_sources', 'turn_set_size', 'turn_set_hash',
      'turn_set_basis', 'cost_confidence',
    ];

    for (const field of dailyV2Fields) assert.ok(field in daily, `daily v2 field preserved: ${field}`);
    for (const field of sessionV2Fields) assert.ok(field in session, `session v2 field preserved: ${field}`);
    assert.deepEqual(Object.keys(daily).filter(field => !dailyV2Fields.includes(field)), []);
    assert.deepEqual(Object.keys(session).filter(field => !sessionV2Fields.includes(field)), ['user_email']);
    assert.equal(daily._summary_schema_version, 3);
    assert.equal(session._summary_schema_version, 3);
  });

  it('never includes the account email or account domain in an uploaded summary', async () => {
    setup([sampledAccountEntry({ accountEmail: 'account@example.com', accountDomain: 'example.com' })], {
      CCXRAY_USER_EMAIL: 'configured@identity.test',
    });
    await flushExport();

    const payload = _uploads[0].body;
    assert.ok(payload.includes('configured@identity.test'), 'existing user_email remains the summary identity');
    assert.ok(!payload.includes('account@example.com'), 'accountEmail stays local to filtering');
    assert.ok(!payload.includes('accountDomain'), 'per-turn account fields do not enter summaries');
    assert.ok(!payload.includes('"account_domain"'), 'no account-domain summary field was added');
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
      accountEmail: 'test@example.com',
      accountDomain: 'example.com',
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
    const savedDomains = process.env.CCXRAY_EXPORT_DOMAINS;
    process.env.CCXRAY_HOME = home;
    process.env.CCXRAY_EXPORT_GCS_BUCKET = 'test-bucket';
    process.env.CCXRAY_AGENT_ID = 'test-agent-001';
    process.env.CCXRAY_EXPORT_DOMAINS = 'example.com';
    delete process.env.LOGS_DIR;
    // Save and restore ambient DISABLE — this test bypasses setup()/cleanup() and manages
    // its own env, but afterEach(cleanup) still runs. Without saving, cleanup deletes the
    // ambient value and later files under --test-isolation=none lose the safety flag.
    const savedDisable = process.env.CCXRAY_EXPORT_DISABLE;
    _savedFlags = {
      disable: savedDisable,
      tz: process.env.TZ,
      domains: savedDomains,
    };
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
