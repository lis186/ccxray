'use strict';

// Two live HTTP clients share the same proxy/store, as on a hub. index.js
// starts at module load rather than exporting a server factory, so use a child.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CWD_A = '/synthetic/client-a';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

function request(port, url, { method = 'GET', agent, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, agent,
      headers: { ...headers, ...(payload === undefined ? {} : {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      }) },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, data }));
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.end(payload);
  });
}

describe('body-less session attribution on a shared proxy (#767)', () => {
  let home, upstream, child, done, port, sseReq;
  let output = '', sseData = '';
  const forwarded = [];
  const clientA = new http.Agent({ keepAlive: true });
  const clientB = new http.Agent({ keepAlive: true });
  const headersA = { 'x-ccxray-agent-id': 'herdr:test-a', 'anthropic-version': '2023-06-01' };
  const headersB = { 'x-ccxray-agent-id': 'herdr:test-b', 'anthropic-version': '2023-06-01' };

  async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
      const result = await check();
      if (result) return result;
      if (child?.exitCode !== null) throw new Error(`proxy exited: ${output}`);
      await delay(50);
    }
    throw new Error(`proxy condition timed out: ${output}`);
  }

  async function recorded(count) {
    return waitFor(() => {
      const rows = fs.readFileSync(path.join(home, 'logs/index.ndjson'), 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse);
      return rows.length >= count ? rows : null;
    });
  }

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bodyless-'));
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs/index.ndjson'), '');
    fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
    upstream = http.createServer((req, res) => {
      forwarded.push({ method: req.method, url: req.url });
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
          id: 'msg_synthetic_a', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Synthetic reply' }], stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const reserve = http.createServer();
    port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(key)) delete env[key];
    }
    delete env.STORAGE_BACKEND;
    delete env.PROXY_HOST;
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--no-browser'], {
      env: { ...env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
        CLAUDE_CONFIG_DIR: home, CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await waitFor(async () => {
      try { return (await request(port, '/_api/health')).status === 200; } catch { return false; }
    });
    await new Promise((resolve, reject) => {
      sseReq = http.get(`http://127.0.0.1:${port}/_events`, res => {
        res.on('data', chunk => { sseData += chunk; });
        resolve();
      });
      sseReq.once('error', reject);
    });
    assert.equal((await request(port, '/v1/messages', { method: 'POST', agent: clientA, headers: headersA, body: {
      model: 'claude-sonnet-4-6', max_tokens: 32, metadata: { session_id: SESSION_A },
      context_management: { edits: [] },
      system: `Primary working directory: ${CWD_A}`,
      messages: [{ role: 'user', content: 'Synthetic turn from client A' }],
    } })).status, 200);
    const [row] = await recorded(1);
    assert.equal(row.sessionId, SESSION_A);
    assert.equal(row.cwd, CWD_A);
    assert.equal(row.agentId, 'herdr:test-a');
  });

  after(async () => {
    sseReq?.destroy();
    clientA.destroy();
    clientB.destroy();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await done; } finally { clearTimeout(timer); }
    }
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  async function assertProbe(expectedSession, count) {
    const rows = await recorded(count);
    const row = rows.at(-1);
    assert.equal(row.agentId, 'herdr:test-b');
    assert.equal(row.sessionId, expectedSession, 'client B must not borrow client A session');
    assert.equal(row.cwd, null, 'client B must not borrow client A cwd');
    assert.equal(row.method, 'HEAD');
    assert.equal(row.path, '/api/hello');
    assert.equal(row.status, 200);
    const response = await request(port, '/_api/entries');
    assert.equal(response.status, 200);
    const { entries } = JSON.parse(response.data);
    assert.ok(Array.isArray(entries), 'entries API returns an object containing an entries array');
    const entry = entries.find(entry => entry.id === row.id);
    if (expectedSession === null) {
      assert.equal(entry, undefined, 'default session scope excludes rows without a session');
    } else {
      assert.ok(entry, 'body-less row with an explicit session is available in the session scope');
      assert.equal(entry.sessionId, expectedSession);
      assert.equal(entry.cwd, null);
    }
    // Deployment agentId is persisted in the index, but summarizeEntry omits it
    // from both the entries API and SSE. Check identity on the index row above.
    await waitFor(() => sseData.split('\n').some(line => {
      if (!line.startsWith('data: ')) return false;
      const entry = JSON.parse(line.slice(6));
      return entry.id === row.id && entry.sessionId === expectedSession
        && entry.cwd === null
        && entry.method === 'HEAD' && entry.url === '/api/hello' && entry.status === 200;
    }));
    assert.deepEqual(forwarded.at(-1), { method: 'HEAD', url: '/api/hello' });
  }

  it('leaves client B session and cwd unset after client A has recorded a turn', async () => {
    assert.equal((await request(port, '/api/hello', { method: 'HEAD', agent: clientB, headers: headersB })).status, 200);
    await assertProbe(null, 2);
  });

  it('preserves an explicit x-session-id on client B body-less request', async () => {
    assert.equal((await request(port, '/api/hello', { method: 'HEAD', agent: clientB,
      headers: { ...headersB, 'x-session-id': SESSION_B } })).status, 200);
    await assertProbe(SESSION_B, 3);
  });
});
