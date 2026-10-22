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
it('routing fix and provider header hygiene at fake upstreams', async t => {
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
  const xaiReceived = [];
  const xai = http.createServer((req, res) => {
    xaiReceived.push({ url: req.url, headers: req.headers }); req.resume();
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
    const xaiPort = await listen(xai);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--hub-mode', '--no-browser'], {
      env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
        CLAUDE_CONFIG_DIR: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: '127.0.0.1', OPENAI_TEST_PORT: String(openaiPort), OPENAI_TEST_PROTOCOL: 'http',
        XAI_BASE_URL: `http://127.0.0.1:${xaiPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${openaiPort}/backend-api/codex` },
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
    const unknown = await request(port, '/v1/alpha/unlisted?probe=synthetic', 'POST', {}, '{}');
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
    await t.test('routing fix: Codex search path goes to the ChatGPT upstream', async () => {
      const before = openaiReceived.length;
      const otherBefore = received.length;
      const result = await request(port, '/v1/alpha/search', 'POST', {
        authorization: 'Bearer syntheticheader.payload.signature', 'chatgpt-account-id': 'acct',
      }, '{}');
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.data), { synthetic: true });
      assert.equal(openaiReceived.length, before + 1);
      assert.equal(openaiReceived.at(-1).url, '/backend-api/codex/alpha/search');
      assert.equal(received.length, otherBefore);
    });
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
    for (const url of ['/v1/responses?probe=synthetic', '/v1/alpha/unlisted?probe=synthetic']) {
      assert.equal((await request(port, url, 'POST', { 'x-codex-turn-metadata': '{}' }, '{}')).status, 200);
    }
    assert.equal((await request(port, '/v1/alpha/account', 'POST', { 'chatgpt-account-id': 'acct' }, '{}')).status, 200);
    assert.equal((await request(port, '/v1/alpha/api-key', 'POST', { authorization: 'bearer sk-proj-synthetic', 'user-agent': 'codex_cli_rs/0.163.0' }, '{}')).status, 200);
    assert.equal(openaiReceived.length, 5 + openaiHeaders.length);
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
    await t.test('routing fix (#745): gateway bearer at Anthropic', async () => {
      const openaiBefore = openaiReceived.length;
      for (const [url, method] of [['/v1/messages', 'POST'], ['/v1/models', 'GET']]) {
        const before = received.length;
        const result = await request(port, url, method, {
          'anthropic-version': '2023-06-01', authorization: 'Bearer sk-gw-123',
        }, method === 'POST' ? '{}' : undefined);
        assert.equal(result.status, 200);
        assert.equal(received.length, before + 1);
        assert.equal(received.at(-1).url, url);
        assert.equal(received.at(-1).headers.authorization, 'Bearer sk-gw-123');
        assert.equal(received.at(-1).headers['anthropic-version'], '2023-06-01');
        assert.equal(openaiReceived.length - openaiBefore, 0);
        assert.equal(xaiReceived.length, 0);
      }
    });
    await t.test('header-aware routing (#745)', async () => {
      const openaiBefore = openaiReceived.length;
      for (const headers of [claudeHeaders, { authorization: 'Bearer sk-ant-synthetic' }]) {
        const before = received.length;
        assert.equal((await request(port, '/v1/models', 'GET', headers)).status, 200);
        assert.equal(received.length, before + 1);
        assert.equal(received.at(-1).url, '/v1/models');
        assert.equal(openaiReceived.length, openaiBefore);
      }
      for (const headers of [{ 'user-agent': 'codex_cli_rs/0.163.0' }, { 'chatgpt-account-id': 'acct' }]) {
        const before = openaiReceived.length, otherBefore = received.length;
        assert.equal((await request(port, '/v1/models', 'GET', headers)).status, 200);
        assert.equal(openaiReceived.length, before + 1);
        assert.equal(received.length, otherBefore);
      }
      const before = received.length, otherBefore = openaiReceived.length;
      for (const [url, headers] of [
        ['/v1/responses', claudeHeaders],
        ['/v1/models', { ...claudeHeaders, 'chatgpt-account-id': 'acct' }],
        ['/v1/unlisted', { authorization: 'Bearer sk-proj-synthetic' }],
      ]) {
        const result = await request(port, url, 'GET', headers);
        assert.equal(result.status, 421);
        assert.equal(JSON.parse(result.data).error.type, 'ccxray_unknown_route');
      }
      assert.equal(received.length, before);
      assert.equal(openaiReceived.length, otherBefore);
      assert.equal(xaiReceived.length, 0);
      for (const method of ['HEAD', 'GET']) {
        assert.equal((await request(port, '/api/hello', method)).status, 200);
      }
      assert.equal(received.length, before + 2);
      assert.doesNotMatch(output, /refused (?:HEAD|GET) \/api\/hello/);
    });
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
    await t.test('header-aware routing (#745): Grok x-api-key at xAI', async () => {
      const before = received.length, otherBefore = openaiReceived.length;
      for (const url of ['/v1/responses', '/v1/models', '/v1/settings']) {
        const xaiBefore = xaiReceived.length;
        assert.equal((await request(port, url, 'POST', {
          'x-api-key': 'xai-synthetic', 'user-agent': 'grok-shell/0.2.93',
        }, '{}')).status, 200);
        assert.equal(xaiReceived.length, xaiBefore + 1);
        assert.equal(xaiReceived.at(-1).url, url);
        assert.equal(xaiReceived.at(-1).headers['x-api-key'], 'xai-synthetic');
      }
      assert.equal(received.length, before);
      assert.equal(openaiReceived.length, otherBefore);
    });
    await t.test('routing fix (#745): Grok hub identity at xAI', async () => {
      assert.equal((await registerClient(home, 'grok')).ok, true);
      const before = received.length, otherBefore = openaiReceived.length;
      for (const headers of [{}, { 'x-api-key': 'xai-synthetic' }]) {
        for (const url of ['/v1/responses', '/v1/alpha/title', '/v1/models']) {
          const xaiBefore = xaiReceived.length;
          assert.equal((await request(port, `/_ccxray/client/${process.pid}${url}`, 'POST', headers, '{}')).status, 200);
          assert.equal(xaiReceived.length, xaiBefore + 1);
          assert.equal(xaiReceived.at(-1).url, url);
        }
      }
      assert.equal((await request(port, `/_ccxray/client/${process.pid}/v1/messages`, 'POST', {}, '{}')).status, 421);
      assert.equal(received.length, before);
      assert.equal(openaiReceived.length, otherBefore);
    });
    await stop(); child = null;
    const rows = fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.ok(['POST', 'HEAD', 'GET'].includes(row.method));
      assert.ok(row.path.startsWith('/'));
      assert.ok(!row.path.includes('?'));
      assert.notEqual(row.status, 421);
    }
    assert.ok(rows.some(row => row.path === '/v1/alpha/unlisted' && row.provider === 'openai' && row.agent === 'codex'));
  } finally {
    await stop();
    xai.closeAllConnections();
    await new Promise(resolve => xai.close(resolve));
    openai.closeAllConnections();
    await new Promise(resolve => openai.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
