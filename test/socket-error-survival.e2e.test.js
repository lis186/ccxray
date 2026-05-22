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

// Slow SSE responder that can optionally self-destruct after N chunks
// (simulates upstream EPIPE). Controlled via ?destroy=N on the request URL.
function makeSlowUpstream() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const destroyAfter = parseInt(url.searchParams.get('destroy') || '0', 10);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write('event: message_start\n');
    res.write('data: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-3-haiku-20240307',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) + '\n\n');
    res.write('event: content_block_start\n');
    res.write('data: ' + JSON.stringify({
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    }) + '\n\n');

    let i = 0;
    const interval = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(interval); return; }
      try {
        res.write('event: content_block_delta\n');
        res.write('data: ' + JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `chunk${i}` },
        }) + '\n\n');
      } catch (_) { clearInterval(interval); return; }
      i++;
      if (destroyAfter > 0 && i >= destroyAfter) {
        clearInterval(interval);
        try { res.socket.destroy(); } catch (_) {}
        return;
      }
      if (i > 50) {
        clearInterval(interval);
        try {
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } catch (_) {}
      }
    }, 25);
  });
}

function probe(port) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'probe' }],
    });
    const req = http.request({
      hostname: 'localhost', port, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'sk-fake',
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let len = 0;
      res.on('data', c => { len += c.length; });
      res.on('end', () => resolve({ statusCode: res.statusCode, len }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
    setTimeout(() => resolve({ error: 'timeout' }), 8000);
  });
}

function abortMidStream(port) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'abort me' }],
    });
    const req = http.request({
      hostname: 'localhost', port, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'sk-fake',
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream',
      },
    }, res => {
      let count = 0;
      res.on('data', chunk => {
        count += (chunk.toString().match(/\n\n/g) || []).length;
        if (count >= 2) {
          req.destroy();
          resolve('aborted');
        }
      });
      res.on('error', () => resolve('res-error'));
      res.on('end', () => resolve('ended'));
    });
    req.on('error', () => resolve('req-error'));
    req.write(body); req.end();
    setTimeout(() => { try { req.destroy(); } catch (_) {} resolve('timeout'); }, 5000);
  });
}

function upstreamDestroyRequest(port) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'destroy me' }],
    });
    const req = http.request({
      hostname: 'localhost', port, path: '/v1/messages?destroy=3', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'sk-fake',
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream',
      },
    }, res => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('end', () => resolve({ outcome: 'ended', bytes }));
      res.on('error', () => resolve({ outcome: 'res-error', bytes }));
    });
    req.on('error', e => resolve({ outcome: 'req-error', error: e.code || e.message }));
    req.write(body); req.end();
    setTimeout(() => { try { req.destroy(); } catch (_) {} resolve({ outcome: 'timeout' }); }, 5000);
  });
}

describe('proxy survives client and upstream socket errors (efd4a70)', () => {
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('survives both client mid-stream abort and upstream socket destroy', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-socket-survival-'));
    tmpDirs.push(home);

    const upstream = makeSlowUpstream();
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
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);

      // Case 1: client aborts mid-stream
      const abortOutcome = await abortMidStream(proxyPort);
      assert.equal(abortOutcome, 'aborted', `expected aborted outcome, got ${abortOutcome}`);
      await new Promise(r => setTimeout(r, 500));
      assert.equal(child.exitCode, null, 'proxy must be alive after client abort');
      const probe1 = await probe(proxyPort);
      assert.equal(probe1.statusCode, 200, `probe-1 should be HTTP 200, got ${JSON.stringify(probe1)}`);

      // Case 2: upstream destroys TCP socket mid-response
      const upstreamOutcome = await upstreamDestroyRequest(proxyPort);
      assert.ok(
        upstreamOutcome.outcome === 'ended' || upstreamOutcome.outcome === 'res-error',
        `expected ended/res-error after upstream destroy, got ${JSON.stringify(upstreamOutcome)}`
      );
      await new Promise(r => setTimeout(r, 500));
      assert.equal(child.exitCode, null, 'proxy must be alive after upstream destroy');
      const probe2 = await probe(proxyPort);
      assert.equal(probe2.statusCode, 200, `probe-2 should be HTTP 200, got ${JSON.stringify(probe2)}`);

      assert.ok(
        !/uncaughtException|^TypeError|^Error:.*\n\s+at /m.test(stderr),
        `stderr should not contain uncaught exception traces. Tail: ${stderr.slice(-500)}`
      );
    } finally {
      upstream.close();
      await killAndWait(child);
    }
  });
});
