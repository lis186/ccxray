'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
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

    async writeSharedIfAbsent(filename, data) {
      const p = safeJoin(sharedDir, filename);
      try {
        await fsp.writeFile(p, data, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    },

    async readShared(filename) {
      return fsp.readFile(safeJoin(sharedDir, filename), 'utf8');
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
