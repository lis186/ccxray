'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Use an isolated temp dir so tests never touch real ~/.ccxray
const TEST_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-test-'));
process.env.CCXRAY_HOME = TEST_HUB_DIR;

// Now require hub (picks up CCXRAY_HOME)
const hub = require('../server/hub');

// Inject no-op shutdown so idle timer never calls process.exit in tests
hub.setOnShutdown(() => {});

after(() => {
  // Cleanup temp dir
  fs.rmSync(TEST_HUB_DIR, { recursive: true, force: true });
});

// ── Unit: lockfile operations ───────────────────────────────────────

describe('lockfile operations', () => {
  after(() => { hub.deleteHubLock(); });

  it('readHubLock returns null when no file', () => {
    hub.deleteHubLock();
    assert.equal(hub.readHubLock(), null);
  });

  it('writeHubLock creates file with expected fields', () => {
    const lock = hub.writeHubLock(5577, 12345);
    assert.equal(lock.port, 5577);
    assert.equal(lock.pid, 12345);
    assert.ok(lock.version);
    assert.ok(lock.startedAt);

    const read = hub.readHubLock();
    assert.equal(read.port, 5577);
    assert.equal(read.pid, 12345);
  });

  it('deleteHubLock removes file', () => {
    hub.writeHubLock(5577, 12345);
    hub.deleteHubLock();
    assert.equal(hub.readHubLock(), null);
  });

  it('deleteHubLock is idempotent', () => {
    hub.deleteHubLock();
    hub.deleteHubLock(); // should not throw
  });
});

// ── Unit: isPidAlive ────────────────────────────────────────────────

describe('isPidAlive', () => {
  it('returns true for current process', () => {
    assert.equal(hub.isPidAlive(process.pid), true);
  });

  it('returns false for non-existent pid', () => {
    assert.equal(hub.isPidAlive(999999), false);
  });
});

// ── Unit: version compatibility ─────────────────────────────────────

describe('checkVersionCompat', () => {
  const clientVersion = require('../package.json').version;

  it('same version → ok, no warning', () => {
    const result = hub.checkVersionCompat(clientVersion);
    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
    assert.equal(result.fatal, undefined);
  });

  it('same major, different minor → ok with warning', () => {
    const [major] = clientVersion.split('.');
    const fakeVersion = `${major}.99.0`;
    const result = hub.checkVersionCompat(fakeVersion);
    assert.equal(result.ok, true);
    assert.ok(result.warning);
  });

  it('same major, different patch → ok, no warning', () => {
    const [major, minor] = clientVersion.split('.');
    const fakeVersion = `${major}.${minor}.99`;
    const result = hub.checkVersionCompat(fakeVersion);
    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
  });

  it('different major → fatal', () => {
    const [major] = clientVersion.split('.');
    const fakeVersion = `${parseInt(major) + 1}.0.0`;
    const result = hub.checkVersionCompat(fakeVersion);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.ok(result.message);
  });
});

// ── Unit: client lifecycle ──────────────────────────────────────────

describe('client lifecycle', () => {
  beforeEach(() => { clearAllClients(); });
  after(() => { clearAllClients(); });

  it('addClient adds to status', () => {
    hub.addClient(11111, '/tmp/project-a');
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].pid, 11111);
    assert.equal(status.clients[0].cwd, '/tmp/project-a');
  });

  it('addClient with second client', () => {
    hub.addClient(11111, '/tmp/project-a');
    hub.addClient(22222, '/tmp/project-b');
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 2);
  });

  it('removeClient removes from status', () => {
    hub.addClient(11111, '/tmp/project-a');
    hub.addClient(22222, '/tmp/project-b');
    hub.removeClient(11111);
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].pid, 22222);
  });

  it('removeClient on last client leaves empty', () => {
    hub.addClient(11111, '/tmp/project-a');
    hub.removeClient(11111);
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 0);
  });
});

// ── Unit: hub log truncation ────────────────────────────────────────

