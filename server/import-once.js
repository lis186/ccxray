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

// A live owner always holds the lock, however long its scan runs — a full
// ~/.claude* walk can outlast any timeout we would pick, and reclaiming from a
// working importer is exactly the double-import this lock exists to prevent.
// The TTL therefore guards only PID REUSE: a lock this old whose recorded pid is
// now alive almost certainly belongs to an unrelated process.
const LOCK_PID_REUSE_MS = 60 * 60 * 1000;
// Bounds a genuinely wedged scan. Deliberately far above the throttle so a slow
// but working import is never killed mid-append.
const WATCHDOG_MS = 30 * 60 * 1000;
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

// Acquisition is a hardlink, which is atomic: only one process's unique file can
// become `file`, so uncontended and live-holder contention need nothing else.
//
// Reclaiming a DEAD holder's lock is the hard part, and two obvious shapes both
// admit two owners. `wx`-else-unlink-and-retry lets the second unlink remove the
// first racer's fresh lock. Adding an inode check before the unlink only narrows
// it: `stat` and `unlink` are separate syscalls, so R1 can stat the stale inode,
// R2 can replace it with its own live lock in between, and R1's unlink then
// removes R2's. Measured — an 8-racer test found two owners in round 2.
//
// So the takedown itself is serialized by a second hardlink. Only the process
// holding `.reclaim` may delete a lock, and it re-reads the holder while holding
// it, so a holder that became live in the meantime is left alone.
//
// Residual, accepted: a process that dies between taking `.reclaim` and
// releasing it leaves it behind, and the staleness bound that clears it is
// itself check-then-act. A reclaim is a handful of syscalls, so the window is
// microseconds against a bound of RECLAIM_STALE_MS, and the consequence of
// getting it wrong is the original race — not a new failure mode.
const RECLAIM_STALE_MS = 60 * 1000;

function lockPayload(now) {
  return JSON.stringify({ pid: process.pid, startedAt: now });
}

// Atomic create-if-absent. `link` fails with EEXIST rather than truncating, and
// ownership is confirmed by inode identity rather than by the call not throwing.
function tryClaim(target, payload, suffix) {
  const unique = `${target}.${process.pid}.${suffix}`;
  try {
    fs.writeFileSync(unique, payload, { mode: 0o600 });
  } catch {
    return 'error';
  }
  try { fs.linkSync(unique, target); } catch (error) {
    if (error.code !== 'EEXIST') {
      try { fs.unlinkSync(unique); } catch { /* nothing to clean */ }
      return 'error';
    }
  }
  let owned = false;
  try { owned = fs.statSync(target).ino === fs.statSync(unique).ino; } catch { /* not ours */ }
  try { fs.unlinkSync(unique); } catch { /* already gone */ }
  return owned ? 'claimed' : 'taken';
}

function readHolder(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
}

// A live owner is never displaced by age alone; the age bound exists only so a
// lock whose pid has plausibly been recycled cannot wedge every later run.
function holderHolds(held, now) {
  if (!held) return false;
  const startedAt = Number(held.startedAt) || 0;
  const recycled = startedAt > 0 && now - startedAt >= LOCK_PID_REUSE_MS;
  return pidAlive(held.pid) && !recycled;
}

function acquireLock(env = process.env, now = Date.now()) {
  const file = lockPath(env);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* exists */ }
  const payload = lockPayload(now);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = tryClaim(file, payload, `l${attempt}`);
    if (claim === 'claimed') return { ok: true, file };
    if (claim === 'error') return { ok: false, reason: 'lock-error' };

    const held = readHolder(file);
    if (holderHolds(held, now)) return { ok: false, reason: 'locked', pid: held.pid };

    const reclaim = `${file}.reclaim`;
    const gotReclaim = tryClaim(reclaim, payload, `r${attempt}`);
    if (gotReclaim === 'error') return { ok: false, reason: 'lock-error' };
    if (gotReclaim === 'taken') {
      const other = readHolder(reclaim);
      const started = Number(other && other.startedAt) || 0;
      if (started > 0 && now - started >= RECLAIM_STALE_MS) {
        try { fs.unlinkSync(reclaim); } catch { /* somebody cleared it first */ }
      }
      continue; // another racer is taking it down; look again
    }
    try {
      // Re-read under the reclaim lock: the holder may have been replaced by a
      // live one while we were deciding, and that one must not be deleted.
      if (!holderHolds(readHolder(file), now)) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    } finally {
      try { fs.unlinkSync(reclaim); } catch { /* already gone */ }
    }
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

  // Past this point the work is delegated to modules that read process.env
  // directly and cache from it: importer.js's discoverHomes() reads
  // process.env.CCXRAY_IMPORT_HOMES, and config.LOGS_DIR is fixed at first
  // require. An injected env cannot reach them, so honouring one here would scan
  // the wrong homes, write the wrong logs, and leave the flush guard set on a
  // process that never asked for it. The gates above are env-injectable on
  // purpose (that is what the in-process tests exercise); the scan is not.
  if (env !== process.env) {
    releaseLock(lock);
    return { ok: false, ran: false, reason: 'env-not-supported' };
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
    writeState({ ...state, lastRunAt: now, lastError: 'watchdog: scan exceeded WATCHDOG_MS' }, env);
    process.exit(1);
  }, WATCHDOG_MS);
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

module.exports = {
  importOnce, acquireLock, releaseLock, statePath, lockPath, pidAlive,
  LOCK_PID_REUSE_MS, WATCHDOG_MS,
};
