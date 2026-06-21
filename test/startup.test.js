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

// Poll until fn() returns a truthy value (or stops throwing) instead of
// guessing a fixed setTimeout. The proxy writes logs from a separate process,
// so the test can only observe completion by polling the filesystem/API —
// a fixed sleep flakes under parallel-suite load. See issue #100.
async function waitFor(fn, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start);
    let timer;
    try {
      // Race fn() against the remaining budget so an async predicate that never
      // settles (e.g. an httpGet to a dead proxy) can't hang the test — the
      // timeout still fires. clearTimeout below keeps the loser timer from
      // lingering on the event loop.
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('predicate exceeded deadline')), remaining); }),
      ]);
      if (result) return result;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

// Read index.ndjson as a parsed array, or [] if not written yet.
function readIndex(logsDir) {
  const p = path.join(logsDir, 'index.ndjson');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
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

  it('hub routes return 410 (moved to socket)', async () => {
    const res = await httpGetFull(port, '/_api/hub/status');
    assert.equal(res.status, 410);
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

// ── S5a: secret upstream subcommand ──────────────────────────────

describe('S5a: secret upstream subcommand', () => {
  it('prints base64url upstream token and exits 0', async () => {
    const { stdout, code } = await spawnAndCollect(['secret', 'upstream']);
    assert.equal(code, 0, `expected exit 0, got ${code}`);
    const token = stdout.trim();
    assert.ok(/^[A-Za-z0-9_-]{20,}$/.test(token), `expected base64url token, got: ${token}`);
  });

  it('prints same token on repeated calls (deterministic from local-secret)', async () => {
    const { stdout: a } = await spawnAndCollect(['secret', 'upstream']);
    const { stdout: b } = await spawnAndCollect(['secret', 'upstream']);
    assert.equal(a.trim(), b.trim());
  });

  // Codex 1.10.0 P3 regression guard: previously `secret` was allow-listed
  // out of unknownCommand to let `secret upstream` reach its handler, but no
  // catch-all rejected typos — `ccxray secret foo` or bare `ccxray secret`
  // silently started the proxy instead of erroring.
  it('`ccxray secret foo` (unknown subcommand) → exits 1 with error', async () => {
    const { stderr, code } = await spawnAndCollect(['secret', 'foo']);
    assert.equal(code, 1, `expected exit 1, got ${code}`);
    assert.match(stderr, /unknown secret subcommand|secret subcommand/i);
  });

  it('`ccxray secret` (no subcommand) → exits 1 with error', async () => {
    const { stderr, code } = await spawnAndCollect(['secret']);
    assert.equal(code, 1, `expected exit 1, got ${code}`);
    assert.match(stderr, /unknown secret subcommand|secret subcommand|missing/i);
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

  it('accepts client registration via socket', async () => {
    const lockPath = path.join(TEST_HOME, 'hub.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.ok(lock.sockPath, 'lockfile should contain sockPath');
    const hub = require('../server/hub');
    const res = await hub.hubSocketRequest(lock.sockPath, { cmd: 'register', pid: 77777, cwd: '/test' });
    assert.equal(res.ok, true);
    assert.equal(res.firstClient, true);

    // Cleanup
    await hub.hubSocketRequest(lock.sockPath, { cmd: 'unregister', pid: 77777 });
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

describe('provider launcher selection', () => {
  it('rejects unsupported provider commands instead of silently starting standalone mode', async () => {
    const { stderr, code } = await spawnAndCollect(['unknown-ai'], 3000);

    assert.equal(code, 1);
    assert.ok(stderr.includes('unsupported provider "unknown-ai"'), stderr);
    assert.ok(stderr.includes('claude'), stderr);
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

describe('claude launcher mode', () => {
  function createFakeClaudeCapture() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fake-claude-'));
    const capturePath = path.join(fakeBin, 'capture.json');
    const claudePath = path.join(fakeBin, 'claude');
    fs.writeFileSync(claudePath, [
      '#!/bin/sh',
      'node -e \'const fs=require("fs"); fs.writeFileSync(process.env.CCXRAY_TEST_CLAUDE_CAPTURE, JSON.stringify({ argv: process.argv.slice(1), anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null }));\' -- "$@"',
    ].join('\n'));
    fs.chmodSync(claudePath, 0o755);
    return { fakeBin, capturePath };
  }

  it('spawns claude through the provider registry and forwards user args', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeClaudeCapture();
    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'claude', '--continue'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, ['--continue']);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('consumes --no-browser as a ccxray flag before launching claude', async () => {
    const port = await findFreePort();
    const { fakeBin, capturePath } = createFakeClaudeCapture();
    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'claude', '--no-browser'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, []);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('uses hub discovery and registration for claude mode without explicit port', async () => {
    const port = await findFreePort();
    const hubChild = spawnServer(['--port', String(port), '--hub-mode']);
    await waitForPort(port);

    const { fakeBin, capturePath } = createFakeClaudeCapture();
    const nodeBin = path.dirname(process.execPath);
    try {
      const { code, stderr } = await spawnAndCollect(
        ['claude', '--continue'],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CLAUDE_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, ['--continue']);
      assert.equal(capture.anthropicBaseUrl, `http://localhost:${port}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      await killAndWait(hubChild);
      try { fs.unlinkSync(path.join(TEST_HOME, 'hub.json')); } catch {}
    }
  });
});

describe('codex desktop app launcher mode', () => {
  function createFakeCodexCapture() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fake-codex-'));
    const capturePath = path.join(fakeBin, 'capture.json');
    const codexPath = path.join(fakeBin, 'codex');
    fs.writeFileSync(codexPath, [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      "const http = require('http');",
      "const argv = process.argv.slice(2);",
      "const configArgs = argv.flatMap((arg, idx) => arg === '-c' ? [argv[idx + 1]] : []).filter(Boolean);",
      "const configArg = configArgs.find(arg => arg.includes('openai_base_url')) || null;",
      "const chatgptConfigArg = configArgs.find(arg => arg.includes('chatgpt_base_url')) || null;",
      "const openaiMatch = configArg && configArg.match(/openai_base_url=\"([^\"]+)\"/);",
      "const chatgptMatch = chatgptConfigArg && chatgptConfigArg.match(/chatgpt_base_url=\"([^\"]+)\"/);",
      "const openaiBaseUrl = openaiMatch ? openaiMatch[1] : null;",
      "const chatgptBaseUrl = chatgptMatch ? chatgptMatch[1] : null;",
      "function writeCapture(extra = {}) {",
      "  fs.writeFileSync(process.env.CCXRAY_TEST_CODEX_CAPTURE, JSON.stringify({ argv, configArgs, configArg, chatgptConfigArg, openaiBaseUrl, chatgptBaseUrl, cwd: process.cwd(), ...extra }));",
      "}",
      "function probeHealth(baseUrl) {",
      "  return new Promise(resolve => {",
      "    if (!baseUrl) return resolve(false);",
      "    const req = http.get(new URL('/_api/health', baseUrl), { timeout: 1000 }, res => {",
      "      let data = '';",
      "      res.on('data', c => { data += c; });",
      "      res.on('end', () => {",
      "        try { resolve(JSON.parse(data).ok === true); } catch { resolve(false); }",
      "      });",
      "    });",
      "    req.on('error', () => resolve(false));",
      "    req.on('timeout', () => { req.destroy(); resolve(false); });",
      "  });",
      "}",
      "(async () => {",
      "  const healthOk = await probeHealth(openaiBaseUrl);",
      "  writeCapture({ healthOk });",
      "  process.exit(healthOk ? 0 : 2);",
      "})().catch(err => {",
      "  writeCapture({ error: err.message });",
      "  process.exit(1);",
      "});",
    ].join('\n'));
    fs.chmodSync(codexPath, 0o755);
    return { fakeBin, capturePath };
  }

  it('launches codex app on macOS with the OpenAI proxy override', { skip: process.platform !== 'darwin' ? 'codex app is a macOS desktop launch path' : false }, async () => {
    const port = await findFreePort();
    const workspacePath = path.join(TEST_HOME, 'codex-desktop-workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    const { fakeBin, capturePath } = createFakeCodexCapture();

    try {
      const nodeBin = path.dirname(process.execPath);
      const { code, stderr } = await spawnAndCollect(
        ['--port', String(port), 'codex', 'app', workspacePath],
        8000,
        {
          PATH: `${fakeBin}${path.delimiter}${nodeBin}`,
          CCXRAY_TEST_CODEX_CAPTURE: capturePath,
        }
      );

      assert.equal(code, 0, stderr);
      const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capture.argv, [
        '-c',
        `openai_base_url="http://localhost:${port}/v1"`,
        '-c',
        `chatgpt_base_url="http://localhost:${port}/v1"`,
        'app',
        workspacePath,
      ]);
      assert.equal(capture.openaiBaseUrl, `http://localhost:${port}/v1`);
      assert.equal(capture.chatgptBaseUrl, `http://localhost:${port}/v1`);
      assert.equal(capture.healthOk, true);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

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
    const logsDir = path.join(TEST_HOME, 'logs');
    await waitFor(() => {
      const f = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
      return f.some(x => x.endsWith('_req.json')) && f.some(x => x.endsWith('_res.json'));
    });

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

  it('preserves request-level params (thinking, stream, etc.) in _req.json', async () => {
    const requestBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      stream: true,
      output_config: { effort: 'high' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      messages: [{ role: 'user', content: 'extraparams-test' }],
    });

    await sendProxyRequest(proxyPort, requestBody);

    const logsDir = path.join(TEST_HOME, 'logs');
    const req = await waitFor(() => {
      const reqFiles = fs.existsSync(logsDir)
        ? fs.readdirSync(logsDir).filter(f => f.endsWith('_req.json')).sort().reverse()
        : [];
      if (!reqFiles.length) return null;
      const latest = JSON.parse(fs.readFileSync(path.join(logsDir, reqFiles[0]), 'utf8'));
      return latest.model === 'claude-haiku-4-5-20251001' ? latest : null;
    });

    assert.equal(req.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(req.thinking, { type: 'adaptive' }, 'thinking must be preserved');
    assert.equal(req.stream, true, 'stream must be preserved');
    assert.deepEqual(req.output_config, { effort: 'high' }, 'output_config must be preserved');
    assert.ok(req.context_management, 'context_management must be preserved');
  });
});

// ── SSE streaming proxy E2E ─────────────────────────────────────────

describe('SSE streaming proxy', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;

  before(async () => {
    // Mock upstream that returns SSE event stream (like real Anthropic API)
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });

        // Simulate Anthropic SSE response
        const events = [
          { type: 'message_start', message: { id: 'msg_sse_test', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from SSE' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];

        let i = 0;
        const sendNext = () => {
          if (i >= events.length) { res.end(); return; }
          res.write(`event: ${events[i].type}\ndata: ${JSON.stringify(events[i])}\n\n`);
          i++;
          setTimeout(sendNext, 5);
        };
        sendNext();
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

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

  it('streams SSE chunks from upstream through proxy to client', async () => {
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test sse' }],
    });

    const { chunks, headers } = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => { chunks.push(c.toString()); });
        res.on('end', () => resolve({ chunks, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(requestBody);
    });

    // Verify SSE content-type preserved
    assert.ok(
      (headers['content-type'] || '').includes('text/event-stream'),
      'Response should be text/event-stream'
    );

    // Verify SSE events came through
    const fullResponse = chunks.join('');
    assert.ok(fullResponse.includes('message_start'), 'Should contain message_start event');
    assert.ok(fullResponse.includes('content_block_delta'), 'Should contain content_block_delta');
    assert.ok(fullResponse.includes('Hello '), 'Should contain streamed text "Hello "');
    assert.ok(fullResponse.includes('from SSE'), 'Should contain streamed text "from SSE"');
    assert.ok(fullResponse.includes('message_stop'), 'Should contain message_stop');
  });

  it('writes SSE response to log as parsed events array', async () => {
    const logsDir = path.join(TEST_HOME, 'logs');
    const resContent = await waitFor(() => {
      const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
      const resFiles = files.filter(f => f.endsWith('_res.json'));
      if (!resFiles.length) return null;
      const lastResFile = resFiles.sort().pop();
      const parsed = JSON.parse(fs.readFileSync(path.join(logsDir, lastResFile), 'utf8'));
      return (Array.isArray(parsed) && parsed.length >= 5) ? parsed : null;
    });

    // SSE responses are stored as parsed event arrays
    assert.ok(Array.isArray(resContent), 'SSE res log should be an array of events');
    assert.ok(resContent.length >= 5, `Expected >= 5 events, got ${resContent.length}`);

    // Verify event types are captured
    const types = resContent.map(e => e.type);
    assert.ok(types.includes('message_start'), 'Should log message_start');
    assert.ok(types.includes('content_block_delta'), 'Should log content_block_delta');
    assert.ok(types.includes('message_stop'), 'Should log message_stop');
  });
});

// ── OpenAI Responses raw capture ────────────────────────────────────

describe('OpenAI Responses raw capture', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let receivedReq = null;

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
        if (req.url.includes('stream=1') && req.url.includes('tools=1')) {
          // SSE response with function_call output item
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end([
            'event: response.output_item.done',
            'data: ' + JSON.stringify({
              type: 'response.output_item.done',
              item: { type: 'function_call', name: 'exec_command', call_id: 'call_t1', status: 'completed', arguments: '{"cmd":"ls"}' },
              output_index: 0,
            }),
            '',
            'event: response.completed',
            'data: ' + JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_sse_tools', object: 'response', model: 'gpt-5.5', status: 'completed',
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                output: [{ type: 'function_call', name: 'exec_command', call_id: 'call_t1' }] },
            }),
            '',
          ].join('\n'));
          return;
        }
        if (req.url.includes('stream=1')) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'x-openai-mock': 'responses-stream' });
          res.end([
            'event: response.created',
            'data: ' + JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_stream_v0', object: 'response', model: 'gpt-5.5', status: 'in_progress' },
            }),
            '',
            'event: response.completed',
            'data: ' + JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_stream_v0',
                object: 'response',
                model: 'gpt-5.5',
                status: 'completed',
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'stream ok' }] }],
              },
            }),
            '',
          ].join('\n'));
          return;
        }
        if (req.url.includes('tools=1')) {
          // Non-SSE JSON response with function_call in output[]
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp_json_tools', object: 'response', model: 'gpt-5.5', status: 'completed',
            output: [
              { type: 'function_call', name: 'exec_command', call_id: 'call_j1' },
              { type: 'function_call', name: 'apply_patch', call_id: 'call_j2' },
            ],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-openai-mock': 'responses' });
        res.end(JSON.stringify({
          id: 'resp_raw_v0',
          object: 'response',
          model: 'gpt-5.1-codex',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'codex ok' }] }],
        }));
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        OPENAI_TEST_HOST: 'localhost',
        OPENAI_TEST_PORT: String(mockPort),
        OPENAI_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('forwards /v1/responses to OpenAI upstream and logs full raw req/res JSON', async () => {
    const requestBody = JSON.stringify({
      model: 'gpt-5.1-codex',
      instructions: 'You are Codex in raw capture mode.',
      input: 'inspect the repository',
      tools: [{ type: 'function', name: 'shell' }],
    });

    const response = await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?trace=1');

    assert.equal(response.status, 200);
    assert.ok(receivedReq, 'mock OpenAI upstream should receive the request');
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/v1/responses?trace=1');
    assert.equal(JSON.parse(receivedReq.body).instructions, 'You are Codex in raw capture mode.');

    const logsDir = path.join(TEST_HOME, 'logs');
    const entry = await waitFor(() => readIndex(logsDir).find(e => e.provider === 'openai' && e.agent === 'codex' && e.model === 'gpt-5.1-codex'));
    assert.ok(entry, 'expected OpenAI index entry');
    assert.equal(entry.sessionId, 'codex-raw');
    assert.equal(entry.cost, null);

    const reqLog = JSON.parse(fs.readFileSync(path.join(logsDir, `${entry.id}_req.json`), 'utf8'));
    assert.equal(reqLog.instructions, 'You are Codex in raw capture mode.');
    assert.equal(reqLog.input, 'inspect the repository');
    assert.equal(reqLog.prevId, undefined);

    const resLog = JSON.parse(fs.readFileSync(path.join(logsDir, `${entry.id}_res.json`), 'utf8'));
    assert.equal(resLog.id, 'resp_raw_v0');
    assert.equal(resLog.output[0].content[0].text, 'codex ok');
  });

  it('normalizes OpenAI SSE-shaped responses even without event-stream headers', async () => {
    const requestBody = JSON.stringify({
      model: 'gpt-5.5',
      input: 'stream the result',
      stream: true,
    });

    const response = await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?stream=1');

    assert.equal(response.status, 200);

    const logsDir = path.join(TEST_HOME, 'logs');
    const entry = await waitFor(() => readIndex(logsDir).find(e => e.responseMetadata?.id === 'resp_stream_v0'));
    assert.ok(entry, 'expected OpenAI stream index entry');
    assert.equal(entry.isSSE, true);
    assert.equal(entry.model, 'gpt-5.5');
    assert.equal(entry.stopReason, 'completed');
    assert.equal(entry.usage.input_tokens, 10);
    assert.equal(entry.responseMetadata.responseStatus, 'completed');

    const resLog = JSON.parse(fs.readFileSync(path.join(logsDir, `${entry.id}_res.json`), 'utf8'));
    const finalEvent = resLog[resLog.length - 1];
    assert.equal(finalEvent.type, 'response.completed');
    assert.equal(finalEvent.data.response.output[0].content[0].text, 'stream ok');
  });

  it('HTTP SSE OpenAI response with function_call populates entry.toolCalls', async () => {
    const requestBody = JSON.stringify({ model: 'gpt-5.5', input: 'run ls', stream: true });
    await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?stream=1&tools=1');

    const logsDir = path.join(TEST_HOME, 'logs');
    const entry = await waitFor(() => readIndex(logsDir).find(e => e.responseMetadata?.id === 'resp_sse_tools'));
    assert.ok(entry, 'expected SSE tools entry');
    assert.equal(entry.toolCalls.Bash, 1, 'exec_command should be aliased to Bash');
  });

  it('HTTP non-SSE OpenAI JSON with function_call in output[] populates entry.toolCalls', async () => {
    const requestBody = JSON.stringify({ model: 'gpt-5.5', input: 'edit file' });
    await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?tools=1');

    const logsDir = path.join(TEST_HOME, 'logs');
    const entry = await waitFor(() => readIndex(logsDir).find(e => e.provider === 'openai' && e.responseMetadata?.id === 'resp_json_tools'));
    assert.ok(entry, 'expected non-SSE JSON tools entry');
    assert.equal(entry.toolCalls.Bash, 1, 'exec_command should be aliased to Bash');
    assert.equal(entry.toolCalls.Edit, 1, 'apply_patch should be aliased to Edit');
  });

  it('groups Codex turns by session_id header and marks OpenAI subagents', async () => {
    const sessionId = 'codex-session-header-001';
    const mainBody = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'You are Codex. Keep responses short.',
      input: 'main turn',
    });
    const subagentBody = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'You are a worker agent for Codex. Execute the requested task.',
      input: 'worker turn',
    });

    await sendOpenAIResponsesRequest(proxyPort, mainBody, '/v1/responses?trace=session-main', { session_id: sessionId });
    await sendOpenAIResponsesRequest(proxyPort, subagentBody, '/v1/responses?trace=session-worker', {
      session_id: sessionId,
      'x-openai-subagent': 'worker',
    });
    const logsDir = path.join(TEST_HOME, 'logs');
    const indexEntries = await waitFor(() => {
      const es = readIndex(logsDir).filter(e => e.sessionId === sessionId);
      return es.length === 2 ? es : null;
    });

    assert.equal(indexEntries.length, 2);
    assert.equal(indexEntries[0].isSubagent, false);
    assert.equal(indexEntries[0].sessionInferred, false);
    assert.equal(indexEntries[1].isSubagent, true);
    assert.equal(indexEntries[1].sessionInferred, false);
  });

  it('captures Codex instructions in the System Prompt version index', async () => {
    const sessionId = 'codex-system-prompt-001';
    const requestBody = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'You are an explorer agent for Codex. Inspect the codebase and report findings.',
      input: 'inspect prompt index',
    });

    await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?trace=sysprompt', {
      session_id: sessionId,
      'x-openai-subagent': 'explorer',
    });
    const explorer = await waitFor(async () => {
      const data = await httpGet(proxyPort, '/_api/sysprompt/versions');
      return data.versions.find(v => v.agentKey === 'explorer');
    });
    assert.ok(explorer, 'expected Codex explorer prompt version');
    assert.equal(explorer.agentLabel, 'Codex Explorer');
    assert.ok(explorer.coreHash);
    assert.ok(explorer.b2Len > 0);
  });

  it('restores Codex prompt agent type from metadata sidecar instead of instruction text', async () => {
    const sessionId = 'codex-system-prompt-restore-001';
    const requestBody = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'Inspect the codebase and report findings.',
      input: 'inspect prompt restore',
    });

    await sendOpenAIResponsesRequest(proxyPort, requestBody, '/v1/responses?trace=sysprompt-restore', {
      session_id: sessionId,
      'x-openai-subagent': 'worker',
    });
    const workerLen = 'Inspect the codebase and report findings.'.length;
    // Ensure the prompt version is persisted before we kill the proxy, so the
    // restart genuinely tests restore (not a write that never reached disk).
    await waitFor(async () => {
      const data = await httpGet(proxyPort, '/_api/sysprompt/versions');
      return data.versions.find(v => v.agentKey === 'worker' && v.b2Len === workerLen);
    });

    await killAndWait(proxyChild);
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        OPENAI_TEST_HOST: 'localhost',
        OPENAI_TEST_PORT: String(mockPort),
        OPENAI_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    const worker = await waitFor(async () => {
      const data = await httpGet(proxyPort, '/_api/sysprompt/versions');
      return data.versions.find(v => v.agentKey === 'worker' && v.b2Len === workerLen);
    });
    assert.ok(worker, 'expected restored Codex worker prompt version');
    assert.equal(worker.agentLabel, 'Codex Worker');
  });
});

