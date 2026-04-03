'use strict';

const { createLocalStorage } = require('./local');

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

  switch (backend) {
    case 's3': {
      const { createS3Storage } = require('./s3');
      return createS3Storage({
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        prefix: process.env.S3_PREFIX || 'logs/',
      });
    }
    case 'local':
    default: {
      const path = require('path');
      const logsDir = process.env.LOGS_DIR || path.join(__dirname, '..', '..', 'logs');
      return createLocalStorage(logsDir);
    }
  }
}

module.exports = { createStorage };
