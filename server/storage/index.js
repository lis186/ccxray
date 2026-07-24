'use strict';

const path = require('path');
const { createLocalStorage } = require('./local');

// Old package-relative logs/ location (<repo>/logs). The local adapter migrates
// from here into the resolved logs dir on first init(). Resolved here — at the
// single point where the local adapter is constructed — so it never runs at
// config-import time and never applies to non-local backends (e.g. S3/R2).
const LEGACY_LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

// Wraps a storage adapter so every async write is tracked in an in-flight Set.
// drain() awaits all pending writes — used on shutdown so process.exit doesn't
// kill the event loop while fs.writeFile is mid-flight, leaving 0-byte files.
// Loops until the set is empty in case a tracked promise spawns another write.
function withWriteTracking(adapter) {
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    const cleanup = () => pending.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  };
  // #344: exclusive index lock. While pruneLogs rewrites index.ndjson it holds
  // exclusivity; appendIndex() awaits it so a concurrent append can never land
  // between the rewrite's read and its atomic rename (which would drop the line).
  // Order at the prune site: beginExclusive() (new appends start queuing) →
  // drain() (flush appends already dispatched to the fs threadpool) → rewrite →
  // release(). This closes the intra-process race that a stat-based CAS cannot
  // (fs.appendFile writes on the libuv threadpool, truly concurrent with a
  // synchronous rename). Cross-process writers to a shared index are out of
  // scope (the #333 multi-instance case), same as the file-delete pass.
  let exclusive = null;
  const awaitExclusive = async () => { while (exclusive) await exclusive; };
  return {
    ...adapter,
    write: (id, suffix, data) => track(adapter.write(id, suffix, data)),
    // Fast path (no lock held — the overwhelming common case): dispatch AND
    // track synchronously, so `appendIndex(); await drain()` sees the write in
    // `pending` (an unconditional async await would delay track() past a drain).
    // Locked path (only while pruneLogs rewrites): park until release, THEN
    // track the write. track() is never on the gate-wait itself — otherwise
    // prune's own drain() (right after beginExclusive) would await an append
    // parked on the gate it holds → deadlock. The trade: a parked append isn't
    // in `pending`, so a shutdown landing inside the brief startup-prune window
    // won't drain it — rare, and the turn's _req/_res are still on disk
    // (recoverable via `ccxray rebuild-index`).
    appendIndex: (line) => {
      if (!exclusive) return track(adapter.appendIndex(line));
      return (async () => { await awaitExclusive(); return track(adapter.appendIndex(line)); })();
    },
    writeSharedIfAbsent: (filename, data) => track(adapter.writeSharedIfAbsent(filename, data)),
    deleteFile: (filename) => track(adapter.deleteFile(filename)),
    // Acquire exclusive index access; returns a release fn. Caller MUST release
    // (finally) or appends deadlock. Single-holder by contract (only pruneLogs).
    beginExclusive: () => {
      let release;
      const p = new Promise((res) => { release = res; });
      exclusive = p;
      return () => { if (exclusive === p) exclusive = null; release(); };
    },
    drain: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}

/**
 * Create the appropriate storage adapter based on STORAGE_BACKEND env var.
 *
 * STORAGE_BACKEND=local (default) — local filesystem
 *
 * A remote object-storage backend (S3/R2) is not supported yet. The adapter in
 * ./s3.js is incomplete (missing index/shared methods) and sending logs
 * off-machine has unresolved security considerations, so selecting it fails
 * fast at startup rather than starting a misconfigured proxy.
 *
 * @returns {import('./interface').StorageAdapter}
 */
function createStorage() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

  let adapter;
  switch (backend) {
    case 's3': {
      throw new Error(
        'STORAGE_BACKEND=s3 is not supported yet. ccxray stores logs on the ' +
        'local filesystem only. Omit STORAGE_BACKEND or set it to "local".'
      );
    }
    case 'local':
    default: {
      const { resolveLogsDir } = require('../paths');
      adapter = createLocalStorage(resolveLogsDir(), { legacyDir: LEGACY_LOGS_DIR });
      break;
    }
  }
  return withWriteTracking(adapter);
}

module.exports = { createStorage };