// ── Intercept lifecycle E2E ──────────────────────────────────────────

describe('Intercept lifecycle', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  const TEST_SESSION = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
  let mockUpstreamNextResponse = null;

  function makeRequestBody(content) {
    return JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content }],
      metadata: { user_id: JSON.stringify({ session_id: TEST_SESSION }) },
    });
  }

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (mockUpstreamNextResponse) {
          const r = mockUpstreamNextResponse;
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_intercept',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'approved response' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    // Establish session by sending initial request
    const initBody = makeRequestBody('init session');
    await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(initBody), 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(initBody);
    });
  });

  after(async () => {
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('toggle intercept on/off', async () => {
    // Enable intercept
    const on = await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    assert.equal(on.enabled, true);
    assert.equal(on.sessionId, TEST_SESSION);

    // Disable intercept
    const off = await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    assert.equal(off.enabled, false);
  });

  it('intercept → approve → request forwarded', async () => {
    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    // Connect SSE to catch pending_request event
    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');

    // Send request — should be held
    const body = makeRequestBody('intercept me');
    const responsePromise = sendProxyRequest(proxyPort, body);

    // Wait for SSE to tell us the pending request ID
    const pendingId = await pendingIdPromise;
    assert.ok(pendingId, 'Should receive pending_request via SSE');

    // Approve the request
    const approveResult = await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/approve`, {});
    assert.equal(approveResult.ok, true);

    // Original request should complete
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('approved response'));

    // Disable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
  });

  it('intercept → reject → client gets 499', async () => {
    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');

    const body = makeRequestBody('reject me');
    const responsePromise = sendProxyRequest(proxyPort, body);

    const pendingId = await pendingIdPromise;
    assert.ok(pendingId, 'Should receive pending_request via SSE');

    // Reject the request
    const rejectResult = await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/reject`, {});
    assert.equal(rejectResult.ok, true);

    // Client should get 499
    const response = await responsePromise;
    assert.equal(response.status, 499);
    assert.ok(response.body.includes('request_rejected'));

    // Cleanup
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
  });

  it('intercept → approve → upstream 500 → state recovers', async () => {
    // Make upstream return 500 for next request
    mockUpstreamNextResponse = { status: 500, body: { type: 'error', error: { message: 'boom' } } };

    // Enable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });

    const pendingIdPromise = waitForSSEEvent(proxyPort, 'pending_request');
    const body = makeRequestBody('intercept then fail');
    const responsePromise = sendProxyRequest(proxyPort, body);

    const pendingId = await pendingIdPromise;
    assert.ok(pendingId);

    // Approve — proxy forwards to upstream which returns 500
    await httpPost(proxyPort, `/_api/intercept/${encodeURIComponent(pendingId)}/approve`, {});

    const response = await responsePromise;
    assert.equal(response.status, 500, 'Client should get the 500 from upstream');

    // Disable intercept
    await httpPost(proxyPort, '/_api/intercept/toggle', { sessionId: TEST_SESSION });
    mockUpstreamNextResponse = null;

    // Verify proxy is still healthy
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

// ── Proxy error paths ───────────────────────────────────────────────

describe('Proxy error paths', () => {
  let proxyChild;
  let proxyPort;
  // No mock upstream — proxy points to a port with nothing listening
  const DEAD_PORT = 1; // privileged, guaranteed no listener

  before(async () => {
    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(DEAD_PORT),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
  });

  it('E1: upstream connection refused → 502 proxy_error', async () => {
    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test error' }],
    }));

    assert.equal(response.status, 502);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'proxy_error');
    assert.ok(body.message, 'Should have error message');
  });

  it('E1: proxy survives after upstream error (not crashed)', async () => {
    // Health check still works after error
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

describe('Proxy upstream error responses', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let nextResponse = null;

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (nextResponse) {
          const { status, headers, body: resBody, sse, destroyAfter } = nextResponse;
          res.writeHead(status, headers || { 'Content-Type': 'application/json' });
          if (sse) {
            // Send partial SSE then destroy connection
            for (const chunk of sse) {
              res.write(chunk);
            }
            if (destroyAfter) {
              setTimeout(() => res.end(), 50);
            } else if (nextResponse.socketDestroy) {
              setTimeout(() => res.socket.destroy(), 50);
            } else {
              res.end();
            }
          } else {
            res.end(typeof resBody === 'string' ? resBody : JSON.stringify(resBody));
          }
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_ok', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
        }
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

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
    nextResponse = null;
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('E2: upstream 500 → passthrough to client', async () => {
    nextResponse = {
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test 500' }],
    }));

    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.type, 'error');
    nextResponse = null;
  });

  it('E2: upstream 429 rate limit → passthrough to client', async () => {
    nextResponse = {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'retry-after': '30',
      },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test 429' }],
    }));

    assert.equal(response.status, 429);
    const body = JSON.parse(response.body);
    assert.equal(body.error.type, 'rate_limit_error');
    nextResponse = null;
  });

  it('E3: SSE stream aborted mid-response → client gets partial data', async () => {
    nextResponse = {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      sse: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial "}}\n\n',
      ],
      destroyAfter: true, // destroy connection after sending partial events
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test abort' }],
    }));

    // Client should receive partial SSE data (whatever was forwarded before disconnect)
    assert.ok(response.body.includes('message_start'), 'Should have received message_start');
    assert.ok(response.body.includes('partial '), 'Should have received partial text');
    // No message_stop — stream was cut
    nextResponse = null;
  });

  it('E3: proxy survives SSE abort (not crashed)', async () => {
    nextResponse = null;
    await new Promise(r => setTimeout(r, 200));
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });

  it('E3b: upstream socket destroyed mid-SSE → proxy handles ECONNRESET', async () => {
    nextResponse = {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      sse: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_reset","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before reset"}}\n\n',
      ],
      socketDestroy: true,
    };

    const response = await sendProxyRequest(proxyPort, JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'test reset' }],
    }));

    // Client response should have ended (not hung)
    assert.ok(response.status >= 200, 'Should receive a response, not hang');
    nextResponse = null;
  });

  it('E3b: proxy survives socket destroy', async () => {
    await new Promise(r => setTimeout(r, 300));
    const health = await httpGet(proxyPort, '/_api/health');
    assert.deepEqual(health, { ok: true });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

// ── State consistency after errors ──────────────────────────────────

describe('Store state consistency after errors', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let nextResponse = null;
  const SESSION_ID = 'bbbbcccc-dddd-eeee-ffff-000000000000';

  function makeBody(content) {
    return JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content }],
      metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    });
  }

  before(async () => {
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (nextResponse) {
          const { status, headers, body: resBody } = nextResponse;
          res.writeHead(status, headers || { 'Content-Type': 'application/json' });
          res.end(typeof resBody === 'string' ? resBody : JSON.stringify(resBody));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_ok', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: 'claude-sonnet-4-20250514',
            usage: { input_tokens: 10, output_tokens: 5 },
          }));
        }
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

    proxyPort = await findFreePort();
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: {
        ANTHROPIC_TEST_HOST: 'localhost',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    await waitForPort(proxyPort);

    // Establish session
    await sendProxyRequest(proxyPort, makeBody('init'));
    await new Promise(r => setTimeout(r, 200));
  });

  after(async () => {
    nextResponse = null;
    await killAndWait(proxyChild);
    await new Promise(r => mockUpstream.close(r));
  });

  it('session becomes inactive after upstream 500', async () => {
    nextResponse = { status: 500, body: { type: 'error', error: { message: 'fail' } } };
    await sendProxyRequest(proxyPort, makeBody('trigger 500'));
    nextResponse = null;

    // Check session status via SSE — should become inactive after the error
    const sessionStatus = await waitFor(async () => {
      const sseData = await collectSSESnapshot(proxyPort);
      return sseData.find(d => d._type === 'session_status' && d.sessionId === SESSION_ID && d.active === false);
    });
    assert.ok(sessionStatus, 'Should have session_status event');
    assert.equal(sessionStatus.active, false, 'Session should be inactive after error');
  });

  it('subsequent request succeeds after previous error', async () => {
    nextResponse = null; // back to normal
    const response = await sendProxyRequest(proxyPort, makeBody('after error'));
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.content[0].text, 'ok');
  });

  it('entries count is consistent after mixed success/error', async () => {
    const { entries } = await httpGet(proxyPort, '/_api/entries');
    // Should have entries from: init, trigger 500, after error (at least 3)
    assert.ok(entries.length >= 3, `Expected >= 3 entries, got ${entries.length}`);
  });
});

