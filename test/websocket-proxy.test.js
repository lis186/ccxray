'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const WebSocket = require('ws');
const { deriveUpstreamToken } = require('./helpers/upstream-token');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function spawnServer(args, env) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
    env: { ...process.env, BROWSER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.getOutput = () => ({ stdout, stderr });
  return child;
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
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for proxy'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for proxy'));
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

async function waitForIndexEntry(logsDir, predicate, timeoutMs = 4000) {
  const indexPath = path.join(logsDir, 'index.ndjson');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(indexPath)) {
      const entries = fs.readFileSync(indexPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const match = entries.find(predicate);
      if (match) return match;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for index entry');
}

// Wait until at least `minCount` index entries match, returning the matches.
// Polling beats a fixed sleep before reading index.ndjson — the proxy writes
// from a separate process and a guessed delay flakes under load. See #100.
async function waitForIndexEntries(logsDir, predicate, minCount, timeoutMs = 4000) {
  const indexPath = path.join(logsDir, 'index.ndjson');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(indexPath)) {
      const matches = fs.readFileSync(indexPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(predicate);
      if (matches.length >= minCount) return matches;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${minCount} index entries`);
}

// ponytail: bounded barrier — rejects on close/error/timeout instead of hanging forever
function waitForCompleted(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('barrier timeout: no response.completed')); }, timeoutMs);
    const onMsg = d => {
      if (JSON.parse(d.toString()).type === 'response.completed') { cleanup(); resolve(); }
    };
    const onClose = () => { cleanup(); reject(new Error('ws closed before response.completed')); };
    const onError = err => { cleanup(); reject(err); };
    function cleanup() { clearTimeout(timer); ws.off('message', onMsg); ws.off('close', onClose); ws.off('error', onError); }
    ws.on('message', onMsg);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

describe('OpenAI Responses WebSocket proxy', () => {
  let testHome;
  let upstreamServer;
  let upstreamWss;
  let upstreamPort;
  let proxyChild;
  let proxyPort;

  beforeEach(async () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ws-test-'));
    upstreamServer = http.createServer();
    await new Promise(resolve => upstreamServer.listen(0, resolve));
    upstreamPort = upstreamServer.address().port;
    proxyPort = await findFreePort();
  });

  afterEach(async () => {
    await killAndWait(proxyChild);
    if (upstreamWss) await new Promise(resolve => upstreamWss.close(resolve));
    if (upstreamServer?.listening) await new Promise(resolve => upstreamServer.close(resolve));
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  async function startProxy(extraEnv = {}) {
    proxyChild = spawnServer(['--port', String(proxyPort)], {
      CCXRAY_HOME: testHome,
      OPENAI_TEST_HOST: 'localhost',
      OPENAI_TEST_PORT: String(upstreamPort),
      OPENAI_TEST_PROTOCOL: 'http',
      ...extraEnv,
    });
    await waitForPort(proxyPort);
  }

  it('forwards text and binary frames and records a transport entry by session_id header', async () => {
    const received = { headers: null, text: null, binary: null };
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', (ws, req) => {
      received.headers = req.headers;
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          received.binary = Buffer.from(data);
          ws.send(data, { binary: true });
        } else {
          received.text = data.toString();
          ws.send(`echo:${received.text}`);
        }
      });
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea943';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        authorization: 'Bearer test-openai-key',
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
        'x-codex-turn-metadata': JSON.stringify({
          session_id: sessionId,
          agent_type: 'worker',
          workspaces: { cwd: '/tmp/ccxray-ws' },
        }),
      },
    });

    const messages = [];
    ws.on('message', data => messages.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send('hello');
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    assert.equal(received.headers['openai-beta'], 'responses_websockets=2026-02-06');
    assert.equal(received.headers.session_id, sessionId);
    assert.equal(received.headers.authorization, 'Bearer test-openai-key');
    assert.equal(received.text, 'hello');
    assert.deepEqual(received.binary, Buffer.from([1, 2, 3]));
    assert.ok(messages.some(msg => msg.toString() === 'echo:hello'));
    assert.ok(messages.some(msg => msg.equals(Buffer.from([1, 2, 3]))));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.provider, 'openai');
    assert.equal(entry.agent, 'codex');
    assert.equal(entry.isSubagent, true);
    assert.equal(entry.cwd, '/tmp/ccxray-ws');
    assert.equal(entry.responseMetadata.transport, 'websocket');
    assert.equal(entry.responseMetadata.capture, 'transport-only');
    assert.equal(entry.responseMetadata.frameCounts.clientToUpstream, 2);
    assert.equal(entry.responseMetadata.frameCounts.upstreamToClient, 2);

    const reqLog = JSON.parse(fs.readFileSync(path.join(testHome, 'logs', `${entry.id}_req.json`), 'utf8'));
    assert.equal(reqLog.transport, 'websocket');
    assert.equal(reqLog.headers.sessionId, sessionId);
    assert.equal(reqLog.headers.agentType, 'worker');
  });

  it('extracts stopReason and title from response events and client request', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', () => {
        ws.send(JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
        }));
      });
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea950';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({
      type: 'response.create', generate: true,
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] }],
    }));
    await new Promise(resolve => setTimeout(resolve, 300));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.stopReason, 'completed');
    assert.equal(entry.title, 'Say hello');
  });

  it('closes the client and records an error entry when upstream rejects the handshake', async () => {
    upstreamServer.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea944';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });

    const close = await new Promise(resolve => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    assert.equal(close.code, 1011);

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.status, 401);
    assert.match(entry.responseMetadata.error.message, /rejected handshake: 401/);
  });

  it('routes /v1/realtime WebSocket upgrades to the OpenAI upstream', async () => {
    const received = { url: null, text: null };
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/realtime' });
    upstreamWss.on('connection', (ws, req) => {
      received.url = req.url;
      ws.on('message', data => {
        received.text = data.toString();
        ws.send('realtime-ok');
      });
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea945';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/realtime?model=gpt-realtime`, {
      headers: {
        'openai-beta': 'realtime=v1',
        session_id: sessionId,
      },
    });
    const messages = [];
    ws.on('message', data => messages.push(data.toString()));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send('hello realtime');
    await new Promise(resolve => setTimeout(resolve, 200));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    assert.equal(received.url, '/v1/realtime?model=gpt-realtime');
    assert.equal(received.text, 'hello realtime');
    assert.ok(messages.includes('realtime-ok'));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.provider, 'openai');
    assert.equal(entry.responseMetadata.transport, 'websocket');
    assert.equal(entry.responseMetadata.endpoint, '/v1/realtime');
    const reqLog = JSON.parse(fs.readFileSync(path.join(testHome, 'logs', `${entry.id}_req.json`), 'utf8'));
    assert.equal(reqLog.url, '/v1/realtime?model=gpt-realtime');
    assert.equal(reqLog.endpoint, '/v1/realtime');
  });

  it('records the entry and keeps running when the client disconnects abnormally', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', data => ws.send(`echo:${data.toString()}`));
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea946';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send('hello');
    await new Promise(resolve => setTimeout(resolve, 100));
    ws.terminate();

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.status, 101);
    assert.equal(entry.responseMetadata.close.side, 'client');
    assert.equal(entry.responseMetadata.close.code, 1006);

    await waitForPort(proxyPort);
    assert.equal(proxyChild.exitCode, null);
  });

  it('closes idle WebSocket pairs and records a timeout entry', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', () => {});
    await startProxy({ CCXRAY_WS_IDLE_TIMEOUT_MS: '100' });

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea947';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const close = await new Promise(resolve => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    assert.equal(close.code, 1011);
    assert.equal(close.reason, 'idle timeout');

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.status, 504);
    assert.match(entry.responseMetadata.error.message, /idle timeout/);
  });

  it('fires idle timeout when upstream stalls before completing handshake', async () => {
    // Accept TCP but never reply: simulates a slowloris-style upstream. Track
    // the raw sockets so afterEach's upstreamServer.close() doesn't block on
    // upgraded connections that we own directly.
    const stalledSockets = [];
    upstreamServer.on('upgrade', (_req, socket) => {
      stalledSockets.push(socket);
    });
    try {
      await startProxy({ CCXRAY_WS_IDLE_TIMEOUT_MS: '150' });

      const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea947';
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=2026-02-06',
          session_id: sessionId,
        },
      });
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const close = await new Promise(resolve => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      assert.equal(close.code, 1011);
      assert.equal(close.reason, 'idle timeout');

      const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
      assert.equal(entry.status, 504);
      assert.match(entry.responseMetadata.error.message, /idle timeout/);
    } finally {
      for (const socket of stalledSockets) {
        try { socket.destroy(); } catch {}
      }
    }
  });

  it('rejects WebSocket upgrade with 401 when no X-Ccxray-Auth is present (enforcement on)', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', () => {
      throw new Error('upstream should not be reached when auth fails');
    });
    await startProxy({ CCXRAY_LOOPBACK_REQUIRE_AUTH: '1' });

    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: 'auth-fail-001',
      },
    });
    const result = await new Promise(resolve => {
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ statusCode: res.statusCode });
      });
      ws.on('error', err => resolve({ error: err.message }));
    });
    assert.equal(result.statusCode, 401);
  });

  it('rejects WebSocket upgrade with 401 when X-Ccxray-Auth is forged', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', () => {
      throw new Error('upstream should not be reached when auth fails');
    });
    await startProxy({ CCXRAY_LOOPBACK_REQUIRE_AUTH: '1' });

    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        'x-ccxray-auth': 'forged-nonsense',
        session_id: 'auth-fail-002',
      },
    });
    const result = await new Promise(resolve => {
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ statusCode: res.statusCode });
      });
      ws.on('error', err => resolve({ error: err.message }));
    });
    assert.equal(result.statusCode, 401);
  });

  it('accepts WebSocket upgrade with a valid X-Ccxray-Auth (enforcement on)', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', (ws) => {
      ws.on('message', data => ws.send(`echo:${data.toString()}`));
    });
    await startProxy({ CCXRAY_LOOPBACK_REQUIRE_AUTH: '1' });

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea948';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'x-ccxray-auth': deriveUpstreamToken({ home: testHome }),
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });
    const messages = [];
    ws.on('message', d => messages.push(d.toString()));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send('ping');
    await new Promise(r => setTimeout(r, 200));
    ws.close(1000, 'done');
    await new Promise(r => ws.on('close', r));
    assert.ok(messages.includes('echo:ping'));
  });

  it('captures response.create frame content in _req.json and populates tokens/msgCount/toolCount', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }));
        ws.send(JSON.stringify({
          type: 'response.completed',
          response: {
            usage: { input_tokens: 500, output_tokens: 20 },
            model: 'gpt-5.5',
          },
        }));
      });
    });
    await startProxy();

    const sessionId = 'ws-capture-test-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.5',
      instructions: 'You are a test assistant.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] },
      ],
      tools: [
        { type: 'function', name: 'shell', description: 'Run command', parameters: { type: 'object' } },
        { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
      ],
      tool_choice: 'auto',
    }));

    await new Promise(resolve => setTimeout(resolve, 500));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.msgCount, 1, 'msgCount should reflect input array length');
    assert.equal(entry.toolCount, 2, 'toolCount should reflect tools array length');

    // Prompt identity parity with the HTTP path (codex main traffic is WS)
    assert.match(entry.sysHash, /^[0-9a-f]{12}$/, 'sysHash from instructions');
    assert.match(entry.coreHash, /^[0-9a-f]{12}$/, 'coreHash from prompt registration');
    assert.equal(entry.agentKey, 'default');
    assert.equal(entry.agentLabel, 'Codex Default');
    assert.ok(fs.existsSync(path.join(testHome, 'logs', 'shared', `openai_instructions_${entry.sysHash}.json`)), 'shared instructions file written');

    const reqLog = JSON.parse(fs.readFileSync(path.join(testHome, 'logs', `${entry.id}_req.json`), 'utf8'));
    assert.equal(reqLog.provider, 'openai');
    assert.equal(reqLog.model, 'gpt-5.5');
    assert.equal(reqLog.instructions, 'You are a test assistant.');
    assert.equal(reqLog.transport, 'websocket');
    assert.equal(reqLog.capture, undefined, 'capture should NOT be transport-only when content is captured');
    assert.ok(Array.isArray(reqLog.input), 'input array should be present');
    assert.equal(reqLog.input.length, 1);
    assert.equal(reqLog.input[0].role, 'user');
    assert.ok(Array.isArray(reqLog.tools), 'tools array should be present');
    assert.equal(reqLog.tools.length, 2);
    assert.equal(reqLog.tool_choice, 'auto');
  });

  it('captured request without instructions still classifies agent (codex default)', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => { ws.on('message', () => {}); });
    await startProxy();

    const sessionId = 'ws-noinstr-test-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: { 'openai-beta': 'responses_websockets=2026-02-06', session_id: sessionId },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }));
    await new Promise(resolve => setTimeout(resolve, 500));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.sysHash ?? null, null, 'no instructions → no sysHash');
    assert.equal(entry.agentKey, 'default', 'fallback classification without instructions');
  });

  it('falls back to transport-only when client sends non-JSON frames', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', () => ws.send('pong'));
    });
    await startProxy();

    const sessionId = 'ws-capture-fallback-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        session_id: sessionId,
      },
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send('not json');
    await new Promise(resolve => setTimeout(resolve, 200));
    ws.close(1000, 'done');
    await new Promise(resolve => ws.on('close', resolve));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId);
    assert.equal(entry.msgCount, 0, 'msgCount should be 0 for non-captured frames');

    const reqLog = JSON.parse(fs.readFileSync(path.join(testHome, 'logs', `${entry.id}_req.json`), 'utf8'));
    assert.equal(reqLog.capture, 'transport-only', 'should fall back to transport-only');
    assert.equal(reqLog.instructions, undefined, 'no instructions in transport-only');
  });

  it('returns 404 for upgrades on non-OpenAI WebSocket paths', async () => {
    await startProxy();
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/messages`);
    const result = await new Promise(resolve => {
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ statusCode: res.statusCode });
      });
      ws.on('error', err => resolve({ error: err.message }));
    });
    assert.equal(result.statusCode, 404);
  });

  it('forwards Sec-WebSocket-Protocol selection through to the upstream', async () => {
    let upstreamProtocolHeader = null;
    upstreamWss = new WebSocket.Server({
      server: upstreamServer,
      path: '/v1/responses',
      handleProtocols(protocols) {
        return protocols.values().next().value || false;
      },
    });
    const upstreamConnected = new Promise(resolve => {
      upstreamWss.on('connection', (_ws, req) => {
        upstreamProtocolHeader = req.headers['sec-websocket-protocol'];
        resolve();
      });
    });
    await startProxy();

    const sessionId = '019e0ab2-bcc2-7b72-a1bf-980edc2ea949';
    const ws = new WebSocket(
      `ws://localhost:${proxyPort}/v1/responses`,
      ['codex-v1', 'codex-v2'],
      { headers: { session_id: sessionId } },
    );
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    // Proxy → upstream handshake races the proxy → client one; wait for it.
    await upstreamConnected;

    assert.equal(ws.protocol, 'codex-v1');
    // ws joins protocols with ", " when constructing the upstream request header.
    assert.match(upstreamProtocolHeader || '', /codex-v1.*codex-v2/);
    ws.close(1000, 'done');
    await new Promise(r => ws.on('close', r));
  });

  it('emits a separate entry per response.completed turn within one WS', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    let msgCount = 0;
    upstreamWss.on('connection', ws => {
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type !== 'response.create') return;
        msgCount++;
        ws.send(JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'gpt-5.5',
            usage: { input_tokens: 100 * msgCount, output_tokens: 10 * msgCount, total_tokens: 110 * msgCount },
          },
        }));
      });
    });
    await startProxy();

    const sessionId = 'ws-per-turn-multi-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: { 'openai-beta': 'responses_websockets=2026-02-06', session_id: sessionId },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    const turn1Done = waitForCompleted(ws);
    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Turn one' }] }],
    }));
    await turn1Done;
    // ponytail: 2ms guard against ms-precision timestamp collision on fast roundtrips
    await new Promise(r => setTimeout(r, 2));

    const turn2Done = waitForCompleted(ws);
    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Turn two' }] }],
    }));
    await turn2Done;
    ws.close(1000, 'done');
    await new Promise(r => ws.on('close', r));

    const turnEntries = await waitForIndexEntries(
      path.join(testHome, 'logs'),
      e => e.sessionId === sessionId && e.title,
      2,
    );
    assert.equal(turnEntries.length, 2, 'should have 2 per-turn entries');
    assert.notEqual(turnEntries[0].id, turnEntries[1].id, 'entries should have different IDs');
    assert.equal(turnEntries[0].title, 'Turn one');
    assert.equal(turnEntries[1].title, 'Turn two');
    assert.equal(turnEntries[0].usage.input_tokens, 100);
    assert.equal(turnEntries[1].usage.input_tokens, 200);
    assert.equal(turnEntries[0].stopReason, 'completed');
    assert.equal(turnEntries[1].stopReason, 'completed');
  });

  it('skips warm-up turn (generate=false) and only emits real turns', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type !== 'response.create') return;
        ws.send(JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'gpt-5.5',
            usage: { input_tokens: parsed.generate === false ? 500 : 1000, output_tokens: parsed.generate === false ? 0 : 50, total_tokens: parsed.generate === false ? 500 : 1050 },
          },
        }));
      });
    });
    await startProxy();

    const sessionId = 'ws-warmup-skip-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: { 'openai-beta': 'responses_websockets=2026-02-06', session_id: sessionId },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    const warmupDone = waitForCompleted(ws);
    ws.send(JSON.stringify({ type: 'response.create', generate: false, model: 'gpt-5.5' }));
    await warmupDone;

    const realDone = waitForCompleted(ws);
    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Real turn' }] }],
    }));
    await realDone;
    ws.close(1000, 'done');
    await new Promise(r => ws.on('close', r));

    // Wait for the real turn to land, then assert the warm-up produced no entry.
    // Warm-up is sent first, so by the time the real-turn entry exists, a wrongly
    // recorded warm-up entry would already be present too.
    const logsDir = path.join(testHome, 'logs');
    await waitForIndexEntry(logsDir, e => e.sessionId === sessionId && e.title === 'Real turn');
    const entries = fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const turnEntries = entries.filter(e => e.sessionId === sessionId && e.title);
    assert.equal(turnEntries.length, 1, 'should have 1 entry (warm-up skipped)');
    assert.equal(turnEntries[0].title, 'Real turn');
    assert.equal(turnEntries[0].usage.input_tokens, 1000);
  });

  it('emits a partial entry when WS closes mid-turn (before response.completed)', async () => {
    upstreamWss = new WebSocket.Server({ server: upstreamServer, path: '/v1/responses' });
    upstreamWss.on('connection', ws => {
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type !== 'response.create') return;
        ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial output' }));
      });
    });
    await startProxy();

    const sessionId = 'ws-mid-turn-close-001';
    const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
      headers: { 'openai-beta': 'responses_websockets=2026-02-06', session_id: sessionId },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Interrupted turn' }] }],
    }));
    await new Promise(r => setTimeout(r, 200));
    ws.close(1000, 'mid-turn close');
    await new Promise(r => ws.on('close', r));

    const entry = await waitForIndexEntry(path.join(testHome, 'logs'), e => e.sessionId === sessionId && e.title);
    assert.equal(entry.title, 'Interrupted turn');
    assert.equal(entry.status, 101);
  });
});
