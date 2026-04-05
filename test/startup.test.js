'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-startup-test-'));

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helper: find an available port ─────────────────────────────────

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Helper: spawn server and wait for ready ────────────────────────

function spawnServer(args, opts = {}) {
  const env = {
    ...process.env,
    CCXRAY_HOME: TEST_HOME,
    BROWSER: 'none', // never open browser in tests
    ...opts.env,
  };
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.getOutput = () => ({ stdout, stderr });
  return child;
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            if (JSON.parse(data).ok) return resolve();
          } catch {}
          if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
          setTimeout(check, 200);
        });
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(check, 200);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

// ── S4: standalone mode (ccxray without claude) ────────────────────

describe('S4: standalone mode', () => {
  let child;
  let port;

  before(async () => {
    port = await findFreePort();
    child = spawnServer(['--port', String(port)]);
    await waitForPort(port);
  });

  after(async () => {
    await killAndWait(child);
  });

  it('serves health endpoint', async () => {
    const data = await httpGet(port, '/_api/health');
    assert.deepEqual(data, { ok: true });
  });

  it('serves dashboard HTML at /', async () => {
    const html = await httpGetRaw(port, '/');
    assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'));
  });

  it('serves hub status', async () => {
    const data = await httpGet(port, '/_api/hub/status');
    assert.equal(data.app, 'ccxray');
    assert.ok(data.version);
  });
});

// ── S5: status subcommand ──────────────────────────────────────────

describe('S5: status subcommand', () => {
  it('reports no hub when nothing is running', async () => {
    // Ensure no lockfile
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}

    const { stdout, code } = await spawnAndCollect(['status']);
    assert.ok(stdout.includes('No hub running'));
    assert.equal(code, 0);
  });

  it('reports dead hub and cleans lockfile', async () => {
    // Write a fake lockfile with dead pid
    const lockPath = path.join(TEST_HOME, 'hub.json');
    fs.writeFileSync(lockPath, JSON.stringify({ port: 9999, pid: 999999, version: '1.0.0' }));

    const { stdout, code } = await spawnAndCollect(['status']);
    assert.ok(stdout.includes('dead') || stdout.includes('Cleaning'));
    assert.equal(code, 1);

    // Lockfile should be cleaned up
    assert.ok(!fs.existsSync(lockPath));
  });
});

// ── S6: hub mode startup ───────────────────────────────────────────

describe('S6: hub mode startup', () => {
  let child;
  let port;

  before(async () => {
    port = await findFreePort();
    child = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
  });

  after(async () => {
    await killAndWait(child);
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
  });

  it('writes lockfile after startup', () => {
    const lockPath = path.join(TEST_HOME, 'hub.json');
    assert.ok(fs.existsSync(lockPath));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.port, port);
    assert.ok(lock.pid > 0);
    assert.ok(lock.version);
  });

  it('responds to health check', async () => {
    const data = await httpGet(port, '/_api/health');
    assert.deepEqual(data, { ok: true });
  });

  it('accepts client registration', async () => {
    const data = await httpPost(port, '/_api/hub/register', { pid: 77777, cwd: '/test' });
    assert.equal(data.ok, true);
    assert.equal(data.firstClient, true);

    // Cleanup
    await httpPost(port, '/_api/hub/unregister', { pid: 77777 });
  });
});

// ── E3: --port validation ──────────────────────────────────────────