// ── Concurrent requests ─────────────────────────────────────────────

describe('Concurrent proxy requests', () => {
  let mockUpstream;
  let mockPort;
  let proxyChild;
  let proxyPort;
  let requestLog = [];

  before(async () => {
    // Mock upstream: echo user message back. SSE mode when stream:true.
    mockUpstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userMsg = parsed.messages?.[0]?.content || 'unknown';
        const delay = Math.floor(Math.random() * 50) + 10;
        setTimeout(() => {
          requestLog.push(userMsg);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${userMsg}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`);
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `echo:${userMsg}` } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_${userMsg}`, type: 'message', role: 'assistant',
              content: [{ type: 'text', text: `echo:${userMsg}` }],
              model: 'claude-sonnet-4-20250514',
              usage: { input_tokens: 10, output_tokens: 5 },
            }));
          }
        }, delay);
      });
    });
    await new Promise(r => mockUpstream.listen(0, r));
    mockPort = mockUpstream.address().port;

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

  it('5 concurrent requests each get correct response', async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    const responses = await Promise.all(ids.map(id =>
      sendProxyRequest(proxyPort, JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: id }],
      }))
    ));

    // Each response should echo back its own request ID
    for (let i = 0; i < ids.length; i++) {
      assert.equal(responses[i].status, 200, `Request ${ids[i]} should succeed`);
      const body = JSON.parse(responses[i].body);
      assert.equal(body.content[0].text, `echo:${ids[i]}`, `Response for ${ids[i]} should match`);
    }
  });

  it('3 concurrent SSE streaming requests each get correct events', async () => {
    const ids = ['stream-a', 'stream-b', 'stream-c'];

    const responses = await Promise.all(ids.map(id =>
      sendProxyRequest(proxyPort, JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: id }],
      }))
    ));

    for (let i = 0; i < ids.length; i++) {
      assert.equal(responses[i].status, 200, `SSE request ${ids[i]} should succeed`);
      assert.ok(responses[i].body.includes(`echo:${ids[i]}`), `SSE response for ${ids[i]} should contain its echo`);
    }
  });

  it('all concurrent requests are logged separately', async () => {
    const logsDir = path.join(TEST_HOME, 'logs');
    const reqFiles = await waitFor(() => {
      const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
      const rf = files.filter(f => f.endsWith('_req.json'));
      return rf.length >= 5 ? rf : null;
    });
    // Should have at least 5 req files from concurrent test
    assert.ok(reqFiles.length >= 5, `Expected >= 5 req logs, got ${reqFiles.length}`);
  });

  it('upstream received all 8 requests (5 non-streaming + 3 streaming)', () => {
    assert.equal(requestLog.length, 8, 'Mock upstream should have received 8 requests');
    const sorted = [...requestLog].sort();
    assert.deepEqual(sorted, ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'stream-a', 'stream-b', 'stream-c']);
  });
});

