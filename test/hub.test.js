'use strict';

const { describe, it, before, after } = require('node:test');
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
  after(() => {
    // Clear clients map via remove
    for (const [pid] of hub.getHubStatus().clients.map(c => [c.pid])) {
      hub.removeClient(pid);
    }
  });

  it('addClient adds to status', () => {
    hub.addClient(11111, '/tmp/project-a');
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].pid, 11111);
    assert.equal(status.clients[0].cwd, '/tmp/project-a');
  });

  it('addClient with second client', () => {
    hub.addClient(22222, '/tmp/project-b');
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 2);
  });

  it('removeClient removes from status', () => {
    hub.removeClient(11111);
    const status = hub.getHubStatus();
    assert.equal(status.clients.length, 1);
    assert.equal(status.clients[0].pid, 22222);
  });

  it('removeClient on last client leaves empty', () => {
    hub.removeClient(22222);
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
    assert.deepEqual(res, { ok: true });
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
    hub.writeHubLock(19999, process.pid);
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

// ── Integration: checkHubHealth ─────────────────────────────────────

describe('checkHubHealth', () => {
  it('returns false for port with no server', async () => {
    const result = await hub.checkHubHealth(19998, 500);
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
    hub.deleteHubLock();
    hubPid = hub.forkHub(0); // port 0 = random
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
    const ok = await hub.registerClient(port, 44444, '/test/project');
    assert.equal(ok, true);

    const status = await httpGet(port, '/_api/hub/status');
    assert.ok(status.clients.some(c => c.pid === 44444));

    await hub.unregisterClient(port, 44444);

    const status2 = await httpGet(port, '/_api/hub/status');
    assert.ok(!status2.clients.some(c => c.pid === 44444));
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
