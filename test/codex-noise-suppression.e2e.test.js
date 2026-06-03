'use strict';

// Codex 0.133+ pings ~10 distinct platform endpoints on startup (plugin lists,
// connector directory, app metadata, usage, analytics). Without filtering,
// ccxray records each one as a dashboard entry — drowning the actual
// conversation in noise. This test fires those paths at a real proxy with a
// mock upstream and asserts the dashboard's /_api/entries stays empty.

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
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
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
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

// Mock upstream that 404s everything (matches what chatgpt.com does for
// these endpoints in the real environment).
function makeMock404Upstream() {
  return http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'mock 404' } }));
  });
}

function fireRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'x-api-key': 'sk-fake',
      'chatgpt-account-id': '11111111-2222-3333-4444-555555555555',
    };
    if (body) headers['content-type'] = 'application/json';
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method, headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchEntries(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/_api/entries`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

describe('codex platform noise paths are suppressed from dashboard entries', () => {
  after(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('proxies noise paths (including analytics) but creates zero dashboard entries', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-codex-noise-'));
    tmpDirs.push(home);

    const upstream = makeMock404Upstream();
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    // Route both anthropic and openai upstreams to the same mock 404 server.
    // The classification fix moves /v1/ps/plugins from anthropic to openai;
    // either way, the upstream just 404s.
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(upstreamPort),
        OPENAI_TEST_PROTOCOL: 'http',
        CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        CCXRAY_LOOPBACK_NO_AUTH: '1', // 2.2: exercises codex noise suppression, not the auth gate
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForPort(proxyPort);

      // Sampled from a real codex 0.133-0.136 startup capture.
      // Analytics events are included: they 404 for API-key users and create
      // garbage "(unknown)" / "Codex Raw" entries with !http markers.
      const noisePaths = [
        ['GET', '/v1/plugins/featured?platform=codex'],
        ['GET', '/v1/plugins/list'],
        ['GET', '/v1/ps/plugins/installed?scope=GLOBAL'],
        ['GET', '/v1/ps/plugins/installed?scope=WORKSPACE&includeDownloadUrls=true'],
        ['POST', '/v1/api/codex/apps'],
        ['GET', '/v1/api/codex/usage'],
        ['GET', '/v1/connectors/directory/list?external_logos=true'],
        ['POST', '/v1/codex/analytics-events/events'],
        ['GET', '/v1/models?client_version=0.136.0'],
      ];
      for (const [method, urlPath] of noisePaths) {
        const out = await fireRequest(proxyPort, method, urlPath);
        assert.equal(out.status, 404, `${method} ${urlPath} should be proxied (got ${out.status})`);
      }

      // Give the proxy a moment to settle any async writes.
      await new Promise(r => setTimeout(r, 200));

      let entries = (await fetchEntries(proxyPort)).entries || [];
      assert.equal(entries.length, 0, `noise-only phase should produce 0 entries, got ${entries.length}`);

      // Positive control: a normal Anthropic /v1/messages request SHOULD record.
      await fireRequest(proxyPort, 'POST', '/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      });
      await new Promise(r => setTimeout(r, 200));
      entries = (await fetchEntries(proxyPort)).entries || [];
      assert.equal(entries.length, 1, `positive control: expected 1 entry, got ${entries.length}`);
    } finally {
      await killAndWait(child);
      upstream.close();
    }
  });
});
