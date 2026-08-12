'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exportSync = require('../server/export-sync');
const store = require('../server/store');

function withEnv(values, fn) {
  const old = {};
  for (const [key, value] of Object.entries(values)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function makeHome(lines = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-test-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), lines.map(JSON.stringify).join('\n') + (lines.length ? '\n' : ''));
  return home;
}

function writeCursor(home, cursor) {
  fs.writeFileSync(path.join(home, 'export-cursor.json'), JSON.stringify({ seq: {}, partial: false, ...cursor }));
}

function entry(id, overrides = {}) {
  return {
    id, sessionId: 's1', localDate: '2026-08-12', receivedAt: Number(id.replace(/\D/g, '')) || 1,
    provider: 'anthropic', model: 'model-a', isSubagent: false, cwd: '/work/repo',
    msgCount: 10, maxContext: 1000,
    usage: { input_tokens: 150, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    cost: { cost: 1, confidence: 'exact' }, turnToolCalls: {}, skillCalls: {}, toolSources: {},
    status: 200, stopReason: 'end_turn', sysHash: 'sys', toolsHash: 'tools',
    ...overrides,
  };
}

test('flush is side-effect free when export bucket is unset', async () => {
  const home = path.join(os.tmpdir(), `ccxray-export-absent-${process.pid}-${Date.now()}`);
  const oldHome = process.env.CCXRAY_HOME;
  const oldBucket = process.env.CCXRAY_EXPORT_GCS_BUCKET;
  process.env.CCXRAY_HOME = home;
  delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
  try {
    exportSync.startExportSync();
    await exportSync.flushExport();
    exportSync.stopExportSync();
    assert.equal(fs.existsSync(home), false);
  } finally {
    if (oldHome === undefined) delete process.env.CCXRAY_HOME; else process.env.CCXRAY_HOME = oldHome;
    if (oldBucket === undefined) delete process.env.CCXRAY_EXPORT_GCS_BUCKET; else process.env.CCXRAY_EXPORT_GCS_BUCKET = oldBucket;
  }
});

test('first uploaded day after bootstrap is marked partial', async () => {
  const home = makeHome([entry('1')]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, async () => {
      await exportSync.flushExport();
      fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify(entry('2')) + '\n');
      await exportSync.flushExport();
    });
    assert.equal(JSON.parse(uploads[0].split('\n')[0]).partial_day, true);
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('first flush checkpoints the index tail without uploading', async () => {
  const home = makeHome([{ id: 'one' }, { id: 'two' }]);
  const uploads = [];
  try {
    exportSync._setUploader(async (...args) => uploads.push(args));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'bucket' }, () => exportSync.flushExport());
    assert.deepEqual(uploads, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8')), {
      lastId: 'two', partial: true, seq: {},
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('exports complete daily and session summaries for new index rows', async () => {
  const lines = [
    { id: 'seed' },
    entry('1', { receivedAt: 1, turnToolCalls: { Read: 1 }, skillCalls: { review: 1 }, toolSources: { call1: 'local', call2: 'local' } }),
    entry('2', { receivedAt: 2, usage: { input_tokens: 550, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 50 }, cost: { cost: 2, confidence: 'prefix' }, msgCount: 12, model: 'model-b', turnToolCalls: { Bash: 2 }, duplicateToolCalls: { Bash: 1 } }),
    entry('3', { receivedAt: 3, usage: { input_tokens: 850, output_tokens: 40 }, cost: { cost: 3, confidence: 'fallback' }, msgCount: 5, isSubagent: true, turnToolFail: true, hasCredential: true, beta1m: true, thinkingDuration: 10 }),
    entry('4', { receivedAt: 4, sessionId: 's2', model: 'model-b', cost: { cost: 4, confidence: 'exact' }, status: 500, stopReason: 'error' }),
    entry('5', { receivedAt: 5, sessionId: 's2', model: 'model-b', cost: null, turnToolCalls: { Read: 2 } }),
  ];
  const home = makeHome(lines);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '/fake/.claude' };
  store.sessionMeta.s2 = { configDir: '/fake/.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push({ bucket, name, body }));
    await withEnv({
      CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'bucket', CCXRAY_AGENT_ID: 'agent-1',
      CCXRAY_EXPORT_CONFIG_DIRS: '.claude', CCXRAY_EXPORT_GCS_PREFIX: 'summaries/',
    }, () => exportSync.flushExport());
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].bucket, 'bucket');
    assert.match(uploads[0].name, /^summaries\/dt=2026-08-12\/agent-1--1--[a-f0-9]{8}\.jsonl$/);
    const [daily, ...sessions] = uploads[0].body.trim().split('\n').map(JSON.parse);
    assert.deepEqual({
      type: daily.type, version: daily._summary_schema_version, dt: daily.dt,
      upload_seq: daily.upload_seq, cost_total: daily.cost_total,
      cost_confidence: daily.cost_confidence, turn_count: daily.turn_count,
      subagent_turn_count: daily.subagent_turn_count, session_count: daily.session_count,
      error_count: daily.error_count, credential_flag: daily.credential_flag,
      compaction_count: daily.compaction_count, tool_fail_count: daily.tool_fail_count,
      duplicate_tool_call_count: daily.duplicate_tool_call_count,
    }, {
      type: 'daily', version: 1, dt: '2026-08-12', upload_seq: 1, cost_total: 10,
      cost_confidence: 'mixed', turn_count: 5, subagent_turn_count: 1, session_count: 2,
      error_count: 1, credential_flag: true, compaction_count: 1, tool_fail_count: 1,
      duplicate_tool_call_count: 1,
    });
    assert.deepEqual(daily.context_utilization, { '0-40': 3, '40-80': 1, '80+': 1 });
    // first-turn context includes cache: s1=(150+30+40)/1000=22%, s2=(150+30+40)/1000=22% → median=22
    assert.equal(daily.first_turn_context_pct_median, 22);
    assert.deepEqual(daily.tool_usage, { Read: 3, Bash: 2 });
    assert.deepEqual(daily.skill_usage, { review: 1 });
    assert.deepEqual(daily.tool_sources, { local: 2 });
    assert.equal(daily.tool_used_count, 2);
    assert.equal(daily.sys_hash_count, 1);
    assert.equal(daily.tools_hash_count, 1);
    assert.deepEqual(daily.cwd_repos, ['/work/repo']);
    assert.deepEqual(daily.models['model-a'], { turns: 2, input: 1000, output: 60, cache_read: 30, cache_creation: 40, thinking_turns: 1, beta1m_turns: 1, cost: 4 });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].summary_id, daily.summary_id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'))).lastId, '5');
    assert.equal(fs.readdirSync(home).some(name => name.includes('.tmp.')), false);
  } finally {
    delete store.sessionMeta.s1;
    delete store.sessionMeta.s2;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('payload omits prompt content, raw hashes, edit metadata, and timestamps', async () => {
  const bait = 'SECRET-PROMPT-BAIT';
  const home = makeHome([{ id: 'seed' }, entry('1', {
    title: bait, editSummary: bait, sysHash: bait, toolsHash: bait,
    prompt: bait, receivedAt: 123456789, elapsed: '9.9', ts: bait,
  })]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    assert.equal(uploads[0].includes(bait), false);
    const records = uploads[0].trim().split('\n').map(JSON.parse);
    for (const record of records) {
      for (const key of Object.keys(record)) {
        assert.equal(['receivedAt', 'elapsed', 'time', 'timestamp', 'ts', 'title', 'editSummary', 'prompt'].includes(key), false);
      }
    }
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session summaries compute flags, primary model, and all confidence folds', async () => {
  const rows = [{ id: 'seed' }];
  rows.push(entry('credential', { sessionId: 'credential', hasCredential: true, cost: { cost: 1, confidence: 'exact' } }));
  for (let i = 0; i < 201; i++) rows.push(entry(`runaway-${i}`, {
    sessionId: 'runaway', receivedAt: i + 10, model: i % 2 ? 'z-model' : 'a-model',
    cost: { cost: 0.3, confidence: i === 0 ? 'prefix' : undefined },
  }));
  rows.push(entry('high', { sessionId: 'high', cost: { cost: 26, confidence: 'fallback' } }));
  rows.push(entry('spike-1', { sessionId: 'spike', turnToolFail: true, cost: null }));
  rows.push(entry('spike-2', { sessionId: 'spike', turnToolFail: true, cost: null }));
  rows.push(entry('spike-3', { sessionId: 'spike', turnToolFail: false, cost: null }));
  rows.push(entry('mixed-1', { sessionId: 'mixed', cost: { cost: 1, confidence: 'exact' } }));
  rows.push(entry('mixed-2', { sessionId: 'mixed', cost: { cost: 1, confidence: 'fallback' } }));
  const home = makeHome(rows);
  const uploads = [];
  for (const sid of ['credential', 'runaway', 'high', 'spike', 'mixed']) store.sessionMeta[sid] = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    const sessions = Object.fromEntries(uploads[0].trim().split('\n').slice(1).map(JSON.parse).map(s => [s.session_id, s]));
    assert.deepEqual(sessions.credential.flags, ['credential_leak']);
    assert.deepEqual(sessions.runaway.flags, ['runaway', 'high_cost']);
    assert.equal(sessions.runaway.model_primary, 'a-model');
    assert.deepEqual(sessions.high.flags, ['high_cost']);
    assert.deepEqual(sessions.spike.flags, ['tool_fail_spike']);
    assert.equal(sessions.credential.cost_confidence, 'exact');
    assert.equal(sessions.runaway.cost_confidence, 'exact');
    assert.equal(sessions.high.cost_confidence, 'fallback');
    assert.equal(sessions.spike.cost_confidence, 'unknown');
    assert.equal(sessions.mixed.cost_confidence, 'mixed');
  } finally {
    for (const sid of ['credential', 'runaway', 'high', 'spike', 'mixed']) delete store.sessionMeta[sid];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('daily summaries fold exact, fallback, mixed, and unknown cost confidence', async () => {
  const rows = [
    { id: 'seed' },
    entry('exact-1', { sessionId: 'exact', localDate: '2026-08-01', cost: { cost: 1, confidence: 'prefix' } }),
    entry('fallback-1', { sessionId: 'fallback', localDate: '2026-08-02', cost: { cost: 1, confidence: 'fallback' } }),
    entry('mixed-1', { sessionId: 'mixed-day', localDate: '2026-08-03', cost: { cost: 1, confidence: 'exact' } }),
    entry('mixed-2', { sessionId: 'mixed-day', localDate: '2026-08-03', cost: { cost: 1, confidence: 'fallback' } }),
    entry('unknown-1', { sessionId: 'unknown', localDate: '2026-08-04', cost: null }),
  ];
  const home = makeHome(rows);
  const daily = {};
  for (const sid of ['exact', 'fallback', 'mixed-day', 'unknown']) store.sessionMeta[sid] = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => {
      const record = JSON.parse(body.split('\n')[0]);
      daily[record.dt] = record.cost_confidence;
    });
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    assert.deepEqual(daily, {
      '2026-08-01': 'exact', '2026-08-02': 'fallback',
      '2026-08-03': 'mixed', '2026-08-04': 'unknown',
    });
  } finally {
    for (const sid of ['exact', 'fallback', 'mixed-day', 'unknown']) delete store.sessionMeta[sid];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cursor continuation: full daily snapshot (last-writer-wins), cursor advances', async () => {
  const home = makeHome([entry('1'), entry('2'), entry('3'), entry('4'), entry('5')]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: '3' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    // last-writer-wins: daily snapshot aggregates ALL 5 entries, not just 4+5
    assert.equal(JSON.parse(uploads[0].split('\n')[0]).turn_count, 5);
    const cursor = JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.lastId, '5');
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pruned cursor restarts from the first index row', async () => {
  const home = makeHome([entry('1'), entry('2')]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: 'pruned' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    assert.equal(JSON.parse(uploads[0].split('\n')[0]).turn_count, 2);
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config-dir whitelist: known-outside excluded, unknown-configDir included', async () => {
  const home = makeHome([{ id: 'seed' }, entry('1'), entry('2', { sessionId: 'outside' }), entry('3', { sessionId: 'missing' })]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '/fake/.claude' };
  store.sessionMeta.outside = { configDir: '/fake/.claude-work' };
  // 'missing' has no sessionMeta → configDir unknown → included (P2: exclude would lose restart backlog)
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent', CCXRAY_EXPORT_CONFIG_DIRS: '.claude' }, () => exportSync.flushExport());
    const records = uploads[0].trim().split('\n').map(JSON.parse);
    assert.equal(records[0].turn_count, 2); // s1 + missing (unknown → included)
    const sids = records.slice(1).map(s => s.session_id).sort();
    assert.deepEqual(sids, ['missing', 's1']);
  } finally {
    delete store.sessionMeta.s1;
    delete store.sessionMeta.outside;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('tool and skill names are truncated and email-like names are dropped', async () => {
  const long = 'x'.repeat(65);
  const home = makeHome([{ id: 'seed' }, entry('1', {
    turnToolCalls: { [long]: 2, 'drop@example.com': 3 },
    skillCalls: { [long]: 4, 'drop@example.com': 5 },
  })]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push(body));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, () => exportSync.flushExport());
    const daily = JSON.parse(uploads[0].split('\n')[0]);
    assert.deepEqual(daily.tool_usage, { ['x'.repeat(64)]: 2 });
    assert.deepEqual(daily.skill_usage, { ['x'.repeat(64)]: 4 });
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('exclusive lock skips a concurrent flush and unlocks after completion', async () => {
  const home = makeHome([{ id: 'seed' }, entry('1')]);
  const uploads = [];
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => {
      uploads.push(body);
      if (uploads.length === 1) { entered(); await blocked; }
    });
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: 'agent' }, async () => {
      const first = exportSync.flushExport();
      await started;
      await exportSync.flushExport();
      assert.equal(uploads.length, 1);
      unblock();
      await first;
      fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify(entry('2')) + '\n');
      await exportSync.flushExport();
      assert.equal(uploads.length, 2);
    });
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('upload sequence increments and persistent agent id is reused', async () => {
  const home = makeHome([{ id: 'seed' }, entry('1')]);
  const uploads = [];
  store.sessionMeta.s1 = { configDir: '.claude' };
  writeCursor(home, { lastId: 'seed' });
  try {
    exportSync._setUploader(async (bucket, name, body) => uploads.push({ name, body }));
    await withEnv({ CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'b', CCXRAY_AGENT_ID: undefined }, async () => {
      await exportSync.flushExport();
      fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify(entry('2')) + '\n');
      await exportSync.flushExport();
    });
    const daily = uploads.map(u => JSON.parse(u.body.split('\n')[0]));
    assert.deepEqual(daily.map(d => d.upload_seq), [1, 2]);
    assert.equal(daily[0].agent_id, daily[1].agent_id);
    assert.equal(fs.readFileSync(path.join(home, 'export-agent-id'), 'utf8').trim(), daily[0].agent_id);
  } finally {
    delete store.sessionMeta.s1;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