// ── Hub crash recovery race condition ────────────────────────────────

describe('Hub recovery race: two simultaneous forks', () => {
  let port;

  after(() => {
    // Kill any hub on port
    try {
      const lockPath = path.join(TEST_HOME, 'hub.json');
      if (fs.existsSync(lockPath)) {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        try { process.kill(lock.pid, 'SIGKILL'); } catch {}
        fs.unlinkSync(lockPath);
      }
    } catch {}
  });

  it('two concurrent forkHub calls → only one hub survives', async () => {
    port = await findFreePort();

    // Fork two hubs simultaneously on the same port
    const child1 = spawnServer(['--port', String(port), '--hub-mode']);
    const child2 = spawnServer(['--port', String(port), '--hub-mode']);

    // Wait for one to succeed (write lockfile)
    await waitForPort(port);

    // Only one hub should be listening
    const health = await httpGet(port, '/_api/health');
    assert.deepEqual(health, { ok: true });

    // Lockfile should exist with correct port
    const lockPath = path.join(TEST_HOME, 'hub.json');
    assert.ok(fs.existsSync(lockPath));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.port, port);

    // Clean up both children
    await killAndWait(child1);
    await killAndWait(child2);

    // Wait for port release
    await new Promise(resolve => {
      const check = () => {
        const srv = net.createServer();
        srv.once('error', () => setTimeout(check, 200));
        srv.once('listening', () => srv.close(() => resolve()));
        srv.listen(port);
      };
      check();
    });
  });
});

