'use strict';

// Team-rollout exporter contract (design-proxy-rollout §3.1, §3.7): enrollment state,
// first-run floor, the lock-held startup flush, and the startup prune decision.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pinExportLockPort } = require('./helpers/export-lock-fixture');

const exportSync = require('../server/export-sync');
const { flushExport, withExportLock, startupFlushAndPrune, pruneDecision, readEnrollment, startExportSync, _setUploader, _setCredentialLogger, stopExportSync, awaitPendingFlush } = exportSync;
const ROOT = path.resolve(__dirname, '..');
const EXPORT_SYNC = path.join(ROOT, 'server', 'export-sync.js');
const WAIT_MS = 5000;

const ENV_KEYS = [
  'CCXRAY_HOME', 'CCXRAY_EXPORT_GCS_BUCKET', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_USER_EMAIL',
  'CCXRAY_AGENT_ID', 'CCXRAY_EXPORT_DISABLE', 'LOGS_DIR', 'LOG_RETENTION_DAYS',
  'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_CONFIG_DIRS', 'CCXRAY_TEAM',
  'CCXRAY_EXPORT_GCS_KEY_FILE', 'CLOUDSDK_CONFIG',
];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
let home, uploads, credentialConfigDir;

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

function entryAt(dt, time, n = 1) {
  const id = `${dt}T${time.replaceAll(':', '-')}-000`;
  return {
    ...entry(n), id, ts: id, receivedAt: Date.parse(`${dt}T${time}Z`),
    sessionId: 's-cross-midnight', responseId: `msg-${id}`,
  };
}

async function setup({ entries = [], env = {} } = {}) {
  if (credentialConfigDir) fs.rmSync(credentialConfigDir, { recursive: true, force: true });
  credentialConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-gcloud-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-test-'));
  await pinExportLockPort(home);
  fs.mkdirSync(path.join(home, 'logs'));
  writeIndex(entries);
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    CCXRAY_HOME: home, CCXRAY_EXPORT_GCS_BUCKET: 'test-bucket',
    CCXRAY_AGENT_ID: 'agent-1', CCXRAY_EXPORT_DOMAINS: 'example.com', CLOUDSDK_CONFIG: credentialConfigDir,
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
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.log = log; console.error = error; });
}

function withTimeout(promise, label, timeoutMs = WAIT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function silenceConsole() {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    console.log = log;
    console.error = error;
  };
}

async function settleStartup(promise) {
  try { await withTimeout(promise, 'startup cleanup'); } catch {}
}

function removalWriter(childHome) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
    withExportLock(() => {
      fs.writeFileSync(path.join(process.env.CCXRAY_HOME, 'export-enrollment.json'), JSON.stringify({
        state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30,
      }) + '\\n');
      return 'removed';
    }).then(outcome => process.stdout.write(JSON.stringify({ outcome: outcome ?? null }) + '\\n'))
      .catch(err => { console.error(err.stack); process.exitCode = 1; });
  `;
  const env = { ...process.env, CCXRAY_HOME: childHome, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1' };
  delete env.CCXRAY_EXPORT_GCS_BUCKET;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, 5000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`removal writer timed out: ${stderr}`));
      if (code !== 0) return reject(new Error(`removal writer exit ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (err) { reject(new Error(`invalid removal writer output: ${stdout} ${stderr}`)); }
    });
  });
}

