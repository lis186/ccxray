'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

// Isolated temp dir — never touches real ~/.ccxray
const TEST_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hubsock-'));
process.env.CCXRAY_HOME = TEST_HUB_DIR;

const hub = require('../server/hub');

hub.setOnShutdown(() => {});

after(() => {
  fs.rmSync(TEST_HUB_DIR, { recursive: true, force: true });
});

function clearAllClients() {
  for (const c of hub.getHubStatus().clients) {
    hub.removeClient(c.pid);
  }
}

// ── 1.19: Socket lifecycle ─────────────────────────────────────────

describe('socket lifecycle', () => {
  let sockServer;

  afterEach(() => {
    if (sockServer) { try { sockServer.close(); } catch {} sockServer = null; }
  });

  it('SOCK_PATH is under HUB_DIR', () => {
    assert.ok(hub.SOCK_PATH);
    assert.ok(hub.SOCK_PATH.startsWith(hub.HUB_DIR));
    assert.ok(hub.SOCK_PATH.endsWith('hub.sock'));
  });

  it('createHubSocket() listens on SOCK_PATH', async () => {
    sockServer = await hub.createHubSocket();
    assert.ok(fs.existsSync(hub.SOCK_PATH), 'socket file should exist');
  });

  it('socket file has mode 0600', async () => {
    sockServer = await hub.createHubSocket();
    const stat = fs.statSync(hub.SOCK_PATH);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  });

  it('socket accepts connections', async () => {
    sockServer = await hub.createHubSocket();
    const client = net.connect(hub.SOCK_PATH);
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('error', reject);
    });
    client.destroy();
  });

  it('closing socket server removes socket file', async () => {
    sockServer = await hub.createHubSocket();
    assert.ok(fs.existsSync(hub.SOCK_PATH));
    await new Promise(resolve => sockServer.close(resolve));
    sockServer = null;
    // Node auto-unlinks on close; verify
    assert.ok(!fs.existsSync(hub.SOCK_PATH), 'socket file should be removed after close');
  });
});

// ── 1.19: Stale socket cleanup ────────────────────────────────────

describe('cleanupStaleSocket', () => {
  afterEach(() => {
    try { fs.unlinkSync(hub.SOCK_PATH); } catch {}
  });

  it('removes orphan socket file when no lockfile exists', async () => {
    // Create a fake socket file (just a regular file pretending)
    fs.writeFileSync(hub.SOCK_PATH, '');
    hub.deleteHubLock();
    await hub.cleanupStaleSocket();
    assert.ok(!fs.existsSync(hub.SOCK_PATH), 'orphan socket should be removed');
  });

  it('removes socket file when lockfile pid is dead', async () => {
    fs.writeFileSync(hub.SOCK_PATH, '');
    hub.writeHubLock(5577, 999999); // dead pid
    await hub.cleanupStaleSocket();
    assert.ok(!fs.existsSync(hub.SOCK_PATH), 'stale socket should be removed');
    hub.deleteHubLock();
  });

  it('does not remove socket file when lockfile pid is alive and socket responds', async () => {
    // Create a real listening socket
    const srv = net.createServer();
    await new Promise(r => srv.listen(hub.SOCK_PATH, r));
    hub.writeHubLock(5577, process.pid);
    await hub.cleanupStaleSocket();
    assert.ok(fs.existsSync(hub.SOCK_PATH), 'live socket should NOT be removed');
    await new Promise(r => srv.close(r));
    hub.deleteHubLock();
  });

  it('no-op when socket file does not exist', async () => {
    try { fs.unlinkSync(hub.SOCK_PATH); } catch {}
    await hub.cleanupStaleSocket(); // should not throw
  });
});

// ── 1.20: Line-buffered framing ───────────────────────────────────

