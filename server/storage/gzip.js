'use strict';

// Transparent gzip for log artifacts (#776). Filenames never change; a reader
// recognizes a compressed file by its magic bytes, so plain-JSON files written
// by older builds (or with CCXRAY_COMPRESS_DISABLE=1) stay readable forever.
//
// INVARIANT (#776 D2): the proxy hot path only uses the async zlib calls below.
// gzipSync/gunzipSync would block the event loop for the full body (multi-MB
// _req files); the Sync helper exists for CLI/scripts that already run off it.

const zlib = require('zlib');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const GZIP_LEVEL = 6;

// Bound compression (#776 codex r1). Every write used to start its own whole-buffer
// gzip, so a burst of large bodies (up to CCXRAY_MAX_BODY_MB each) put every input
// plus its output in flight at once. At most MAX_CONCURRENT jobs run; the rest wait
// in a FIFO. (The payload strings are already in memory; this bounds the zlib
// working set and the extra compressed copy, not the inputs.)
const MAX_CONCURRENT = 2;
let active = 0;
const waiters = [];

// Shutdown flips writes to plain: gracefulExit has a hard deadline, and a gzip that
// has not reached writeFile by then leaves an indexed entry with no payload. Readers
// accept plain files, so correctness is unaffected; only the size saving is lost.
let shuttingDown = false;
let signalShutdown;
const shutdownSignal = new Promise(resolve => { signalShutdown = resolve; });

function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(true); }
  return new Promise(resolve => waiters.push(resolve)); // resolves true = slot handed over, false = shutdown
}

function release() {
  const next = waiters.shift();
  if (next) next(true); else active--;
}

function beginShutdown() {
  shuttingDown = true;
  signalShutdown();
  for (const w of waiters.splice(0)) w(false);
}

function compressionEnabled(env = process.env) {
  return env.CCXRAY_COMPRESS_DISABLE !== '1';
}

// UTF-8 text can never start with 0x1f 0x8b (0x8b is a continuation byte), and
// JSON starts with `{`/`[`/whitespace, so the sniff cannot misfire on plain files.
function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// Payload as it should hit the disk: gzip Buffer, or the input untouched when
// compression is disabled or shutdown has begun.
async function encodeForWrite(data) {
  if (!compressionEnabled() || shuttingDown) return data;
  if (!(await acquire())) return data;
  try {
    if (shuttingDown) return data;
    const gz = gzipAsync(data, { level: GZIP_LEVEL });
    gz.catch(() => {}); // the loser of the race below must not become an unhandled rejection
    // A shutdown that arrives mid-gzip abandons the job and writes the input plain.
    return await Promise.race([gz, shutdownSignal.then(() => data)]);
  } finally { release(); }
}

async function decodeToString(buf) {
  return (isGzip(buf) ? await gunzipAsync(buf) : buf).toString('utf8');
}

function decodeToStringSync(buf) {
  return (isGzip(buf) ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

// Test-only: shutdown state is process-global by design.
function resetForTests() {
  shuttingDown = false; active = 0; waiters.length = 0;
}

module.exports = {
  MAX_CONCURRENT, beginShutdown, resetForTests, GZIP_LEVEL, compressionEnabled, isGzip, encodeForWrite, decodeToString, decodeToStringSync,
  gzipAsync, gunzipAsync,
};
