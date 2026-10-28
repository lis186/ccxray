'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-health-capabilities-'));
process.env.CCXRAY_HOME = FIX_HOME;
delete process.env.AUTH_TOKEN;
const identityRoot = Buffer.alloc(32, 0x42);
fs.writeFileSync(path.join(FIX_HOME, 'local-secret'), identityRoot, { mode: 0o600 });

const hub = require('../server/hub');

after(() => {
  fs.rmSync(FIX_HOME, { recursive: true, force: true });
});

describe('health capabilities', () => {
  it('advertises only implemented capabilities', () => {
    const response = {
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };

    assert.equal(hub.handleHubRoutes({ url: '/_api/health', method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.1' } }, response), true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).capabilities, []);
  });
});


describe('health listener identity', () => {
  const health = (challenge, localPort = 12345) => {
    let body;
    const headers = challenge === undefined ? {} : { 'x-ccxray-shim-challenge': challenge };
    const request = { url: '/_api/health', method: 'GET', headers, socket: { remoteAddress: '203.0.113.1', localPort } };
    assert.equal(hub.handleHubRoutes(request, { writeHead() {}, end(value) { body = value; } }), true);
    return body;
  };

  for (const hubPort of [null, 23456]) {
    it(`proves the socket's own port in ${hubPort ? 'hub' : 'standalone'} mode`, () => {
      hub.setHubPort(hubPort);
      try {
        const nonce = 'Aa'.repeat(32);
        const plain = health();
        const challenged = JSON.parse(health(nonce));
        const key = crypto.hkdfSync('sha256', identityRoot, Buffer.alloc(0), Buffer.from('ccxray/v1/shim-identity'), 32);
        const expected = crypto.createHmac('sha256', key).update(`ccxray-shim-identity/v1\n${nonce}\n12345`).digest('base64url');
        assert.equal(challenged.shimProof, expected);
        delete challenged.shimProof;
        assert.equal(JSON.stringify(challenged), plain);
        assert.equal(health(), plain);
        assert.notEqual(JSON.parse(health(nonce, 12346)).shimProof, expected);
      } finally { hub.setHubPort(null); }
    });
  }

  it('ignores malformed challenges without changing the response bytes', () => {
    const plain = health();
    for (const nonce of ['', 'a'.repeat(31), 'a'.repeat(129), 'g'.repeat(64), ' a'.repeat(32), 'a'.repeat(32) + '\n', ['a'.repeat(32)]]) {
      assert.equal(health(nonce), plain);
    }
  });

  it('accepts both challenge length boundaries', () => {
    for (const length of [32, 128]) assert.match(JSON.parse(health('a'.repeat(length))).shimProof, /^[A-Za-z0-9_-]{43}$/);
  });
});
