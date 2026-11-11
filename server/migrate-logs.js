'use strict';

// `ccxray migrate-logs` — one-way conversion of existing plain-JSON log files
// (`_req.json`, `_res.json`, `_req.received.json`, shared/*.json) to gzip (#776).
//
// New writes are already gzip (server/storage/gzip.js); this command is for the
// files written before that. Filenames never change and readers sniff the magic
// bytes, so a half-migrated home is fully readable and the run is resumable —
// an already-gzip file is simply skipped.
//
// Per file: gzip → gunzip → byte-compare with the original → write tmp →
// (re-stat the original) → rename. The re-stat + rename are synchronous with no
// await between them (ADR 0021's CAS shape): a file that a server rewrote or
// retention-pruned while we compressed it is left alone instead of being
// clobbered or resurrected. The original mtime is carried over to the new file
// because `statShared().mtime` is the "first seen" date shown for shared files.
//
// Safe beside a live hub: files younger than MIN_AGE_MS are skipped (the
// intercept-edit path rewrites a _req.json within seconds of creation), and the
// rename is atomic for concurrent readers.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { acquireMaintenanceLock, releaseMaintenanceLock } = require('./rebuild-index');
const { isGzip, gzipAsync, gunzipAsync, GZIP_LEVEL } = require('./storage/gzip');

const MIN_AGE_MS = 10 * 60 * 1000;
const RESERVE_BYTES = 1024 ** 3;
const LOG_FILE_RE = /_(?:req\.received|req|res)\.json$/;
const TMP_SUFFIX = '.migrate-tmp';

function defaultFreeBytes(dir) {
  // statfsSync is Node >= 18.15; on older runtimes the pause rule cannot be
  // evaluated, so it is skipped rather than guessed.
  if (typeof fs.statfsSync !== 'function') return Infinity;
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

const fmt = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} B`;
};

async function collectCandidates(storage, dir) {
  const out = [];
  const add = async (names, baseDir) => {
    for (const name of names) {
      const file = path.join(baseDir, name);
      let st;
      try { st = await fsp.lstat(file); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ file, dir: baseDir, name, size: st.size, st });
    }
  };
  await add((await storage.list()).filter(n => LOG_FILE_RE.test(n)), dir);
  await add((await storage.listShared()).filter(n => n.endsWith('.json')), path.join(dir, 'shared'));
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

async function migrateLogs({
  apply = false, storage = config.storage, log = console.log,
  minAgeMs = MIN_AGE_MS, reserveBytes = RESERVE_BYTES, freeBytes = defaultFreeBytes, now = Date.now,
} = {}) {
  const dir = storage.location;
  if (!dir || !storage.supportsDelta) {
    log('migrate-logs only supports the local filesystem backend.');
    return { refused: true, reason: 'unsupported-backend' };
  }
  await storage.init();

  const lock = apply ? acquireMaintenanceLock(storage, 'migrate-logs', log) : null;
  if (apply && !lock) return { refused: true, reason: 'maintenance-locked' };

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

      if (apply) {
        const free = freeBytes(dir);
        if (free < reserveBytes + 2 * c.size) {
          r.paused = true;
          log(`Paused: ${fmt(free)} free, need ${fmt(reserveBytes + 2 * c.size)} for ${c.name}. Free some space and re-run to resume.`);
          break;
        }
      }

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

        const tmp = c.file + TMP_SUFFIX;
        await fsp.writeFile(tmp, gz, { mode: c.st.mode & 0o777 });
        // CAS (ADR 0021 shape): re-stat then rename, synchronously.
        let now2;
        try { now2 = fs.statSync(c.file); } catch { now2 = null; }
        if (!now2 || now2.ino !== c.st.ino || now2.size !== c.st.size || now2.mtimeMs !== c.st.mtimeMs) {
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
  if (!apply) log('Nothing was written. Re-run with --apply to convert (one-way; old ccxray builds cannot read converted files).');
  return r;
}

module.exports = { migrateLogs, MIN_AGE_MS, RESERVE_BYTES };
