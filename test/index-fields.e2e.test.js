'use strict';

// #504 projection guard. These tests exercise the real entry-construction and
// serialization paths in forward.js (anthropic SSE / non-SSE, openai SSE /
// non-SSE), ws-proxy.js, rebuild-index, and the importer, then assert
// structure, presence, and legacy field order on the resulting index.ndjson
// lines.
//
// Value-level oracle: GOLDEN_LEGACY_LINES below are pre-#504 index lines —
// live (anthropic/openai/ws) AND historical (rebuild-index, importer) —
// captured by replaying these exact fixtures against origin/main@6e2aa71
// (the last commit before this branch), normalized by replacing the
// time/pricing-volatile fields in VOLATILE_FIELDS with '<volatile>'.
// Comparing the live line (minus the enumerated #504 fields) byte-wise
// against the golden proves every legacy field VALUE still serializes as the
// old server did — not merely that key order is stable. Regenerate with the
// procedure in the PR that introduced this file if a legit legacy-field
// change lands: replay the same fixtures on the pre-change commit and paste
// the normalized lines.

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
// Append-only fields added after the frozen legacy shape. The original group
// came from #504; later fields stay here so the projection guard keeps treating
// them as additive rather than reporting a legacy regression.
const NEW_504_FIELDS = [
  'agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls','compacted',
  'contextUsageKnown',
];
const IDENTITY_KEYS = ['agentId','userEmail','team','agentType'];
const IDENTITY_VALUES = {
  agentId: 'machine-7', team: 'platform',
  userEmail: 'dev@example.test', agentType: 'ci-bot',
};

// Fields whose values are time- or pricing-dependent and therefore replaced
// with '<volatile>' before comparing against GOLDEN_LEGACY_LINES. Everything
// else — including responseId, which the mocks derive deterministically from
// the request marker — must match the pre-#504 oracle byte-for-byte.
const VOLATILE_FIELDS = new Set(['id','ts','receivedAt','elapsed','cost']);

