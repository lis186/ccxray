'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// hub.js resolves CCXRAY_HOME at load; keep it on a throwaway directory.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-listen-'));
const originalHome = process.env.CCXRAY_HOME;
const originalProxyHost = process.env.PROXY_HOST;
process.env.CCXRAY_HOME = tmpHome;
delete process.env.PROXY_HOST;

const listen = require('../server/listen');
const hub = require('../server/hub');

after(() => {
  if (originalHome !== undefined) process.env.CCXRAY_HOME = originalHome; else delete process.env.CCXRAY_HOME;
  if (originalProxyHost !== undefined) process.env.PROXY_HOST = originalProxyHost; else delete process.env.PROXY_HOST;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function canListenOn(host) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, host, () => s.close(() => resolve(true)));
  });
}

function closeServer(srv) {
  return new Promise(resolve => {
    if (!srv.listening) return resolve();
    srv.close(() => resolve());
    if (srv.closeAllConnections) srv.closeAllConnections();
  });
}

function get(host, port, route = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: route, agent: false }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

function connectResult(host, port) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = r => { sock.destroy(); resolve(r); };
    sock.once('connect', () => done('connected'));
    sock.once('error', err => done(err.code));
    sock.setTimeout(1000, () => done('timeout'));
  });
}

function makeServer() {
  return http.createServer((req, res) => {
    res.end(JSON.stringify({ remote: req.socket.remoteAddress }));
  });
}

function firstNonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

let hasV6Loopback = false;
before(async () => { hasV6Loopback = await canListenOn('::1'); });

describe('resolveListenHosts', () => {
  it('defaults to 127.0.0.1 with ::1 as an optional extra', () => {
    assert.deepEqual(listen.resolveListenHosts({}), { primary: '127.0.0.1', optional: ['::1'] });
    assert.deepEqual(listen.resolveListenHosts({ PROXY_HOST: '  ' }), { primary: '127.0.0.1', optional: ['::1'] });
  });

  it('PROXY_HOST selects a single listener on that host', () => {
    assert.deepEqual(listen.resolveListenHosts({ PROXY_HOST: '0.0.0.0' }), { primary: '0.0.0.0', optional: [] });
    assert.deepEqual(listen.resolveListenHosts({ PROXY_HOST: '192.0.2.10' }), { primary: '192.0.2.10', optional: [] });
  });

  it('accepts a bracketed IPv6 literal', () => {
    assert.deepEqual(listen.resolveListenHosts({ PROXY_HOST: '[::]' }), { primary: '::', optional: [] });
    assert.deepEqual(listen.resolveListenHosts({ PROXY_HOST: '::' }), { primary: '::', optional: [] });
  });

  it('isSingleInterfaceHost flags one non-loopback address, not wildcards or loopback', () => {
    for (const h of ['192.0.2.10', 'fe80::1', 'myhost.lan']) assert.equal(listen.isSingleInterfaceHost(h), true, h);
    for (const h of ['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost', '', undefined]) assert.equal(listen.isSingleInterfaceHost(h), false, String(h));
  });

  it('isLoopbackHost recognises loopback spellings only', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) assert.equal(listen.isLoopbackHost(h), true, h);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '', undefined]) assert.equal(listen.isLoopbackHost(h), false, String(h));
  });
});

