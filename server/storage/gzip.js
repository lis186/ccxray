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

function compressionEnabled(env = process.env) {
  return env.CCXRAY_COMPRESS_DISABLE !== '1';
}

// UTF-8 text can never start with 0x1f 0x8b (0x8b is a continuation byte), and
// JSON starts with `{`/`[`/whitespace, so the sniff cannot misfire on plain files.
function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// Payload as it should hit the disk: gzip Buffer, or the input untouched when
// compression is disabled.
async function encodeForWrite(data) {
  if (!compressionEnabled()) return data;
  return gzipAsync(data, { level: GZIP_LEVEL });
}

async function decodeToString(buf) {
  return (isGzip(buf) ? await gunzipAsync(buf) : buf).toString('utf8');
}

function decodeToStringSync(buf) {
  return (isGzip(buf) ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

module.exports = {
  GZIP_LEVEL, compressionEnabled, isGzip, encodeForWrite, decodeToString, decodeToStringSync,
  gzipAsync, gunzipAsync,
};
