'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
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
function registerClient(home, agentType) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(home, 'hub.sock'));
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('register timed out')));
    socket.once('connect', () => socket.write(JSON.stringify({
      cmd: 'register', pid: process.pid, cwd: home, agentType,
    }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      socket.end();
      try { resolve(JSON.parse(data.split('\n')[0])); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
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
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--hub-mode', '--no-browser'], {
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
      try { if ((await request(port, '/_api/health')).status === 200 && fs.existsSync(path.join(home, 'hub.json'))) { ready = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, output);
    assert.equal((await registerClient(home, 'codex')).ok, true);
    const unknown = await request(port, '/v1/alpha/search?probe=synthetic', 'POST', {}, '{}');
    assert.equal(unknown.status, 421);
    assert.equal(JSON.parse(unknown.data).error.type, 'ccxray_unknown_route');
    assert.deepEqual(received, []);
    assert.deepEqual(openaiReceived, []);
    const openaiHeaders = [
      { 'chatgpt-account-id': 'acct' },
      { 'chatgpt-account-id': 'acct', authorization: 'bearer syntheticheader.payload.signature' },
      { 'x-codex-turn-metadata': '{}' },
      { 'openai-beta': 'synthetic' },
      { 'x-openai-test': 'synthetic' },
      { originator: 'codex_exec' },
      { 'user-agent': 'codex_cli_rs/0.163.0 (Linux)' },
    ];
    for (const headers of openaiHeaders) {
      for (const url of ['/v1/messages', '/v1/messages/count_tokens', '/api/hello']) {
        const result = await request(port, url, 'POST', { ...headers, 'anthropic-version': '2023-06-01' }, '{}');
        assert.equal(result.status, 421);
        assert.equal(JSON.parse(result.data).error.type, 'ccxray_unknown_route');
      }
    }
    for (const url of ['/api/event_logging/batch', '/v1/alpha/bare-jwt']) {
      const bareJwt = await request(port, url, 'POST', { authorization: 'bearer syntheticheader.payload.signature' }, '{}');
      assert.equal(bareJwt.status, 421);
    }
    const quota = JSON.stringify({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] });
    assert.equal((await request(port, '/v1/messages', 'POST', { 'x-codex-turn-metadata': '{}' }, quota)).status, 421);
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
      assert.equal((await request(port, url, 'POST', { 'x-codex-turn-metadata': '{}' }, '{}')).status, 200);
    }
    assert.equal((await request(port, '/v1/alpha/account', 'POST', { 'chatgpt-account-id': 'acct' }, '{}')).status, 200);
    assert.equal((await request(port, '/v1/alpha/api-key', 'POST', { authorization: 'bearer sk-proj-synthetic', 'user-agent': 'codex_cli_rs/0.163.0' }, '{}')).status, 200);
    assert.equal(openaiReceived.length, 4 + openaiHeaders.length);
    assert.equal(received.length, 2);
    for (const url of ['/v1/files', '/v1/skills']) {
      const before = received.length;
      assert.equal((await request(port, url, 'POST', { 'anthropic-version': '2023-06-01' }, '{}')).status, 200);
      assert.equal(received.length, before + 1);
    }
    for (const url of ['/v1/files', '/v1/skills', '/v1/messages']) {
      const before = received.length;
      assert.equal((await request(port, url, 'POST', {
        'anthropic-version': '2023-06-01', authorization: 'Bearer syntheticheader.payload.signature',
      }, '{}')).status, 200);
      assert.equal(received.length, before + 1);
      assert.equal(received.at(-1).url, url);
    }
    for (const method of ['HEAD', 'GET']) {
      assert.equal((await request(port, '/', method)).status, 200);
      assert.equal((await request(port, '/', method, { 'anthropic-version': '2023-06-01' })).status, 200);
    }
    for (const agentType of ['codex', 'claude']) {
      if (agentType === 'claude') assert.equal((await registerClient(home, agentType)).ok, true);
      const expected = agentType === 'codex' ? openaiReceived : received;
      const other = agentType === 'codex' ? received : openaiReceived;
      const before = expected.length, otherBefore = other.length;
      const url = `/v1/alpha/hub-${agentType}`;
      assert.equal((await request(port, `/_ccxray/client/${process.pid}${url}`, 'POST', {}, '{}')).status, 200);
      assert.equal(expected.length, before + 1);
      assert.equal(expected.at(-1).url, url);
      assert.equal(other.length, otherBefore);
      if (agentType === 'codex') {
        assert.equal((await request(port, `/_ccxray/client/${process.pid}/v1/messages`, 'POST', {}, '{}')).status, 421);
        assert.equal(received.length, otherBefore);
      }
    }
    await stop(); child = null;
    const rows = fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.ok(['POST', 'HEAD', 'GET'].includes(row.method));
      assert.ok(row.path.startsWith('/'));
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
