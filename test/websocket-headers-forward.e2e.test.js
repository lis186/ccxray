'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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

describe('WebSocket upgrade header forwarding + ChatGPT routing (PR #29, 0ff5507)', () => {
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('forwards chatgpt-account-id and custom headers to ChatGPT upstream when header is present', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ws-headers-'));
    tmpDirs.push(home);

    let capturedHeaders = null;
    let capturedPath = null;
    const upstreamHttp = http.createServer();
    const upstreamWss = new WebSocket.Server({ noServer: true });
    upstreamHttp.on('upgrade', (req, socket, head) => {
      capturedHeaders = { ...req.headers };
      capturedPath = req.url;
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        setTimeout(() => { try { ws.send('hello'); ws.close(1000, 'bye'); } catch (_) {} }, 50);
      });
    });
    await new Promise(resolve => upstreamHttp.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        // Route both OpenAI and ChatGPT upstream to our fake server.
        // When the client sends chatgpt-account-id, config.js routes to CHATGPT_BASE_URL.
        OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForPort(proxyPort);

      const customHeaders = {
        'chatgpt-account-id': 'acct-test-12345',
        'openai-beta': 'realtime=v1',
        'x-mark': 'verify-canary',
      };
      const wsUrl = `ws://localhost:${proxyPort}/v1/realtime?model=gpt-4o-realtime-preview`;
      const ws = new WebSocket(wsUrl, { headers: customHeaders });

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout')), 4000);
        ws.once('open', () => { clearTimeout(t); resolve(); });
        ws.once('error', e => { clearTimeout(t); reject(e); });
      });
      await new Promise(r => setTimeout(r, 200));
      ws.close();
      await new Promise(r => setTimeout(r, 300));

      assert.ok(capturedHeaders, 'upstream must have received a WS upgrade');
      assert.equal(capturedHeaders['chatgpt-account-id'], 'acct-test-12345',
        'chatgpt-account-id must be forwarded intact');
      assert.equal(capturedHeaders['openai-beta'], 'realtime=v1',
        'openai-beta must be forwarded intact');
      assert.equal(capturedHeaders['x-mark'], 'verify-canary',
        'custom headers must pass through');
      assert.equal(capturedHeaders['host'], '127.0.0.1',
        'host must be rewritten to upstream hostname (no port — buildWebSocketHeaders sets host = upstream.host)');

      // ChatGPT routing: when chatgpt-account-id is present, ccxray strips /v1
      // prefix and prepends /backend-api/codex (the CHATGPT_BASE_URL path).
      assert.match(capturedPath, /^\/backend-api\/codex\/realtime\?model=gpt-4o-realtime-preview$/,
        `upstream path should be ChatGPT-rewritten, got ${capturedPath}`);
    } finally {
      upstreamHttp.close();
      await killAndWait(child);
    }
  });
});