afterEach(async () => {
  _setUploader(null);
  _setCredentialLogger(null);
  stopExportSync();
  await awaitPendingFlush();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (credentialConfigDir) fs.rmSync(credentialConfigDir, { recursive: true, force: true });
  credentialConfigDir = null;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe('first run (§3.7)', () => {
  // The day-1 loss: with a domain filter and no CCXRAY_USER_EMAIL, the empty-index
  // first flush used to hard-fail before writing a cursor; the next flush then anchored
  // the cursor at the tail and never uploaded the first session.
  it('an empty index is nothing-new and the first session still exports', async () => {
    await setup();
    for (const missing of [false, true]) {
      if (missing) fs.rmSync(path.join(home, 'logs/index.ndjson'));
      assert.equal(await quiet(() => flushExport()), 'nothing-new');
      assert.equal(uploads.length, 0);
      assert.equal(readJson('export-cursor.json').lastId, null);
      assert.equal(readJson('export-last.json').outcome, 'nothing-new');
      assert.equal(readJson('export-last.json').eligibleTurns, 0);
      assert.equal(pruneDecision('nothing-new', home).prune, true);
    }

    appendIndex(entry(1), entry(2));
    assert.equal(await quiet(() => flushExport()), 'exported');
    assert.deepEqual(uploadedDts(), [utcDay()]);
  });

  it('keeps the identity failure, cursor and prune hold when all turns are excluded', async () => {
    await setup({ entries: [entry(1, { accountEmail: null }), entry(2, { accountEmail: 'dev@outside.test' })] });
    assert.equal(await quiet(() => flushExport()), 'hard-failed');
    assert.equal(uploads.length, 0);
    assert.equal(readJson('export-cursor.json').lastId, null);
    const attempt = readJson('export-last.json');
    assert.equal(attempt.category, 'no-candidate');
    assert.equal(attempt.eligibleTurns, 0);
    assert.deepEqual(attempt.excludedTurns, { noAccount: 1, domainMismatch: 1 });
    assert.equal(pruneDecision('hard-failed', home).prune, false);
  });

  it('uploads today from an existing index but never an older day', async () => {
    await setup({ entries: [entry(1, { daysAgo: 3 }), entry(2)] });
    assert.equal(await quiet(() => flushExport()), 'exported');
    assert.deepEqual(uploadedDts(), [utcDay()]);
    assert.equal(readJson('export-enrollment.json').state, 'enrolled');
  });

  it('repairs an enrolled home with no cursor from the enrollment day', async () => {
    await setup({ entries: [entry(1, { daysAgo: 2 }), entry(2, { daysAgo: 4 })] });
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
    await setup({ entries: [entry(1)] });
    writeJson('export-enrollment.json', { state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30 });
    const enrollmentBefore = fs.readFileSync(path.join(home, 'export-enrollment.json'), 'utf8');
    const lastSuccessAt = new Date(Date.now() - 60_000).toISOString();
    writeJson('export-last.json', { outcome: 'exported', lastSuccessAt });
    assert.equal(await quiet(() => flushExport()), 'removed');
    assert.equal(uploads.length, 0);
    assert.equal(fs.existsSync(path.join(home, 'export-cursor.json')), false);
    assert.equal(readJson('export-enrollment.json').state, 'removed');
    assert.equal(fs.readFileSync(path.join(home, 'export-enrollment.json'), 'utf8'), enrollmentBefore,
      'a removal flush must leave the enrollment tombstone unchanged');
    assert.equal(fs.existsSync(path.join(home, 'export-last.json')), true,
      'the removal outcome is persisted even though no upload is attempted');
    assert.equal(readJson('export-last.json').outcome, 'removed');
    assert.equal(readJson('export-last.json').lastSuccessAt, lastSuccessAt,
      'recording removal must preserve the last successful export time');
  });
});

describe('effective floor (I2)', () => {
  it('an older cursor cannot upload days before the current enrollment', async () => {
    await setup({ entries: [entry(1, { daysAgo: 5 }), entry(2, { daysAgo: 1 })] });
    writeJson('export-cursor.json', { lastId: null, seq: {}, partial: false, cutoffDt: utcDay(-10), floorV: 1 });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: new Date(Date.now() - 86_400_000).toISOString(), retentionDays: 30,
    });
    await quiet(() => flushExport());
    assert.deepEqual(uploadedDts(), [utcDay(-1)]);
  });
});