function collectSSESnapshot(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const events = [];
    const req = http.get(`http://localhost:${port}/_events`, res => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(events); });
    });
    req.on('error', () => resolve(events));
  });
}

function waitForSSEEvent(port, eventType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/_events`, res => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout waiting for ${eventType}`)); }, timeoutMs);
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data._type === eventType) {
              clearTimeout(timer);
              req.destroy();
              resolve(data.requestId || data.id || null);
              return;
            }
          } catch {}
        }
      });
    });
    req.on('error', () => {}); // ignore destroy errors
  });
}

function sendProxyRequest(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sendOpenAIResponsesRequest(port, body, urlPath = '/v1/responses', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer test-key', ...extraHeaders },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON: ${data}`)); }
      });
    });
    req.on('error', reject);
    // Reject (don't hang) if the proxy accepts the socket but never responds.
    req.setTimeout(5000, () => req.destroy(new Error('httpGet timeout')));
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

function httpGetFull(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
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

describe('Proxy loop startup guard', () => {
  it('exits when ANTHROPIC_BASE_URL points back to itself (claude mode)', async () => {
    const proxyPort = await findFreePort();
    const { stderr, code } = await spawnAndCollect(['--port', String(proxyPort)], 10000, {
      ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
    });

    assert.equal(code, 1);
    assert.ok(stderr.includes('ANTHROPIC_BASE_URL points back to ccxray'), `Expected loop error, got: ${stderr}`);
    assert.ok(stderr.includes('--allow-upstream-loop'), `Expected override hint, got: ${stderr}`);
  });

  it('exits when OPENAI_BASE_URL points back to itself (codex mode)', async () => {
    const proxyPort = await findFreePort();
    const { stderr, code } = await spawnAndCollect(['--port', String(proxyPort), 'codex'], 10000, {
      OPENAI_BASE_URL: `http://localhost:${proxyPort}/v1`,
    });

    assert.equal(code, 1);
    assert.ok(stderr.includes('OPENAI_BASE_URL points back to ccxray'), `Expected loop error, got: ${stderr}`);
    assert.ok(stderr.includes('--allow-upstream-loop'), `Expected override hint, got: ${stderr}`);
  });

  it('does NOT exit when ANTHROPIC_BASE_URL loops but running codex (different upstream)', async () => {
    const proxyPort = await findFreePort();

    // Create a stub 'codex' binary so the server can launch it without ENOENT in CI
    // (real codex may not be installed in the test environment)
    const stubBinDir = path.join(TEST_HOME, 'stub-bin');
    fs.mkdirSync(stubBinDir, { recursive: true });
    const stubCodex = path.join(stubBinDir, 'codex');
    fs.writeFileSync(stubCodex, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });

    const proxyChild = spawnServer(['--port', String(proxyPort), 'codex'], {
      env: {
        ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`,
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });

    try {
      await waitForPort(proxyPort);
      const health = await httpGet(proxyPort, '/_api/health');
      assert.deepEqual(health, { ok: true });
    } finally {
      await killAndWait(proxyChild);
    }
  });

  it('allows startup with --allow-upstream-loop override', async () => {
    const proxyPort = await findFreePort();
    const proxyChild = spawnServer(['--port', String(proxyPort), '--allow-upstream-loop'], {
      env: { ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}` },
    });

    try {
      await waitForPort(proxyPort);
      const health = await httpGet(proxyPort, '/_api/health');
      assert.deepEqual(health, { ok: true });
    } finally {
      await killAndWait(proxyChild);
    }
  });

  it('allows startup with CCXRAY_ALLOW_UPSTREAM_LOOP=1 override', async () => {
    const proxyPort = await findFreePort();
    const proxyChild = spawnServer(['--port', String(proxyPort)], {
      env: { ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}`, CCXRAY_ALLOW_UPSTREAM_LOOP: '1' },
    });

    try {
      await waitForPort(proxyPort);
      const health = await httpGet(proxyPort, '/_api/health');
      assert.deepEqual(health, { ok: true });
    } finally {
      await killAndWait(proxyChild);
    }
  });

  it('exits when CHATGPT_BASE_URL points back to itself (codex ChatGPT-auth)', async () => {
    const proxyPort = await findFreePort();
    const { stderr, code } = await spawnAndCollect(['--port', String(proxyPort), 'codex'], 10000, {
      CHATGPT_BASE_URL: `http://localhost:${proxyPort}/v1`,
    });

    assert.equal(code, 1);
    assert.ok(stderr.includes('CHATGPT_BASE_URL points back to ccxray'), `Expected loop error, got: ${stderr}`);
    assert.ok(stderr.includes('--allow-upstream-loop'), `Expected override hint, got: ${stderr}`);
  });

  it('does NOT exit when CHATGPT_BASE_URL is left at the built-in default (chatgpt.com)', async () => {
    // Sanity check: built-in default must never self-loop.
    const proxyPort = await findFreePort();

    const stubBinDir = path.join(TEST_HOME, 'stub-bin-chatgpt-default');
    fs.mkdirSync(stubBinDir, { recursive: true });
    const stubCodex = path.join(stubBinDir, 'codex');
    fs.writeFileSync(stubCodex, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });

    const proxyChild = spawnServer(['--port', String(proxyPort), 'codex'], {
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });

    try {
      await waitForPort(proxyPort);
      const health = await httpGet(proxyPort, '/_api/health');
      assert.deepEqual(health, { ok: true });
    } finally {
      await killAndWait(proxyChild);
    }
  });
});
