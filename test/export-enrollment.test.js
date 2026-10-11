'use strict';

// Team-rollout exporter contract (design-proxy-rollout §3.1, §3.7): enrollment state,
// first-run floor, the lock-held startup flush, and the startup prune decision.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const exportSync = require('../server/export-sync');
const { flushExport, withExportLock, pruneDecision, _setUploader } = exportSync;

const ENV_KEYS = [
  'CCXRAY_HOME', 'CCXRAY_EXPORT_GCS_BUCKET', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_USER_EMAIL',
  'CCXRAY_AGENT_ID', 'CCXRAY_EXPORT_DISABLE', 'LOGS_DIR', 'LOG_RETENTION_DAYS',
  'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_CONFIG_DIRS', 'CCXRAY_TEAM',
];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
let home, uploads;

function utcDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function entry(n, { daysAgo = 0, accountEmail = 'dev@example.com' } = {}) {
  const receivedAt = Date.now() - daysAgo * 86_400_000 - n * 1000;
  return {
    id: `e-${daysAgo}-${n}`, ts: `e-${daysAgo}-${n}`, receivedAt, sessionId: `s-${daysAgo}`,
    responseId: `msg-${daysAgo}-${n}`, provider: 'anthropic', model: 'claude-sonnet-4-6',
    msgCount: 2 + n, usage: { input_tokens: 100, output_tokens: 10 },
    cost: { cost: 0.01, confidence: 'exact' }, maxContext: 200000, stopReason: 'end_turn',
    status: 200, accountEmail, accountDomain: accountEmail ? accountEmail.split('@')[1] : undefined,
  };
}

function setup({ entries = [], env = {} } = {}) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-test-'));
  fs.mkdirSync(path.join(home, 'logs'));
  writeIndex(entries);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'test-bucket',
    CCXRAY_AGENT_ID: 'agent-1', CCXRAY_EXPORT_DOMAINS: 'example.com',
  }, env);
  for (const k of Object.keys(require.cache)) if (k.includes('/server/config')) delete require.cache[k];
  uploads = [];
  _setUploader(async (bucket, name, body) => { uploads.push({ name, body }); });
}

function writeIndex(entries) {
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'),
    entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function appendIndex(...entries) {
  fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), entries.map(e => JSON.stringify(e) + '\n').join(''));
}

const readJson = name => JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));
const writeJson = (name, v) => fs.writeFileSync(path.join(home, name), JSON.stringify(v) + '\n');
const uploadedDts = () => uploads.map(u => u.name.match(/dt=(\d{4}-\d{2}-\d{2})/)[1]).sort();

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  return Promise.resolve().then(fn).finally(() => { console.log = log; });
}

afterEach(() => {
  _setUploader(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe('first run (§3.7)', () => {
  // The day-1 loss: with a domain filter and no CCXRAY_USER_EMAIL, the empty-index
  // first flush used to hard-fail before writing a cursor; the next flush then anchored
  // the cursor at the tail and never uploaded the first session.
  it('the first session survives an identity hard-fail on an empty index', async () => {
    setup();
    assert.equal(await quiet(() => flushExport()), 'hard-failed');

    appendIndex(entry(1), entry(2));
    assert.equal(await quiet(() => flushExport()), 'exported');
    assert.deepEqual(uploadedDts(), [utcDay()]);
  });

  it('uploads today from an existing index but never an older day', async () => {
    setup({ entries: [entry(1, { daysAgo: 3 }), entry(2)] });
    assert.equal(await quiet(() => flushExport()), 'exported');
    assert.deepEqual(uploadedDts(), [utcDay()]);
    assert.equal(readJson('export-enrollment.json').state, 'enrolled');
  });

  it('repairs an enrolled home with no cursor from the enrollment day', async () => {
    setup({ entries: [entry(1, { daysAgo: 2 }), entry(2, { daysAgo: 4 })] });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), retentionDays: 30,
    });
    await quiet(() => flushExport());
    assert.equal(readJson('export-cursor.json').cutoffDt, utcDay(-2));
    assert.deepEqual(uploadedDts(), [utcDay(-2)]);
  });
});

describe('removed state', () => {
  it('a removed home neither exports nor re-enrolls, even with no cursor', async () => {
    setup({ entries: [entry(1)] });
    writeJson('export-enrollment.json', { state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30 });
    assert.equal(await quiet(() => flushExport()), 'removed');
    assert.equal(uploads.length, 0);
    assert.equal(fs.existsSync(path.join(home, 'export-cursor.json')), false);
    assert.equal(readJson('export-enrollment.json').state, 'removed');
  });
});

