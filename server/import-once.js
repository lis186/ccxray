'use strict';

// `ccxray import --once` — a throttled, lock-guarded, single-shot transcript
// scan, meant to be fired and forgotten by something that has just noticed the
// index has fallen behind (the Herdr badge's staleness marker).
//
// It deliberately does NOT refuse while a hub is running, unlike
// `rebuild-index --reimport` (rebuild-index.js:573-577). That refusal is right
// for a destructive full rebuild; applying it here would leave every hub user
// permanently stale, which is the whole failure being fixed. What made the
// refusal necessary is avoided instead: this process only APPENDS index lines
// (append(2) with O_APPEND, storage/local.js:91-93) and never writes
// sessions.json, so it shares no whole-file write with the hub. The hub picks
// the new lines up on its next start, where `loadSessionIndex` already rebuilds
// on "index.ndjson newer than sessions.json" (session-index.js:68-72).

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

function ccxrayHome(env = process.env) {
  return env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
}

function statePath(env = process.env) {
  return path.join(ccxrayHome(env), 'import-once.json');
}

function lockPath(env = process.env) {
  return path.join(ccxrayHome(env), 'import-once.lock');
}

function minIntervalMs(env = process.env) {
  const raw = Number(env.CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_INTERVAL_MS;
}

function readState(env = process.env) {
  try { return JSON.parse(fs.readFileSync(statePath(env), 'utf8')); } catch { return {}; }
}

function writeState(state, env = process.env) {
  const file = statePath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

// A pid check, not a `ps | grep` — signal 0 asks the kernel. EPERM means the pid
// exists and belongs to someone else, which still counts as alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// O_EXCL create is the mutex. A lock whose owner is gone, or that is older than
// LOCK_TTL_MS, is reclaimed — a crashed run must not wedge every later one.
function acquireLock(env = process.env, now = Date.now()) {
  const file = lockPath(env);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* exists */ }
  const payload = JSON.stringify({ pid: process.pid, startedAt: now });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx', mode: 0o600 });
      return { ok: true, file };
    } catch (error) {
      if (error.code !== 'EEXIST') return { ok: false, reason: 'lock-error' };
    }
    let held = {};
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable = stale */ }
    const fresh = Number(held.startedAt) > 0 && now - Number(held.startedAt) < LOCK_TTL_MS;
    if (fresh && pidAlive(held.pid)) return { ok: false, reason: 'locked', pid: held.pid };
    try { fs.unlinkSync(file); } catch { /* someone else reclaimed it first */ }
  }
  return { ok: false, reason: 'locked' };
}

function releaseLock(lock) {
  if (!lock || !lock.ok) return;
  try { fs.unlinkSync(lock.file); } catch { /* already gone */ }
}

// The work order proposed gating on "index.ndjson unchanged since the last
// import". That test is inverted for this caller: the badge fires precisely
// BECAUSE the index has stopped growing, so the gate would suppress every run
// that mattered. A plain time throttle is used instead, and the index mtime is
// recorded for diagnosis only.
async function importOnce(opts = {}) {
  const env = opts.env || process.env;
  const now = Number(opts.now) || Date.now();
  const state = readState(env);

  if (!opts.force) {
    const since = now - (Number(state.lastRunAt) || 0);
    const wait = minIntervalMs(env);
    if (since < wait) {
      return { ok: true, ran: false, reason: 'throttled', retryInMs: wait - since };
    }
  }

  const lock = acquireLock(env, now);
  if (!lock.ok) {
    // 'locked' is a benign skip — somebody else is already doing the work. Any
    // other lock failure (an unwritable CCXRAY_HOME, a bad mount) is a real
    // failure and must not be reported as ok: this runs detached with nobody
    // reading stdout, so an ok/0 here is a silent death that looks like a skip.
    const benign = lock.reason === 'locked';
    if (!benign) writeState({ ...state, lastRunAt: now, lastError: `lock: ${lock.reason}` }, env);
    return { ok: benign, ran: false, reason: lock.reason, pid: lock.pid || null };
  }

  // Guard the derived view the hub owns; see the INVARIANT on session-index
  // flush(). Set before the importer is required so nothing can flush early.
  process.env.CCXRAY_SESSION_INDEX_NO_FLUSH = '1';

  // A detached child nobody is waiting on must be bounded, or a scan that wedges
  // on one pathological home becomes an orphan holding the lock until its TTL.
  // unref'd, so it can only fire while something else is still keeping the loop
  // alive — it cannot by itself delay a clean exit (ADR 0015 R1).
  const watchdog = setTimeout(() => {
    releaseLock(lock);
    writeState({ ...state, lastRunAt: now, lastError: 'watchdog: scan exceeded LOCK_TTL_MS' }, env);
    process.exit(1);
  }, LOCK_TTL_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  let result;
  try {
    // scanAndImport appends straight to index.ndjson and assumes the log dir is
    // already there — the server calls init() at startup. Without this, every
    // append throws ENOENT into the importer's catch and the run reports turns
    // it imported nowhere.
    await require('./config').storage.init();
    const { scanAndImport } = require('./importer');
    result = await scanAndImport();
  } catch (error) {
    clearTimeout(watchdog);
    releaseLock(lock);
    // Record the failure rather than dying quietly: this runs detached with no
    // stdout anyone reads, so the state file is the only place a silent death
    // can surface.
    writeState({ ...state, lastRunAt: now, lastError: String(error && error.message || error) }, env);
    return { ok: false, ran: true, error: String(error && error.message || error) };
  }
  clearTimeout(watchdog);
  releaseLock(lock);

  let indexMtimeMs = null;
  try {
    indexMtimeMs = fs.statSync(path.join(ccxrayHome(env), 'logs', 'index.ndjson')).mtimeMs;
  } catch { /* no index yet */ }

  writeState({
    lastRunAt: now,
    lastImported: result ? result.imported : 0,
    lastSkipped: result ? result.skipped : 0,
    indexMtimeMs,
    lastError: null,
  }, env);

  // `ran` distinguishes "did the work, found nothing" from "declined to run".
  // scanAndImport's own `skipped` is a FILE count, so it may not share a key with
  // the gate's reason — conflating them made a successful run read as a skip.
  return {
    ok: true,
    ran: true,
    imported: result ? result.imported : 0,
    filesSkipped: result ? result.skipped : 0,
  };
}

module.exports = { importOnce, acquireLock, releaseLock, statePath, lockPath, pidAlive, LOCK_TTL_MS };
