'use strict';

// `ccxray migrate-logs` — one-way conversion of existing plain-JSON log files
// (`_req.json`, `_res.json`, `_req.received.json`, shared/*.json) to gzip (#776).
//
// New writes are already gzip (server/storage/gzip.js); this command is for the
// files written before that. Filenames never change and readers sniff the magic
// bytes, so a half-migrated home is fully readable and the run is resumable —
// an already-gzip file is simply skipped.
//
// Per file: gzip → gunzip → byte-compare with the original → write tmp (mode
// fchmod'ed to the original's) → re-stat the original → rename. The re-stat and
// rename are synchronous with no await between them (ADR 0021's CAS shape,
// fingerprint dev+ino+size+mtime), and the original mtime is carried over
// because `statShared().mtime` is the "first seen" date shown for shared files.
//
// Writer coordination (--apply only):
//   • refuses while a ccxray server is live (hub lock, a ccxray on the default
//     port, or a recent index write — standalone `--port` servers write no lock);
//   • holds the ADR 0021 maintenance lock, which startup `pruneLogs` honors, so a
//     server started mid-run cannot prune or re-anchor concurrently;
//   • skips files younger than MIN_AGE_MS.
// Dry-run is read-only: it never calls storage.init() (which can mkdir / move
// legacy logs) and takes no lock.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const hub = require('./hub');
const { acquireMaintenanceLock, releaseMaintenanceLock } = require('./maintenance-lock');
const { liveHubBlocking, indexWasRecentlyWritten } = require('./rebuild-index');
const { isGzip, gzipAsync, gunzipAsync, GZIP_LEVEL } = require('./storage/gzip');

const MIN_AGE_MS = 10 * 60 * 1000;
const RESERVE_BYTES = 1024 ** 3;
const LOG_FILE_RE = /_(?:req\.received|req|res)\.json$/;
const TMP_SUFFIX = '.migrate-tmp';

