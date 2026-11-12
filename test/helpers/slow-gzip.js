'use strict';
// Test-only preload (via NODE_OPTIONS --require): delays zlib.gzip for inputs
// that contain CCXRAY_TEST_SLOW_GZIP_MATCH by CCXRAY_TEST_SLOW_GZIP_MS, to model
// a busy threadpool / huge payload without touching production code (#776).
// Must load before server/storage/gzip.js promisifies zlib.gzip.
const zlib = require('node:zlib');

const ms = Number(process.env.CCXRAY_TEST_SLOW_GZIP_MS || 0);
const match = process.env.CCXRAY_TEST_SLOW_GZIP_MATCH || '';
if (ms > 0) {
  const real = zlib.gzip;
  zlib.gzip = function slowGzip(buf, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const slow = !match || Buffer.from(buf).includes(match);
    if (!slow) return real.call(zlib, buf, opts, cb);
    setTimeout(() => real.call(zlib, buf, opts, cb), ms);
  };
}
