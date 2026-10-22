'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function request(port, url, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, data }));
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.end(body);
  });
}
it('routing fix and provider header hygiene at fake upstreams', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-routing-'));
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'index.ndjson'), '');
  fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers }); req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"synthetic":true}');
  });
  const openaiReceived = [];
  const openai = http.createServer((req, res) => {
    openaiReceived.push({ url: req.url, headers: req.headers }); req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"synthetic":true}');
  });
  let child, done;
  const stop = async () => {
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await done; } finally { clearTimeout(timer); }
  };
  try {
    const upstreamPort = await listen(upstream);
    const openaiPort = await listen(openai);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--no-browser'], {
      env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
        CLAUDE_CONFIG_DIR: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: '127.0.0.1', OPENAI_TEST_PORT: String(openaiPort), OPENAI_TEST_PROTOCOL: 'http',
        CHATGPT_BASE_URL: `http://127.0.0.1:${openaiPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await request(port, '/_api/health')).status === 200) { ready = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, output);
    const unknown = await request(port, '/v1/alpha/search?probe=synthetic', 'POST', {}, '{}');
    assert.equal(unknown.status, 421);
    assert.equal(JSON.parse(unknown.data).error.type, 'ccxray_unknown_route');
    assert.deepEqual(received, []);
    assert.deepEqual(openaiReceived, []);
    const openaiHeaders = [
      { 'chatgpt-account-id': 'acct' },
      { authorization: 'Bearer syntheticheader.payload.signature' },
      { 'x-codex-test': 'synthetic' },
      { 'openai-beta': 'synthetic' },
      { 'x-openai-test': 'synthetic' },
      { originator: 'codex_cli_rs' },
    ];
    for (const headers of openaiHeaders) {
      for (const url of ['/v1/messages', '/v1/messages/count_tokens', '/api/hello']) {
        const result = await request(port, url, 'POST', { ...headers, 'anthropic-version': '2023-06-01' }, '{}');
        assert.equal(result.status, 421);
        assert.equal(JSON.parse(result.data).error.type, 'ccxray_unknown_route');
      }
    }
    const quota = JSON.stringify({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] });
    assert.equal((await request(port, '/v1/messages', 'POST', { 'x-codex-test': 'synthetic' }, quota)).status, 421);
    assert.deepEqual(received, []);
    assert.deepEqual(openaiReceived, []);
    assert.equal(fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8'), '');
    assert.deepEqual(fs.readdirSync(logs).filter(f => /_(req|res)\.json$/.test(f)), []);
    for (const headers of openaiHeaders) {
      assert.equal((await request(port, '/v1/alpha/headers', 'POST', headers, '{}')).status, 200);
    }
    assert.deepEqual(received, []);
    const claudeHeaders = { 'anthropic-version': '2023-06-01', 'x-api-key': 'synthetic' };
    for (const url of ['/v1/messages?probe=synthetic', '/v1/messages/count_tokens?probe=synthetic']) {
      assert.equal((await request(port, url, 'POST', claudeHeaders, '{}')).status, 200);
    }
    assert.equal(received.length, 2);
    for (const row of received) {
      for (const [key, value] of Object.entries(claudeHeaders)) assert.equal(row.headers[key], value);
    }
    for (const url of ['/v1/responses?probe=synthetic', '/v1/alpha/search?probe=synthetic']) {
      assert.equal((await request(port, url, 'POST', { 'x-codex-test': 'synthetic' }, '{}')).status, 200);
    }
    assert.equal((await request(port, '/v1/alpha/account', 'POST', { 'chatgpt-account-id': 'acct' }, '{}')).status, 200);
    assert.equal(openaiReceived.length, 3 + openaiHeaders.length);
    assert.equal(received.length, 2);
    await stop(); child = null;
    const rows = fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.equal(row.method, 'POST');
      assert.ok(row.path.startsWith('/v1/'));
      assert.ok(!row.path.includes('?'));
      assert.notEqual(row.status, 421);
    }
    assert.ok(rows.some(row => row.path === '/v1/alpha/search' && row.provider === 'openai' && row.agent === 'codex'));
  } finally {
    await stop();
    openai.closeAllConnections();
    await new Promise(resolve => openai.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
