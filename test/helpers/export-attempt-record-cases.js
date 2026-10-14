'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const exportSync = require('../../server/export-sync');
const { CredentialError, networkError, uploadError } = require('../../server/export-credentials');
const { pinExportLockPort } = require('./export-lock-fixture');

const ENV_KEYS = [
  'CCXRAY_HOME', 'LOGS_DIR', 'CLOUDSDK_CONFIG', 'CCXRAY_EXPORT_GCS_KEY_FILE',
  'CCXRAY_EXPORT_DISABLE', 'NODE_TEST_CONTEXT', 'CCXRAY_EXPORT_GCS_BUCKET',
  'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_EXPORT_CONFIG_DIRS',
  'CCXRAY_EXPORT_CWD_ALLOWLIST', 'CCXRAY_USER_EMAIL', 'CCXRAY_AGENT_ID',
  'CCXRAY_TEAM', 'LOG_RETENTION_DAYS', 'TZ',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let root;
let home;
let logsDir;
let gcloudDir;
let uploads;

function today() { return new Date().toISOString().slice(0, 10); }

function entry(dt = today(), n = 1, overrides = {}) {
  const time = `10:${String(n).padStart(2, '0')}:00`;
  const id = `${dt}T${time.replaceAll(':', '-')}-000`;
  return {
    id,
    ts: id,
    receivedAt: Date.parse(`${dt}T${time}Z`),
    sessionId: `session-${dt}-${n}`,
    responseId: `response-${dt}-${n}`,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    msgCount: n,
    usage: { input_tokens: 100, output_tokens: 20 },
    cost: { cost: 0.01, confidence: 'exact' },
    maxContext: 200000,
    stopReason: 'end_turn',
    status: 200,
    accountEmail: 'person@example.com',
    accountDomain: 'example.com',
    ...overrides,
  };
}

function writeIndex(entries) {
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), entries.map(row => JSON.stringify(row)).join('\n')
    + (entries.length ? '\n' : ''));
}

async function setup({ entries = [entry()], env = {}, cursor = undefined } = {}) {
  await cleanup();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-attempt-record-'));
  home = path.join(root, 'home');
  logsDir = path.join(home, 'logs');
  gcloudDir = path.join(root, 'gcloud');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(gcloudDir, { recursive: true });
  await pinExportLockPort(home);
  writeIndex(entries);

  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    CCXRAY_HOME: home,
    LOGS_DIR: logsDir,
    CLOUDSDK_CONFIG: gcloudDir,
    CCXRAY_EXPORT_GCS_BUCKET: 'synthetic-bucket',
    CCXRAY_EXPORT_DOMAINS: 'example.com',
    CCXRAY_USER_EMAIL: 'person@example.com',
    CCXRAY_AGENT_ID: 'synthetic-agent',
    CCXRAY_TEAM: 'synthetic-team',
    TZ: 'UTC',
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
  uploads = [];
  exportSync._setUploader(async (bucket, name, body) => uploads.push({ bucket, name, body }));
  exportSync._setTokenExchanger(null);
  exportSync._resetTokenCache();
  delete require.cache[require.resolve('../../server/config')];

  if (cursor !== null) {
    const initial = cursor || { lastId: null, seq: {}, partial: false, cutoffDt: today(), floorV: 1 };
    fs.writeFileSync(path.join(home, 'export-cursor.json'), JSON.stringify(initial) + '\n');
  }
}

async function cleanup() {
  exportSync._setUploader(null);
  exportSync._setTokenExchanger(null);
  exportSync._resetTokenCache();
  delete require.cache[require.resolve('../../server/config')];
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = home = logsDir = gcloudDir = undefined;
  uploads = undefined;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function lastAttempt() {
  return JSON.parse(fs.readFileSync(path.join(home, 'export-last.json'), 'utf8'));
}

async function quiet(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); }
  finally { console.log = log; console.error = error; }
}

