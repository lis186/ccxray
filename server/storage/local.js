'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

/**
 * Local filesystem storage adapter.
 * @param {string} logsDir — absolute path to the logs directory
 * @param {object} [opts]
 * @param {string} [opts.legacyDir] — absolute path to a pre-existing
 *   package-relative logs/ directory to migrate from on first init(). When
 *   omitted, no legacy migration is attempted. This logic lives only on the
 *   local adapter, so non-local backends (e.g. S3) never touch the local FS.
 * @returns {import('./interface').StorageAdapter}
 */
function safeJoin(base, filename) {
  if (filename.includes('\0')) throw new Error(`unsafe filename: NUL byte`);
  const resolved = path.resolve(base, filename);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw new Error(`unsafe filename: traversal detected`);
  }
  return resolved;
}

function createLocalStorage(logsDir, opts = {}) {
  const sharedDir = path.join(logsDir, 'shared');
  const indexPath = path.join(logsDir, 'index.ndjson');
  const legacyDir = opts.legacyDir || null;
  // Shared filenames this process has confirmed valid (#775); see writeSharedIfAbsent.
  const verifiedShared = new Set();
  const inflightShared = new Map(); // filename → in-flight write (#775)

  // One-time, best-effort migration from the old package-relative logs/
  // location. Errors are logged and swallowed — a failed migration must never
  // crash startup (mirrors the original catch-and-log behavior).
  async function migrateLegacyLogs() {
    if (!legacyDir) return;
    const legacyIndex = path.join(legacyDir, 'index.ndjson');
    if (!fs.existsSync(legacyIndex)) return;
    try {
      for (const f of await fsp.readdir(legacyDir)) {
        await fsp.rename(path.join(legacyDir, f), path.join(logsDir, f));
      }
      console.log(`Migrated logs from ${legacyDir} → ${logsDir}`);
    } catch (e) {
      console.error(`Log migration failed: ${e.message}`);
    }
  }

  // A shared file counts as present only if it parses; missing, empty and
  // truncated all read as "absent" so the writer replaces them (#775).
  async function sharedFileIsValid(filename) {
    try { JSON.parse(await storage.readShared(filename)); return true; } catch { return false; }
  }

  // `ccxray gc --apply` quarantines instead of deleting (#775): unreferenced
  // files move to shared/.gc-trash-<UTC ts>/ and are only removed by `gc
  // --purge` after 7 days. A read of a missing name therefore looks there first
  // (newest dir first) and moves the file back, so a hash that turns out to be
  // referenced after all is restored transparently. The trash-dir list is cached
  // against shared/'s mtime: a miss costs one stat, and the (large) readdir is
  // redone only when shared/ changed — restore probes sys_ then openai_ names,
  // so misses are routine.
  const TRASH_PREFIX = '.gc-trash-';
  let trashCache = { mtimeMs: -1, dirs: [] };
  async function trashDirs() {
    let st;
    try { st = await fsp.stat(sharedDir); } catch { return []; }
    if (st.mtimeMs !== trashCache.mtimeMs) {
      let names = [];
      try { names = await fsp.readdir(sharedDir); } catch {}
      trashCache = { mtimeMs: st.mtimeMs, dirs: names.filter(n => n.startsWith(TRASH_PREFIX)).sort().reverse() };
    }
    return trashCache.dirs;
  }
  // true when `filename` is (now) present at its final path
  async function restoreFromTrash(filename) {
    const p = safeJoin(sharedDir, filename);
    for (const dir of await trashDirs()) {
      try {
        await fsp.rename(path.join(sharedDir, dir, filename), p);
        return true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        // not in this dir — or another process already restored it
        try { await fsp.access(p); return true; } catch {}
      }
    }
    return false;
  }

  async function commitShared(filename, data) {
    const p = safeJoin(sharedDir, filename);
    if (await sharedFileIsValid(filename)) { verifiedShared.add(filename); return; }
    // 12-hex nonce: `ccxray gc` recognizes exactly this shape as its own debris.
    const tmp = path.join(sharedDir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}-${path.basename(filename)}`);
    try {
      await fsp.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
      try {
        await fsp.link(tmp, p); // atomic no-replace commit of a missing file
      } catch (e) {
        if (e.code === 'EEXIST') {
          // Someone else got there first. Keep a valid file; replace a corrupt
          // one, re-validating right before the rename.
          if (!(await sharedFileIsValid(filename))) await fsp.rename(tmp, p);
        } else if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(e.code)) {
          // Filesystem without hard links: fall back to rename, still guarded
          // by a last-moment validity check (narrow race, content-addressed).
          if (!(await sharedFileIsValid(filename))) await fsp.rename(tmp, p);
        } else {
          throw e;
        }
      }
    } finally {
      await fsp.unlink(tmp).catch(() => {}); // already gone after a rename
    }
    verifiedShared.add(filename);
  }

  const storage = {
    supportsDelta: true,

    // Human-readable destination for the startup banner.
    location: logsDir,

    async init() {
      // Snapshot before mkdir so we migrate only into a freshly-created logs
      // dir — mirrors the original `if (!fs.existsSync(LOGS_DIR))` guard and
      // never clobbers a populated logs dir.
      const logsDirExisted = fs.existsSync(logsDir);
      await fsp.mkdir(logsDir, { recursive: true, mode: 0o700 });
      await fsp.mkdir(sharedDir, { recursive: true, mode: 0o700 });
      if (!logsDirExisted) await migrateLegacyLogs();
    },

    async write(id, suffix, data) {
      await fsp.writeFile(path.join(logsDir, id + suffix), data, { mode: 0o600 });
    },

    async read(id, suffix) {
      return fsp.readFile(path.join(logsDir, id + suffix), 'utf8');
    },

    async list() {
      return fsp.readdir(logsDir);
    },

    async stat(id, suffix) {
      return fsp.stat(path.join(logsDir, id + suffix));
    },

    async deleteFile(filename) {
      try {
        await fsp.unlink(path.join(logsDir, filename));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },

    // ── Index (index.ndjson) ──────────────────────────────────────────

    async appendIndex(line) {
      await fsp.appendFile(indexPath, line, { mode: 0o600 });
    },

    async readIndex() {
      try {
        return await fsp.readFile(indexPath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
      }
    },

    // Streaming line iterator over index.ndjson. Blank lines are skipped. Safe
    // for indexes past Node's ~512MB single-string limit (#345) — readIndex()
    // throws ERR_STRING_TOO_LONG there; this never materializes the whole file.
    // Missing file → empty iteration.
    readIndexLines() {
      const p = indexPath;
      return (async function* () {
        // Open directly (no existsSync → no TOCTOU): a missing file surfaces as
        // an ENOENT 'error' on the stream, which we swallow to honor the
        // "missing index → empty iteration" contract. Other read errors propagate.
        const input = fs.createReadStream(p, { encoding: 'utf8' });
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of rl) if (line) yield line;
        } catch (e) {
          if (!e || e.code !== 'ENOENT') throw e;
        } finally {
          // Close BOTH: rl.close() alone leaves the underlying fd open when a
          // consumer breaks early (cold-load returns mid-iteration) → fd leak.
          rl.close();
          input.destroy();
        }
      })();
    },

    // ── Shared content-addressed storage (shared/) ───────────────────

    // Atomic + no-clobber (#775). Content goes to a unique tmp file in shared/;
    // a MISSING final file is committed with `link(tmp, final)`, which fails
    // with EEXIST instead of replacing, so two writers that both saw "missing"
    // can never overwrite each other's valid file (openai_prompt_meta_<h> may
    // legitimately differ for identical instructions). Only a final file that
    // fails to parse (torn write: zero-byte/truncated) is replaced, via rename,
    // after re-validating it immediately before — before #775 the `wx` write
    // skipped on EEXIST, so a torn file stayed corrupt forever. Validation goes
    // through readShared so it follows whatever on-disk encoding that path
    // decodes. Same-process writers of one name share a single in-flight
    // promise (first data wins, like no-clobber). Residual: two PROCESSES
    // repairing the same corrupt file can still race between the re-validation
    // and the rename; the content is hash-addressed, so the loser rewrites an
    // equivalent file.
    writeSharedIfAbsent(filename, data) {
      safeJoin(sharedDir, filename);
      // Hot path (every request): a hash already verified or written by this
      // process is not re-read. Safe — content-addressed, and gc is offline.
      if (verifiedShared.has(filename)) return Promise.resolve();
      let inflight = inflightShared.get(filename);
      if (!inflight) {
        inflight = commitShared(filename, data).finally(() => inflightShared.delete(filename));
        inflightShared.set(filename, inflight);
      }
      return inflight;
    },

    async readShared(filename) {
      const p = safeJoin(sharedDir, filename);
      try {
        return await fsp.readFile(p, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT' || !(await restoreFromTrash(filename))) throw e;
        return fsp.readFile(p, 'utf8');
      }
    },

    async statShared(filename) {
      const p = safeJoin(sharedDir, filename);
      try {
        return await fsp.stat(p);
      } catch (e) {
        if (e.code !== 'ENOENT') return null;
        try { return (await restoreFromTrash(filename)) ? await fsp.stat(p) : null; } catch { return null; }
      }
    },

    // Quarantine dirs (.gc-trash-*) are not shared files: omitted here so every
    // consumer sees only real entries (gc reads the trash dirs directly).
    async listShared() {
      try {
        return (await fsp.readdir(sharedDir)).filter(n => !n.startsWith(TRASH_PREFIX));
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
  return storage;
}

module.exports = { createLocalStorage };
