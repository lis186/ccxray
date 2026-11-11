'use strict';
// Test-only: read a raw log file from disk as text, whether it is plain JSON
// (legacy / CCXRAY_COMPRESS_DISABLE=1) or gzip (default since #776).
const fs = require('node:fs');
const { decodeToStringSync } = require('../../server/storage/gzip');

module.exports = { readLogText: (file) => decodeToStringSync(fs.readFileSync(file)) };
