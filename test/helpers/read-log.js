'use strict';
// Test-only: read a raw log file from disk as text, whether it is plain JSON
// (legacy / CCXRAY_COMPRESS_DISABLE=1) or gzip (default since #776).
const fs = require('node:fs');
const { decodeToStringSync } = require('../../server/storage/gzip');

const readLogText = (file) => decodeToStringSync(fs.readFileSync(file));

// The proxy appends the index line concurrently with the log write, so a test
// that waits on the index can see a missing, empty or still-being-written file.
// Poll until the file parses (gzip's async hop made that window easy to hit).
async function readLogJson(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return JSON.parse(readLogText(file)); } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise(r => setTimeout(r, 20));
    }
  }
}

// Same race for a bare existence check (the file now appears after the gzip hop).
async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  return fs.existsSync(file);
}

module.exports = { readLogText, readLogJson, waitForFile };
