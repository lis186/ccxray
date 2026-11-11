'use strict';

// #776 (codex r1): compression is bounded (MAX_CONCURRENT jobs) and flips to plain
// at shutdown. zlib.gzip is wrapped BEFORE the module under test loads, because it
// promisifies the function once at require time.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

let active = 0, peak = 0, started = 0, delayMs = 40;
const realGzip = zlib.gzip;
zlib.gzip = function wrapped(buf, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  started++; active++; peak = Math.max(peak, active);
  setTimeout(() => realGzip.call(zlib, buf, opts, (err, out) => { active--; cb(err, out); }), delayMs);
};
const gz = require('../server/storage/gzip');

beforeEach(() => { gz.resetForTests(); active = peak = started = 0; delayMs = 40; });

describe('bounded compression (#776)', () => {
  it('never runs more than MAX_CONCURRENT gzip jobs at once, and still compresses everything', async () => {
    const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => gz.encodeForWrite('payload-' + i + 'x'.repeat(100))));
    assert.ok(peak <= gz.MAX_CONCURRENT, `peak ${peak} <= ${gz.MAX_CONCURRENT}`);
    assert.equal(peak, gz.MAX_CONCURRENT, 'the bound is actually reached');
    assert.equal(started, 10);
    outs.forEach((o, i) => assert.ok(gz.isGzip(o) && zlib.gunzipSync(o).toString().startsWith('payload-' + i)));
  });

  it('after beginShutdown, queued and in-flight writes come back plain (no gzip wait)', async () => {
    delayMs = 5000; // far longer than the test: a gzip wait would time the test out
    const inputs = Array.from({ length: 6 }, (_, i) => 'queued-' + i);
    const pending = inputs.map(d => gz.encodeForWrite(d));
    await new Promise(r => setTimeout(r, 20)); // 2 in flight, 4 queued
    assert.equal(started, gz.MAX_CONCURRENT);
    const t0 = Date.now();
    gz.beginShutdown();
    const outs = await Promise.all(pending);
    assert.ok(Date.now() - t0 < 1000, 'resolved promptly, not after the slow compressor');
    assert.deepEqual(outs, inputs, 'all six written plain');
    assert.equal(await gz.encodeForWrite('late'), 'late', 'writes after shutdown are plain');
    assert.equal(started, gz.MAX_CONCURRENT, 'no new gzip job started after shutdown');
  });
});
