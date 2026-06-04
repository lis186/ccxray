'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { deriveUpstreamToken } = require('./helpers/upstream-token');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const tmpDirs = [];

async function findFreePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

function makeTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-auth-e2e-'));
  tmpDirs.push(home);
  return home;
}

function postJson(port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-api-key': 'sk-fake',
        'anthropic-version': '2023-06-01',
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

describe('Auth header injection E2E (1.4)', () => {
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('strips X-Ccxray-Auth and X-Ccxray-Bootstrap from HTTP requests forwarded to upstream', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const upstreamRequests = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant',
        model: 'claude-3-haiku-20240307', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    let stderr = '';
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);

      const resp = await postJson(proxyPort, '/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      }, {
        // Valid token so 2.2 enforcement passes; the point of this test is that
        // it is stripped before forwarding, not that it is rejected.
        'x-ccxray-auth': deriveUpstreamToken({ home }),
        'x-ccxray-bootstrap': 'bootstrap-secret-456',
      });

      assert.equal(resp.statusCode, 200, 'proxy should forward and respond 200');
      assert.equal(upstreamRequests.length, 1, 'upstream should receive exactly one request');

      const fwdHeaders = upstreamRequests[0].headers;
      assert.equal(fwdHeaders['x-ccxray-auth'], undefined,
        'X-Ccxray-Auth must NOT be forwarded to upstream');
      assert.equal(fwdHeaders['x-ccxray-bootstrap'], undefined,
        'X-Ccxray-Bootstrap must NOT be forwarded to upstream');
      assert.ok(fwdHeaders['x-api-key'], 'x-api-key should still be forwarded');
      assert.ok(fwdHeaders['anthropic-version'], 'anthropic-version should still be forwarded');
    } finally {
      upstream.close();
      await killAndWait(child);
    }
  });

  it('X-Ccxray-Auth does NOT appear in disk logs (_req.json)', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant',
        model: 'claude-3-haiku-20240307', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await waitForPort(proxyPort);

      const upstreamToken = deriveUpstreamToken({ home });
      await postJson(proxyPort, '/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      }, {
        'x-ccxray-auth': upstreamToken,
        'cookie': 'ccxray_s=sensitive-session-cookie',
      });

      // Wait for async disk write
      await new Promise(r => setTimeout(r, 500));

      const logsDir = path.join(home, 'logs');
      if (fs.existsSync(logsDir)) {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          const content = fs.readFileSync(path.join(logsDir, f), 'utf8');
          assert.ok(!content.includes(upstreamToken),
            `X-Ccxray-Auth value leaked to ${f}`);
          assert.ok(!content.includes('sensitive-session-cookie'),
            `Cookie value leaked to ${f}`);
        }
      }
    } finally {
      upstream.close();
      await killAndWait(child);
    }
  });

  it('prints deprecation banner when CCXRAY_LOOPBACK_NO_AUTH=1', async () => {
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    let stderr = '';
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        CCXRAY_LOOPBACK_NO_AUTH: '1',
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);
      await new Promise(r => setTimeout(r, 300));
      assert.match(stderr, /CCXRAY_LOOPBACK_NO_AUTH/,
        'startup banner should name the flag so the operator knows upstream auth is disabled');
    } finally {
      await killAndWait(child);
    }
  });

  it('prints paranoid-mode banner when CCXRAY_LOOPBACK_REQUIRE_AUTH=1', async () => {
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    let stderr = '';
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        CCXRAY_LOOPBACK_REQUIRE_AUTH: '1',
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);
      await new Promise(r => setTimeout(r, 300));
      assert.match(stderr, /CCXRAY_LOOPBACK_REQUIRE_AUTH/,
        'startup banner should name the paranoid flag');
    } finally {
      await killAndWait(child);
    }
  });

  it('WS upgrade without X-Ccxray-Auth is rejected with 401 (enforcement on)', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const upstreamWss = new WebSocket.Server({ noServer: true });
    const upstreamHttp = http.createServer();
    upstreamHttp.on('upgrade', (req, socket, head) => {
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', data => ws.send(data));
        setTimeout(() => ws.close(1000, 'done'), 500);
      });
    });
    await new Promise(resolve => upstreamHttp.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(upstreamPort),
        OPENAI_TEST_PROTOCOL: 'http',
        CCXRAY_LOOPBACK_REQUIRE_AUTH: '1',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await waitForPort(proxyPort);

      // No X-Ccxray-Auth and no ChatGPT-OAuth markers — enforcement rejects 401.
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=v1',
          'codex-session-id': 'test-session-123',
        },
      });

      const result = await new Promise((resolve) => {
        ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ statusCode: res.statusCode }); });
        ws.on('open', () => resolve({ opened: true }));
        ws.on('error', err => resolve({ error: err.message }));
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
      assert.equal(result.statusCode, 401, 'WS upgrade without X-Ccxray-Auth must be rejected with 401');
    } finally {
      upstreamHttp.close();
      await killAndWait(child);
    }
  });

  it('WS upgrade with ChatGPT-OAuth markers is accepted (carve-out)', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const upstreamWss = new WebSocket.Server({ noServer: true });
    const upstreamHttp = http.createServer();
    upstreamHttp.on('upgrade', (req, socket, head) => {
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        setTimeout(() => ws.close(1000, 'done'), 500);
      });
    });
    await new Promise(resolve => upstreamHttp.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(upstreamPort),
        OPENAI_TEST_PROTOCOL: 'http',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await waitForPort(proxyPort);

      // ChatGPT-OAuth carve-out: chatgpt-account-id + JWT, no X-Ccxray-Auth → accepted.
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=v1',
          'chatgpt-account-id': 'acct-test-456',
          'authorization': 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakesig',
          'codex-session-id': 'test-session-oauth',
        },
      });

      const result = await new Promise((resolve) => {
        ws.on('open', () => resolve({ opened: true }));
        ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ statusCode: res.statusCode }); });
        ws.on('error', err => resolve({ error: err.message }));
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
      assert.ok(result.opened, `ChatGPT-OAuth carve-out should connect, got ${JSON.stringify(result)}`);
    } finally {
      upstreamHttp.close();
      await killAndWait(child);
    }
  });

  it('WS upgrade strips X-Ccxray-Auth before forwarding to upstream', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const receivedUpgradeHeaders = [];
    const upstreamWss = new WebSocket.Server({ noServer: true });
    const upstreamHttp = http.createServer();
    upstreamHttp.on('upgrade', (req, socket, head) => {
      receivedUpgradeHeaders.push({ ...req.headers });
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        setTimeout(() => ws.close(1000, 'done'), 500);
      });
    });
    await new Promise(resolve => upstreamHttp.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(upstreamPort),
        OPENAI_TEST_PROTOCOL: 'http',
        AUTH_TOKEN: 'ws-strip-secret',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    try {
      await waitForPort(proxyPort);

      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=v1',
          // Valid token so 2.2 enforcement passes; the test asserts it is stripped upstream.
          'x-ccxray-auth': deriveUpstreamToken({ home, authToken: 'ws-strip-secret' }),
          'x-ccxray-bootstrap': 'also-must-not-reach',
          'authorization': 'Bearer sk-real-key',
          'codex-session-id': 'test-session-strip',
        },
      });

      await new Promise((resolve, reject) => {
        ws.on('open', () => resolve(true));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 5000);
      });

      await new Promise(resolve => {
        ws.on('close', resolve);
        setTimeout(resolve, 2000);
      });

      assert.equal(receivedUpgradeHeaders.length, 1, 'upstream should receive one upgrade');
      const h = receivedUpgradeHeaders[0];
      assert.equal(h['x-ccxray-auth'], undefined,
        'X-Ccxray-Auth must NOT reach upstream via WS');
      assert.equal(h['x-ccxray-bootstrap'], undefined,
        'X-Ccxray-Bootstrap must NOT reach upstream via WS');
      assert.equal(h['authorization'], 'Bearer sk-real-key',
        'Authorization header should be preserved');
      assert.ok(h['openai-beta'], 'openai-beta should be preserved');
    } finally {
      upstreamHttp.close();
      await killAndWait(child);
    }
  });
});