describe('truncateHubLog', () => {
  it('truncates log file larger than 1MB to ~100KB', () => {
    const logPath = hub.HUB_LOG_PATH;
    // Write a 1.5MB log file
    const line = 'x'.repeat(100) + '\n';
    const lines = line.repeat(15000); // ~1.5MB
    fs.writeFileSync(logPath, lines);
    const sizeBefore = fs.statSync(logPath).size;
    assert.ok(sizeBefore > 1024 * 1024);

    hub.truncateHubLog();

    const sizeAfter = fs.statSync(logPath).size;
    assert.ok(sizeAfter < 110 * 1024, `Expected < 110KB, got ${sizeAfter}`);
    assert.ok(sizeAfter > 0);
  });

  it('does not truncate small log files', () => {
    const logPath = hub.HUB_LOG_PATH;
    fs.writeFileSync(logPath, 'small log\n');
    hub.truncateHubLog();
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'small log\n');
  });
});

// ── Integration: hub server routes ──────────────────────────────────

describe('hub server routes', () => {
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      if (!hub.handleHubRoutes(req, res)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
      server.on('error', reject);
    });
  });

  after(async () => {
    // Clear clients registered during tests
    hub.removeClient(33333);
    await new Promise(resolve => server.close(resolve));
  });

  it('GET /_api/health → 200 { ok: true }', async () => {
    const data = await httpGet(port, '/_api/health');
    assert.deepEqual(data, { ok: true });
  });

  it('GET /_api/hub/status → 200 with clients array', async () => {
    const data = await httpGet(port, '/_api/hub/status');
    assert.ok(Array.isArray(data.clients));
    assert.ok(typeof data.uptime === 'number');
    assert.ok(data.version);
  });

  it('POST /_api/hub/register → adds client', async () => {
    const res = await httpPost(port, '/_api/hub/register', { pid: 33333, cwd: '/test' });
    assert.equal(res.ok, true);
    assert.equal(typeof res.firstClient, 'boolean');
    const status = await httpGet(port, '/_api/hub/status');
    assert.ok(status.clients.some(c => c.pid === 33333));
  });

  it('POST /_api/hub/unregister → removes client', async () => {
    await httpPost(port, '/_api/hub/unregister', { pid: 33333 });
    const status = await httpGet(port, '/_api/hub/status');
    assert.ok(!status.clients.some(c => c.pid === 33333));
  });

  it('POST /_api/hub/register with bad JSON → 400', async () => {
    const statusCode = await httpPostRaw(port, '/_api/hub/register', 'not json');
    assert.equal(statusCode, 400);
  });
});

// ── Integration: hub discovery ──────────────────────────────────────

describe('hub discovery', () => {
  after(() => { hub.deleteHubLock(); });

  it('returns null when no lockfile', async () => {
    hub.deleteHubLock();
    const result = await hub.discoverHub();
    assert.equal(result, null);
  });

  it('returns null and cleans up stale lockfile (dead pid)', async () => {
    hub.writeHubLock(5577, 999999); // pid that doesn't exist
    const result = await hub.discoverHub();
    assert.equal(result, null);
    assert.equal(hub.readHubLock(), null); // lockfile deleted
  });

  it('returns null when pid alive but health check fails', async () => {
    // Write lockfile with our own pid but a port nothing is listening on
    hub.writeHubLock(1, process.pid); // port 1: privileged, guaranteed no listener
    const result = await hub.discoverHub();
    assert.equal(result, null);
    assert.equal(hub.readHubLock(), null);
  });

  it('returns lock when pid alive and health check passes', async () => {
    // Spin up a minimal health server
    const srv = http.createServer((req, res) => {
      hub.handleHubRoutes(req, res);
    });
    await new Promise(r => srv.listen(0, r));
    const srvPort = srv.address().port;

    hub.writeHubLock(srvPort, process.pid);
    const result = await hub.discoverHub();
    assert.ok(result);
    assert.equal(result.port, srvPort);

    hub.deleteHubLock();
    await new Promise(r => srv.close(r));
  });
});

// ── Integration: orphan hub probe ───────────────────────────────────

