'use strict';

// Claude Code calls POST /v1/messages/count_tokens (token pre-counting for
// large content). The body is {model, messages} — no system prompt, no
// metadata, no tools — which happens to satisfy every subagent heuristic
// (isAnthropicSubagent + isLikelySubagent), so each call was recorded as a
// fake single-turn subagent entry glued onto the active session and rendered
// as an extra swimlane. This test fires count_tokens at a real proxy with a
// mock upstream and asserts zero dashboard entries are created, while a real
// /v1/messages request still records one.

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

// Mock upstream: count_tokens returns its real response shape; everything
// else gets a minimal messages response.
function makeMockUpstream() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 73081 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
  });
}

function fireRequest(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method: 'POST',
      headers: { 'x-api-key': 'sk-fake', 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
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

describe('anthropic count_tokens requests are suppressed from dashboard entries', () => {
  after(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('proxies count_tokens (response intact) but creates zero entries', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ct-noise-'));
    tmpDirs.push(home);

    const upstream = makeMockUpstream();
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

    try {
      await waitForPort(proxyPort);

      // Shape captured from a real Claude Code count_tokens call: bare
      // {model, messages} with a single large user message.
      const out = await fireRequest(proxyPort, '/v1/messages/count_tokens', {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'some very large document text' }],
      });
      assert.equal(out.status, 200, 'count_tokens should be proxied through');
      assert.equal(JSON.parse(out.body).input_tokens, 73081, 'upstream response must pass through intact');

      await new Promise(r => setTimeout(r, 200));
      let entries = (await fetchEntries(proxyPort)).entries || [];
      assert.equal(entries.length, 0, `count_tokens should produce 0 entries, got ${entries.length}`);

      // Positive control: a normal /v1/messages request SHOULD record.
      await fireRequest(proxyPort, '/v1/messages', {
        model: 'claude-opus-4-6', max_tokens: 10,
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