describe('startup lock (§3.1)', () => {
  // A nested acquire cannot bind the same per-home socket. Startup must pass its
  // already-held socket handle into the flush instead.
  it('flushExport({lockToken}) runs inside withExportLock', async () => {
    await setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    const outcome = await withExportLock(lockToken => quiet(() => flushExport({ lockToken })));
    assert.equal(outcome, 'exported');
  });

  it('a plain flushExport inside the held lock is lost, not deadlocked', async () => {
    await setup({ entries: [entry(1)] });
    const outcome = await withExportLock(() => quiet(() => flushExport()));
    assert.equal(outcome, 'lock-lost');
  });

  it('export-last keeps lastSuccessAt across a failed attempt', async () => {
    await setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
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

describe('enrollment read and recovery', () => {
  it('an invalid enrollment stops before cursor creation or upload', async () => {
    await setup({ entries: [entry(1)] });
    fs.writeFileSync(path.join(home, 'export-enrollment.json'), '{broken json');
    assert.equal(readEnrollment(home)?.state, 'invalid');
    assert.equal(await quiet(() => flushExport()), 'enrollment-invalid');
    assert.equal(uploads.length, 0);
    assert.equal(fs.existsSync(path.join(home, 'export-cursor.json')), false);
    assert.equal(readJson('export-last.json').outcome, 'enrollment-invalid');
  });

  it('an invalid enrollment still owes data until the retention cap', async () => {
    await setup();
    writeJson('export-enrollment.json', { state: 'unknown', enrolledAt: new Date().toISOString(), retentionDays: 30 });
    writeJson('export-last.json', { lastSuccessAt: new Date().toISOString() });
    assert.equal(pruneDecision('not-enabled').prune, false);
    assert.equal(pruneDecision('enrollment-invalid').prune, false);
    assert.equal(pruneDecision('lock-lost').prune, false);
  });

  it('recovers an enrollment across UTC midnight from its original floor', async () => {
    const today = utcDay();
    const yesterday = utcDay(-1);
    await setup({ entries: [entryAt(yesterday, '23:55:00'), entryAt(today, '00:01:00', 2)] });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: `${yesterday}T23:59:00.000Z`, retentionDays: 30,
    });
    await quiet(() => flushExport());
    assert.equal(readJson('export-cursor.json').cutoffDt, yesterday);
    assert.deepEqual(uploadedDts(), [today, yesterday].sort());
  });

  it('same-day re-enrollment preserves the existing upload sequence', async () => {
    const today = utcDay();
    await setup({ entries: [entryAt(today, '12:00:00')] });
    writeJson('export-cursor.json', {
      lastId: null, seq: { [today]: 3 }, partial: false, cutoffDt: utcDay(-10), floorV: 1,
    });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: `${today}T00:00:00.000Z`, retentionDays: 30,
    });
    await quiet(() => flushExport());
    assert.equal(readJson('export-cursor.json').seq[today], 4);
    assert.match(uploads[0].name, new RegExp(`--4--`));
  });
});

