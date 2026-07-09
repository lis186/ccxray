'use strict';

// End-to-end: real ccxray process + mock xAI upstream.
// Covers Grok control-plane noise, main turn recording, title-gen grok-raw,
// header-based xAI routing (no OPENAI_BASE_URL swap).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const FIX = path.join(__dirname, 'fixtures', 'wire-parsers', 'grok');
const tmpDirs = [];

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 1000 }, res => {
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

function makeMockXaiUpstream() {
  return http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/v1/models' || pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'grok-4.5', object: 'model' },
          { id: 'grok-build', object: 'model' },
        ],
      }));
      return;
    }

    if ((pathname === '/v1/responses' || pathname.endsWith('/responses')) && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        const model = body.model || 'grok-4.5';
        const text = model === 'grok-build' ? 'title-ok' : 'pong';
        const completed = {
          type: 'response.completed',
          response: {
            id: `resp_${model}_mock`,
            object: 'response',
            model,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text }],
              },
            ],
            usage: {
              input_tokens: model === 'grok-build' ? 400 : 30570,
              output_tokens: model === 'grok-build' ? 20 : 22,
              total_tokens: model === 'grok-build' ? 420 : 30592,
              input_tokens_details: { cached_tokens: model === 'grok-build' ? 100 : 5504 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        };
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
        res.end();
      });
      return;
    }

    // Control-plane / unknown → 404 (same shape as real proxy misses)
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
  });
}

function request(port, { method = 'GET', path: urlPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    let payload = null;
    if (body != null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      hdrs['content-type'] = hdrs['content-type'] || 'application/json';
      hdrs['content-length'] = String(payload.length);
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, headers: hdrs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchEntries(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/_api/entries`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

describe('Grok proxy e2e', () => {
  after(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('records main Grok turn, labels agent=grok, suppresses control-plane noise, uses grok-raw for title-gen', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-grok-e2e-'));
    tmpDirs.push(home);

    const upstream = makeMockXaiUpstream();
    await new Promise(r => upstream.listen(upstreamPort, '127.0.0.1', r));

    // Point xAI upstream at mock. Keep OpenAI/Anthropic on mock too so
    // mis-routed traffic still returns instead of hanging on public nets.
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
        XAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(upstreamPort),
        OPENAI_TEST_PROTOCOL: 'http',
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const mainReq = load('main_req.json');
    const titleReq = load('title_req.json');
    const mainHeaders = load('headers_main.json');
    const titleHeaders = load('headers_title.json');

    try {
      await waitForPort(proxyPort);

      // ── 1) Control-plane noise (Grok headers) ──
      for (const p of ['/v1/settings', '/v1/feedback/config', '/v1/models']) {
        const out = await request(proxyPort, {
          method: 'GET',
          path: p,
          headers: {
            'user-agent': mainHeaders['user-agent'],
            'x-grok-client-identifier': mainHeaders['x-grok-client-identifier'],
            'x-grok-client-version': mainHeaders['x-grok-client-version'],
          },
        });
        // models is 200 from mock; settings/feedback 404 — either is fine as long as no entry
        assert.ok([200, 404].includes(out.status), `${p} status ${out.status}`);
      }
      await new Promise(r => setTimeout(r, 250));
      let payload = await fetchEntries(proxyPort);
      let entries = payload.entries || payload || [];
      assert.equal(entries.length, 0, `noise phase should be 0 entries, got ${entries.length}`);

      // ── 2) Title-gen (empty session headers) → grok-raw, agent grok ──
      const titleOut = await request(proxyPort, {
        method: 'POST',
        path: '/v1/responses',
        headers: titleHeaders,
        body: titleReq,
      });
      assert.equal(titleOut.status, 200, `title-gen status ${titleOut.status}: ${titleOut.body.slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 400));

      // ── 3) Main turn ──
      const mainOut = await request(proxyPort, {
        method: 'POST',
        path: '/v1/responses',
        headers: mainHeaders,
        body: mainReq,
      });
      assert.equal(mainOut.status, 200, `main status ${mainOut.status}: ${mainOut.body.slice(0, 200)}`);
      assert.match(mainOut.body, /pong|response\.completed/);
      await new Promise(r => setTimeout(r, 500));

      payload = await fetchEntries(proxyPort);
      entries = payload.entries || payload || [];
      assert.ok(entries.length >= 2, `expected ≥2 entries (title+main), got ${entries.length}`);

      const main = entries.find(e => e.model === 'grok-4.5');
      const title = entries.find(e => e.model === 'grok-build');
      assert.ok(main, 'main grok-4.5 entry missing');
      assert.ok(title, 'title grok-build entry missing');

      // Main turn identity
      assert.equal(main.agent, 'grok');
      assert.equal(main.sessionId, mainHeaders['x-grok-session-id']);
      assert.equal(main.sessionInferred, false);
      assert.equal(main.status, 200);
      assert.equal(main.maxContext, 500_000);
      assert.equal(main.cwd, '/tmp/grok-ccxray-smoke');
      assert.ok(main.cost && main.cost.cost != null, `main cost missing: ${JSON.stringify(main.cost)}`);
      assert.ok(!main.cost.warning, `main cost warning: ${main.cost.warning}`);
      assert.ok(main.usage && main.usage.input_tokens > 0);

      // Title-gen must NOT pollute Codex Raw
      assert.equal(title.agent, 'grok');
      assert.equal(title.sessionId, 'grok-raw');
      assert.notEqual(title.sessionId, 'codex-raw');

      // Disk index agrees
      const indexPath = path.join(home, 'logs', 'index.ndjson');
      assert.ok(fs.existsSync(indexPath), 'index.ndjson missing');
      const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.ok(lines.some(l => l.agent === 'grok' && l.model === 'grok-4.5'));
      assert.ok(lines.every(l => l.sessionId !== 'codex-raw'), 'no codex-raw sessions for Grok traffic');
    } finally {
      await killAndWait(child);
      upstream.close();
    }
  });
});
