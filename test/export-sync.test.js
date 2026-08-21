'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

// Set up env + uploader mock before each test
// Save ambient suppression state at module load, before any test clears it.
// Without this, the first test's afterEach(cleanup) deletes an inherited
// CCXRAY_EXPORT_DISABLE without knowing its original value.
const _ambientDisable = process.env.CCXRAY_EXPORT_DISABLE;
let _home, _uploads, _savedFlags = { disable: _ambientDisable };
function setup(entries, envOverrides = {}) {
  _home = mkHome();
  _uploads = [];
  writeIndex(_home, entries);

  // Env — TZ must match the server that generates entry ids (Asia/Taipei)
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
  _savedFlags = { disable: process.env.CCXRAY_EXPORT_DISABLE };
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
      JSON.stringify({ lastId: null, seq: {}, partial: false }) + '\n');
  }
}

function cleanup() {
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
  _savedFlags = {};
  _setUploader(null);
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

  it('first-run: cursor init to tail, no upload', async () => {
    setup([makeEntry()], { _skipCursor: true });
    await flushExport();
    assert.equal(_uploads.length, 0, 'no upload on first run');
    const cursor = JSON.parse(fs.readFileSync(path.join(_home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, '2026-08-12T10-00-00-000');
    assert.equal(cursor.partial, true);
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
    assert.equal(daily._summary_schema_version, 1);
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
      'cost_total', 'turn_count', 'model_primary', 'flags', 'summary_id']) {
      assert.ok(f in sess, `missing field: ${f}`);
    }
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
    setup([makeEntry({ receivedAt: 1723449600000, elapsed: '5.2' })]);
    await flushExport();
    const payload = _uploads[0].body;
    assert.ok(!payload.includes('1723449600'), 'no receivedAt epoch');
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

  it('configDir whitelist: entries outside excluded, unknown included', async () => {
    setup([
      makeEntry({ configDir: '.claude' }),
      makeEntry({ id: '2026-08-12T10-01-00-000', sessionId: 'sess-002', configDir: '.codex', msgCount: 5 }),
      makeEntry({ id: '2026-08-12T10-02-00-000', sessionId: 'sess-003', msgCount: 5 }), // no configDir → include
    ], { CCXRAY_EXPORT_CONFIG_DIRS: '.claude' });
    await flushExport();
    const daily = _uploads[0].records.find(r => r.type === 'daily');
    assert.equal(daily.session_count, 2, 'only .claude + unknown sessions');
    assert.equal(daily.turn_count, 2);
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
    _savedFlags = { disable: savedDisable };
    delete process.env.CCXRAY_EXPORT_DISABLE;
    _uploads = [];
    _setUploader(async (bucket, name, body) => {
      _uploads.push({ bucket, name, body, records: body.trim().split('\n').map(l => JSON.parse(l)) });
    });

    writeIndex(home, [makeEntry()]);

    // First run: init cursor
    await flushExport();
    assert.equal(_uploads.length, 0);

    // Add new entry
    fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'),
      JSON.stringify(makeEntry({ id: '2026-08-12T11-00-00-000', msgCount: 12 })) + '\n');

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