// pre-#504 oracle: origin/main@6e2aa71, fixtures identical to this file,
// volatile fields normalized to <volatile>. See header comment for provenance.
const GOLDEN_LEGACY_LINES = {
  'anthropic non-SSE dupes':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"11111111-1111-4111-8111-111111111111","provider":"anthropic","agent":"claude","model":"claude-sonnet-4-6","msgCount":2,"toolCount":0,"toolCalls":{"Bash":2},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-e2e","isSSE":false,"usage":{"input_tokens":5,"output_tokens":1},"cost":"<volatile>","maxContext":200000,"stopReason":"end_turn","title":"ok","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"5feeb813d8f1","toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":null,"toolSources":{"INDEX_FIELDS_JSON_DUPES-tool-1":"local","INDEX_FIELDS_JSON_DUPES-tool-2":"local"},"responseId":"msg_INDEX_FIELDS_JSON_DUPES","turnToolCalls":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'anthropic non-SSE plain':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"22222222-2222-4222-8222-222222222222","provider":"anthropic","agent":"claude","model":"claude-sonnet-4-6","msgCount":1,"toolCount":0,"toolCalls":{},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-e2e","isSSE":false,"usage":{"input_tokens":5,"output_tokens":1},"cost":"<volatile>","maxContext":200000,"stopReason":"end_turn","title":"ok","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"5feeb813d8f1","toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":"1de3abc0","toolSources":{},"responseId":"msg_INDEX_FIELDS_JSON_PLAIN","turnToolCalls":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'anthropic SSE dupes':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"33333333-3333-4333-8333-333333333333","provider":"anthropic","agent":"claude","model":"claude-sonnet-4-6","msgCount":2,"toolCount":0,"toolCalls":{"Bash":2},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-e2e","isSSE":true,"usage":{"input_tokens":5,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"cost":"<volatile>","maxContext":200000,"stopReason":"end_turn","title":"ok","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"5feeb813d8f1","toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":null,"toolSources":{"INDEX_FIELDS_SSE_DUPES-tool-1":"local","INDEX_FIELDS_SSE_DUPES-tool-2":"local"},"responseId":"msg_INDEX_FIELDS_SSE_DUPES","turnToolCalls":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'anthropic SSE plain':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"44444444-4444-4444-8444-444444444444","provider":"anthropic","agent":"claude","model":"claude-sonnet-4-6","msgCount":1,"toolCount":0,"toolCalls":{},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-e2e","isSSE":true,"usage":{"input_tokens":5,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"cost":"<volatile>","maxContext":200000,"stopReason":"end_turn","title":"ok","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"5feeb813d8f1","toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":"83ab9ba6","toolSources":{},"responseId":"msg_INDEX_FIELDS_SSE_PLAIN","turnToolCalls":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'openai SSE':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"openai-fields-http-session","provider":"openai","agent":"codex","model":"gpt-5.5","msgCount":1,"toolCount":0,"toolCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":null,"isSSE":true,"usage":{"input_tokens":100,"output_tokens":5,"total_tokens":105,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"input_tokens_details":{"cached_tokens":0}},"cost":"<volatile>","maxContext":400000,"responseMetadata":{"provider":"openai","id":"resp_OPENAI_FIELDS_SSE","object":"response","model":"gpt-5.5","status":200,"responseStatus":"completed","streaming":true},"stopReason":"completed","title":"OPENAI_FIELDS_SSE","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"6214b4838c62","toolsHash":null,"coreHash":"c66aaa345818","agentKey":"default","agentLabel":"Codex Default","toolSources":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'openai non-SSE':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"openai-fields-http-session","provider":"openai","agent":"codex","model":"gpt-5.5","msgCount":1,"toolCount":0,"toolCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":null,"isSSE":false,"usage":{"input_tokens":100,"output_tokens":5,"total_tokens":105,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"input_tokens_details":{"cached_tokens":0}},"cost":"<volatile>","maxContext":400000,"responseMetadata":{"provider":"openai","id":"resp_OPENAI_FIELDS_JSON","object":"response","model":"gpt-5.5","status":200,"responseStatus":"completed"},"stopReason":"completed","title":"OPENAI_FIELDS_JSON","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","sysHash":"6214b4838c62","toolsHash":null,"coreHash":"c66aaa345818","agentKey":"default","agentLabel":"Codex Default","toolSources":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'ws-proxy':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"index-fields-ws-session","provider":"openai","agent":"codex","model":"gpt-5.5","msgCount":1,"toolCount":0,"toolCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-ws","isSSE":false,"usage":null,"cost":"<volatile>","maxContext":400000,"responseMetadata":{"transport":"websocket","capture":"transport-only","endpoint":"/v1/responses","frameCounts":{"clientToUpstream":1,"upstreamToClient":1},"byteCounts":{"clientToUpstream":179,"upstreamToClient":50},"close":{"side":"client","code":1000,"reason":"test complete"},"error":null},"stopReason":"test complete","title":"hello","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":101,"receivedAt":"<volatile>","sysHash":"b54cd80f54c1","toolsHash":null,"coreHash":"2db6420c3d64","agentKey":"default","agentLabel":"Codex Default","toolSources":{},"turnToolCallIds":{},"turnToolResults":[]}',
  'rebuild orphan':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"66666666-6666-4666-8666-666666666666","provider":"anthropic","agent":"claude","model":"claude-sonnet-4-6","msgCount":1,"toolCount":0,"toolCalls":{},"skillCalls":{},"isSubagent":false,"sessionInferred":false,"cwd":"/tmp/index-fields-e2e","isSSE":false,"usage":null,"cost":"<volatile>","maxContext":200000,"stopReason":"","title":"INDEX_FIELDS_REBUILD_SOURCE","thinkingDuration":null,"toolFail":false,"elapsed":"<volatile>","status":null,"receivedAt":"<volatile>","sysHash":"5feeb813d8f1","toolsHash":null,"coreHash":null,"agentKey":null,"agentLabel":null,"convId":"ca0026d0","responseId":"msg_INDEX_FIELDS_REBUILD_SOURCE","turnToolCalls":{},"turnToolResults":[]}',
  // maxContext joins the imported line: the Claude importer derives a window the
  // same way the live path does, so a reader no longer has to assume 200K for
  // every imported turn (the Codex importer has done this since #384).
  'importer':
    '{"id":"<volatile>","ts":"<volatile>","sessionId":"sess-1","provider":"anthropic","model":"claude-sonnet-4-5-20250514","sessionInferred":false,"cwd":"/tmp/index-fields-import","isSSE":false,"usage":{"input_tokens":5000,"output_tokens":500,"cache_read_input_tokens":1000,"cache_creation_input_tokens":2000},"cost":"<volatile>","maxContext":200000,"stopReason":"end_turn","title":"imported turn","elapsed":"<volatile>","status":200,"receivedAt":"<volatile>","imported":true,"importSource":"claude-code","responseId":"msg_import_fields_1","turnToolCallIds":{},"turnToolResults":[]}',
};

