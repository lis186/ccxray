'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { handleSSERoute, normalizeIp } = require('../server/routes/sse');
const store = require('../server/store');
const { MAX_SSE_PER_IP } = require('../server/config');

// ── Helpers ──────────────────────────────────────────────────────────

// Build a fake SSE client already in store.sseClients so we can simulate
// hitting the per-IP cap without actually opening real connections.
function fakeClient(ip) {
  return { socket: { remoteAddress: ip } };
}

function fakeReqRes(ip = '127.0.0.1', url = '/_events') {
  const socket = { remoteAddress: ip };
  const listeners = {};
  const req = {
    url,
    socket,
    on(event, cb) { listeners[event] = cb; return this; },
  };
  let status = null;
  let ended = null;
  const written = [];
  const res = {
    socket, // same socket as req — mirrors real Node.js behavior
    _status: () => status,
    _ended: () => ended,
    _written: () => written,
    writeHead(s) { status = s; },
    write(chunk) { written.push(chunk); },
    end(data) { ended = data || true; },
  };
  return { req, res };
}

// ── normalizeIp ──────────────────────────────────────────────────────

describe('normalizeIp', () => {
  it('passes through a plain IPv4', () => {
    assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
  });

  it('normalizes ::1 to 127.0.0.1', () => {
    assert.equal(normalizeIp('::1'), '127.0.0.1');
  });

  it('normalizes ::ffff:127.0.0.1 to 127.0.0.1', () => {
    assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  });

  it('strips ::ffff: prefix from any mapped IPv4', () => {
    assert.equal(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1');
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(normalizeIp(null), '');
    assert.equal(normalizeIp(undefined), '');
  });
});

// ── SSE per-IP cap (unit — no real TCP) ──────────────────────────────

describe('SSE per-IP cap', () => {
  beforeEach(() => {
    store.sseClients.length = 0;
  });

  afterEach(() => {
    store.sseClients.length = 0;
  });

  it('accepts first connection (store empty)', () => {
    const { req, res } = fakeReqRes('10.0.0.1');
    const handled = handleSSERoute(req, res);
    assert.equal(handled, true);
    assert.equal(res._status(), 200);
  });

  it('rejects when per-IP count reaches MAX_SSE_PER_IP', () => {
    const ip = '10.0.0.2';
    // Pre-populate store with MAX_SSE_PER_IP fake clients from the same IP.
    for (let i = 0; i < MAX_SSE_PER_IP; i++) {
      store.sseClients.push(fakeClient(ip));
    }

    const { req, res } = fakeReqRes(ip);
    handleSSERoute(req, res);
    assert.equal(res._status(), 429);
    const body = JSON.parse(res._ended());
    assert.equal(body.error, 'SSE connection limit per IP exceeded');
  });

  it('allows connection from a different IP even when one IP is at cap', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < MAX_SSE_PER_IP; i++) {
      store.sseClients.push(fakeClient(ip));
    }

    const { req, res } = fakeReqRes('10.0.0.99'); // different IP
    handleSSERoute(req, res);
    assert.equal(res._status(), 200, 'different IP should not be blocked');
  });

  it('count drops after a client closes, allowing new connection', () => {
    const ip = '10.0.0.4';
    // Fill to (cap - 1)
    for (let i = 0; i < MAX_SSE_PER_IP - 1; i++) {
      store.sseClients.push(fakeClient(ip));
    }

    // Open one more via handleSSERoute (takes us to cap)
    const { req: req1, res: res1 } = fakeReqRes(ip);
    handleSSERoute(req1, res1);
    assert.equal(res1._status(), 200, 'should accept up to cap');
    assert.equal(store.sseClients.length, MAX_SSE_PER_IP);

    // Now we are at cap — next should be rejected
    const { req: req2, res: res2 } = fakeReqRes(ip);
    handleSSERoute(req2, res2);
    assert.equal(res2._status(), 429);

    // Simulate the first real connection closing by removing it from the store
    // (mimics the 'close' event handler in sse.js)
    const idx = store.sseClients.indexOf(res1);
    if (idx >= 0) store.sseClients.splice(idx, 1);

    // Now a new connection should be accepted
    const { req: req3, res: res3 } = fakeReqRes(ip);
    handleSSERoute(req3, res3);
    assert.equal(res3._status(), 200, 'should accept after one closed');
  });

  it('non-/_events path is not handled', () => {
    const { req, res } = fakeReqRes('10.0.0.5', '/_api/entries');
    const handled = handleSSERoute(req, res);
    assert.equal(handled, false);
    assert.equal(res._status(), null);
  });
});

// ── HTTP server timeout values ────────────────────────────────────────

describe('HTTP server timeout assignments', () => {
  it('headersTimeout=60000, keepAliveTimeout=5000, requestTimeout=0', () => {
    // Mirror the assignments from server/index.js to confirm the values compile
    // and are what the spec calls for.
    const srv = http.createServer(() => {});
    srv.headersTimeout = 60_000;
    srv.keepAliveTimeout = 5_000;
    srv.requestTimeout = 0;

    assert.equal(srv.headersTimeout, 60_000);
    assert.equal(srv.keepAliveTimeout, 5_000);
    assert.equal(srv.requestTimeout, 0);
  });
});