describe('default bind is loopback only', () => {
  it('every listener address is loopback and both families share one port', async () => {
    const srv = makeServer();
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const addrs = listen.listenAddresses(srv);
      assert.ok(addrs.length >= 1);
      for (const a of addrs) {
        assert.ok(listen.isLoopbackHost(a.address), `unexpected bind address ${a.address}`);
        assert.equal(a.port, port);
      }
      assert.equal(addrs[0].address, '127.0.0.1');
      if (hasV6Loopback) assert.deepEqual(addrs.map(a => a.address), ['127.0.0.1', '::1']);
    } finally {
      await closeServer(srv);
    }
  });

  it('requests over 127.0.0.1 and ::1 reach the same handler', async () => {
    const srv = makeServer();
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const v4 = await get('127.0.0.1', port);
      assert.equal(v4.status, 200);
      assert.equal(JSON.parse(v4.body).remote, '127.0.0.1');
      if (hasV6Loopback) {
        const v6 = await get('::1', port);
        assert.equal(v6.status, 200);
        assert.equal(JSON.parse(v6.body).remote, '::1');
      }
    } finally {
      await closeServer(srv);
    }
  });

  it('an upgrade request over ::1 reaches the server upgrade handler', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const srv = makeServer();
    const seen = [];
    srv.on('upgrade', (req, socket) => {
      seen.push(req.socket.remoteAddress);
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '::1', port, path: '/v1/responses', agent: false,
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 101);
      assert.deepEqual(seen, ['::1']);
    } finally {
      await closeServer(srv);
    }
  });

  it('does not cover a non-loopback interface address', async t => {
    const lan = firstNonLoopbackIPv4();
    if (!lan) return t.skip('no non-loopback IPv4 interface on this host');
    const srv = makeServer();
    try {
      const port = await hub.tryListen(srv, 0, 0);
      // Binding the interface address on the same port succeeds only when
      // nothing (e.g. a 0.0.0.0 listener) already covers it. Checked by bind
      // rather than connect so the test needs no non-loopback traffic.
      assert.equal(await canListenOnPort(lan, port), true);
    } finally {
      await closeServer(srv);
    }
  });

  it('close() stops every listener', async () => {
    const srv = makeServer();
    const port = await hub.tryListen(srv, 0, 0);
    await closeServer(srv);
    assert.equal(await connectResult('127.0.0.1', port), 'ECONNREFUSED');
    if (hasV6Loopback) assert.equal(await connectResult('::1', port), 'ECONNREFUSED');
  });
});

describe('PROXY_HOST opt-in', () => {
  it('binds only the given host', async () => {
    process.env.PROXY_HOST = '0.0.0.0';
    const srv = makeServer();
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const addrs = listen.listenAddresses(srv);
      assert.equal(addrs.length, 1);
      assert.equal(addrs[0].address, '0.0.0.0');
      assert.equal((await get('127.0.0.1', port)).status, 200);
      const lan = firstNonLoopbackIPv4();
      // Linux rejects this re-bind; macOS/BSD permits a specific address
      // to bind the same port as a wildcard listener.
      if (lan && process.platform === 'linux') assert.equal(await canListenOnPort(lan, port), false);
    } finally {
      delete process.env.PROXY_HOST;
      await closeServer(srv);
    }
  });

  it('binds a specific loopback address without the ::1 extra', async () => {
    process.env.PROXY_HOST = '127.0.0.1';
    const srv = makeServer();
    try {
      await hub.tryListen(srv, 0, 0);
      assert.deepEqual(listen.listenAddresses(srv).map(a => a.address), ['127.0.0.1']);
    } finally {
      delete process.env.PROXY_HOST;
      await closeServer(srv);
    }
  });
});

describe('port in use on one loopback family', () => {
  it('::1 taken while 127.0.0.1 is free → the whole port counts as in use', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const blocker = net.createServer();
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '::1', resolve); });
    const port = blocker.address().port;
    const srv = makeServer();
    try {
      await assert.rejects(hub.tryListen(srv, port, 0), err => err.code === 'EADDRINUSE');
      assert.equal(srv.listening, false, 'the IPv4 listener must be released');
      assert.equal(await canListenOnPort('127.0.0.1', port), true);
    } finally {
      await closeServer(srv);
      await new Promise(r => blocker.close(() => r()));
    }
  });

  it('port scan moves past a port whose ::1 side is taken', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    // Fixture: a ::1 blocker whose next port is free on both families. An
    // ephemeral port can sit next to a busy one, so retry the allocation.
    let blocker = null;
    let port = 0;
    for (let i = 0; i < 20 && !blocker; i++) {
      const b = net.createServer();
      await new Promise((resolve, reject) => { b.once('error', reject); b.listen(0, '::1', resolve); });
      const p = b.address().port;
      if (p < 65535 && await canListenOnPort('127.0.0.1', p + 1) && await canListenOnPort('::1', p + 1)) {
        blocker = b; port = p;
      } else {
        await new Promise(r => b.close(() => r()));
      }
    }
    if (!blocker) return t.skip('fixture: no free port next to an ephemeral port after 20 tries');
    const srv = makeServer();
    try {
      const got = await hub.tryListen(srv, port, 5);
      assert.ok(got > port && got <= port + 5, `expected a later port, got ${got}`);
      assert.deepEqual(listen.listenAddresses(srv).map(a => [a.address, a.port]), [['127.0.0.1', got], ['::1', got]]);
    } finally {
      await closeServer(srv);
      await new Promise(r => blocker.close(() => r()));
    }
  });

  it('127.0.0.1 taken → EADDRINUSE without a retry budget', async () => {
    const blocker = net.createServer();
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    const port = blocker.address().port;
    const srv = makeServer();
    try {
      await assert.rejects(hub.tryListen(srv, port, 0), err => err.code === 'EADDRINUSE');
      assert.equal(srv.listening, false);
    } finally {
      await closeServer(srv);
      await new Promise(r => blocker.close(() => r()));
    }
  });
});