describe('orphan hub probe', () => {
  let srv;
  let srvPort;

  before(async () => {
    srv = http.createServer((req, res) => {
      hub.handleHubRoutes(req, res);
    });
    await new Promise(r => srv.listen(0, r));
    srvPort = srv.address().port;
    hub.setHubPort(srvPort);
  });

  after(async () => {
    hub.deleteHubLock();
    await new Promise(r => srv.close(r));
  });

  it('discovers orphan hub when lockfile is missing', async () => {
    hub.deleteHubLock();
    const result = await hub.discoverHub(srvPort);
    assert.ok(result, 'should find orphan hub');
    assert.equal(result.port, srvPort);
    assert.equal(result.pid, process.pid);
    // lockfile should be reconstructed
    const lock = hub.readHubLock();
    assert.ok(lock, 'lockfile should be reconstructed');
    assert.equal(lock.port, srvPort);
  });

  it('returns null when probed port has no server', async () => {
    hub.deleteHubLock();
    const result = await hub.discoverHub(19997);
    assert.equal(result, null);
    assert.equal(hub.readHubLock(), null);
  });

  it('returns null when probed port has non-ccxray service', async () => {
    const fakeSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    await new Promise(r => fakeSrv.listen(0, r));
    const fakePort = fakeSrv.address().port;

    hub.deleteHubLock();
    const result = await hub.discoverHub(fakePort);
    assert.equal(result, null);

    await new Promise(r => fakeSrv.close(r));
  });

  it('rejects lookalike service with hub-shaped payload but no app marker', async () => {
    const fakeSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const fakePort = fakeSrv.address().port;
      res.end(JSON.stringify({ pid: process.pid, version: '1.0.0', port: fakePort }));
    });
    await new Promise(r => fakeSrv.listen(0, r));
    const fakePort = fakeSrv.address().port;

    hub.deleteHubLock();
    const result = await hub.discoverHub(fakePort);
    assert.equal(result, null, 'should reject service without app:ccxray marker');
    assert.equal(hub.readHubLock(), null);

    await new Promise(r => fakeSrv.close(r));
  });

  it('returns null when no defaultPort provided', async () => {
    hub.deleteHubLock();
    const result = await hub.discoverHub();
    assert.equal(result, null);
  });
});

// ── Integration: checkHubHealth ─────────────────────────────────────

describe('checkHubHealth', () => {
  it('returns false for port with no server', async () => {
    const result = await hub.checkHubHealth(1, 500); // port 1: privileged, no listener
    assert.equal(result, false);
  });

  it('returns true for port with health endpoint', async () => {
    const srv = http.createServer((req, res) => {
      hub.handleHubRoutes(req, res);
    });
    await new Promise(r => srv.listen(0, r));
    const port = srv.address().port;

    const result = await hub.checkHubHealth(port);
    assert.equal(result, true);

    await new Promise(r => srv.close(r));
  });
});

// ── Integration: fork + readiness ───────────────────────────────────

describe('hub fork and readiness', () => {
  let hubPid = null;

  after(() => {
    if (hubPid) {
      try { process.kill(hubPid, 'SIGTERM'); } catch {}
    }
    hub.deleteHubLock();
  });

  it('forkHub + waitForHubReady produces a lockfile', async () => {
    // Find an available port (port 0 is rejected by --port CLI validation)
    const net = require('net');
    const tmpSrv = net.createServer();
    await new Promise(r => tmpSrv.listen(0, r));
    const freePort = tmpSrv.address().port;
    await new Promise(r => tmpSrv.close(r));

    hub.deleteHubLock();
    hubPid = hub.forkHub(freePort);
    assert.ok(hubPid > 0);

    const lock = await hub.waitForHubReady(8000);
    assert.ok(lock);
    assert.ok(lock.port > 0);
    assert.ok(lock.pid > 0);
    assert.ok(lock.version);
    hubPid = lock.pid; // update to actual hub pid for cleanup
  });
});

// ── Integration: register/unregister via HTTP ───────────────────────

describe('register/unregister via HTTP', () => {
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      if (!hub.handleHubRoutes(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(r => server.close(r));
  });

  it('registerClient + unregisterClient round-trip', async () => {
    const reg = await hub.registerClient(port, 44444, '/test/project');
    assert.equal(reg.ok, true);

    const status = await httpGet(port, '/_api/hub/status');
    assert.ok(status.clients.some(c => c.pid === 44444));

    await hub.unregisterClient(port, 44444);

    const status2 = await httpGet(port, '/_api/hub/status');
    assert.ok(!status2.clients.some(c => c.pid === 44444));
  });
});

// With setOnShutdown(() => {}), idle timer is harmless — just clear clients.
function clearAllClients() {
  for (const c of hub.getHubStatus().clients) {
    hub.removeClient(c.pid);
  }
}

// ── L1: firstClient flag ───────────────────────────────────────────