function normalizedLegacyLine(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (NEW_504_FIELDS.includes(k)) continue;
    out[k] = VOLATILE_FIELDS.has(k) ? '<volatile>' : obj[k];
  }
  return JSON.stringify(out);
}

function assertProjection(entry, where, goldenKey) {
  const { raw, obj } = entry;
  // (0) raw line 正準性：後面所有斷言都建立在 parse→reserialize 之上；若
  //     序列化改了空白或跳脫方式，parse 後比較會看不見。這條把 raw byte
  //     釘回 JSON.stringify 的正準形，讓 (c)(d) 的比較是 byte 級可信的。
  assert.equal(JSON.stringify(obj), raw, `${where}: raw index line is not canonical JSON.stringify output`);
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
  // (d) value 層 oracle：與 pre-#504 golden line 逐 byte 相同（揮發欄位正規化後）。
  //     (a)-(c) 都由同一份新輸出推導，抓不到 legacy VALUE 的回歸；這條抓得到。
  //     goldenKey 為必填——沒有 oracle 的路徑等於退回自我指涉檢查。
  const golden = GOLDEN_LEGACY_LINES[goldenKey];
  assert.ok(golden, `${where}: no golden registered for ${goldenKey}`);
  assert.equal(normalizedLegacyLine(obj), golden, `${where}: legacy projection diverged from pre-#504 golden (${goldenKey})`);
}

function assertPresence(obj, { hasDupes, identity }, where) {
  for (const k of IDENTITY_KEYS) {
    if (identity[k] !== undefined) assert.equal(obj[k], identity[k], `${where}: ${k}`);
    else assert.ok(!(k in obj), `${where}: unset env ${k} must not appear`);
  }
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

function assertLiveLine(entry, options, where) {
  assertProjection(entry, where, options.golden);
  assertPresence(entry.obj, options, where);
  console.log(`[index-fields keys] ${where}: ${Object.keys(entry.obj).join(',')}`);
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

// identity: 'partial' = agentId+team only（userEmail/agentType 未設）,
//           'full'    = 四個 env 全設,
//           'none'    = 四個 env 全未設。
// 三種狀態合起來讓每個 env-derived 欄位的 set 與 unset 兩態都被真實路徑驗過。
function isolatedEnv(home, overrides = {}, { identity = 'partial' } = {}) {
  const base = { ...process.env };
  // 開發機外洩的行為性變數（如 CCXRAY_LOOPBACK_REQUIRE_AUTH、指向本機 hub 的
  // ANTHROPIC_BASE_URL）會改變受測行為；整族刷掉，需要的由 overrides 白名單放回。
  for (const k of Object.keys(base)) {
    if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(k)) delete base[k];
  }
  delete base.LOGS_DIR;
  delete base.STORAGE_BACKEND;
  const env = {
    ...base,
    ...overrides,
    CCXRAY_HOME: home,
    // Window resolution reads a package-relative pricing-cache.json that
    // CCXRAY_HOME does not isolate; pin it so a spawned server derives windows
    // from the same input on CI and on a machine that has run ccxray for real.
    // See docs/testing.md.
    CCXRAY_PRICING_CACHE: '/nonexistent/ccxray-pricing-cache.json',
    RESTORE_DAYS: '0',
    CCXRAY_IMPORT_DISABLE: '1',
    BROWSER: 'none',
    TZ: 'Asia/Tokyo',
  };
  if (identity === 'partial' || identity === 'full') {
    env.CCXRAY_AGENT_ID = IDENTITY_VALUES.agentId;
    env.CCXRAY_TEAM = IDENTITY_VALUES.team;
  }
  if (identity === 'full') {
    env.CCXRAY_USER_EMAIL = IDENTITY_VALUES.userEmail;
    env.CCXRAY_AGENT_TYPE = IDENTITY_VALUES.agentType;
  }
  return env;
}

const IDENTITY_EXPECT = {
  partial: { agentId: IDENTITY_VALUES.agentId, team: IDENTITY_VALUES.team },
  full: { ...IDENTITY_VALUES },
  none: {},
};

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
  return fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean)
    .map(raw => ({ raw, obj: JSON.parse(raw) }));
}

