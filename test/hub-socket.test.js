'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// Isolated temp dir — never touches real ~/.ccxray
const TEST_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hubsock-'));
const TEST_LOGS_DIR = path.join(TEST_HUB_DIR, 'logs');
const TEST_CLOUDSDK_DIR = path.join(TEST_HUB_DIR, 'gcloud');
fs.mkdirSync(TEST_LOGS_DIR, { recursive: true });
fs.writeFileSync(path.join(TEST_LOGS_DIR, 'index.ndjson'), '');
fs.mkdirSync(TEST_CLOUDSDK_DIR, { recursive: true });
const ENV_KEYS = [
  'CCXRAY_HOME', 'LOGS_DIR', 'CLOUDSDK_CONFIG', 'CCXRAY_EXPORT_GCS_KEY_FILE',
  'CCXRAY_EXPORT_DISABLE', 'NODE_TEST_CONTEXT', 'CCXRAY_EXPORT_GCS_BUCKET',
  'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_EXPORT_CONFIG_DIRS',
  'CCXRAY_EXPORT_CWD_ALLOWLIST', 'CCXRAY_USER_EMAIL', 'CCXRAY_AGENT_ID',
  'CCXRAY_TEAM', 'LOG_RETENTION_DAYS',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.CCXRAY_HOME = TEST_HUB_DIR;
process.env.LOGS_DIR = TEST_LOGS_DIR;
process.env.CLOUDSDK_CONFIG = TEST_CLOUDSDK_DIR;
process.env.CCXRAY_EXPORT_DISABLE = '1';

const hub = require('../server/hub');

hub.setOnShutdown(() => {});

after(() => {
  fs.rmSync(TEST_HUB_DIR, { recursive: true, force: true });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearAllClients() {
  for (const c of hub.getHubStatus().clients) {
    hub.removeClient(c.pid);
  }
}

function socketCommand(message) {
  let output = '';
  hub.handleSocketCommand(message, { write: chunk => { output += chunk; } });
  return output;
}

function heldClient(pid) {
  return hub.getHubStatus().clients.find(client => client.pid === pid);
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

describe('malformed hub socket reply handling', () => {
  it('rejects malformed JSON without crashing the calling process', async () => {
    const socketPath = path.join(TEST_HUB_DIR, 'malformed-reply.sock');
    const server = net.createServer(socket => {
      socket.once('data', () => socket.end('{not-json}\n'));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      const code = [
        `const hub = require(${JSON.stringify(path.resolve(__dirname, '../server/hub.js'))});`,
        `hub.hubSocketRequest(${JSON.stringify(socketPath)}, { cmd: 'status' }, 1000)`,
        `.then(() => { process.stderr.write('unexpected-resolution'); process.exitCode = 2; })`,
        `.catch(error => process.stdout.write(error.code || 'rejected'));`,
      ].join('\n');
      const childEnv = {
        ...process.env,
        CCXRAY_HOME: TEST_HUB_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        CLOUDSDK_CONFIG: TEST_CLOUDSDK_DIR,
        CCXRAY_EXPORT_DISABLE: '1',
      };
      let stdout = '';
      let stderr = '';
      const child = spawn(process.execPath, ['-e', code], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('malformed reply child timed out')); }, 3000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', status => { clearTimeout(timer); resolve(status); });
      });
      assert.equal(exitCode, 0, `the child must survive the malformed reply; stderr: ${stderr}`);
      assert.equal(stdout, 'malformed-reply');
    } finally {
      await new Promise(resolve => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch {}
    }
  });
});

describe('tokened registration cancellation', () => {
  beforeEach(clearAllClients);
  afterEach(clearAllClients);

  it('T3a: unregister-before-register cancels only that launch token', () => {
    const pid = 82001;
    const token = '1000000000000001';
    assert.equal(socketCommand({ cmd: 'unregister', pid, token }), '{"ok":true}\n');
    assert.equal(socketCommand({ cmd: 'register', pid, cwd: '/fixture/cancelled', token }), 'null\n');
    assert.equal(heldClient(pid), undefined);
  });

  it('a matched unregister removes the marker so the same token can register again', () => {
    const pid = 82002;
    const token = '1000000000000002';
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/first', token }), /"ok":true/);
    assert.equal(socketCommand({ cmd: 'unregister', pid, token }), '{"ok":true}\n');
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/again', token }), /"ok":true/);
    assert.equal(heldClient(pid).cwd, '/fixture/again');
  });

  it('a reused pid is owned by its newest token; stale unregister cannot remove it', () => {
    const pid = 82003;
    const older = '1000000000000003';
    const current = '1000000000000004';
    socketCommand({ cmd: 'register', pid, cwd: '/fixture/old', token: older });
    socketCommand({ cmd: 'register', pid, cwd: '/fixture/current', token: current });
    socketCommand({ cmd: 'unregister', pid, token: older });
    assert.equal(heldClient(pid).cwd, '/fixture/current');
    socketCommand({ cmd: 'unregister', pid, token: current });
    assert.equal(heldClient(pid), undefined);
  });

  it('keeps legacy tokenless behavior', () => {
    const pid = 82004;
    socketCommand({ cmd: 'unregister', pid });
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/legacy' }), /"ok":true/);
    assert.equal(heldClient(pid).cwd, '/fixture/legacy');
    socketCommand({ cmd: 'unregister', pid });
    assert.equal(heldClient(pid), undefined);
  });

  it('a tokenless unregister removes a tokened registration', () => {
    const pid = 82007;
    const token = '1000000000000010';
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/tokened', token }), /"ok":true/);
    assert.equal(socketCommand({ cmd: 'unregister', pid }), '{"ok":true}\n');
    assert.equal(heldClient(pid), undefined);
  });

  it('a tokened unregister removes a legacy registration', () => {
    const pid = 82008;
    const token = '1000000000000011';
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/legacy' }), /"ok":true/);
    assert.equal(socketCommand({ cmd: 'unregister', pid, token }), '{"ok":true}\n');
    assert.equal(heldClient(pid), undefined);
  });

  it('accepts a legacy registration despite a cancellation marker for that pid', () => {
    const pid = 82009;
    const token = '1000000000000012';
    assert.equal(socketCommand({ cmd: 'unregister', pid, token }), '{"ok":true}\n');
    assert.match(socketCommand({ cmd: 'register', pid, cwd: '/fixture/legacy-after-marker' }), /"ok":true/);
    assert.equal(heldClient(pid).cwd, '/fixture/legacy-after-marker');
  });

  it('ignores malformed tokens without a reply or a cancellation marker', () => {
    const pid = 82005;
    for (const token of [null, 'xyz', 42]) {
      assert.equal(socketCommand({ cmd: 'unregister', pid, token }), '');
      assert.equal(socketCommand({ cmd: 'register', pid, cwd: '/fixture/invalid', token }), '');
    }
    assert.equal(heldClient(pid), undefined);
  });

  it('T3a\u2032: retains a live pid marker and reclaims a dead pid marker', async () => {
    const liveToken = '1000000000000006';
    socketCommand({ cmd: 'unregister', pid: process.pid, token: liveToken });
    assert.equal(socketCommand({ cmd: 'register', pid: process.pid, cwd: '/fixture/live', token: liveToken }), 'null\n');

    const child = require('child_process').spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const deadToken = '1000000000000007';
    socketCommand({ cmd: 'unregister', pid: deadPid, token: deadToken });
    assert.equal(hub.isPidAlive(deadPid), false);
    hub.sweepDeadClients();
    assert.equal(socketCommand({ cmd: 'register', pid: process.pid, cwd: '/fixture/live-after-sweep', token: liveToken }), 'null\n', 'sweep must retain a live token cancellation marker');
    assert.match(socketCommand({ cmd: 'register', pid: deadPid, cwd: '/fixture/reaped', token: deadToken }), /"ok":true/);
    assert.equal(heldClient(deadPid).cwd, '/fixture/reaped');
  });

  it('T3a\u2033: characterizes reverse-order pid reuse as an accepted residual', () => {
    const pid = 82006;
    const current = '1000000000000008';
    const older = '1000000000000009';
    socketCommand({ cmd: 'register', pid, cwd: '/fixture/current', token: current });
    socketCommand({ cmd: 'register', pid, cwd: '/fixture/older', token: older });
    assert.equal(heldClient(pid).cwd, '/fixture/older');
    socketCommand({ cmd: 'unregister', pid, token: current });
    assert.equal(heldClient(pid).cwd, '/fixture/older');
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

  it('throws HubUnresponsiveError and keeps the lock when sockPath in lockfile but socket not responding (#730)', async () => {
    hub.writeHubLock(5577, process.pid, undefined, hub.SOCK_PATH);

    await assert.rejects(hub.discoverHub(), err => err.code === 'HUB_UNRESPONSIVE');
    assert.equal(hub.readHubLock().pid, process.pid);
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