describe('effective floor (I2)', () => {
  it('an older cursor cannot upload days before the current enrollment', async () => {
    setup({ entries: [entry(1, { daysAgo: 5 }), entry(2, { daysAgo: 1 })] });
    writeJson('export-cursor.json', { lastId: null, seq: {}, partial: false, cutoffDt: utcDay(-10), floorV: 1 });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: new Date(Date.now() - 86_400_000).toISOString(), retentionDays: 30,
    });
    await quiet(() => flushExport());
    assert.deepEqual(uploadedDts(), [utcDay(-1)]);
  });
});

describe('startup lock (§3.1)', () => {
  // The exporter lock is pid-scoped: a nested acquire from the same process sees a live
  // holder and skips. Startup must hand the held token in instead.
  it('flushExport({lockToken}) runs inside withExportLock', async () => {
    setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    const outcome = await withExportLock(lockToken => quiet(() => flushExport({ lockToken })));
    assert.equal(outcome, 'exported');
    assert.equal(fs.existsSync(path.join(home, 'export.lock')), false, 'lock released');
  });

  it('a plain flushExport inside the held lock is lost, not deadlocked', async () => {
    setup({ entries: [entry(1)] });
    const outcome = await withExportLock(() => quiet(() => flushExport()));
    assert.equal(outcome, 'lock-lost');
  });

  it('export-last keeps lastSuccessAt across a failed attempt', async () => {
    setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    await quiet(() => flushExport());
    const ok = readJson('export-last.json');
    assert.equal(ok.outcome, 'exported');
    appendIndex(entry(2));
    _setUploader(async () => { throw new Error('boom'); });
    await assert.rejects(quiet(() => flushExport()), /boom/);
    const failed = readJson('export-last.json');
    assert.equal(failed.outcome, 'upload-failed');
    assert.equal(failed.lastSuccessAt, ok.lastSuccessAt);
  });
});

describe('pruneDecision (§3.1 iii)', () => {
  const DAY = 86_400_000;
  const enroll = (daysAgo, retentionDays = 30) => writeJson('export-enrollment.json', {
    state: 'enrolled', enrolledAt: new Date(Date.now() - daysAgo * DAY).toISOString(), retentionDays,
  });

  it('prunes after any successful outcome', () => {
    setup();
    for (const o of ['exported', 'nothing-new', 'no-data']) assert.equal(pruneDecision(o).prune, true, o);
  });

  it('an env-less process prunes an un-enrolled home with config retention', () => {
    setup({ env: { LOG_RETENTION_DAYS: '14' } });
    const d = pruneDecision('not-enabled');
    assert.equal(d.prune, true);
    assert.equal(d.retentionDays, 14);
  });

  it('an env-less process keeps an enrolled home and uses its retention', () => {
    setup({ env: { LOG_RETENTION_DAYS: '14' } });
    enroll(1, 30);
    const d = pruneDecision('not-enabled');
    assert.equal(d.prune, false);
    assert.equal(d.retentionDays, 30);
  });

  it('a removed home prunes', () => {
    setup();
    writeJson('export-enrollment.json', { state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30 });
    assert.equal(pruneDecision('removed').prune, true);
  });

  it('failures keep files until the 2×retention cap', () => {
    setup();
    enroll(10, 30);
    for (const o of ['hard-failed', 'upload-failed']) assert.equal(pruneDecision(o).prune, false, o);
    enroll(61, 30);
    fs.rmSync(path.join(home, 'export-cursor.json'), { force: true });
    const d = pruneDecision('upload-failed');
    assert.equal(d.prune, true);
    assert.ok(d.reason);
  });

  it('a recent lastSuccessAt outranks an old enrollment', () => {
    setup();
    enroll(90, 30);
    writeJson('export-last.json', { outcome: 'upload-failed', lastSuccessAt: new Date().toISOString() });
    assert.equal(pruneDecision('upload-failed').prune, false);
  });

  it('no valid basis at all prunes and says why', () => {
    setup();
    writeJson('export-enrollment.json', { state: 'enrolled', enrolledAt: 'garbage', retentionDays: 30 });
    writeJson('export-last.json', { lastSuccessAt: 'also-garbage' });
    // the cursor mtime is the last resort; remove it so nothing is valid
    fs.rmSync(path.join(home, 'export-cursor.json'), { force: true });
    const d = pruneDecision('hard-failed');
    assert.equal(d.prune, true);
    assert.match(d.reason, /basis/);
  });
});