describe('firstClient flag', () => {
  let server;
  let port;

  before(async () => {
    clearAllClients();
    server = http.createServer((req, res) => {
      if (!hub.handleHubRoutes(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    clearAllClients();
    await new Promise(r => server.close(r));
  });

  it('first client registered → firstClient: true', async () => {
    // Ensure hub is truly empty
    clearAllClients();
    const res = await httpPost(port, '/_api/hub/register', { pid: 50001, cwd: '/a' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, true);
  });

  it('second client registered → firstClient: false', async () => {
    const res = await httpPost(port, '/_api/hub/register', { pid: 50002, cwd: '/b' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, false);
  });

  it('after all disconnect, next client → firstClient: true again', async () => {
    await httpPost(port, '/_api/hub/unregister', { pid: 50001 });
    await httpPost(port, '/_api/hub/unregister', { pid: 50002 });

    const status = await httpGet(port, '/_api/hub/status');
    assert.equal(status.clients.length, 0);

    const res = await httpPost(port, '/_api/hub/register', { pid: 50003, cwd: '/c' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, true);
  });
});

// ── L2: Hub idle timer lifecycle ───────────────────────────────────

describe('hub idle timer lifecycle', () => {
  before(() => { clearAllClients(); });
  after(() => { clearAllClients(); });

  it('addClient cancels idle timer started by removeClient', () => {
    // Make hub empty, then add+remove to arm idle timer
    clearAllClients();
    hub.addClient(60001, '/timer-test');
    hub.removeClient(60001);
    // Idle timer is now ticking (5s to process.exit)

    // Adding a new client must cancel the idle timer
    hub.addClient(60002, '/timer-test-2');
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].pid, 60002);
    // If idle timer was NOT cancelled, process.exit would fire in 5s
  });

  it('removing non-last client does not trigger idle timer', () => {
    clearAllClients();
    hub.addClient(60001, '/x');
    hub.addClient(60002, '/y');
    const statusBefore = hub.getHubStatus();
    assert.equal(statusBefore.clients.length, 2);

    hub.removeClient(60001);
    // 60002 still present → no idle timer
    const statusAfter = hub.getHubStatus();
    assert.equal(statusAfter.clients.length, 1);
    assert.equal(statusAfter.clients[0].pid, 60002);
  });
});

// ── L3: Dead client cleanup logic ──────────────────────────────────

describe('dead client cleanup logic', () => {
  before(() => { clearAllClients(); });
  after(() => { clearAllClients(); });

  it('isPidAlive returns false for a dead pid', () => {
    assert.equal(hub.isPidAlive(999999), false);
  });

  it('simulated dead client check removes dead clients', () => {
    clearAllClients();
    hub.addClient(999999, '/dead-project');
    hub.addClient(process.pid, '/alive-project');

    const before = hub.getHubStatus();
    assert.equal(before.clients.length, 2);

    // Simulate what startDeadClientCheck interval callback does
    for (const c of hub.getHubStatus().clients) {
      if (!hub.isPidAlive(c.pid)) hub.removeClient(c.pid);
    }

    const after = hub.getHubStatus();
    assert.equal(after.clients.length, 1);
    assert.equal(after.clients[0].pid, process.pid);
  });

  it('live client survives dead client check', () => {
    clearAllClients();
    hub.addClient(999999, '/dead');
    hub.addClient(process.pid, '/alive');
    for (const c of hub.getHubStatus().clients) {
      if (!hub.isPidAlive(c.pid)) hub.removeClient(c.pid);
    }
    assert.ok(hub.getHubStatus().clients.some(c => c.pid === process.pid));
  });
});

// ── L7: firstClient flag on idle cycle ─────────────────────────────

describe('firstClient on idle cycle via HTTP', () => {
  let server;
  let port;

  before(async () => {
    clearAllClients();
    server = http.createServer((req, res) => {
      if (!hub.handleHubRoutes(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    clearAllClients();
    await new Promise(r => server.close(r));
  });

  it('full cycle: register → unregister all → register again gets firstClient true', async () => {
    // Remove guard so hub is empty
    await httpPost(port, '/_api/hub/unregister', { pid: 88888 });

    // First register on empty hub
    const r1 = await httpPost(port, '/_api/hub/register', { pid: 70001, cwd: '/cycle' });
    assert.equal(r1.firstClient, true);

    // Second register
    const r2 = await httpPost(port, '/_api/hub/register', { pid: 70002, cwd: '/cycle2' });
    assert.equal(r2.firstClient, false);

    // Unregister both — triggers idle timer
    await httpPost(port, '/_api/hub/unregister', { pid: 70001 });
    await httpPost(port, '/_api/hub/unregister', { pid: 70002 });

    // Hub is now empty — next register should be firstClient again
    // (also cancels idle timer)
    const r3 = await httpPost(port, '/_api/hub/register', { pid: 70003, cwd: '/cycle3' });
    assert.equal(r3.firstClient, true);
  });
});

// ── R5+E4: version compat + registration rejection ─────────────────

describe('version compat edge cases', () => {
  it('writeHubLock with versionOverride uses provided version', () => {
    const lock = hub.writeHubLock(9999, 12345, '99.0.0');
    assert.equal(lock.version, '99.0.0');
    assert.equal(lock.port, 9999);
    hub.deleteHubLock();
  });

  it('writeHubLock without override uses package.json version', () => {
    const expected = require('../package.json').version;
    const lock = hub.writeHubLock(9999, 12345);
    assert.equal(lock.version, expected);
    hub.deleteHubLock();
  });
});

// ── X3: CCXRAY_HOME custom directory ────────────────────────────────

describe('CCXRAY_HOME custom directory', () => {
  it('hub uses CCXRAY_HOME for lockfile path', () => {
    const hubDir = hub.HUB_DIR;
    assert.equal(hubDir, process.env.CCXRAY_HOME);
    assert.ok(hub.HUB_LOCK_PATH.startsWith(hubDir));
    assert.ok(hub.HUB_LOG_PATH.startsWith(hubDir));
  });
});

// ── R3: stale lockfile double-cleanup ───────────────────────────────

describe('stale lockfile cleanup', () => {
  after(() => { hub.deleteHubLock(); });

  it('discoverHub cleans up lockfile with dead pid even when health check would pass', async () => {
    // Write a lockfile pointing to a dead pid but a port that IS listening
    const srv = http.createServer((req, res) => {
      hub.handleHubRoutes(req, res);
    });
    await new Promise(r => srv.listen(0, r));
    const srvPort = srv.address().port;

    hub.writeHubLock(srvPort, 999999); // dead pid, live port
    const result = await hub.discoverHub();
    assert.equal(result, null);
    assert.equal(hub.readHubLock(), null); // cleaned up

    await new Promise(r => srv.close(r));
  });
});

// ── Hub status shape ────────────────────────────────────────────────

describe('hub status shape', () => {
  it('getHubStatus includes app marker', () => {
    const status = hub.getHubStatus();
    assert.equal(status.app, 'ccxray');
    assert.ok(status.version);
    assert.equal(typeof status.uptime, 'number');
    assert.ok(Array.isArray(status.clients));
  });

  it('setHubPort persists in getHubStatus', () => {
    hub.setHubPort(7777);
    const status = hub.getHubStatus();
    assert.equal(status.port, 7777);
    hub.setHubPort(null); // reset
  });
});

// ── Unit: tryListen port scanner ────────────────────────────────────

describe('tryListen', () => {
  const net = require('net');

  it('binds on first try when port is free', async () => {
    const srv = http.createServer();
    const port = await hub.tryListen(srv, 0, 0); // port 0 = OS assigns
    assert.ok(port > 0);
    await new Promise(r => srv.close(r));
  });

  it('finds next free port when target is occupied (maxAttempts=2)', async () => {
    // Occupy a port
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(0, r));
    const occupiedPort = blocker.address().port;

    const srv = http.createServer();
    const bound = await hub.tryListen(srv, occupiedPort, 2);
    assert.ok(bound > occupiedPort, `expected port > ${occupiedPort}, got ${bound}`);
    assert.ok(bound <= occupiedPort + 2);

    await new Promise(r => srv.close(r));
    await new Promise(r => blocker.close(r));
  });

  it('throws EADDRINUSE when maxAttempts=0 and port is occupied', async () => {
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(0, r));
    const occupiedPort = blocker.address().port;

    const srv = http.createServer();
    await assert.rejects(
      () => hub.tryListen(srv, occupiedPort, 0),
      err => err.code === 'EADDRINUSE'
    );

    await new Promise(r => blocker.close(r));
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    }).on('error', reject);
  });
}

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end(json);
  });
}

function httpPostRaw(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(body);
  });
}