// 8s was too tight and produced a load-sensitive false failure (#538): the
// importer is deliberately non-blocking and runs only AFTER restore and the
// pricing warm-up, so "server boots, restores, warms pricing, then scans and
// imports" is the budget being measured — not the import itself. Measured on a
// 14-core machine with every core saturated, the first index line appeared after
// 31s; unloaded it is ~1s. A passing run returns as soon as the line appears, so
// the larger budget costs nothing except on a genuine failure.
function waitForIndexLines(home, expected, timeoutMs = 45000) {
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

function makeAnthropicUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const rawBody = JSON.stringify(body);
      // message id 由 request marker 推導（不是 counter）：responseId 因此可
      // 凍結在 golden 裡，dedup 身分欄位的回歸抓得到。
      const anthMarker = (rawBody.match(/INDEX_FIELDS_[A-Z_]+/) || ['INDEX_FIELDS_UNKNOWN'])[0];
      const messageId = `msg_${anthMarker}`;
      const wantsSSE = rawBody.includes('INDEX_FIELDS_SSE');
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

// codex-shaped OpenAI Responses upstream：SSE 與 JSON 兩型由 request 內的
// marker 決定。response id 由 marker 推導（不是 counter），golden 才可重現。
function makeOpenAIUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
      const model = body.model || 'gpt-5.5';
      const raw = JSON.stringify(body);
      const wantsSSE = raw.includes('OPENAI_FIELDS_SSE');
      const marker = wantsSSE ? 'OPENAI_FIELDS_SSE' : 'OPENAI_FIELDS_JSON';
      const completed = {
        type: 'response.completed',
        response: {
          id: `resp_${marker}`, object: 'response', model, status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } },
        },
      };
      if (!wantsSSE) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completed.response));
        return;
      }
      const sse = [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: completed.response.id, model, status: 'in_progress' } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      ].join('');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
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

function postJson(port, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: reqPath, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function postMessages(port, body) {
  return postJson(port, '/v1/messages', body, {
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
  });
}

function postResponses(port, body) {
  return postJson(port, '/v1/responses', body, {
    authorization: 'Bearer sk-test',
    'session_id': 'openai-fields-http-session',
  });
}

function responsesBody(marker, { stream }) {
  return {
    model: 'gpt-5.5',
    stream,
    instructions: 'You are Codex',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }],
  };
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
  const identity = IDENTITY_EXPECT.partial;

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
    }, { identity: 'partial' });
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
    assertLiveLine(lines[0], { hasDupes: true, identity, golden: 'anthropic non-SSE dupes' }, 'anthropic non-SSE dupes');
    assertLiveLine(lines[1], { hasDupes: false, identity, golden: 'anthropic non-SSE plain' }, 'anthropic non-SSE plain');
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
    assertLiveLine(lines[0], { hasDupes: true, identity, golden: 'anthropic SSE dupes' }, 'anthropic SSE dupes');
    assertLiveLine(lines[1], { hasDupes: false, identity, golden: 'anthropic SSE plain' }, 'anthropic SSE plain');
  });
});

