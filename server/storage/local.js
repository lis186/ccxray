'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { TRASH_PREFIX, linkNoReplace, restoreFile } = require('../shared-trash');

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

  // ── shared/ (#775) ────────────────────────────────────────────────────
  // Write-once. The request path only ever publishes a MISSING final file, with
  // a no-replace link; it never renames over, moves aside or "repairs" an
  // existing file (three review rounds of races came from doing that). A
  // corrupt final is left alone and warned about once; `ccxray gc --apply`
  // repairs it offline. Reads treat an unparseable file as missing.

  // The one place on-disk shared content is decoded; `rel` may be a file in a
  // quarantine dir (`<.gc-trash-…>/<name>`). Everything below validates through it.
  function readSharedRaw(rel) {
    return fsp.readFile(safeJoin(sharedDir, rel), 'utf8');
  }
  // 'valid' (parses) | 'corrupt' (present but unparseable: torn / zero-byte) | 'missing'
  async function checkSharedRel(rel) {
    let text;
    try { text = await readSharedRaw(rel); } catch (e) {
      if (e.code === 'ENOENT') return { state: 'missing' };
      throw e;
    }
    try { JSON.parse(text); return { state: 'valid', text }; } catch { return { state: 'corrupt', text }; }
  }

  // `ccxray gc --apply` quarantines instead of deleting: unreferenced files move
  // to shared/.gc-trash-<UTC ts>/ and are only removed by `gc --purge` after 7
  // days. A read of a missing (or corrupt) name therefore looks there for the
  // newest VALID copy. It restores it — no-replace link/rename via
  // server/shared-trash.js — only when the final is ABSENT; a corrupt final is
  // never overwritten on this path, the quarantine copy is just served. The
  // trash-dir list is cached against shared/'s mtime: a miss costs one stat and
  // the (large) readdir is redone only when shared/ changed — restore probes
  // sys_ then openai_ names, so misses are routine.
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
  async function validTrashCopy(filename) {
    for (const dir of await trashDirs()) {
      const r = await checkSharedRel(`${dir}/${filename}`);
      if (r.state === 'valid') return { dir, text: r.text };
    }
    return null;
  }

  const warnedCorrupt = new Set();
  async function commitShared(filename, data) {
    const p = safeJoin(sharedDir, filename);
    // Plain check: no quarantine lookup, no restore on the write path.
    const { state } = await checkSharedRel(filename);
    if (state === 'corrupt' && !warnedCorrupt.has(filename)) {
      warnedCorrupt.add(filename);
      console.error(`shared/${filename} is corrupt; leaving it untouched (run \`ccxray gc --apply\` to repair)`);
    }
    if (state !== 'missing') { verifiedShared.add(filename); return; }
    // 12-hex nonce: `ccxray gc` recognizes exactly this shape as its own debris.
    const tmp = path.join(sharedDir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}-${path.basename(filename)}`);
    try {
      await fsp.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
      await linkNoReplace(tmp, p); // false = someone else created it first: keep theirs
    } finally {
      await fsp.unlink(tmp).catch(() => {}); // gone already after a rename fallback
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

    // Write-once (#775): publishes only a missing file, atomically, via a
    // no-replace link of a complete tmp file. An existing file — valid or
    // corrupt — is never replaced here. Same-process writers of one name share
    // one in-flight promise (first data wins).
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

    // An unparseable file counts as missing: fall back to the newest valid
    // quarantine copy (restored only if the final is absent).
    async readShared(filename) {
      const r = await checkSharedRel(filename);
      if (r.state === 'valid') return r.text;
      const copy = await validTrashCopy(filename);
      if (!copy) throw Object.assign(new Error(`ENOENT: shared/${filename} is ${r.state}`), { code: 'ENOENT' });
      if (r.state === 'missing') {
        const res = await restoreFile(sharedDir, copy.dir, filename);
        if (res === 'exists') { // a writer got there first — prefer its file if it is good
          const again = await checkSharedRel(filename);
          if (again.state === 'valid') return again.text;
        }
      }
      return copy.text; // corrupt final: served from quarantine, final left untouched
    },

    async statShared(filename) {
      try {
        const p = safeJoin(sharedDir, filename);
        const r = await checkSharedRel(filename);
        if (r.state === 'valid') return await fsp.stat(p);
        const copy = await validTrashCopy(filename);
        if (!copy) return null;
        if (r.state === 'missing' && (await restoreFile(sharedDir, copy.dir, filename)) !== 'missing') return await fsp.stat(p);
        return await fsp.stat(safeJoin(sharedDir, `${copy.dir}/${filename}`));
      } catch { return null; }
    },

    // Side-effect-free validity probe for `ccxray gc`: 'valid' | 'corrupt' |
    // 'missing', for the final file or (with `quarantineDir`) a quarantined copy.
    async checkShared(filename, { quarantineDir } = {}) {
      return (await checkSharedRel(quarantineDir ? `${quarantineDir}/${filename}` : filename)).state;
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