describe('startup exclusion gates', () => {
  it('holds the socket through upload; a removal writer waits until flush completes', async () => {
    await setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    let beginUpload;
    let finishUpload;
    const uploadStarted = new Promise(resolve => { beginUpload = resolve; });
    const uploadGate = new Promise(resolve => { finishUpload = resolve; });
    const restoreConsole = silenceConsole();
    _setUploader(async (...args) => {
      uploads.push({ name: args[1], body: args[2] });
      beginUpload();
      await withTimeout(uploadGate, 'upload gate');
    });
    const startup = startupFlushAndPrune({ pruneLogs: async () => {} });
    try {
      await withTimeout(uploadStarted, 'uploadStarted');
      assert.equal((await withTimeout(removalWriter(home), 'removal writer while upload is held')).outcome, null,
        'the remover cannot enter while upload is held');
      finishUpload();
      assert.equal(await withTimeout(startup, 'startup completion'), 'exported');
      const cursorBefore = fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8');

      assert.equal((await withTimeout(removalWriter(home), 'removal writer after startup')).outcome, 'removed');
      assert.equal(await withTimeout(flushExport(), 'post-removal flush'), 'removed');
      assert.equal(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8'), cursorBefore);
      assert.equal(uploads.length, 1);
      assert.equal(readJson('export-last.json').outcome, 'removed');
    } finally {
      finishUpload();
      restoreConsole();
      await settleStartup(startup);
    }
  });

  it('holds the socket until the awaited prune finishes, then releases it', async () => {
    await setup({ env: { CCXRAY_EXPORT_DISABLE: '1' } });
    let beginPrune;
    let finishPrune;
    const pruneStarted = new Promise(resolve => { beginPrune = resolve; });
    const pruneGate = new Promise(resolve => { finishPrune = resolve; });
    const restoreConsole = silenceConsole();
    const startup = startupFlushAndPrune({ pruneLogs: async () => {
      beginPrune();
      await withTimeout(pruneGate, 'prune gate');
    } });
    try {
      await withTimeout(pruneStarted, 'pruneStarted');
      assert.equal(await withTimeout(withExportLock(() => 'acquired'), 'contending lock attempt'), undefined);
      finishPrune();
      assert.equal(await withTimeout(startup, 'startup completion'), 'not-enabled');
      assert.equal(await withTimeout(withExportLock(() => 'acquired'), 'lock reacquisition'), 'acquired');
    } finally {
      finishPrune();
      restoreConsole();
      await settleStartup(startup);
    }
  });

  it('normalizes upload errors while holding through prune; a throwing prune still releases', async () => {
    await setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com', LOG_RETENTION_DAYS: '0' } });
    _setUploader(async () => { throw new Error('upload boom'); });
    let beginPrune;
    let finishPrune;
    const pruneStarted = new Promise(resolve => { beginPrune = resolve; });
    const pruneGate = new Promise(resolve => { finishPrune = resolve; });
    const restoreConsole = silenceConsole();
    const startup = startupFlushAndPrune({ pruneLogs: async () => {
      beginPrune();
      await withTimeout(pruneGate, 'prune gate');
    } });
    try {
      await withTimeout(pruneStarted, 'pruneStarted');
      assert.equal(await withTimeout(withExportLock(() => 'acquired'), 'contending lock attempt'), undefined);
      finishPrune();
      assert.equal(await withTimeout(startup, 'startup completion'), 'upload-failed');

      process.env.CCXRAY_EXPORT_DISABLE = '1';
      writeJson('export-enrollment.json', { state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30 });
      await assert.rejects(withTimeout(startupFlushAndPrune({
        pruneLogs: async () => { throw new Error('prune boom'); },
      }), 'throwing prune startup completion'), /prune boom/);
      assert.equal(await withTimeout(withExportLock(() => 'acquired'), 'post-error lock reacquisition'), 'acquired');
    } finally {
      finishPrune();
      restoreConsole();
      await settleStartup(startup);
    }
  });
});

describe('startup diagnostics and outcome reporting', () => {
  it('records startup acquisition and interval/shutdown lock-loss phases', async () => {
    await setup({ entries: [entry(1)], env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    assert.equal(await quiet(() => startupFlushAndPrune({ pruneLogs: async () => {} })), 'exported');
    await withExportLock(async () => {
      assert.equal(await quiet(() => flushExport({ phase: 'interval' })), 'lock-lost');
      assert.equal(await quiet(() => flushExport({ phase: 'shutdown' })), 'lock-lost');
    });
    const events = fs.readFileSync(path.join(home, 'export-events.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(line => line.event.type), ['lock-acquired', 'lock-lost', 'lock-lost']);
    assert.equal(events[0].event.phase, 'startup');
    assert.equal(events[1].event.phase, 'interval');
    assert.equal(events[2].event.phase, 'shutdown');
    assert.equal(typeof events[1].event.port, 'number');
    assert.equal(events[1].event.code, 'EADDRINUSE');
  });

  it('prints one legacy-file advisory while continuing to acquire and prune', async () => {
    await setup({ env: { CCXRAY_EXPORT_DISABLE: '1' } });
    fs.writeFileSync(path.join(home, 'export.lock'), 'legacy');
    const lines = [];
    let pruned = 0;
    assert.equal(await startupFlushAndPrune({ pruneLogs: async () => { pruned++; }, log: line => lines.push(line) }), 'not-enabled');
    assert.equal(pruned, 1);
    assert.equal(lines.filter(line => line.includes('export.lock exists')).length, 1);
    assert.equal(fs.readFileSync(path.join(home, 'export.lock'), 'utf8'), 'legacy');
  });

  it('persists cap-basis-invalid under the startup lock before pruning', async () => {
    await setup({ env: { CCXRAY_EXPORT_DISABLE: '1' } });
    writeJson('export-enrollment.json', { state: 'enrolled', enrolledAt: 'invalid-date', retentionDays: 30 });
    writeJson('export-last.json', { lastSuccessAt: 'also-invalid' });
    const pruneEvents = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async () => {
      pruneEvents.push(fs.readFileSync(path.join(home, 'export-events.log'), 'utf8').trim().split('\n').map(JSON.parse).map(row => row.event.type));
    } }), 'not-enabled');
    assert.deepEqual(pruneEvents, [['lock-acquired', 'cap-basis-invalid']]);
  });

  it('a removed startup outcome is not announced as an active exporter', async () => {
    await setup({ env: { CCXRAY_USER_EMAIL: 'dev@example.com' } });
    const lines = [];
    _setCredentialLogger(line => lines.push(line));
    writeJson('export-enrollment.json', {
      state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30,
    });
    startExportSync({ startupOutcome: 'removed' });
    stopExportSync();
    await awaitPendingFlush();
    assert.ok(lines.some(line => line.includes('removed — this home was un-enrolled')));
    assert.equal(lines.some(line => line.includes('exporter active')), false);
    assert.equal(readJson('export-last.json').outcome, 'removed',
      'the initial flush must still reread and record the removed enrollment');

    lines.length = 0;
    fs.writeFileSync(path.join(home, 'export-enrollment.json'), '{invalid json');
    startExportSync({ startupOutcome: 'enrollment-invalid' });
    stopExportSync();
    await awaitPendingFlush();
    assert.ok(lines.some(line => line.includes('enrollment-invalid — export-enrollment.json')));
    assert.equal(lines.some(line => line.includes('exporter active')), false);
    assert.equal(readJson('export-last.json').outcome, 'enrollment-invalid',
      'the initial flush must still reread and record invalid enrollment');
  });
});

describe('startup prune decision guards', () => {
  const DAY = 86_400_000;

  it('does not prune an enrolled home from an env-less startup', async () => {
    await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '17' } });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: new Date(Date.now() - DAY).toISOString(), retentionDays: 5,
    });
    const pruneCalls = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
    assert.deepEqual(pruneCalls, []);
  });

  it('does not prune invalid enrollment while last success is inside the cap', async () => {
    await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '17' } });
    const enrollmentPath = path.join(home, 'export-enrollment.json');
    const enrollmentBytes = '{broken enrollment json\n';
    fs.writeFileSync(enrollmentPath, enrollmentBytes);
    const lastSuccessAt = new Date(Date.now() - DAY).toISOString();
    writeJson('export-last.json', { outcome: 'upload-failed', lastSuccessAt });
    const pruneCalls = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
    assert.deepEqual(pruneCalls, []);
    assert.equal(fs.readFileSync(enrollmentPath, 'utf8'), enrollmentBytes,
      'startup must not rewrite an invalid enrollment file');
    assert.equal(readJson('export-last.json').lastSuccessAt, lastSuccessAt);
  });

  it('prunes an enrolled home after its retention cap and passes enrollment retention', async () => {
    await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '17' } });
    writeJson('export-enrollment.json', {
      state: 'enrolled', enrolledAt: new Date(Date.now() - 11 * DAY).toISOString(), retentionDays: 5,
    });
    const pruneCalls = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
    assert.deepEqual(pruneCalls, [{ retentionDays: 5 }]);
  });

  it('prunes invalid enrollment after the configured retention cap expires', async () => {
    await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '7' } });
    fs.writeFileSync(path.join(home, 'export-enrollment.json'), '{broken enrollment json\n');
    writeJson('export-last.json', {
      lastSuccessAt: new Date(Date.now() - 15 * DAY).toISOString(),
    });
    const pruneCalls = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
    assert.deepEqual(pruneCalls, [{ retentionDays: 7 }]);
  });

  it('prunes a removed home with configured retention', async () => {
    await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '17' } });
    writeJson('export-enrollment.json', {
      state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 5,
    });
    const pruneCalls = [];
    assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
    assert.deepEqual(pruneCalls, [{ retentionDays: 17 }]);
  });

  for (const code of ['EACCES', 'EIO']) {
    it(`keeps recent data when enrollment reads fail with ${code}`, async () => {
      await setup({ env: { CCXRAY_EXPORT_GCS_BUCKET: '', LOG_RETENTION_DAYS: '9' } });
      const enrollmentPath = path.join(home, 'export-enrollment.json');
      const enrollmentBytes = '{state: unreadable but preserved}\n';
      fs.writeFileSync(enrollmentPath, enrollmentBytes);
      writeJson('export-last.json', {
        lastSuccessAt: new Date(Date.now() - DAY).toISOString(),
      });
      const originalReadFileSync = fs.readFileSync;
      const pruneCalls = [];
      fs.readFileSync = function (filename, ...args) {
        if (path.resolve(String(filename)) === enrollmentPath) {
          const err = new Error(`fixture ${code}`);
          err.code = code;
          throw err;
        }
        return originalReadFileSync.call(this, filename, ...args);
      };
      try {
        assert.equal(await startupFlushAndPrune({ pruneLogs: async options => pruneCalls.push(options) }), 'not-enabled');
      } finally {
        fs.readFileSync = originalReadFileSync;
      }
      assert.deepEqual(pruneCalls, [], `${code} must not be treated as an absent enrollment`);
      assert.equal(fs.readFileSync(enrollmentPath, 'utf8'), enrollmentBytes);
    });
  }
});