describe('live OpenAI HTTP index lines use the real forward.js construction paths', () => {
  let upstream;
  let proxy;
  let proxyPort;
  let home;
  const identity = IDENTITY_EXPECT.full;

  before(async () => {
    const upstreamPort = await findFreePort();
    proxyPort = await findFreePort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-oai-'));
    tmpDirs.push(home);
    upstream = makeOpenAIUpstream();
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
    const env = isolatedEnv(home, {
      OPENAI_TEST_HOST: '127.0.0.1',
      OPENAI_TEST_PORT: String(upstreamPort),
      OPENAI_TEST_PROTOCOL: 'http',
    }, { identity: 'full' });
    proxy = launchProxy(proxyPort, env);
    await waitForPort(proxyPort);
  });

  after(async () => {
    if (proxy) await killAndWait(proxy.child);
    if (upstream) await new Promise(resolve => upstream.close(resolve));
  });

  it('openai SSE projects legacy fields and enforces #504 presence (all identity vars set)', async () => {
    const beforeCount = readIndexLines(home).length;
    assert.equal(await postResponses(proxyPort, responsesBody('OPENAI_FIELDS_SSE', { stream: true })), 200);
    const lines = (await waitForIndexLines(home, beforeCount + 1)).slice(beforeCount);
    assert.equal(lines.length, 1, `unexpected proxy stderr: ${proxy.stderr()}`);
    assertLiveLine(lines[0], { hasDupes: false, identity, golden: 'openai SSE' }, 'openai SSE');
  });

  it('openai non-SSE projects legacy fields and enforces #504 presence (all identity vars set)', async () => {
    const beforeCount = readIndexLines(home).length;
    assert.equal(await postResponses(proxyPort, responsesBody('OPENAI_FIELDS_JSON', { stream: false })), 200);
    const lines = (await waitForIndexLines(home, beforeCount + 1)).slice(beforeCount);
    assert.equal(lines.length, 1, `unexpected proxy stderr: ${proxy.stderr()}`);
    assertLiveLine(lines[0], { hasDupes: false, identity, golden: 'openai non-SSE' }, 'openai non-SSE');
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
  it('projects legacy fields and omits all unset identity and null duplicate fields', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-ws-'));
    tmpDirs.push(home);
    const upstream = await makeWsUpstream(upstreamPort);
    const env = isolatedEnv(home, {
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    }, { identity: 'none' });
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
      assertLiveLine(lines[0], { hasDupes: false, identity: IDENTITY_EXPECT.none, golden: 'ws-proxy' }, 'ws-proxy');
    } finally {
      await killAndWait(proxy.child);
      for (const client of upstream.wss.clients) client.terminate();
      await new Promise(resolve => upstream.wss.close(resolve));
      await new Promise(resolve => upstream.server.close(resolve));
    }
  });
});

