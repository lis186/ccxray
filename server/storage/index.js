'use strict';

const { createLocalStorage } = require('./local');

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
  return {
    ...adapter,
    write: (id, suffix, data) => track(adapter.write(id, suffix, data)),
    appendIndex: (line) => track(adapter.appendIndex(line)),
    writeSharedIfAbsent: (filename, data) => track(adapter.writeSharedIfAbsent(filename, data)),
    deleteFile: (filename) => track(adapter.deleteFile(filename)),
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
 * STORAGE_BACKEND=s3 — S3/R2 (requires @aws-sdk/client-s3)
 *
 * @returns {import('./interface').StorageAdapter}
 */
function createStorage() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

  let adapter;
  switch (backend) {
    case 's3': {
      const { createS3Storage } = require('./s3');
      adapter = createS3Storage({
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        prefix: process.env.S3_PREFIX || 'logs/',
      });
      break;
    }
    case 'local':
    default: {
      const { resolveLogsDir } = require('../paths');
      adapter = createLocalStorage(resolveLogsDir());
      break;
    }
  }
  return withWriteTracking(adapter);
}

module.exports = { createStorage };
