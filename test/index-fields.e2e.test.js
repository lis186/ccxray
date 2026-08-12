'use strict';

// #504 projection guard. These tests exercise the real entry-construction and
// serialization paths in forward.js and ws-proxy.js, then assert structure,
// presence, and legacy field order on the resulting index.ndjson lines. They
// cannot prove that each legacy field VALUE is byte-identical to the old server;
// that requires running the old server as an oracle and is one-time orchestrator
// evidence, not a self-contained regression test.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const tmpDirs = [];

// 凍結的 pre-#504 欄位清單，順序即為當時的順序。刻意不 import INDEX_FIELDS——
// 那會讓投影斷言變成自我指涉（拿被測物當標準答案）。
const LEGACY_INDEX_FIELDS = [
  'id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','skillCalls',
  'isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata',
  'stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt',
  'sysHash','toolsHash','coreHash','agentKey','agentLabel','convId','thinkingStripped','hasCredential','toolSources',
  'edited','editSummary','imported','importSource','responseId','turnToolCalls','turnToolFail',
  'turnToolCallIds','turnToolResults','beta1m',
];
const NEW_504_FIELDS = ['agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls'];

function assertProjection(obj, where) {
  const keys = Object.keys(obj);
  // (a) 不得出現枚舉之外的 key
  const stray = keys.filter(k => !LEGACY_INDEX_FIELDS.includes(k) && !NEW_504_FIELDS.includes(k));
  assert.deepEqual(stray, [], `${where}: key outside legacy ∪ #504 enumeration`);
  // (b) 投影回 legacy 集合後，順序不得變動
  const projectedOrder = keys.filter(k => LEGACY_INDEX_FIELDS.includes(k));
  const legacyOrder = LEGACY_INDEX_FIELDS.filter(k => keys.includes(k));
  assert.deepEqual(projectedOrder, legacyOrder, `${where}: legacy field order changed`);
  // (c) 投影是 byte 級的：以 legacy 順序序列化 legacy-only 的 key，必須與
  //     「原行刪掉枚舉新欄位」逐 byte 相同
  const projLine = JSON.stringify(Object.fromEntries(legacyOrder.map(k => [k, obj[k]])));
  const stripped = { ...obj };
  for (const k of NEW_504_FIELDS) delete stripped[k];
  assert.equal(projLine, JSON.stringify(stripped), `${where}: projection not byte-identical to stripped line`);
}

function assertPresence(obj, { hasDupes }, where) {
  assert.equal(obj.agentId, 'machine-7', `${where}: agentId`);
  assert.equal(obj.team, 'platform', `${where}: team`);
  assert.ok(!('userEmail' in obj), `${where}: unset env must not appear`);
  assert.ok(!('agentType' in obj), `${where}: unset env must not appear`);
  assert.equal(obj.tz, 'Asia/Tokyo', `${where}: tz`);
  assert.ok('localDate' in obj, `${where}: localDate must exist on every live entry`);
  // 可重現性：由該 entry 自己的 receivedAt + tz 重算
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: obj.tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(obj.receivedAt));
  assert.equal(obj.localDate, expected, `${where}: localDate not reproducible from receivedAt+tz`);
  if (hasDupes) assert.deepEqual(obj.duplicateToolCalls, { Bash: 1 }, `${where}: duplicate count`);
  else assert.ok(!('duplicateToolCalls' in obj), `${where}: no-duplicate turn must omit the key`);
}

function assertLiveLine(obj, options, where) {
  assertProjection(obj, where);
  assertPresence(obj, options, where);
  console.log(`[index-fields keys] ${where}: ${Object.keys(obj).join(',')}`);
}

function findFreePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
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

