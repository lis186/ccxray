'use strict';

// #636 acceptance: work attribution (task / role / project) reaches the index
// for every supported CLI wire — Claude (Anthropic HTTP), Codex (OpenAI HTTP and
// WebSocket), Grok (OpenAI wire → xai) — through the one carrier they all share:
// the /_ccxray/attr/ base-URL prefix. Runs the real proxy against a mock
// upstream, so it also proves the prefix and the x-ccxray-* headers never leave
// the process.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const { buildAttributionPrefix } = require('../server/attribution');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');

function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
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
        res.on('end', resolve);
      });
      const retry = () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      };
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
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

function request(port, { method, path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readIndexLines(home) {
  const file = path.join(home, 'logs', 'index.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function waitForIndexLines(home, count, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const lines = readIndexLines(home);
    if (lines.length >= count) return lines;
    if (Date.now() - start > timeoutMs) return lines;
    await new Promise(r => setTimeout(r, 100));
  }
}

function makeUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    hits.push({ url: req.url, headers: { ...req.headers } });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (pathname.endsWith('/billing')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ config: { creditUsagePercent: 1 } }));
      }
      if (pathname.endsWith('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: `msg_${hits.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 },
        }));
      }
      if (pathname.endsWith('/responses')) {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        const model = body.model || 'gpt-5.5';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: `resp_${hits.length}`, object: 'response', model, status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 40 } },
        }));
      }
      res.writeHead(404).end('nope');
    });
  });
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    hits.push({ url: req.url, headers: { ...req.headers }, upgrade: true });
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', () => {
        try { ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })); } catch {}
      });
    });
  });
  return { server, wss, hits };
}

