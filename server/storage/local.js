'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { encodeForWrite, decodeToString, isGzip } = require('./gzip');

// Partial inflate for readHead (#774 x #776): never throws on truncated input.
function gunzipPrefix(buf) {
  return new Promise((resolve) => {
    zlib.gunzip(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (err, out) => resolve(err ? Buffer.alloc(0) : out));
  });
}

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

  return {
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
      // #776: gzip unless CCXRAY_COMPRESS_DISABLE=1; read() sniffs by magic bytes.
      await fsp.writeFile(path.join(logsDir, id + suffix), await encodeForWrite(data), { mode: 0o600 });
    },

    async read(id, suffix) {
      return decodeToString(await fsp.readFile(path.join(logsDir, id + suffix)));
    },

    // First `bytes` bytes of an artifact as UTF-8 (a multi-byte char cut at the
    // boundary decodes to U+FFFD — harmless for substring probes). Optional on
    // the adapter interface; callers fall back to read() when absent (#774).
    async readHead(id, suffix, bytes) {
      const fh = await fsp.open(path.join(logsDir, id + suffix), 'r');
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        if (!isGzip(buf.subarray(0, bytesRead))) return buf.toString('utf8', 0, bytesRead);
        // #774 x #776: a gzip file's head is compressed bytes. Inflate a bounded
        // prefix of the compressed stream (Z_SYNC_FLUSH tolerates the truncated
        // input) and return the first `bytes` decoded bytes. JSON compresses well
        // over 4x, so 4x the window of compressed input covers the decoded head;
        // a shorter result only makes the caller fall back to a full read.
        const zbuf = Buffer.alloc(bytes * 4);
        const z = await fh.read(zbuf, 0, zbuf.length, 0);
        let out = await gunzipPrefix(zbuf.subarray(0, z.bytesRead));
        // A failed partial inflate must never look like an empty (0-byte) file —
        // callers skip empty heads — so fall back to decoding the whole file.
        if (out.length === 0) out = Buffer.from(await decodeToString(await fsp.readFile(path.join(logsDir, id + suffix))), 'utf8');
        return out.toString('utf8', 0, Math.min(bytes, out.length));
      } finally {
        await fh.close();
      }
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

    async writeSharedIfAbsent(filename, data) {
      const p = safeJoin(sharedDir, filename);
      const payload = await encodeForWrite(data); // #776
      try {
        await fsp.writeFile(p, payload, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    },

    async readShared(filename) {
      // #776: the single sniff choke point for shared files (plain or gzip).
      return decodeToString(await fsp.readFile(safeJoin(sharedDir, filename)));
    },

    async statShared(filename) {
      try {
        return await fsp.stat(safeJoin(sharedDir, filename));
      } catch { return null; }
    },

    async listShared() {
      try {
        return await fsp.readdir(sharedDir);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}

module.exports = { createLocalStorage };
