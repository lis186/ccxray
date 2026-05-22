'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-auth-strip-'));
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
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function subscribeSSE(port, token, durationMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: 'localhost', port, path: '/_events',
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`SSE status ${res.statusCode}`)); }
      const events = [];
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          events.push(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      });
      setTimeout(() => { req.destroy(); resolve(events); }, durationMs);
    });
    req.on('error', reject);
  });
}

function recursiveFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...recursiveFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe('AUTH_TOKEN ?token= query param strip (a5d28f0)', () => {
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('strips ?token= from upstream URL, SSE broadcasts, disk logs, and console', async () => {
    const SECRET = 'verify-secret-d4f7';
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = makeTmpHome();

    const upstreamRequests = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant',
        model: 'claude-3-haiku-20240307', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        AUTH_TOKEN: SECRET,
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);

      const ssePromise = subscribeSSE(proxyPort, SECRET, 2500);
      await new Promise(r => setTimeout(r, 150));

      const resp = await postJson(proxyPort, `/v1/messages?token=${SECRET}&trace=keepme`, {
        model: 'claude-3-haiku-20240307',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(resp.statusCode, 200, 'proxy should forward and respond 200');

      const sseEvents = await ssePromise;
      await new Promise(r => setTimeout(r, 200));

      assert.equal(upstreamRequests.length, 1, 'upstream should receive exactly one request');
      assert.equal(upstreamRequests[0].url, '/v1/messages?trace=keepme',
        'upstream URL must have ?token= stripped and other params preserved');

      for (const e of sseEvents) {
        assert.ok(!e.includes(SECRET), `SSE event must not contain secret: ${e.slice(0, 200)}`);
      }
      const sawEntryUrl = sseEvents.some(e => e.includes('"url"') && e.includes('/v1/messages'));
      assert.ok(sawEntryUrl, 'expected at least one SSE event with the entry url');

      const allFiles = recursiveFiles(home);
      assert.ok(allFiles.length >= 3, `expected logs on disk, found ${allFiles.length}`);
      for (const f of allFiles) {
        const txt = fs.readFileSync(f, 'utf8');
        assert.ok(!txt.includes(SECRET), `secret leaked to disk file: ${f}`);
      }

      assert.ok(!stdout.includes(SECRET), 'secret leaked to ccxray stdout');
      assert.ok(!stderr.includes(SECRET), 'secret leaked to ccxray stderr');
    } finally {
      upstream.close();
      await killAndWait(child);
    }
  });
});
