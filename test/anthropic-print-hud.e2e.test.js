'use strict';

// Derive a real Claude launch env from providers.js, parse its newline-delimited
// custom headers as Claude Code does, and drive those headers through the real
// HTTP/SSE forward path for both print and interactive launches.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const PROVIDERS_SCRIPT = path.join(__dirname, '..', 'server', 'providers.js');
const TEST_AUTH_TOKEN = 'synthetic-print-hud-auth-token';

// Matches Claude Code's ANTHROPIC_CUSTOM_HEADERS rule: split on CRLF/LF and
// split each Name: value entry at its first colon.
function parseClaudeCustomHeaders(value) {
  const headers = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

function createClaudeLaunchEnv(port, args, env) {
  const launcherScript = [
    `const providers = require(${JSON.stringify(PROVIDERS_SCRIPT)});`,
    `const auth = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'auth.js'))});`,
    "const launch = providers.getAgentLaunch('claude', Number(process.env.CCXRAY_TEST_LAUNCH_PORT), JSON.parse(process.env.CCXRAY_TEST_LAUNCH_ARGS), process.env);",
    "const expectedAuthToken = auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');",
    'process.stdout.write(JSON.stringify({ env: launch.env, expectedAuthToken }));',
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', launcherScript], {
    env: {
      ...env,
      CCXRAY_TEST_LAUNCH_PORT: String(port),
      CCXRAY_TEST_LAUNCH_ARGS: JSON.stringify(args),
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  return JSON.parse(output);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function findFreePort() {
  const server = http.createServer();
  return listen(server).then(port => new Promise(resolve => server.close(() => resolve(port))));
}

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', resolve);
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
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function isolatedEnv(dataHome, userHome, overrides = {}) {
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(key)) delete base[key];
  }
  delete base.LOGS_DIR;
  delete base.STORAGE_BACKEND;
  delete base.PROXY_PORT;
  delete base.CLAUDE_CONFIG_DIR;
  return {
    ...base,
    ...overrides,
    HOME: userHome,
    CCXRAY_HOME: dataHome,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_PRICING_CACHE: path.join(dataHome, 'pricing-cache.json'),
    RESTORE_DAYS: '0',
    LOG_RETENTION_DAYS: '0',
    BROWSER: 'none',
    TZ: 'UTC',
  };
}

function makeAnthropicUpstream() {
  const receivedHeaders = [];
  let responseNumber = 0;
  const server = http.createServer((req, res) => {
    receivedHeaders.push({ ...req.headers });
    req.resume();
    req.on('end', () => {
      responseNumber += 1;
      const message = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      const body = [
        message('message_start', {
          type: 'message_start',
          message: {
            id: `msg_print_hud_${responseNumber}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
        message('content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        }),
        message('content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'The model reply.' },
        }),
        message('content_block_stop', { type: 'content_block_stop', index: 0 }),
        message('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 4 },
        }),
        message('message_stop', { type: 'message_stop' }),
      ].join('');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
  });
  return { server, receivedHeaders };
}

function postMessages(port, sessionId, claudeHeaders) {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    stream: true,
    metadata: { session_id: sessionId },
    messages: [{ role: 'user', content: 'Reply with the model response.' }],
  });
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
    ...claudeHeaders,
  };

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function parseSSE(raw) {
  return raw.split(/\n\n/).filter(Boolean).map(frame => {
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
    return dataLine ? JSON.parse(dataLine.slice(6)) : null;
  }).filter(Boolean);
}

function textBlocks(events) {
  const byIndex = new Map();
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      byIndex.set(event.index, '');
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      byIndex.set(event.index, (byIndex.get(event.index) || '') + event.delta.text);
    }
  }
  return [...byIndex].sort(([a], [b]) => a - b).map(([, text]) => text);
}

describe('Anthropic Context HUD and Claude print-mode header', () => {
  let scratch, dataHome, userHome, upstream, proxyChild, proxyPort, upstreamPort;
  let proxyStderr = '';

  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-print-hud-'));
    dataHome = path.join(scratch, 'ccxray-home');
    userHome = path.join(scratch, 'user-home');
    fs.mkdirSync(path.join(dataHome, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'logs', 'index.ndjson'), '');
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'pricing-cache.json'), JSON.stringify({
      fetchedAt: Date.now(),
      pricing: {},
      context: {},
    }));

    const mock = makeAnthropicUpstream();
    upstream = mock.server;
    upstream.receivedHeaders = mock.receivedHeaders;
    upstreamPort = await listen(upstream);

    proxyPort = await findFreePort();
    const childEnv = isolatedEnv(dataHome, userHome, {
      ANTHROPIC_TEST_HOST: '127.0.0.1',
      ANTHROPIC_TEST_PORT: String(upstreamPort),
      ANTHROPIC_TEST_PROTOCOL: 'http',
      AUTH_TOKEN: TEST_AUTH_TOKEN,
      CCXRAY_LOOPBACK_REQUIRE_AUTH: '1',
    });
    proxyChild = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxyChild.stdout.on('data', () => {});
    proxyChild.stderr.on('data', chunk => { proxyStderr += chunk.toString(); });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('preserves model text as the last text block for print mode and keeps HUD for interactive mode', async () => {
    const userHeader = 'X-User-Header: retained synthetic value';
    const launchEnv = { ...isolatedEnv(dataHome, userHome, { AUTH_TOKEN: TEST_AUTH_TOKEN }) };
    launchEnv.ANTHROPIC_CUSTOM_HEADERS = userHeader;

    const printLaunch = createClaudeLaunchEnv(proxyPort, ['--model', 'claude-sonnet-4-6', '-p'], launchEnv);
    const printHeaders = parseClaudeCustomHeaders(printLaunch.env.ANTHROPIC_CUSTOM_HEADERS);
    assert.equal(printLaunch.env.ANTHROPIC_BASE_URL, `http://localhost:${proxyPort}`);
    assert.ok(printLaunch.env.ANTHROPIC_CUSTOM_HEADERS.includes(`X-Ccxray-Auth: ${printLaunch.expectedAuthToken}`));

    const printResult = await postMessages(proxyPort, '11111111-1111-4111-8111-111111111111', printHeaders);
    assert.equal(
      printResult.statusCode,
      200,
      `Claude-parsed header names: ${Object.keys(printHeaders).join(', ')}; unexpected proxy stderr: ${proxyStderr}`,
    );
    assert.equal(printHeaders['x-user-header'], 'retained synthetic value');
    assert.equal(printHeaders['x-ccxray-auth'], printLaunch.expectedAuthToken);
    assert.equal(printHeaders['x-ccxray-print-mode'], 'true');
    const printBlocks = textBlocks(parseSSE(printResult.body));
    assert.deepEqual(printBlocks, ['The model reply.']);
    assert.doesNotMatch(printResult.body, /\n\n---\nContext:/);

    const interactiveLaunch = createClaudeLaunchEnv(proxyPort, ['--model', 'claude-sonnet-4-6'], launchEnv);
    const interactiveHeaders = parseClaudeCustomHeaders(interactiveLaunch.env.ANTHROPIC_CUSTOM_HEADERS);

    const interactiveResult = await postMessages(proxyPort, '22222222-2222-4222-8222-222222222222', interactiveHeaders);
    assert.equal(
      interactiveResult.statusCode,
      200,
      `Claude-parsed header names: ${Object.keys(interactiveHeaders).join(', ')}; unexpected proxy stderr: ${proxyStderr}`,
    );
    assert.equal(interactiveHeaders['x-user-header'], 'retained synthetic value');
    assert.equal(interactiveHeaders['x-ccxray-auth'], interactiveLaunch.expectedAuthToken);
    assert.equal(interactiveHeaders['x-ccxray-print-mode'], undefined);
    const interactiveBlocks = textBlocks(parseSSE(interactiveResult.body));
    assert.equal(interactiveBlocks[0], 'The model reply.');
    assert.match(interactiveBlocks.at(-1), /\n\n---\nContext:/);

    assert.equal(upstream.receivedHeaders.length, 2);
    for (const headers of upstream.receivedHeaders) {
      assert.equal(headers['x-user-header'], 'retained synthetic value', 'pre-existing user header must survive');
      assert.equal(
        Object.keys(headers).some(name => name.toLowerCase().startsWith('x-ccxray-')),
        false,
        'internal ccxray headers must be stripped upstream',
      );
      for (const [name, value] of Object.entries(headers)) {
        assert.doesNotMatch(String(value), /x-ccxray-/i, `${name} must not contain an internal header marker`);
      }
    }
  });
});