const CLAUDE_HEADERS = { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' };
const claudeBody = sid => ({
  model: 'claude-sonnet-4', max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
  metadata: { user_id: JSON.stringify({ session_id: sid }) },
});
const GROK_HEADERS = {
  authorization: 'Bearer tok', 'user-agent': 'grok-shell/0.2.93',
  'x-grok-client-identifier': 'grok-shell', 'x-grok-client-version': '0.2.93',
  'x-grok-session-id': '019f-attr-grok',
};

describe('work attribution across claude / codex / grok', () => {
  let upstream;
  let proxy;
  let proxyPort;
  let home;

  before(async () => {
    const upstreamPort = await findFreePort();
    proxyPort = await findFreePort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-attr-'));
    upstream = makeUpstream();
    await new Promise(r => upstream.server.listen(upstreamPort, '127.0.0.1', r));
    // No CCXRAY_TASK/ROLE/PROJECT in the proxy env: attribution must come from
    // the request, never from the hub process's own environment.
    const env = { ...process.env };
    for (const k of ['CCXRAY_TASK', 'CCXRAY_ROLE', 'CCXRAY_PROJECT', 'CCXRAY_AGENT_ID', 'CCXRAY_TEAM', 'CCXRAY_USER_EMAIL', 'CCXRAY_AGENT_TYPE']) delete env[k];
    proxy = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...env,
        CCXRAY_HOME: home, BROWSER: 'none', RESTORE_DAYS: '0', CCXRAY_IMPORT_DISABLE: '1',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        XAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxy);
    for (const client of upstream.wss.clients) client.terminate();
    await new Promise(r => upstream.wss.close(r));
    await new Promise(r => upstream.server.close(r));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('attributes all three CLIs through the base-URL prefix and keeps it off the wire', async () => {
    const prefix = role => buildAttributionPrefix({ task: 'A-012', role, project: 'ipad pos/north' });

    const claude = await request(proxyPort, {
      method: 'POST', path: `${prefix('implementation')}/v1/messages`,
      headers: CLAUDE_HEADERS, body: claudeBody('attr-claude-1'),
    });
    assert.equal(claude.status, 200, claude.body.slice(0, 200));

    const codex = await request(proxyPort, {
      method: 'POST', path: `${prefix('cross-check')}/v1/responses`,
      headers: { authorization: 'Bearer sk-test', session_id: 'attr-codex-1' },
      body: { model: 'gpt-5.5', instructions: 'You are Codex', input: [{ type: 'message', role: 'user', content: 'hi' }] },
    });
    assert.equal(codex.status, 200, codex.body.slice(0, 200));

    const grok = await request(proxyPort, {
      method: 'POST', path: `${prefix('acceptance')}/v1/responses`,
      headers: GROK_HEADERS,
      body: { model: 'grok-4.5', input: [{ type: 'message', role: 'user', content: '<user_query> hi </user_query>' }] },
    });
    assert.equal(grok.status, 200, grok.body.slice(0, 200));

    const lines = (await waitForIndexLines(home, 3)).filter(l => l.task === 'A-012');
    const byAgent = Object.fromEntries(lines.map(l => [l.agent, l]));
    assert.deepEqual(Object.keys(byAgent).sort(), ['claude', 'codex', 'grok']);
    assert.equal(byAgent.claude.role, 'implementation');
    assert.equal(byAgent.codex.role, 'cross-check');
    assert.equal(byAgent.grok.role, 'acceptance');
    // A project label with a space and a slash survives the path segment.
    for (const l of lines) assert.equal(l.taskProject, 'ipad pos/north');

    // Upstream saw the real API path and no ccxray-internal header.
    const apiHits = upstream.hits.filter(h => !h.url.includes('billing'));
    for (const h of apiHits) {
      assert.ok(!h.url.includes('_ccxray'), `prefix leaked upstream: ${h.url}`);
      assert.deepEqual(Object.keys(h.headers).filter(k => k.startsWith('x-ccxray-')), []);
    }
    assert.ok(apiHits.some(h => h.url === '/v1/messages'));

    const summary = JSON.parse((await request(proxyPort, {
      method: 'GET', path: '/_api/task-summary?task=A-012&project=ipad%20pos%2Fnorth',
    })).body);
    assert.equal(summary.calls, 3);
    assert.deepEqual(summary.agents, ['claude', 'codex', 'grok']);
    assert.deepEqual(Object.keys(summary.by_role).sort(), ['acceptance', 'cross-check', 'implementation']);
    // Canonical usage: OpenAI-wire input excludes the 40 cached tokens.
    // claude 12+3+8, codex and grok 60+5+40 each.
    assert.equal(summary.tokens.cache_read, 8 + 40 + 40);
    assert.equal(summary.tokens.total, 23 + 105 + 105);
    assert.equal(summary.by_role['cross-check'].tokens.total, 105);

    const other = JSON.parse((await request(proxyPort, {
      method: 'GET', path: '/_api/task-summary?task=A-012&project=elsewhere',
    })).body);
    assert.equal(other.calls, 0);
  });

  it('advertises the task-attribution capability on the health endpoint', async () => {
    const health = JSON.parse((await request(proxyPort, { method: 'GET', path: '/_api/health' })).body);
    assert.equal(health.ok, true);
    assert.equal(health.app, 'ccxray');
    assert.ok(Array.isArray(health.capabilities) && health.capabilities.includes('task-attribution'));
  });

  it('accepts header attribution from Claude and strips it before forwarding', async () => {
    const before = upstream.hits.length;
    const out = await request(proxyPort, {
      method: 'POST', path: '/v1/messages',
      headers: {
        ...CLAUDE_HEADERS,
        // The shape ccxray's own launcher produces when it comma-joins onto an
        // existing ANTHROPIC_CUSTOM_HEADERS value.
        'x-ccxray-task': 'H-001, X-Ccxray-Account: someone@example.test',
        'x-ccxray-role': ' spec ',
        'x-ccxray-project': 'hdr-project',
      },
      body: claudeBody('attr-claude-hdr'),
    });
    assert.equal(out.status, 200);
    const start = Date.now();
    let line;
    while (!line && Date.now() - start < 8000) {
      line = readIndexLines(home).find(l => l.task === 'H-001');
      if (!line) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(line, 'header-attributed entry missing');
    assert.equal(line.role, 'spec');
    assert.equal(line.taskProject, 'hdr-project');
    const hit = upstream.hits.slice(before).find(h => h.url === '/v1/messages');
    assert.deepEqual(Object.keys(hit.headers).filter(k => k.startsWith('x-ccxray-')), []);
  });

  it('lets the path prefix override an inherited header per key', async () => {
    const out = await request(proxyPort, {
      method: 'POST', path: `${buildAttributionPrefix({ task: 'P-WINS' })}/v1/messages`,
      headers: { ...CLAUDE_HEADERS, 'x-ccxray-task': 'STALE-FROM-ENV', 'x-ccxray-role': 'kept-from-header' },
      body: claudeBody('attr-claude-override'),
    });
    assert.equal(out.status, 200);
    const start = Date.now();
    let line;
    while (!line && Date.now() - start < 8000) {
      line = readIndexLines(home).find(l => l.task === 'P-WINS');
      if (!line) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(line, 'prefix-attributed entry missing');
    assert.equal(line.role, 'kept-from-header');
    assert.ok(!readIndexLines(home).some(l => l.task === 'STALE-FROM-ENV'));
  });

  it('attributes a Codex WebSocket session, which cannot send custom headers', async () => {
    const prefix = buildAttributionPrefix({ task: 'WS-001', role: 'implementation', project: 'ws-proj' });
    const ws = new WebSocket(`ws://localhost:${proxyPort}${prefix}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        'chatgpt-account-id': '55555555-5555-4555-8555-555555555555',
        session_id: 'attr-ws-session',
      },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), 4000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', err => { clearTimeout(timer); reject(err); });
    });
    ws.on('message', () => {});
    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5', instructions: 'CWD: /tmp/attr-ws',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }));
    await new Promise(r => setTimeout(r, 150));
    await new Promise(resolve => { ws.once('close', resolve); ws.close(1000, 'done'); });

    const start = Date.now();
    let line;
    while (!line && Date.now() - start < 8000) {
      line = readIndexLines(home).find(l => l.task === 'WS-001');
      if (!line) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(line, 'websocket-attributed entry missing');
    assert.equal(line.role, 'implementation');
    assert.equal(line.taskProject, 'ws-proj');
    const upgrade = upstream.hits.find(h => h.upgrade);
    assert.ok(upgrade && !upgrade.url.includes('_ccxray'), `prefix leaked on upgrade: ${upgrade && upgrade.url}`);
  });
});

// Mutation-tested gap: gating `useEnvIdentity` on the MERGED identity instead of
// the hub identity made every attributed turn lose userEmail/team (the #505
// export attribution). Nothing went red, because no test combined attribution
// with a deployment identity. This proxy has one.
describe('attribution does not switch off the deployment identity', () => {
  let upstream;
  let proxy;
  let proxyPort;
  let home;

  before(async () => {
    const upstreamPort = await findFreePort();
    proxyPort = await findFreePort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-attr-id-'));
    upstream = makeUpstream();
    await new Promise(r => upstream.server.listen(upstreamPort, '127.0.0.1', r));
    const env = { ...process.env };
    for (const k of ['CCXRAY_TASK', 'CCXRAY_ROLE', 'CCXRAY_PROJECT', 'CCXRAY_AGENT_ID', 'CCXRAY_AGENT_TYPE']) delete env[k];
    proxy = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...env,
        CCXRAY_HOME: home, BROWSER: 'none', RESTORE_DAYS: '0', CCXRAY_IMPORT_DISABLE: '1',
        CCXRAY_USER_EMAIL: 'dev@example.test', CCXRAY_TEAM: 'platform',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxy);
    for (const client of upstream.wss.clients) client.terminate();
    await new Promise(r => upstream.wss.close(r));
    await new Promise(r => upstream.server.close(r));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  async function lineFor(task) {
    const start = Date.now();
    for (;;) {
      const line = readIndexLines(home).find(l => l.task === task);
      if (line || Date.now() - start > 8000) return line;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  it('keeps userEmail and team on an attributed HTTP turn', async () => {
    const out = await request(proxyPort, {
      method: 'POST', path: `${buildAttributionPrefix({ task: 'ID-HTTP', role: 'spec' })}/v1/messages`,
      headers: CLAUDE_HEADERS, body: claudeBody('attr-id-http'),
    });
    assert.equal(out.status, 200);
    const line = await lineFor('ID-HTTP');
    assert.ok(line, 'attributed entry missing');
    assert.equal(line.role, 'spec');
    assert.equal(line.userEmail, 'dev@example.test');
    assert.equal(line.team, 'platform');
  });

  it('keeps userEmail and team on an attributed WebSocket turn', async () => {
    const prefix = buildAttributionPrefix({ task: 'ID-WS', role: 'implementation' });
    const ws = new WebSocket(`ws://localhost:${proxyPort}${prefix}/v1/responses`, {
      headers: {
        'openai-beta': 'responses_websockets=2026-02-06',
        'chatgpt-account-id': '55555555-5555-4555-8555-555555555555',
        session_id: 'attr-id-ws-session',
      },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), 4000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', err => { clearTimeout(timer); reject(err); });
    });
    ws.on('message', () => {});
    ws.send(JSON.stringify({
      type: 'response.create', model: 'gpt-5.5', instructions: 'CWD: /tmp/attr-id-ws',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }));
    await new Promise(r => setTimeout(r, 150));
    await new Promise(resolve => { ws.once('close', resolve); ws.close(1000, 'done'); });

    const line = await lineFor('ID-WS');
    assert.ok(line, 'websocket-attributed entry missing');
    assert.equal(line.role, 'implementation');
    assert.equal(line.userEmail, 'dev@example.test');
    assert.equal(line.team, 'platform');
  });
});