function isolatedEnv(home, overrides = {}, { identity = true } = {}) {
  const env = {
    ...process.env,
    ...overrides,
    CCXRAY_HOME: home,
    RESTORE_DAYS: '0',
    CCXRAY_IMPORT_DISABLE: '1',
    BROWSER: 'none',
    TZ: 'Asia/Tokyo',
  };
  delete env.LOGS_DIR;
  delete env.STORAGE_BACKEND;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CCXRAY_USER_EMAIL;
  delete env.CCXRAY_AGENT_TYPE;
  if (identity) {
    env.CCXRAY_AGENT_ID = 'machine-7';
    env.CCXRAY_TEAM = 'platform';
  } else {
    delete env.CCXRAY_AGENT_ID;
    delete env.CCXRAY_TEAM;
  }
  return env;
}

function launchProxy(port, env) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

function readIndexLines(home) {
  const indexPath = path.join(home, 'logs', 'index.ndjson');
  if (!fs.existsSync(indexPath)) return [];
  return fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function waitForIndexLines(home, expected, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      let lines = [];
      try { lines = readIndexLines(home); } catch {}
      if (lines.length >= expected) return resolve(lines);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`expected ${expected} index lines, found ${lines.length}`));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

let messageSeq = 0;

function makeAnthropicUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const messageId = `msg_index_fields_${++messageSeq}`;
      const wantsSSE = JSON.stringify(body).includes('INDEX_FIELDS_SSE');
      if (!wantsSSE) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        }));
        return;
      }

      const events = [
        ['message_start', {
          type: 'message_start',
          message: {
            id: messageId, type: 'message', role: 'assistant', model: body.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }],
        ['content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        }],
        ['content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', {
          type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
}

function messagesBody(marker, { dupes = false, sessionId }) {
  const messages = [];
  if (dupes) {
    messages.push({ role: 'assistant', content: [
      { type: 'tool_use', id: `${marker}-tool-1`, name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_use', id: `${marker}-tool-2`, name: 'Bash', input: { command: 'pwd' } },
    ] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: marker }] });
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    metadata: { session_id: sessionId },
    system: [{ type: 'text', text: 'Primary working directory: /tmp/index-fields-e2e' }],
    messages,
  };
}

function postMessages(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('live Anthropic index lines use the real forward.js construction paths', () => {
  let upstream;
  let proxy;
  let proxyPort;
  let home;

  before(async () => {
    const upstreamPort = await findFreePort();
    proxyPort = await findFreePort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-http-'));
    tmpDirs.push(home);
    upstream = makeAnthropicUpstream();
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
    const env = isolatedEnv(home, {
      ANTHROPIC_TEST_HOST: '127.0.0.1',
      ANTHROPIC_TEST_PORT: String(upstreamPort),
      ANTHROPIC_TEST_PROTOCOL: 'http',
    });
    proxy = launchProxy(proxyPort, env);
    await waitForPort(proxyPort);
  });

  after(async () => {
    if (proxy) await killAndWait(proxy.child);
    if (upstream) await new Promise(resolve => upstream.close(resolve));
  });

  it('anthropic non-SSE projects legacy fields and enforces #504 presence', async () => {
    const beforeCount = readIndexLines(home).length;
    assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_JSON_DUPES', {
      dupes: true, sessionId: '11111111-1111-4111-8111-111111111111',
    })), 200);
    assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_JSON_PLAIN', {
      sessionId: '22222222-2222-4222-8222-222222222222',
    })), 200);
    const lines = (await waitForIndexLines(home, beforeCount + 2)).slice(beforeCount);
    assert.equal(lines.length, 2, `unexpected proxy stderr: ${proxy.stderr()}`);
    assertLiveLine(lines[0], { hasDupes: true }, 'anthropic non-SSE dupes');
    assertLiveLine(lines[1], { hasDupes: false }, 'anthropic non-SSE plain');
  });

  it('anthropic SSE projects legacy fields and enforces #504 presence', async () => {
    const beforeCount = readIndexLines(home).length;
    assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_SSE_DUPES', {
      dupes: true, sessionId: '33333333-3333-4333-8333-333333333333',
    })), 200);
    assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_SSE_PLAIN', {
      sessionId: '44444444-4444-4444-8444-444444444444',
    })), 200);
    const lines = (await waitForIndexLines(home, beforeCount + 2)).slice(beforeCount);
    assert.equal(lines.length, 2, `unexpected proxy stderr: ${proxy.stderr()}`);
    assertLiveLine(lines[0], { hasDupes: true }, 'anthropic SSE dupes');
    assertLiveLine(lines[1], { hasDupes: false }, 'anthropic SSE plain');
  });
});

