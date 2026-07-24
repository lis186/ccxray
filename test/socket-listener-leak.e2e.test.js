'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');

async function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
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
        setTimeout(check, 200);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 200);
      });
    };
    check();
  });
}

describe('keep-alive socket listener leak', () => {
  let child, mockUpstream;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-leak-'));

  after(async () => {
    if (mockUpstream) await new Promise(r => mockUpstream.close(r));
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(r => { child.on('exit', r); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 3000); });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no MaxListenersExceededWarning after 15 requests on same keep-alive socket', async () => {
    const [proxyPort, upstreamPort] = await Promise.all([findFreePort(), findFreePort()]);

    mockUpstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'keep-alive' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }], model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise(r => mockUpstream.listen(upstreamPort, '127.0.0.1', r));

    let stderr = '';
    child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: tmpDir,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    await waitForPort(proxyPort);

    // 15 > Node's default maxListeners (10) — triggers the warning on unfixed code
    const agent = new http.Agent({ keepAlive: true });
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model: 'test', max_tokens: 10,
          messages: [{ role: 'user', content: [{ type: 'text', text: `req ${i}` }] }],
        });
        const req = http.request({
          hostname: 'localhost', port: proxyPort,
          method: 'POST', path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-api-key': 'sk-fake',
            'anthropic-version': '2023-06-01',
          },
          agent,
        }, res => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end(body);
      });
    }
    agent.destroy();

    // Give the proxy a moment to flush any deferred warnings
    await new Promise(r => setTimeout(r, 500));

    assert.ok(
      !stderr.includes('MaxListenersExceededWarning'),
      `Expected no MaxListenersExceededWarning in stderr:\n${stderr.slice(0, 800)}`
    );
  });
});