describe('export attempt records', () => {
  afterEach(cleanup);

  it('records a successful upload and carries its success time through removal', async () => {
    await setup();
    const initialConfigHash = exportSync.exportConfigHash(process.env);
    assert.equal(await quiet(() => exportSync.flushExport({ phase: 'startup' })), 'exported');
    const success = lastAttempt();
    assert.equal(success.outcome, 'exported');
    assert.equal(success.phase, 'startup');
    assert.equal(success.stage, null);
    assert.equal(success.category, null);
    assert.equal(success.files, 1);
    assert.equal(success.rows, 2);
    assert.equal(success.eligibleTurns, 1);
    assert.deepEqual(success.excludedTurns, { noAccount: 0, domainMismatch: 0 });
    assert.equal(success.candidateEmails, 1);
    assert.equal(success.exportConfigHash, initialConfigHash);
    assert.equal(success.lastSuccessAt, success.attemptedAt);

    process.env.CCXRAY_EXPORT_GCS_BUCKET = 'second-synthetic-bucket';
    const removalConfigHash = exportSync.exportConfigHash(process.env);
    assert.notEqual(removalConfigHash, initialConfigHash);
    fs.writeFileSync(path.join(home, 'export-enrollment.json'), JSON.stringify({
      state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30,
    }));
    assert.equal(await quiet(() => exportSync.flushExport()), 'removed');
    const removed = lastAttempt();
    assert.equal(removed.exportConfigHash, removalConfigHash);
    assert.notEqual(removed.exportConfigHash, success.exportConfigHash);
    assert.equal(removed.stage, null);
    assert.equal(removed.category, null);
    assert.equal(removed.lastSuccessAt, success.lastSuccessAt);
    assert.equal(removed.files, 0);
    assert.equal(removed.rows, 0);
    assert.equal(removed.eligibleTurns, null);
    assert.equal(removed.excludedTurns, null);
    assert.equal(removed.candidateEmails, null);
  });

  it('records a positive excluded domain-mismatch count', async () => {
    await setup({ entries: [
      entry(),
      entry(today(), 2, {
        accountEmail: 'excluded@outside.test',
        accountDomain: 'outside.test',
      }),
    ] });
    assert.equal(await quiet(() => exportSync.flushExport()), 'exported');

    const record = lastAttempt();
    assert.equal(record.eligibleTurns, 1);
    assert.equal(record.excludedTurns.noAccount, 0);
    assert.equal(record.excludedTurns.domainMismatch, 1);
  });

  it('records enrollment-invalid read, parse, and shape outcomes with safe categories', async () => {
    for (const reason of ['read', 'parse', 'shape']) {
      await setup();
      const enrollmentPath = path.join(home, 'export-enrollment.json');
      if (reason === 'parse') fs.writeFileSync(enrollmentPath, '{ broken private@example.test');
      if (reason === 'shape') fs.writeFileSync(enrollmentPath, JSON.stringify({ state: 'other' }));
      const originalRead = fs.readFileSync;
      if (reason === 'read') {
        fs.readFileSync = function (file, ...args) {
          if (path.resolve(String(file)) === path.resolve(enrollmentPath)) {
            const error = new Error('sensitive read detail'); error.code = 'EACCES'; throw error;
          }
          return originalRead.call(this, file, ...args);
        };
      }
      try {
        assert.equal(await quiet(() => exportSync.flushExport()), 'enrollment-invalid');
      } finally {
        fs.readFileSync = originalRead;
      }
      const record = lastAttempt();
      assert.equal(record.stage, 'enrollment');
      assert.equal(record.category, reason);
      assert.equal(record.files, 0);
      assert.equal(record.rows, 0);
      assert.equal(record.eligibleTurns, null);
      assert.equal(JSON.stringify(record).includes('private@example.test'), false);
      assert.equal(JSON.stringify(record).includes('sensitive read detail'), false);
    }
  });

  it('records zero-candidate and two-candidate identity hard failures', async () => {
    const cases = [
      { candidates: 0, rows: [entry(today(), 1, { accountEmail: undefined, accountDomain: undefined })], category: 'no-candidate' },
      { candidates: 2, rows: [
        entry(today(), 1, { accountEmail: 'one@example.com' }),
        entry(today(), 2, { accountEmail: 'two@example.com' }),
      ], category: 'multiple-candidates' },
    ];
    for (const item of cases) {
      await setup({ entries: item.rows, env: { CCXRAY_USER_EMAIL: undefined } });
      assert.equal(await quiet(() => exportSync.flushExport()), 'hard-failed');
      const record = lastAttempt();
      assert.equal(record.stage, 'identity');
      assert.equal(record.category, item.category);
      assert.equal(record.candidateEmails, item.candidates);
      assert.equal(record.files, 0);
      assert.equal(record.rows, 0);
      assert.equal(record.eligibleTurns, item.candidates);
      assert.deepEqual(record.excludedTurns, { noAccount: item.candidates === 0 ? 1 : 0, domainMismatch: 0 });
    }
  });

  it('records aggregate counts for filtered nothing-new and null counts when filtering is inactive', async () => {
    const row = entry();
    await setup({ entries: [row], cursor: {
      lastId: row.id, seq: {}, partial: false, cutoffDt: today(), floorV: 1,
    } });
    assert.equal(await quiet(() => exportSync.flushExport()), 'nothing-new');
    const filtered = lastAttempt();
    assert.equal(filtered.stage, null);
    assert.equal(filtered.eligibleTurns, 1);
    assert.deepEqual(filtered.excludedTurns, { noAccount: 0, domainMismatch: 0 });
    assert.equal(filtered.candidateEmails, 1);
    assert.equal(filtered.lastSuccessAt, filtered.attemptedAt);

    await setup({ entries: [row], env: { CCXRAY_EXPORT_DOMAINS: '' }, cursor: {
      lastId: row.id, seq: {}, partial: false, cutoffDt: today(), floorV: 1,
    } });
    assert.equal(await quiet(() => exportSync.flushExport()), 'nothing-new');
    const unfiltered = lastAttempt();
    assert.equal(unfiltered.eligibleTurns, null);
    assert.equal(unfiltered.excludedTurns, null);
    assert.equal(unfiltered.candidateEmails, null);
  });

  it('records no-data after aggregation', async () => {
    await setup({ entries: [entry(today(), 1, { sessionId: undefined })] });
    assert.equal(await quiet(() => exportSync.flushExport()), 'no-data');
    const record = lastAttempt();
    assert.equal(record.stage, null);
    assert.equal(record.files, 0);
    assert.equal(record.rows, 0);
    assert.equal(record.eligibleTurns, 0);
    assert.deepEqual(record.excludedTurns, { noAccount: 0, domainMismatch: 0 });
    assert.equal(record.candidateEmails, 0);
    assert.equal(record.lastSuccessAt, null);
  });

  it('records exported 0/0 when all new dates are before the floor or already checkpointed', async () => {
    await setup({ entries: [entry('2000-01-01')] });
    assert.equal(await quiet(() => exportSync.flushExport()), 'exported');
    let record = lastAttempt();
    assert.equal(record.files, 0);
    assert.equal(record.rows, 0);
    assert.equal(record.eligibleTurns, 1);

    const row = entry();
    await setup({ entries: [row], cursor: {
      lastId: null,
      seq: { [today()]: 1 },
      partial: false,
      cutoffDt: today(),
      floorV: 1,
      completedDts: [today()],
      snapshotLastId: row.id,
    } });
    assert.equal(await quiet(() => exportSync.flushExport()), 'exported');
    record = lastAttempt();
    assert.equal(record.files, 0);
    assert.equal(record.rows, 0);
    assert.equal(record.lastSuccessAt, record.attemptedAt);
  });

  it('records token refusal through the token exchanger without calling GCS', async () => {
    await setup();
    const adc = {
      type: 'authorized_user',
      client_id: 'synthetic-client-id',
      client_secret: 'synthetic-client-secret',
      refresh_token: 'synthetic-refresh-token',
    };
    fs.writeFileSync(path.join(gcloudDir, 'application_default_credentials.json'), JSON.stringify(adc));
    exportSync._setUploader(null);
    exportSync._setTokenExchanger(async () => {
      throw new CredentialError('token', 'refused:invalid_grant');
    });
    await assert.rejects(quiet(() => exportSync.flushExport()), CredentialError);
    const record = lastAttempt();
    assert.equal(record.outcome, 'upload-failed');
    assert.equal(record.stage, 'token');
    assert.equal(record.category, 'refused:invalid_grant');
    assert.equal(record.files, 0);
    assert.equal(record.rows, 0);
  });

  it('records 403, network, and non-credential upload errors without storing messages', async () => {
    const errors = [
      [uploadError(403), 'authorization', 'denied'],
      [networkError('upload', { code: 'ECONNRESET' }), 'upload', 'network:ECONNRESET'],
      [new Error('private@example.test upstream-body'), 'upload', 'error'],
    ];
    for (const [error, stage, category] of errors) {
      await setup();
      exportSync._setUploader(async () => { throw error; });
      await assert.rejects(quiet(() => exportSync.flushExport()));
      const record = lastAttempt();
      assert.equal(record.stage, stage);
      assert.equal(record.category, category);
      assert.equal(record.files, 0);
      assert.equal(record.rows, 0);
      assert.equal(JSON.stringify(record).includes('private@example.test'), false);
      assert.equal(JSON.stringify(record).includes('upstream-body'), false);
    }
  });

  it('records an unreadable cursor as cursor-read with uncomputed aggregate facts', async () => {
    await setup();
    const cursorPath = path.join(home, 'export-cursor.json');
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (path.resolve(String(file)) === path.resolve(cursorPath)) {
        const error = new Error('cursor details'); error.code = 'EACCES'; throw error;
      }
      return originalRead.call(this, file, ...args);
    };
    try { await assert.rejects(quiet(() => exportSync.flushExport())); }
    finally { fs.readFileSync = originalRead; }
    const record = lastAttempt();
    assert.equal(record.stage, 'cursor-read');
    assert.equal(record.category, 'EACCES');
    assert.equal(record.eligibleTurns, null);
    assert.equal(record.excludedTurns, null);
    assert.equal(record.candidateEmails, null);
    assert.equal(JSON.stringify(record).includes('cursor details'), false);
  });

  it('records non-ENOENT index stream errors as index-read before aggregation', async () => {
    await setup();
    const config = require('../../server/config');
    const originalReadIndexLines = config.storage.readIndexLines;
    config.storage.readIndexLines = () => (async function* () {
      const error = new Error('private index failure'); error.code = 'EIO'; throw error;
    })();
    try { await assert.rejects(quiet(() => exportSync.flushExport())); }
    finally {
      config.storage.readIndexLines = originalReadIndexLines;
      delete require.cache[require.resolve('../../server/config')];
    }
    const record = lastAttempt();
    assert.equal(record.stage, 'index-read');
    assert.equal(record.category, 'EIO');
    assert.equal(record.eligibleTurns, null);
    assert.equal(record.excludedTurns, null);
    assert.equal(record.candidateEmails, null);
    assert.equal(JSON.stringify(record).includes('private index failure'), false);
  });

  it('records cursor-write failure after aggregation and preserves completed upload counts', async () => {
    await setup();
    const cursorPath = path.join(home, 'export-cursor.json');
    const originalRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (path.resolve(String(to)) === path.resolve(cursorPath)) {
        const error = new Error('cursor rename detail'); error.code = 'EACCES'; throw error;
      }
      return originalRename.call(this, from, to);
    };
    try { await assert.rejects(quiet(() => exportSync.flushExport())); }
    finally { fs.renameSync = originalRename; }
    const record = lastAttempt();
    assert.equal(record.stage, 'cursor-write');
    assert.equal(record.category, 'EACCES');
    assert.equal(record.files, 1);
    assert.equal(record.rows, 2);
    assert.equal(record.eligibleTurns, 1);
    assert.deepEqual(record.excludedTurns, { noAccount: 0, domainMismatch: 0 });
    assert.equal(record.candidateEmails, 1);
  });

  it('keeps the first successful date checkpoint when a later upload fails', async () => {
    const dt1 = '2026-10-12';
    const dt2 = '2026-10-13';
    await setup({ entries: [entry(dt1, 1), entry(dt2, 2)], cursor: {
      lastId: null, seq: {}, partial: false, cutoffDt: dt1, floorV: 1,
    } });
    const previousSuccess = '2026-10-01T00:00:00.000Z';
    fs.writeFileSync(path.join(home, 'export-last.json'), JSON.stringify({ lastSuccessAt: previousSuccess }));
    let count = 0;
    exportSync._setUploader(async () => {
      count++;
      if (count === 2) throw new Error('second upload private message');
    });
    await assert.rejects(quiet(() => exportSync.flushExport()));
    const record = lastAttempt();
    assert.equal(record.stage, 'upload');
    assert.equal(record.category, 'error');
    assert.equal(record.files, 1);
    assert.equal(record.rows, 2);
    assert.equal(record.lastSuccessAt, previousSuccess);
    assert.equal(JSON.stringify(record).includes('second upload private message'), false);
    const cursor = JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.seq[dt1], 1);
    assert.deepEqual(cursor.completedDts, [dt1]);
    assert.equal(cursor.snapshotLastId, entry(dt2, 2).id);
  });

  it('does not change the last-attempt bytes when disabled or when another flush owns the lock', async () => {
    await setup();
    const file = path.join(home, 'export-last.json');
    const original = '{"outcome":"previous","attemptedAt":"fixture"}\n';
    fs.writeFileSync(file, original);
    process.env.CCXRAY_EXPORT_DISABLE = '1';
    assert.equal(await quiet(() => exportSync.flushExport()), 'not-enabled');
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    delete process.env.CCXRAY_EXPORT_DISABLE;
    const result = await exportSync.withExportLock(async () => quiet(() => exportSync.flushExport()));
    assert.equal(result, 'lock-lost');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});