describe('rebuild-index does not stamp current deployment metadata onto historical turns', () => {
  it('rebuilds a real orphan without identity, localDate, or tz — all four identity vars set', async () => {
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
    }, { identity: 'none' });
    const proxy = launchProxy(proxyPort, producerEnv);

    try {
      await waitForPort(proxyPort);
      assert.equal(await postMessages(proxyPort, messagesBody('INDEX_FIELDS_REBUILD_SOURCE', {
        sessionId: '66666666-6666-4666-8666-666666666666',
      })), 200);
      const [{ obj: liveLine }] = await waitForIndexLines(home, 1);
      // identity-none live line：四個 env-derived 欄位皆不得出現（unset 態的
      // 全覆蓋），但 localDate/tz 是 live entry 的無條件事實、仍在。
      for (const key of IDENTITY_KEYS) {
        assert.ok(!(key in liveLine), `producer live line: unset ${key} must not appear`);
      }
      assert.ok('localDate' in liveLine && 'tz' in liveLine, 'producer live line keeps localDate/tz');
      await killAndWait(proxy.child);

      const indexPath = path.join(home, 'logs', 'index.ndjson');
      fs.unlinkSync(indexPath);
      assert.equal(fs.existsSync(indexPath), false, 'precondition: live index line removed');

      // rebuild 以四個 identity env 全設的環境跑：歷史 turn 一個都不得被蓋上。
      const rebuild = spawnSync(process.execPath, [SERVER_SCRIPT, 'rebuild-index', '--apply'], {
        env: isolatedEnv(home, {}, { identity: 'full' }),
        encoding: 'utf8',
      });
      assert.equal(rebuild.status, 0, `rebuild failed: ${rebuild.stderr}`);
      assert.match(rebuild.stdout, /recovered 1 \/ 1 turns/);

      const lines = readIndexLines(home);
      assert.equal(lines.length, 1);
      const rebuilt = lines[0];
      assertProjection(rebuilt, 'rebuild orphan', 'rebuild orphan');
      for (const key of [...IDENTITY_KEYS, 'localDate', 'tz']) {
        assert.ok(!(key in rebuilt.obj), `rebuild orphan: historical turn must not gain ${key}`);
      }
      console.log(`[index-fields keys] rebuild orphan: ${Object.keys(rebuilt.obj).join(',')}`);
    } finally {
      await killAndWait(proxy.child);
      await new Promise(resolve => upstream.close(resolve));
    }
  });
});

describe('importer does not stamp current deployment metadata onto imported turns', () => {
  it('imports a claude-code transcript with all four identity vars set — no #504 fields appear', async () => {
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-import-'));
    const importHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-import-src-'));
    const codexImportHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-index-fields-import-codex-'));
    tmpDirs.push(home, importHome, codexImportHome);

    const sessionDir = path.join(importHome, 'index-fields-import-project');
    fs.mkdirSync(sessionDir, { recursive: true });
    const base = { parentUuid: 'parent-1', sessionId: 'importer-fields-session-1', cwd: '/tmp/index-fields-import' };
    fs.writeFileSync(path.join(sessionDir, 'sess-1.jsonl'), [
      JSON.stringify({ ...base, type: 'user', uuid: 'u-1', timestamp: '2026-07-15T10:29:50.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'imported turn' }] } }),
      JSON.stringify({ ...base, type: 'assistant', uuid: 'a-1', timestamp: '2026-07-15T10:30:00.000Z',
        message: {
          id: 'msg_import_fields_1', model: 'claude-sonnet-4-5-20250514', role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn',
          usage: { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000 },
        } }),
    ].join('\n'));

    const env = isolatedEnv(home, {
      CCXRAY_IMPORT_HOMES: importHome,
      CCXRAY_IMPORT_CODEX_HOMES: codexImportHome,
    }, { identity: 'full' });
    env.CCXRAY_IMPORT_DISABLE = '0';
    const proxy = launchProxy(proxyPort, env);

    try {
      await waitForPort(proxyPort);
      const lines = await waitForIndexLines(home, 1);
      assert.equal(lines.length, 1, `unexpected proxy stderr: ${proxy.stderr()}`);
      const imported = lines[0];
      assert.equal(imported.obj.imported, true, 'line came from the importer');
      assertProjection(imported, 'importer', 'importer');
      for (const key of NEW_504_FIELDS.filter(key => key !== 'contextUsageKnown')) {
        assert.ok(!(key in imported.obj), `importer: imported turn must not gain ${key}`);
      }
      assert.equal(imported.obj.contextUsageKnown, true,
        'importer: positive context usage must carry provenance');
      console.log(`[index-fields keys] importer: ${Object.keys(imported.obj).join(',')}`);
    } finally {
      await killAndWait(proxy.child);
    }
  });
});