describe('E3: --port validation', () => {
  it('rejects port 0', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', '0']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });

  it('rejects non-numeric port', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', 'abc']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });

  it('rejects port > 65535', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', '99999']);
    assert.ok(stderr.includes('--port requires a valid port'));
    assert.equal(code, 1);
  });
});

// ── R4: EADDRINUSE handling ────────────────────────────────────────

describe('R4: port conflict', () => {
  let blocker;
  let port;

  before(async () => {
    port = await findFreePort();
    blocker = net.createServer();
    await new Promise(r => blocker.listen(port, r));
  });

  after(() => {
    blocker.close();
  });

  it('standalone mode reports port in use', async () => {
    const { stderr, code } = await spawnAndCollect(['--port', String(port)]);
    assert.ok(stderr.includes('already in use') || stderr.includes('EADDRINUSE'));
    assert.equal(code, 1);
  });
});

// ── R2: hub crash recovery (sequential fork → kill → re-fork) ──────

describe('R2: hub crash recovery', () => {
  let hubPid1 = null;
  let hubPid2 = null;
  let port;

  after(async () => {
    for (const pid of [hubPid1, hubPid2]) {
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
  });

  it('re-forks hub after original hub is killed', async () => {
    port = await findFreePort();

    // 1. Fork first hub
    const child1 = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
    const lock1 = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hub.json'), 'utf8'));
    hubPid1 = lock1.pid;
    assert.ok(hubPid1 > 0);
    assert.equal(lock1.port, port);

    // 2. Kill first hub
    process.kill(hubPid1, 'SIGKILL');
    await new Promise(r => child1.on('exit', r));

    // 3. Delete lockfile (simulating what startHubMonitor does)
    try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}

    // 4. Wait for port to be released
    await new Promise(resolve => {
      const check = () => {
        const srv = net.createServer();
        srv.once('error', () => setTimeout(check, 200));
        srv.once('listening', () => srv.close(() => resolve()));
        srv.listen(port);
      };
      check();
    });

    // 5. Fork second hub on same port
    const child2 = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);
    const lock2 = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'hub.json'), 'utf8'));
    hubPid2 = lock2.pid;
    assert.ok(hubPid2 > 0);
    assert.equal(lock2.port, port);
    assert.notEqual(hubPid2, hubPid1);

    // 6. Verify new hub is healthy
    const health = await httpGet(port, '/_api/health');
    assert.deepEqual(health, { ok: true });

    await killAndWait(child2);
  });
});

// ── E2: claude not found (ENOENT) ──────────────────────────────────

describe('E2: claude not found', () => {
  it('reports error when claude binary is missing', async () => {
    const port = await findFreePort();

    // Spawn with empty PATH so 'claude' cannot be found.
    // Keep node in PATH so the process itself can run.
    const nodeBin = path.dirname(process.execPath);
    const { stderr, code } = await spawnAndCollect(
      ['--port', String(port), 'claude'],
      8000,
      { PATH: nodeBin }
    );

    assert.ok(
      stderr.includes('not found') || stderr.includes('ENOENT'),
      `Expected ENOENT message, got: ${stderr.slice(0, 200)}`
    );
  });
});

// ── P0: Proxy end-to-end (request → forward → response → log) ──────

describe('P0: proxy end-to-end forwarding', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let receivedReq = null;

  before(async () => {
    // 1. Start mock "Anthropic API" server
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from mock' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    // 2. Start proxy pointing to mock upstream
    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('forwards request to upstream and returns response', async () => {
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    // Verify proxy forwarded to mock upstream
    assert.ok(receivedReq, 'mock upstream should have received the request');
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/v1/messages');

    // Verify proxy returned upstream response to client
    assert.equal(response.status, 200);
    assert.equal(response.body.id, 'msg_test123');
    assert.equal(response.body.content[0].text, 'Hello from mock');
  });

  it('writes req/res log files', async () => {
    // Give a moment for async writes
    await new Promise(r => setTimeout(r, 500));

    const logsDir = path.join(TEST_HOME, 'logs');
    const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
    const reqFiles = files.filter(f => f.endsWith('_req.json'));
    const resFiles = files.filter(f => f.endsWith('_res.json'));

    assert.ok(reqFiles.length > 0, `Expected req log files, found: ${files.join(', ')}`);
    assert.ok(resFiles.length > 0, `Expected res log files, found: ${files.join(', ')}`);

    // Verify req log content
    const reqContent = JSON.parse(fs.readFileSync(path.join(logsDir, reqFiles[0]), 'utf8'));
    assert.equal(reqContent.model, 'claude-sonnet-4-20250514');
    assert.ok(reqContent.messages);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    }).on('error', reject);
  });
}

function httpGetRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(`http://localhost:${port}${urlPath}`, {
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

function spawnAndCollect(args, timeoutMs = 10000, envOverrides = {}) {
  return new Promise(resolve => {
    const child = spawnServer(args, { env: envOverrides });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const { stdout, stderr } = child.getOutput();
      resolve({ stdout, stderr, code });
    };
    child.on('exit', (code) => finish(code));
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(null);
    }, timeoutMs);
  });
}
