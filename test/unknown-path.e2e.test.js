'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const headerNames = require('./fixtures/routing/header-names.json');
function shapeHeaders(shape) {
  return Object.fromEntries(headerNames[shape].filter(name => !['host', 'connection', 'upgrade'].includes(name)
    && !name.startsWith('sec-websocket-')).map(name => [name,
    name === 'authorization' ? 'Bearer syntheticheader.payload.signature'
      : name === 'user-agent' ? (shape.startsWith('grok') ? 'grok-shell/0.2.93'
        : shape.startsWith('codex') ? 'codex_cli_rs/0.163.0' : 'claude-code/2.1.306')
      : name === 'content-length' ? '2' : name === 'content-type' ? 'application/json'
      : name === 'content-encoding' ? 'gzip' : name === 'x-codex-turn-metadata' ? '{}' : 'synthetic']));
}
function assertShapeHeaders(headers, shape, extra = [], excluded = []) {
  const omitted = new Set(['accept-encoding', ...excluded]);
  const expected = new Set([...headerNames[shape].filter(name => !omitted.has(name)), ...extra,
    'host', 'connection']);
  for (const name of headerNames[shape]) {
    if (!omitted.has(name)) assert.ok(name in headers, `header allowlist: ${shape}: ${name}`);
  }
  for (const name of Object.keys(headers)) assert.ok(expected.has(name), `header allowlist: ${shape}: ${name}`);
  assert.equal(headers['accept-encoding'], undefined);
}
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
  const chatgptReceived = [];
  const chatgpt = http.createServer((req, res) => {
    chatgptReceived.push({ url: req.url, headers: req.headers }); req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"synthetic":true}');
  });
  const wsConnections = [];
  const wss = new WebSocket.Server({ noServer: true });
  const xaiReceived = [];
  const xai = http.createServer((req, res) => {
    xaiReceived.push({ url: req.url, headers: req.headers }); req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"synthetic":true}');
  });
  for (const server of [upstream, openai, chatgpt, xai]) {
    server.on('upgrade', (req, socket, head) => {
      wsConnections.push({ server, url: req.url, headers: req.headers });
      wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data)));
    });
  }
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
    const chatgptPort = await listen(chatgpt);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--hub-mode', '--no-browser'], {
      env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
        CLAUDE_CONFIG_DIR: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        CCXRAY_FORWARD_HEADERS: '',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: '127.0.0.1', OPENAI_TEST_PORT: String(openaiPort), OPENAI_TEST_PROTOCOL: 'http',
        XAI_BASE_URL: `http://127.0.0.1:${xaiPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${chatgptPort}/backend-api/codex` },
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
      const before = chatgptReceived.length;
      const openaiBefore = openaiReceived.length;
      const otherBefore = received.length;
      const result = await request(port, '/v1/alpha/search', 'POST', {
        authorization: 'Bearer syntheticheader.payload.signature', 'chatgpt-account-id': 'acct',
      }, '{}');
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.data), { synthetic: true });
      assert.equal(chatgptReceived.length, before + 1);
      assert.equal(openaiReceived.length, openaiBefore);
      assert.equal(chatgptReceived.at(-1).url, '/backend-api/codex/alpha/search');
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
    assert.equal(openaiReceived.length, 8);
    assert.equal(chatgptReceived.length, 4);
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
      for (const headers of [
        { 'user-agent': 'codex_cli_rs/0.163.0', authorization: 'Bearer sk-proj-synthetic' },
        { 'user-agent': 'codex_cli_rs/0.163.0', 'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature' },
      ]) {
        const expected = headers['chatgpt-account-id'] ? chatgptReceived : openaiReceived;
        const other = headers['chatgpt-account-id'] ? openaiReceived : chatgptReceived;
        const before = expected.length, otherBefore = received.length, otherCount = other.length;
        assert.equal((await request(port, '/v1/models?client_version=0.163.0', 'GET', headers)).status, 200);
        assert.equal(expected.length, before + 1);
        assert.equal(other.length, otherCount);
        assert.equal(expected.at(-1).url, headers['chatgpt-account-id']
          ? '/backend-api/codex/models?client_version=0.163.0' : '/v1/models?client_version=0.163.0');
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
    await t.test('routing fix (#745): real-socket WebSocket routing', async () => {
      async function upgrade(headers) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, { headers, handshakeTimeout: 3000 });
        let timer;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('WebSocket round trip timed out')), 5000);
            ws.once('error', reject);
            ws.once('unexpected-response', (_req, res) => {
              res.resume();
              resolve(res.statusCode);
            });
            ws.once('open', () => {
              ws.send('synthetic');
              ws.once('message', data => {
                if (data.toString() !== 'synthetic') return reject(new Error('WebSocket echo mismatch'));
                resolve(101);
              });
            });
          });
        } finally {
          clearTimeout(timer);
          ws.terminate();
        }
      }
      for (const headers of [{ 'x-api-key': 'sk-ant-synthetic' }, { 'anthropic-version': '2023-06-01' }]) {
        assert.equal(await upgrade(headers), 404);
        assert.equal(wsConnections.length, 0);
      }
      assert.equal(await upgrade({ 'user-agent': 'codex_cli_rs/0.163.0',
        'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature' }), 101);
      assert.equal(wsConnections.length, 1);
      assert.equal(wsConnections[0].server, chatgpt);
      assert.equal(wsConnections[0].url, '/backend-api/codex/responses');
      for (const account of [true, false]) {
        const headers = shapeHeaders('codex WS UPGRADE /v1/responses');
        if (!account) delete headers['chatgpt-account-id'];
        assert.equal(await upgrade({ ...headers, 'x-foo': 'synthetic', 'x-app': 'synthetic',
          'anthropic-extra': 'synthetic', 'x-ccxray-future': 'synthetic' }), 101);
        const row = wsConnections.at(-1);
        assert.equal(row.server, account ? chatgpt : openai);
        const observed = { ...row.headers };
        if (!account) assert.equal(observed['chatgpt-account-id'], undefined);
        assertShapeHeaders(observed, 'codex WS UPGRADE /v1/responses', [], account ? [] : ['chatgpt-account-id']);
      }

    });
    await t.test('routing fix (#745): Grok with Anthropic-shaped x-api-key', async () => {
      for (const headers of [{ 'user-agent': 'grok-shell/0.2' }, { 'x-grok-model-override': 'synthetic' }]) {
        for (const url of ['/v1/files', '/v1/models', '/v1/responses']) {
          assert.equal((await request(port, url, 'GET', { ...headers, 'x-api-key': 'sk-ant-synthetic' })).status, 421);
        }
      }
      assert.equal(xaiReceived.length, 0);
    });
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
      const xaiBeforeRejected = xaiReceived.length;
      for (const url of ['/v1/files', '/v1/models', '/v1/responses']) {
        for (const headers of [{ 'x-api-key': 'sk-ant-synthetic' }, { 'chatgpt-account-id': 'acct' },
          { 'x-codex-test': 'synthetic' }, { 'user-agent': 'codex_cli_rs/0.163.0' }, { originator: 'codex' }]) {
          assert.equal((await request(port, `/_ccxray/client/${process.pid}${url}`, 'GET', headers)).status, 421);
        }
      }
      assert.equal(xaiReceived.length, xaiBeforeRejected);
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

    await t.test('header allowlist: observed HTTP request shapes', async () => {
      for (const [shape, url, method, target] of [
        ['claude HEAD /api/hello', '/api/hello', 'HEAD', received],
        ['claude POST /v1/messages', '/v1/messages', 'POST', received],
        ['codex GET /v1/models', '/v1/models', 'GET', chatgptReceived],
        ['codex POST /v1/responses (HTTP fallback)', '/v1/responses', 'POST', chatgptReceived],
        ['grok POST /v1/responses', '/v1/responses', 'POST', xaiReceived],
      ]) {
        const headers = shapeHeaders(shape);
        const body = method === 'POST' ? (headers['content-encoding'] ? gzipSync('{}') : '{}') : undefined;
        if (headers['content-length']) headers['content-length'] = String(Buffer.byteLength(body));
        const foreign = shape.startsWith('claude') ? { 'session-id': 'synthetic' }
          : { 'x-app': 'synthetic', 'anthropic-extra': 'synthetic' };
        const before = target.length;
        assert.equal((await request(port, url, method, { ...headers, ...foreign,
          'x-foo': 'synthetic', 'x-ccxray-future': 'synthetic' }, body)).status, 200);
        assert.equal(target.length, before + 1);
        assertShapeHeaders(target.at(-1).headers, shape, ['content-length']);
        if (headers['content-encoding']) assert.equal(target.at(-1).headers['content-encoding'], 'gzip');
      }
      for (const mode of ['api', 'claude-api']) {
        const claude = mode === 'claude-api';
        const shape = claude ? 'claude POST /v1/messages' : 'codex POST /v1/responses (HTTP fallback)';
        const headers = shapeHeaders(shape);
        if (claude) { delete headers.authorization; headers['x-api-key'] = 'synthetic'; }
        else delete headers['chatgpt-account-id'];
        const body = headers['content-encoding'] ? gzipSync('{}') : '{}';
        headers['content-length'] = String(Buffer.byteLength(body));
        const target = claude ? received : openaiReceived;
        const before = target.length;
        assert.equal((await request(port, claude ? '/v1/messages' : '/v1/responses', 'POST', headers, body)).status, 200);
        assert.equal(target.length, before + 1);
        const observed = { ...target.at(-1).headers };
        if (claude) {
          assert.equal(observed['x-api-key'], 'synthetic');
          assert.equal(observed.authorization, undefined);
          delete observed['x-api-key']; observed.authorization = 'synthetic';
        } else assert.equal(observed['chatgpt-account-id'], undefined);
        assertShapeHeaders(observed, shape, [], claude ? [] : ['chatgpt-account-id']);
      }
    });
    await t.test('header allowlist: declarations and MCP transport names at fake upstreams', async () => {
      const foreignNames = ['x-grok-session-id', 'session-id', 'thread-id', 'version',
        'x-xai-token-auth', 'conversation_id'];
      const foreign = Object.fromEntries(foreignNames.map(name => [name, 'synthetic']));
      const declared = [...foreignNames, 'accept-encoding', 'x-user'].join(',');
      assert.equal((await request(port, '/v1/messages', 'POST', {
        ...foreign, 'anthropic-version': '2023-06-01', 'x-user': 'retained',
        'accept-encoding': 'gzip', 'x-ccxray-forward-headers': declared,
      }, '{}')).status, 200);
      const anthropicHeaders = received.at(-1).headers;
      assert.equal(anthropicHeaders['x-user'], 'retained');
      for (const name of [...foreignNames, 'accept-encoding', 'x-ccxray-forward-headers']) {
        assert.equal(anthropicHeaders[name], undefined, name);
      }
      for (const [url, signals, target] of [
        ['/v1/responses', { 'user-agent': 'codex_cli_rs/0.163.0' }, openaiReceived],
        ['/v1/responses', { 'chatgpt-account-id': 'acct' }, chatgptReceived],
        ['/v1/responses', { 'user-agent': 'grok-shell/0.2.93' }, xaiReceived],
      ]) {
        const before = target.length;
        assert.equal((await request(port, url, 'POST', {
          ...signals, 'x-user': 'omitted', 'x-ccxray-forward-headers': 'x-user',
          ...(target === xaiReceived ? { 'x-xai-token-auth': 'synthetic',
            'x-grok-client-version': 'synthetic' } : {}),
        }, '{}')).status, 200);
        assert.equal(target.length, before + 1);
        assert.equal(target.at(-1).headers['x-user'], undefined);
        assert.equal(target.at(-1).headers['x-ccxray-forward-headers'], undefined);
        if (target === xaiReceived) {
          assert.equal(target.at(-1).headers['x-xai-token-auth'], 'synthetic');
          assert.equal(target.at(-1).headers['x-grok-client-version'], 'synthetic');
        }
      }
      const mcp = { 'mcp-session-id': 'session', 'mcp-protocol-version': '2025-06-18', 'last-event-id': 'event' };
      for (const [url, signals, target] of [
        ['/v1/api/codex/ps/mcp', { 'chatgpt-account-id': 'acct' }, chatgptReceived],
        ['/v1/responses', { 'user-agent': 'codex_cli_rs/0.163.0' }, openaiReceived],
        ['/v1/messages', { 'anthropic-version': '2023-06-01',
          'x-ccxray-forward-headers': Object.keys(mcp).join(',') }, received],
      ]) {
        const before = target.length;
        assert.equal((await request(port, url, 'POST', { ...signals, ...mcp }, '{}')).status, 200);
        assert.equal(target.length, before + 1);
        for (const [name, value] of Object.entries(mcp)) {
          assert.equal(target.at(-1).headers[name], target === chatgptReceived ? value : undefined, name);
        }
        if (target === chatgptReceived) assert.equal(target.at(-1).url, '/backend-api/ps/mcp');
      }
    });
    await t.test('routing fix: bearer whitespace and duplicate header values', async () => {
      const counts = () => [openaiReceived.length, chatgptReceived.length, xaiReceived.length];
      const before = counts();
      const anthropicBefore = received.length;
      for (const [url, headers] of [
        ['/v1/messages', { ...shapeHeaders('claude POST /v1/messages'), 'x-codex-turn-metadata': '{}' }],
        ['/v1/responses', { ...shapeHeaders('codex GET /v1/models'), 'anthropic-beta': 'synthetic' }],
      ]) {
        delete headers['content-length'];
        assert.equal((await request(port, url, 'GET', headers)).status, 421);
      }
      assert.equal(received.length, anthropicBefore);
      for (const gap of ['  ', '\t']) {
        for (const url of ['/v1/responses', '/v1/models', '/v1/alpha/search', '/v1/codex/x']) {
          for (const explicit of [false, true]) {
            const headers = { authorization: `Bearer${gap}sk-ant-synthetic`,
              ...(explicit ? { 'user-agent': 'codex_cli_rs/0.163.0' } : {}) };
            const anthropicBefore = received.length;
            const allowed = url === '/v1/models' && !explicit;
            assert.equal((await request(port, url, 'GET', headers)).status, allowed ? 200 : 421);
            assert.equal(received.length, anthropicBefore + Number(allowed));
          }
        }
      }
      for (const name of ['x-api-key', 'authorization']) {
        const anthropic = name === 'x-api-key' ? 'sk-ant-synthetic' : 'Bearer\tsk-ant-synthetic';
        const other = name === 'x-api-key' ? 'xai-synthetic' : 'Bearer syntheticheader.payload.signature';
        for (const values of [[other, anthropic], [anthropic, other]]) {
          for (const url of ['/v1/models', '/v1/responses', '/v1/alpha/search', '/v1/codex/x', '/v1/files']) {
            const headers = ['host', `127.0.0.1:${port}`, 'user-agent', 'grok-shell/0.2.93',
              name, values[0], name, values[1]];
            assert.equal((await request(port, url, 'GET', headers)).status, 421);
          }
        }
      }
      assert.deepEqual(counts(), before);
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
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    chatgpt.closeAllConnections();
    await new Promise(resolve => chatgpt.close(resolve));
    xai.closeAllConnections();
    await new Promise(resolve => xai.close(resolve));
    openai.closeAllConnections();
    await new Promise(resolve => openai.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
