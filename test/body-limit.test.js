'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Use a very small cap (1 byte past zero) for testing
const TEST_MAX_BYTES = 100;

// Minimal server that replicates index.js body-collection + size check logic
function makeServer(maxBodyBytes) {
  return http.createServer((req, res) => {
    const chunks = [];
    let bodySize = 0;
    let rejected = false;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > maxBodyBytes) {
        if (!rejected) {
          rejected = true;
          const mb = Math.round(maxBodyBytes / (1024 * 1024));
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: `Request body exceeds CCXRAY_MAX_BODY_MB (${mb} MB)` } }));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, size: bodySize }));
    });
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Length': data.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('body size cap', () => {
  let server;
  let port;

  before(async () => {
    server = makeServer(TEST_MAX_BYTES);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('returns 413 when body exceeds cap', async () => {
    const oversized = Buffer.alloc(TEST_MAX_BYTES + 1, 'x');
    const result = await post(port, oversized);
    assert.equal(result.status, 413);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'request_too_large');
  });

  it('passes through when body is within cap', async () => {
    const small = Buffer.alloc(TEST_MAX_BYTES, 'y');
    const result = await post(port, small);
    assert.equal(result.status, 200);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.size, TEST_MAX_BYTES);
  });
});
