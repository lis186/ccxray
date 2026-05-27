'use strict';

// Phase 2.3: under dashboard enforcement the static shell (HTML + client
// JS/CSS, no user data) must stay reachable WITHOUT a cookie so the inline
// bootstrap script (redeem #k= / probe /_auth/status) can run — otherwise
// `ccxray open` could never mint the first cookie. The sensitive data
// endpoints (/_api/*, /_events) stay gated. Verifies the serveStatic-before-
// gate routing order in ephemeral mode (no AUTH_TOKEN, no escape hatch).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const tmpDirs = [];

function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', () => { if (Date.now() - start > timeoutMs) reject(new Error('proxy did not start')); else setTimeout(check, 100); });
      req.on('timeout', () => { req.destroy(); if (Date.now() - start > timeoutMs) reject(new Error('proxy did not start')); else setTimeout(check, 100); });
    };
    check();
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'localhost', port, path: urlPath, timeout: 3000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

describe('Dashboard shell stays reachable under enforcement (2.3)', () => {
  let child;
  after(async () => {
    await killAndWait(child);
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('ephemeral mode: shell + assets serve without auth, data endpoints 401', async () => {
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shell-e2e-'));
    tmpDirs.push(home);

    const env = { ...process.env, CCXRAY_HOME: home, BROWSER: 'none', RESTORE_DAYS: '0' };
    delete env.AUTH_TOKEN;            // ephemeral
    delete env.CCXRAY_LOOPBACK_NO_AUTH; // no escape hatch
    child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], { env, stdio: ['ignore', 'ignore', 'ignore'] });

    await waitForPort(proxyPort);

    const root = await get(proxyPort, '/');
    assert.equal(root.statusCode, 200, 'GET / should serve the shell without a cookie');
    assert.match(root.headers['content-type'] || '', /text\/html/);
    assert.match(root.body, /__PROXY_CONFIG__/);

    const css = await get(proxyPort, '/style.css');
    assert.equal(css.statusCode, 200, 'GET /style.css should serve without a cookie');

    const entries = await get(proxyPort, '/_api/entries');
    assert.equal(entries.statusCode, 401, '/_api/entries must stay gated in ephemeral mode');

    const events = await get(proxyPort, '/_events');
    assert.equal(events.statusCode, 401, '/_events (SSE) must stay gated in ephemeral mode');
  });
});