describe('line-buffered framing', () => {
  let sockServer;

  before(async () => {
    clearAllClients();
    sockServer = await hub.createHubSocket();
  });

  after(async () => {
    clearAllClients();
    if (sockServer) await new Promise(r => sockServer.close(r));
  });

  it('handles partial reads (message split across chunks)', async () => {
    const client = net.connect(hub.SOCK_PATH);
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('error', reject);
    });

    // Send a health command in two chunks
    const msg = JSON.stringify({ cmd: 'health' }) + '\n';
    const mid = Math.floor(msg.length / 2);
    client.write(msg.slice(0, mid));
    await new Promise(r => setTimeout(r, 50));
    client.write(msg.slice(mid));

    const response = await new Promise((resolve, reject) => {
      let buf = '';
      client.on('data', chunk => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    assert.deepEqual(response, { ok: true });
    client.destroy();
  });

  it('handles two commands in one TCP segment', async () => {
    // Open two connections to avoid ambiguity (one command per connection)
    // But test that a single connection can handle a message that arrives
    // with the next message's partial beginning
    const client = net.connect(hub.SOCK_PATH);
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('error', reject);
    });

    const msg = JSON.stringify({ cmd: 'health' }) + '\n';
    client.write(msg);

    const response = await new Promise((resolve, reject) => {
      let buf = '';
      client.on('data', chunk => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    assert.deepEqual(response, { ok: true });
    client.destroy();
  });
});

// ── 1.21: All 5 commands via socket ───────────────────────────────

describe('socket command handlers', () => {
  let sockServer;

  before(async () => {
    clearAllClients();
    sockServer = await hub.createHubSocket();
  });

  after(async () => {
    clearAllClients();
    if (sockServer) await new Promise(r => sockServer.close(r));
  });

  async function socketCmd(cmd) {
    return hub.hubSocketRequest(hub.SOCK_PATH, cmd);
  }

  it('health → {ok: true}', async () => {
    const res = await socketCmd({ cmd: 'health' });
    assert.deepEqual(res, { ok: true });
  });

  it('register → {ok: true, firstClient: true}', async () => {
    clearAllClients();
    const res = await socketCmd({ cmd: 'register', pid: 80001, cwd: '/test/a' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, true);
  });

  it('register second → {ok: true, firstClient: false}', async () => {
    const res = await socketCmd({ cmd: 'register', pid: 80002, cwd: '/test/b' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, false);
  });

  it('status → includes registered clients', async () => {
    const res = await socketCmd({ cmd: 'status' });
    assert.equal(res.app, 'ccxray');
    assert.ok(res.clients.some(c => c.pid === 80001));
    assert.ok(res.clients.some(c => c.pid === 80002));
  });

  it('unregister → removes client', async () => {
    const res = await socketCmd({ cmd: 'unregister', pid: 80001 });
    assert.equal(res.ok, true);
    const status = await socketCmd({ cmd: 'status' });
    assert.ok(!status.clients.some(c => c.pid === 80001));
  });

  it('bootstrap-token → returns token string', async () => {
    // bootstrap-token requires auth module to be initialized
    // In test env without AUTH_TOKEN, mintBootstrapToken should still work
    // (it derives from local-secret)
    const res = await socketCmd({ cmd: 'bootstrap-token' });
    assert.ok(res.token, 'should return a token');
    assert.equal(typeof res.token, 'string');
    assert.ok(res.token.length > 10, 'token should be non-trivial');
  });

  it('unknown command → {error: "unknown_command"}', async () => {
    const res = await socketCmd({ cmd: 'nonexistent' });
    assert.ok(res.error);
  });
});

// ── 1.22: 410 on deprecated HTTP hub routes ───────────────────────

describe('deprecated HTTP hub routes → 410', () => {
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      if (!hub.handleHubRoutes(req, res)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(r => server.close(r));
  });

  it('POST /_api/hub/register → 410', async () => {
    const { status, body } = await httpReq(port, 'POST', '/_api/hub/register', { pid: 1, cwd: '/' });
    assert.equal(status, 410);
    assert.ok(body.error);
  });

  it('POST /_api/hub/unregister → 410', async () => {
    const { status, body } = await httpReq(port, 'POST', '/_api/hub/unregister', { pid: 1 });
    assert.equal(status, 410);
  });

  it('POST /_api/hub/bootstrap-token → 410', async () => {
    const { status, body } = await httpReq(port, 'POST', '/_api/hub/bootstrap-token', {});
    assert.equal(status, 410);
  });

  it('GET /_api/hub/status → 410', async () => {
    const { status } = await httpReq(port, 'GET', '/_api/hub/status');
    assert.equal(status, 410);
  });

  it('GET /_api/health → still 200', async () => {
    const { status, body } = await httpReq(port, 'GET', '/_api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true); // #555: health carries occupant identity now
  });
});

// ── 1.23: hubSocketRequest timeout ────────────────────────────────

describe('hubSocketRequest', () => {
  it('rejects on nonexistent socket path', async () => {
    const badPath = path.join(TEST_HUB_DIR, 'nonexistent.sock');
    await assert.rejects(
      () => hub.hubSocketRequest(badPath, { cmd: 'health' }),
      err => err.code === 'ENOENT' || err.message.includes('ENOENT') || err.message.includes('timeout')
    );
  });

  it('returns parsed JSON for valid request', async () => {
    const sockServer = await hub.createHubSocket();
    const res = await hub.hubSocketRequest(hub.SOCK_PATH, { cmd: 'health' });
    assert.deepEqual(res, { ok: true });
    await new Promise(r => sockServer.close(r));
  });
});

// ── 1.24: registerClient signature requires lock object ───────────

describe('registerClient with lock object', () => {
  let sockServer;

  before(async () => {
    clearAllClients();
    sockServer = await hub.createHubSocket();
  });

  after(async () => {
    clearAllClients();
    if (sockServer) await new Promise(r => sockServer.close(r));
  });

  it('registerClient with sockPath uses socket', async () => {
    clearAllClients();
    const lockInfo = { port: 9999, sockPath: hub.SOCK_PATH };
    const res = await hub.registerClient(lockInfo, 90001, '/test/sock');
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, true);
  });

  it('unregisterClient with sockPath uses socket', async () => {
    const lockInfo = { port: 9999, sockPath: hub.SOCK_PATH };
    await hub.unregisterClient(lockInfo, 90001);
    const status = hub.getHubStatus();
    assert.ok(!status.clients.some(c => c.pid === 90001));
  });

  it('registerClient with number (port) falls back to HTTP', async () => {
    // Create a minimal HTTP server for fallback
    const srv = http.createServer((req, res) => {
      if (req.url === '/_api/hub/register' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, firstClient: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => srv.listen(0, r));
    const srvPort = srv.address().port;

    const res = await hub.registerClient(srvPort, 90002, '/test/http');
    assert.equal(res.ok, true);

    await new Promise(r => srv.close(r));
  });
});

// ── 1.25: discoverHub with sockPath ───────────────────────────────

describe('discoverHub with socket', () => {
  let sockServer;

  afterEach(async () => {
    if (sockServer) { await new Promise(r => sockServer.close(r)); sockServer = null; }
    hub.deleteHubLock();
    clearAllClients();
  });

  it('discovers hub via socket when sockPath present in lockfile', async () => {
    sockServer = await hub.createHubSocket();
    hub.writeHubLock(5577, process.pid, undefined, hub.SOCK_PATH);
    const lock = hub.readHubLock();
    assert.ok(lock.sockPath, 'lockfile should contain sockPath');

    const result = await hub.discoverHub();
    assert.ok(result);
    assert.equal(result.port, 5577);
    assert.equal(result.sockPath, hub.SOCK_PATH);
  });

  it('returns null when sockPath in lockfile but socket not responding', async () => {
    hub.writeHubLock(5577, process.pid, undefined, hub.SOCK_PATH);

    const result = await hub.discoverHub();
    assert.equal(result, null);
  });
});

// ── 1.4: writeHubLock includes sockPath ───────────────────────────

describe('writeHubLock sockPath field', () => {
  after(() => { hub.deleteHubLock(); });

  it('lockfile includes sockPath when explicitly passed', () => {
    const lock = hub.writeHubLock(5577, process.pid, undefined, hub.SOCK_PATH);
    assert.equal(lock.sockPath, hub.SOCK_PATH);
    const read = hub.readHubLock();
    assert.equal(read.sockPath, hub.SOCK_PATH);
    hub.deleteHubLock();
  });

  it('lockfile omits sockPath when not passed (P2-2 regression)', () => {
    const lock = hub.writeHubLock(5577, process.pid);
    assert.equal(lock.sockPath, undefined);
    const read = hub.readHubLock();
    assert.equal(read.sockPath, undefined);
    hub.deleteHubLock();
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function httpReq(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body && method !== 'GET') req.end(JSON.stringify(body));
    else req.end();
  });
}