describe('pruneDecision (§3.1 iii)', () => {
  const DAY = 86_400_000;
  const enroll = (daysAgo, retentionDays = 30) => writeJson('export-enrollment.json', {
    state: 'enrolled', enrolledAt: new Date(Date.now() - daysAgo * DAY).toISOString(), retentionDays,
  });

  it('prunes after any successful outcome', async () => {
    await setup();
    for (const o of ['exported', 'nothing-new', 'no-data']) assert.equal(pruneDecision(o).prune, true, o);
  });

  it('an env-less process prunes an un-enrolled home with config retention', async () => {
    await setup({ env: { LOG_RETENTION_DAYS: '14' } });
    const d = pruneDecision('not-enabled');
    assert.equal(d.prune, true);
    assert.equal(d.retentionDays, 14);
  });

  it('an env-less process keeps an enrolled home and uses its retention', async () => {
    await setup({ env: { LOG_RETENTION_DAYS: '14' } });
    enroll(1, 30);
    const d = pruneDecision('not-enabled');
    assert.equal(d.prune, false);
    assert.equal(d.retentionDays, 30);
  });

  it('a removed home prunes', async () => {
    await setup();
    writeJson('export-enrollment.json', { state: 'removed', enrolledAt: new Date().toISOString(), retentionDays: 30 });
    assert.equal(pruneDecision('removed').prune, true);
  });

  it('failures keep files until the 2×retention cap', async () => {
    await setup();
    enroll(10, 30);
    for (const o of ['hard-failed', 'upload-failed']) assert.equal(pruneDecision(o).prune, false, o);
    enroll(61, 30);
    fs.rmSync(path.join(home, 'export-cursor.json'), { force: true });
    const d = pruneDecision('upload-failed');
    assert.equal(d.prune, true);
    assert.ok(d.reason);
  });

  it('a recent lastSuccessAt outranks an old enrollment', async () => {
    await setup();
    enroll(90, 30);
    writeJson('export-last.json', { outcome: 'upload-failed', lastSuccessAt: new Date().toISOString() });
    assert.equal(pruneDecision('upload-failed').prune, false);
  });

  it('no valid basis at all prunes and says why', async () => {
    await setup();
    writeJson('export-enrollment.json', { state: 'enrolled', enrolledAt: 'garbage', retentionDays: 30 });
    writeJson('export-last.json', { lastSuccessAt: 'also-garbage' });
    // the cursor mtime is the last resort; remove it so nothing is valid
    fs.rmSync(path.join(home, 'export-cursor.json'), { force: true });
    const d = pruneDecision('hard-failed');
    assert.equal(d.prune, true);
    assert.match(d.reason, /basis/);
    assert.deepEqual(d.event, { type: 'cap-basis-invalid', outcome: 'hard-failed' });
  });

  it('future timestamps beyond one day are not accepted as cap bases', async () => {
    await setup();
    const tooFar = new Date(Date.now() + 2 * DAY).toISOString();
    writeJson('export-enrollment.json', { state: 'enrolled', enrolledAt: tooFar, retentionDays: 30 });
    writeJson('export-last.json', { lastSuccessAt: tooFar });
    const d = pruneDecision('upload-failed');
    assert.equal(d.prune, true);
    assert.deepEqual(d.event, { type: 'cap-basis-invalid', outcome: 'upload-failed' });
  });
});

// Keep the attempt-record contract cases in the exporter regression suite.
require('./helpers/export-attempt-record-cases');