// Free bytes for the filesystem holding `dir`, or null when it cannot be
// determined (fs.statfsSync is Node >= 18.15). The caller fails closed on null.
function defaultFreeBytes(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

function sameFingerprint(a, b) {
  return !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function defaultLiveServerCheck({ log }) {
  const lock = liveHubBlocking();
  if (lock) return `a ccxray hub is running (pid ${lock.pid})`;
  const occ = await hub.probePortOccupant(config.PORT, 1000);
  if (occ && (occ.kind === 'ccxray-hub' || occ.kind === 'ccxray-standalone')) {
    return `a ccxray server answers on port ${config.PORT}${occ.pid ? ` (pid ${occ.pid})` : ''}`;
  }
  const indexPath = path.join(config.storage.location || config.LOGS_DIR, 'index.ndjson');
  if (indexWasRecentlyWritten(indexPath, log)) return 'index.ndjson was written in the last minute';
  return null;
}

const fmt = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} B`;
};

async function collectCandidates(storage, dir) {
  const out = [];
  const add = async (list, baseDir, keep) => {
    let names;
    try { names = await list(); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names.filter(keep)) {
      const file = path.join(baseDir, name);
      let st;
      try { st = await fsp.lstat(file); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ file, dir: baseDir, name, size: st.size, st });
    }
  };
  await add(() => storage.list(), dir, n => LOG_FILE_RE.test(n));
  await add(() => storage.listShared(), path.join(dir, 'shared'), n => n.endsWith('.json'));
  return out.sort((a, b) => b.size - a.size); // largest-first: the biggest saving lands before any pause
}

async function removeStaleTmp(dirs) {
  let removed = 0;
  for (const d of dirs) {
    let names;
    try { names = await fsp.readdir(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(TMP_SUFFIX)) continue;
      try { await fsp.unlink(path.join(d, n)); removed++; } catch {}
    }
  }
  return removed;
}

async function writeTmp(tmp, data, mode) {
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode); // the open() mode is masked by the process umask
  } finally { await fh.close(); }
}

async function migrateLogs({
  apply = false, storage = config.storage, log = console.log,
  minAgeMs = MIN_AGE_MS, reserveBytes = RESERVE_BYTES, freeBytes = defaultFreeBytes, now = Date.now,
  liveServerCheck = defaultLiveServerCheck, statSync = fs.statSync,
} = {}) {
  const dir = storage.location;
  if (!dir || !storage.supportsDelta) {
    log('migrate-logs only supports the local filesystem backend.');
    return { refused: true, reason: 'unsupported-backend' };
  }
  if (!fs.existsSync(dir)) {
    log(`No logs directory at ${dir}; nothing to migrate.`);
    return { converted: 0, apply, skippedYoung: 0, skippedGzip: 0, skippedNoGain: 0, changed: 0, failed: 0, paused: false };
  }

  let lock = null;
  if (apply) {
    const live = await liveServerCheck({ log });
    if (live) {
      log(`Refusing to migrate: ${live}. Stop ccxray (see \`ccxray status\`) and retry; --dry-run is always safe.`);
      return { refused: true, reason: 'live-server' };
    }
    // Fail closed: without a free-space reading the pause rule cannot be honored.
    let free0 = null;
    try { free0 = freeBytes(dir); } catch {}
    if (typeof free0 !== 'number' || Number.isNaN(free0)) {
      log('Refusing to migrate: cannot determine free disk space on this platform (needs Node >= 18.15), so the low-space pause cannot be enforced.');
      return { refused: true, reason: 'free-space-unknown' };
    }
    lock = acquireMaintenanceLock(storage, 'migrate-logs', log);
    if (!lock) return { refused: true, reason: 'maintenance-locked' };
  }

  const r = {
    apply, converted: 0, bytesBefore: 0, bytesAfter: 0, projectedBefore: 0, projectedAfter: 0,
    skippedYoung: 0, skippedGzip: 0, skippedNoGain: 0, changed: 0, failed: 0, paused: false,
  };
  try {
    if (apply) {
      const stale = await removeStaleTmp([dir, path.join(dir, 'shared')]);
      if (stale) log(`Removed ${stale} stale ${TMP_SUFFIX} file(s) from an interrupted run.`);
    }
    const candidates = await collectCandidates(storage, dir);
    log(`${apply ? 'Migrating' : 'Dry run:'} ${candidates.length} log file(s) in ${dir}`);

    for (const c of candidates) {
      if (now() - c.st.mtimeMs < minAgeMs) { r.skippedYoung++; continue; }

      try {
        const orig = await fsp.readFile(c.file);
        if (isGzip(orig)) { r.skippedGzip++; continue; }
        const gz = await gzipAsync(orig, { level: GZIP_LEVEL });
        if (!(await gunzipAsync(gz)).equals(orig)) throw new Error('round-trip mismatch');
        if (gz.length >= orig.length) { r.skippedNoGain++; continue; }

        if (!apply) {
          r.converted++; r.projectedBefore += orig.length; r.projectedAfter += gz.length;
          continue;
        }

        // The temp file is the only extra space needed (the original is replaced
        // by rename), so the check uses the actual compressed size.
        const need = reserveBytes + gz.length;
        const free = freeBytes(dir);
        if (typeof free !== 'number' || free < need) {
          r.paused = true;
          log(`Paused: ${typeof free === 'number' ? fmt(free) : 'unknown'} free, need ${fmt(need)} for ${c.name}. Free some space and re-run to resume.`);
          break;
        }

        const tmp = c.file + TMP_SUFFIX;
        await writeTmp(tmp, gz, c.st.mode & 0o777);
        // CAS (ADR 0021 shape): re-stat then rename, synchronously.
        let now2;
        try { now2 = statSync(c.file); } catch { now2 = null; }
        if (!sameFingerprint(c.st, now2)) {
          fs.unlinkSync(tmp);
          r.changed++;
          continue;
        }
        fs.utimesSync(tmp, c.st.atime, c.st.mtime);
        fs.renameSync(tmp, c.file);
        r.converted++; r.bytesBefore += orig.length; r.bytesAfter += gz.length;
      } catch (e) {
        r.failed++;
        log(`  skip ${c.name}: ${e.message}`);
        try { fs.unlinkSync(c.file + TMP_SUFFIX); } catch {}
      }
    }
  } finally {
    releaseMaintenanceLock(lock);
  }

  const before = apply ? r.bytesBefore : r.projectedBefore;
  const after = apply ? r.bytesAfter : r.projectedAfter;
  log(`${apply ? 'Converted' : 'Would convert'} ${r.converted} file(s): ${fmt(before)} → ${fmt(after)}` +
    (before ? ` (${((after / before) * 100).toFixed(1)}%)` : ''));
  log(`Skipped: ${r.skippedYoung} younger than ${Math.round(minAgeMs / 60000)} min, ${r.skippedGzip} already gzip, ${r.skippedNoGain} no gain` +
    (apply ? `; ${r.changed} changed during the run, ${r.failed} failed` : ''));
  if (!apply) log('Nothing was written. Re-run with --apply to convert (one-way; older ccxray builds cannot read converted files).');
  return r;
}

module.exports = { migrateLogs, sameFingerprint, MIN_AGE_MS, RESERVE_BYTES };