describe('::1 connections belong to the HTTP server lifecycle', () => {
  function within(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const connections = srv => new Promise((resolve, reject) => srv.getConnections((err, n) => err ? reject(err) : resolve(n)));
  function closeTracked(srv) {
    const state = { done: false, events: [] };
    srv.once('close', () => state.events.push('close-event'));
    state.promise = new Promise(resolve => srv.close(err => { state.done = true; state.events.push('close-cb'); resolve(err); }));
    return state;
  }

  it('an active keep-alive response holds close() until it finishes', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    let release;
    const holding = new Promise(r => { release = r; });
    let arrived;
    const reached = new Promise(r => { arrived = r; });
    const srv = http.createServer(async (req, res) => { arrived(); await holding; res.end('ok'); });
    const agent = new http.Agent({ keepAlive: true });
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const reply = new Promise((resolve, reject) => {
        http.get({ host: '::1', port, path: '/', agent }, res => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => resolve(body));
        }).on('error', reject);
      });
      await within(reached, 2000, 'request reached handler');
      assert.equal(await connections(srv), 1);
      const closing = closeTracked(srv);
      await tick(100);
      assert.equal(closing.done, false, 'close() must wait for the open ::1 response');
      release();
      assert.equal(await within(reply, 2000, 'response'), 'ok');
      srv.closeIdleConnections();
      assert.equal(await within(closing.promise, 2000, 'close completion'), undefined);
      assert.deepEqual(closing.events, ['close-event', 'close-cb']);
      assert.equal(await connections(srv), 0);
    } finally {
      release();
      agent.destroy();
      await closeServer(srv);
    }
  });

  it('a streaming response is counted and ended by closeAllConnections()', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
    });
    try {
      const port = await hub.tryListen(srv, 0, 0);
      const { ended } = await within(new Promise((resolve, reject) => {
        const req = http.get({ host: '::1', port, path: '/events', agent: false }, res => {
          res.once('data', () => resolve({ ended: new Promise(r => res.on('close', r)) }));
        });
        req.on('error', reject);
      }), 2000, 'first event');
      assert.equal(await connections(srv), 1);
      const closing = closeTracked(srv);
      await tick(100);
      assert.equal(closing.done, false, 'close() must wait for the open ::1 stream');
      srv.closeAllConnections();
      await within(ended, 2000, 'client stream end');
      await within(closing.promise, 2000, 'close completion');
      assert.equal(await connections(srv), 0);
    } finally {
      await closeServer(srv);
    }
  });

  it('an upgraded socket holds close() until it is destroyed', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const srv = makeServer();
    let upgraded = null;
    srv.on('upgrade', (req, socket) => {
      upgraded = socket;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let clientSocket = null;
    try {
      const port = await hub.tryListen(srv, 0, 0);
      await within(new Promise((resolve, reject) => {
        const req = http.request({ host: '::1', port, path: '/v1/responses', agent: false,
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
        req.on('upgrade', (res, socket) => { clientSocket = socket; resolve(); });
        req.on('error', reject);
        req.end();
      }), 2000, 'upgrade');
      assert.equal(await connections(srv), 1);
      const closing = closeTracked(srv);
      await tick(100);
      assert.equal(closing.done, false, 'close() must wait for the upgraded ::1 socket');
      upgraded.destroy();
      await within(closing.promise, 2000, 'close completion');
      assert.equal(await connections(srv), 0);
    } finally {
      if (clientSocket) clientSocket.destroy();
      if (upgraded) upgraded.destroy();
      await closeServer(srv);
    }
  });

  // Raw socket so the test controls reuse and partial requests exactly.
  function rawConnect(port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '::1', port }, () => resolve(socket));
      socket.once('error', reject);
    });
  }
  function readUntil(socket, predicate) {
    return new Promise((resolve, reject) => {
      let data = '';
      const onData = c => { data += c; if (predicate(data)) { cleanup(); resolve(data); } };
      const onEnd = () => { cleanup(); resolve(data); };
      const onError = err => { cleanup(); reject(err); };
      function cleanup() { socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError); }
      socket.setEncoding('utf8');
      socket.on('data', onData); socket.once('end', onEnd); socket.once('error', onError);
    });
  }

  it('a keep-alive ::1 socket serves two sequential requests and is idle-closable', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const seen = [];
    const srv = http.createServer((req, res) => { seen.push(req.socket); res.end(req.url); });
    let socket = null;
    try {
      const port = await hub.tryListen(srv, 0, 0);
      socket = await within(rawConnect(port), 2000, 'connect');
      const first = readUntil(socket, d => d.endsWith('/a'));
      socket.write('GET /a HTTP/1.1\r\nHost: x\r\n\r\n');
      const firstData = await within(first, 2000, 'first response');
      assert.match(firstData, /^HTTP\/1\.1 200 [\s\S]*\r\n\r\n\/a$/);
      const second = readUntil(socket, d => d.endsWith('/b'));
      socket.write('GET /b HTTP/1.1\r\nHost: x\r\n\r\n');
      const secondData = await within(second, 2000, 'second response');
      assert.match(secondData, /^HTTP\/1\.1 200 [\s\S]*\r\n\r\n\/b$/);
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], 'both requests must arrive on one socket');
      assert.equal(seen[0].remoteAddress, '::1');
      assert.equal(await connections(srv), 1);
      const ended = new Promise(r => socket.once('close', r));
      srv.closeIdleConnections();
      await within(ended, 2000, 'idle keep-alive socket closed');
      assert.equal(await connections(srv), 0);
    } finally {
      if (socket) socket.destroy();
      await closeServer(srv);
    }
  });

  it('headersTimeout applies to a ::1 connection', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const srv = http.createServer({ connectionsCheckingInterval: 50, headersTimeout: 200, requestTimeout: 400 },
      (req, res) => res.end('unexpected'));
    let socket = null;
    try {
      const port = await hub.tryListen(srv, 0, 0);
      socket = await within(rawConnect(port), 2000, 'connect');
      const reply = readUntil(socket, () => false);
      socket.write('GET / HTTP/1.1\r\nHost: x\r\n'); // headers never finish
      const data = await within(reply, 3000, 'header timeout response');
      assert.match(data, /^HTTP\/1\.1 408 /);
      assert.equal(await connections(srv), 0);
    } finally {
      if (socket) socket.destroy();
      await closeServer(srv);
    }
  });

  it('requestTimeout applies to an incomplete body on a ::1 connection', async t => {
    if (!hasV6Loopback) return t.skip('no IPv6 loopback on this host');
    const srv = http.createServer({ connectionsCheckingInterval: 50, headersTimeout: 300, requestTimeout: 300 },
      (req, res) => { req.resume(); req.on('end', () => res.end('unexpected')); });
    let socket = null;
    try {
      const port = await hub.tryListen(srv, 0, 0);
      socket = await within(rawConnect(port), 2000, 'connect');
      const reply = readUntil(socket, () => false);
      socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc'); // body never finishes
      const data = await within(reply, 3000, 'request timeout response');
      assert.match(data, /^HTTP\/1\.1 408 /);
      assert.equal(await connections(srv), 0);
    } finally {
      if (socket) socket.destroy();
      await closeServer(srv);
    }
  });

  it('close without a callback, a repeated close, and re-listen on the same port', async () => {
    const srv = makeServer();
    const port = await hub.tryListen(srv, 0, 0);
    const closed = new Promise(r => srv.once('close', r));
    srv.close();
    await within(closed, 2000, 'close event');
    const again = await within(new Promise(r => srv.close(err => r(err))), 2000, 'repeated close');
    assert.equal(again && again.code, 'ERR_SERVER_NOT_RUNNING');
    try {
      assert.equal(await hub.tryListen(srv, port, 0), port);
      assert.equal((await get('127.0.0.1', port)).status, 200);
      if (hasV6Loopback) {
        assert.deepEqual(listen.listenAddresses(srv).map(a => a.address), ['127.0.0.1', '::1']);
        assert.equal((await get('::1', port)).status, 200);
      }
    } finally {
      await closeServer(srv);
    }
    assert.equal(await connectResult('127.0.0.1', port), 'ECONNREFUSED');
    if (hasV6Loopback) assert.equal(await connectResult('::1', port), 'ECONNREFUSED');
  });
});

function canListenOnPort(host, port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