function makeWsUpstream(port) {
  return new Promise(resolve => {
    const server = http.createServer();
    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', () => {
          try { ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })); } catch {}
        });
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, wss }));
  });
}

describe('live OpenAI WebSocket index line uses the real ws-proxy.js construction path', () => {
  it('projects legacy fields and omits unset identity and null duplicate fields', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-ws-'));
    tmpDirs.push(home);
    const upstream = await makeWsUpstream(upstreamPort);
    const env = isolatedEnv(home, {
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    });
    delete env.OPENAI_TEST_HOST;
    delete env.OPENAI_TEST_PORT;
    delete env.OPENAI_TEST_PROTOCOL;
    const proxy = launchProxy(proxyPort, env);

    try {
      await waitForPort(proxyPort);
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=2026-02-06',
          'chatgpt-account-id': '55555555-5555-4555-8555-555555555555',
          'session_id': 'index-fields-ws-session',
        },
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS open timeout')), 4000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', err => { clearTimeout(timer); reject(err); });
      });
      ws.on('message', () => {});
      ws.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.5',
        instructions: 'CWD: /tmp/index-fields-ws',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      await new Promise(resolve => {
        ws.once('close', resolve);
        ws.close(1000, 'test complete');
      });

      const lines = await waitForIndexLines(home, 1);
      assert.equal(lines.length, 1, `unexpected proxy stderr: ${proxy.stderr()}`);
      assertLiveLine(lines[0], { hasDupes: false }, 'ws-proxy');
    } finally {
      await killAndWait(proxy.child);
      for (const client of upstream.wss.clients) client.terminate();
      await new Promise(resolve => upstream.wss.close(resolve));
      await new Promise(resolve => upstream.server.close(resolve));
    }
  });
});

describe('rebuild-index does not stamp current deployment metadata onto historical turns', () => {
  it('rebuilds a real orphan without identity, localDate, or tz', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-rebuild-'));
    tmpDirs.push(home);
    const upstream = makeAnthropicUpstream();
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
    const producerEnv = isolatedEnv(home, {
      ANTHROPIC_TEST_HOST: '127.0.0.1',
      ANTHROPIC_TEST_PORT: String(upstreamPort),
      ANTHROPIC_TEST_PROTOCOL: 'http',
    }, { identity: false });
    const proxy = launchProxy(proxyPort, producerEnv);

    try {
      await waitForPort(proxyPort);
      assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_REBUILD_SOURCE', {
        sessionId: '66666666-6666-4666-8666-666666666666',
      })), 200);
      await waitForIndexLines(home, 1);
      await killAndWait(proxy.child);

      const indexPath = path.join(home, 'logs', 'index.ndjson');
      fs.unlinkSync(indexPath);
      assert.equal(fs.existsSync(indexPath), false, 'precondition: live index line removed');

      const rebuild = spawnSync(process.execPath, [SERVER_SCRIPT, 'rebuild-index', '--apply'], {
        env: isolatedEnv(home),
        encoding: 'utf8',
      });
      assert.equal(rebuild.status, 0, `rebuild failed: ${rebuild.stderr}`);
      assert.match(rebuild.stdout, /recovered 1 \/ 1 turns/);

      const lines = readIndexLines(home);
      assert.equal(lines.length, 1);
      const rebuilt = lines[0];
      assertProjection(rebuilt, 'rebuild orphan');
      for (const key of ['agentId', 'team', 'localDate', 'tz']) {
        assert.ok(!(key in rebuilt), `rebuild orphan: historical turn must not gain ${key}`);
      }
      console.log(`[index-fields keys] rebuild orphan: ${Object.keys(rebuilt).join(',')}`);
    } finally {
      await killAndWait(proxy.child);
      await new Promise(resolve => upstream.close(resolve));
    }
  });
});
