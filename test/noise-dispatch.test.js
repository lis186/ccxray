'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');

it('dispatch consults wire parsers, forwards noise intact without entries, and records messages', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-noise-dispatch-'));
  const env = { ...process.env };
  Object.assign(process.env, {
    HOME: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
    CCXRAY_PRICING_CACHE: path.join(home, 'absent-pricing.json'),
    CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1',
    ANTHROPIC_TEST_HOST: 'upstream.invalid', ANTHROPIC_TEST_PORT: '80', ANTHROPIC_TEST_PROTOCOL: 'http',
    OPENAI_TEST_HOST: 'upstream.invalid', OPENAI_TEST_PORT: '80', OPENAI_TEST_PROTOCOL: 'http',
    CHATGPT_BASE_URL: 'http://upstream.invalid/backend-api/codex',
  });
  for (const key of ['CCXRAY_AGENT_ID', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
    'CCXRAY_MODEL_PREFIX']) delete process.env[key];
  const indexWrites = [];
  let store;
  t.after(async () => {
    await Promise.all((store?.entries || []).map(entry => entry._writePromise));
    await Promise.all(indexWrites);
    await require('../server/session-index').flush();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const config = require('../server/config');
  await config.storage.init();
  const appendIndex = config.storage.appendIndex.bind(config.storage);
  t.mock.method(config.storage, 'appendIndex', line => {
    const write = appendIndex(line);
    indexWrites.push(write);
    return write;
  });
  store = require('../server/store');
  const helpers = require('../server/helpers');
  const { WIRE_PARSERS, getParser } = require('../server/wire-parsers');
  const anthropicNoise = t.mock.method(WIRE_PARSERS.anthropic, 'isNoiseRequest');
  const openaiNoise = t.mock.method(WIRE_PARSERS.openai, 'isNoiseRequest');
  const { forwardRequest } = require('../server/forward');
  const { buildForwardHeaders } = require('../server/forward-headers');
  const { checkHttpRoute } = require('../server/request-routing');
  const requests = [], contexts = [];
  const countResponse = JSON.stringify({ input_tokens: 73081 });
  const errorResponse = JSON.stringify({ error: { type: 'not_found', message: 'synthetic 404' } });
  const messageResponse = JSON.stringify({
    id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'synthetic-model',
    content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  let messageStatus = 404;
  // Inject only the upstream transport. Actual forwarding, response handling,
  // parser registry, routing and store registration run in this process.
  t.mock.method(http, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    req.end = body => {
      requests.push({ ...options, body: Buffer.from(body).toString() });
      const isCount = options.path === '/v1/messages/count_tokens';
      const isMessage = options.path === '/v1/messages' && messageStatus === 200;
      const response = Readable.from([Buffer.from(isCount ? countResponse : isMessage ? messageResponse : errorResponse)]);
      response.statusCode = isCount || isMessage ? 200 : 404;
      response.headers = { 'content-type': 'application/json' };
      onResponse(response);
    };
    return req;
  });

  // index.js has no side-effect-free server factory. Compile its complete,
  // verbatim createServer callback, omitting launcher/bootstrap code. Anchors
  // fail closed on structural drift; no copy of the noise branch lives here.
  const filename = path.join(__dirname, '../server/index.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const server = http.createServer(');
  const end = source.indexOf('\nserver.headersTimeout', start);
  assert.ok(start >= 0 && end > start, 'index HTTP callback anchors must exist');
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    http: { createServer: callback => { handler = callback; } },
    Buffer, console, setTimeout, clearTimeout,
    hub: { applyClientRoute() {}, handleHubRoutes: () => false },
    handleAuthRoutes: () => false, serveStatic: () => false,
    dispatch: () => ({ verify: () => true }),
    handleSSERoute: () => false, handleApiRoutes: () => false,
    handleInterceptRoutes: () => false, handleCostRoutes: () => false,
    helpers, store, config, WIRE_PARSERS, getParser, checkHttpRoute, buildForwardHeaders,
    sessionLastReq: new Map(),
    extractPromptAgentType: require('../server/system-prompt').extractPromptAgentType,
    broadcastSessionStatus: require('../server/sse-broadcast').broadcastSessionStatus,
    getAgentCwdFallback: () => null,
    forwardRequest: ctx => { contexts.push(ctx); forwardRequest(ctx); },
  }, { filename });

  async function send(method, url, body, headers) {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers });
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    res.writeHead = status => { res.statusCode = status; };
    const finished = new Promise((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
    });
    handler(req, res);
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    // Stream finish follows the upstream end handler (including entry creation).
    await finished;
    return { status: res.statusCode, body: Buffer.concat(chunks).toString() };
  }

  const message = { model: 'synthetic-model', messages: [{ role: 'user', content: 'ping' }] };
  const anthropicHeaders = { 'x-api-key': 'synthetic-key', 'anthropic-version': '2023-06-01' };
  const count = await send('POST', '/v1/messages/count_tokens', message, anthropicHeaders);
  assert.equal(count.status, 200);
  assert.equal(count.body, countResponse, 'count_tokens response passes through intact');
  assert.equal(store.entries.length, 0, 'count_tokens creates no dashboard entry');
  assert.ok(anthropicNoise.mock.calls.some(call =>
    call.arguments[0] === '/v1/messages/count_tokens'
    && call.arguments[1] === anthropicHeaders
    && JSON.stringify(call.arguments[2]) === JSON.stringify(message)
    && call.result === true), 'dispatch consults the real Anthropic parser with URL, headers and parsed body');
  assert.equal(contexts.at(-1).skipEntry, true, 'dispatch passes skipEntry to forwardRequest');

  // Preserve the former e2e forwarding/status assertions. Classification and
  // near-miss coverage are table-driven in wire-parsers-openai.test.js.
  const noise = [
    ['GET', '/v1/plugins/featured?platform=codex', '/backend-api/plugins/featured?platform=codex'],
    ['GET', '/v1/plugins/list'],
    ['GET', '/v1/ps/plugins/installed?scope=GLOBAL', '/backend-api/ps/plugins/installed?scope=GLOBAL'],
    ['GET', '/v1/ps/plugins/installed?scope=WORKSPACE&includeDownloadUrls=true'],
    ['POST', '/v1/api/codex/apps', '/backend-api/codex/api/codex/apps'],
    ['GET', '/v1/api/codex/usage'],
    ['GET', '/v1/connectors/directory/list?external_logos=true', '/backend-api/connectors/directory/list?external_logos=true'],
    ['POST', '/v1/codex/analytics-events/events', '/backend-api/codex/analytics-events/events'],
    ['GET', '/v1/models?client_version=0.136.0'],
  ];
  for (const [method, url, upstreamPath] of noise) {
    const out = await send(method, url, null, {
      authorization: 'Bearer synthetic-token', 'user-agent': 'codex_cli_rs/0.163.0',
    });
    assert.ok(openaiNoise.mock.calls.some(call => call.arguments[0] === url && call.result === true),
      `${url} consults the real OpenAI parser`);
    assert.equal(out.status, 404, url);
    assert.equal(out.body, errorResponse, url);
    assert.equal(contexts.at(-1).skipEntry, true, url);
    assert.equal(requests.at(-1).method, method, url);
    if (upstreamPath) assert.equal(requests.at(-1).path, upstreamPath, url);
    assert.equal(store.entries.length, 0, `${url} creates no dashboard entry`);
  }
  const positive = await send('POST', '/v1/messages', message, anthropicHeaders);
  assert.equal(positive.status, 404, 'real messages retain upstream status');
  assert.equal(positive.body, errorResponse);
  assert.equal(contexts.at(-1).skipEntry, undefined);
  assert.equal(store.entries.length, 1, 'real messages record exactly one entry');
  assert.equal(store.entries[0].path, '/v1/messages');
  await store.entries[0]._writePromise;

  // Exercise successful message handling as well as the error control above.
  messageStatus = 200;
  const beforeSuccess = store.entries.length;
  const success = await send('POST', '/v1/messages', message, anthropicHeaders);
  assert.equal(success.status, 200);
  assert.equal(success.body, messageResponse, 'successful message response passes through intact');
  assert.equal(contexts.at(-1).skipEntry, undefined);
  assert.equal(store.entries.length, beforeSuccess + 1, 'successful messages record exactly one new entry');
  const entry = store.entries.at(-1);
  assert.equal(entry.path, '/v1/messages');
  assert.equal(entry.status, 200);
  assert.deepEqual(entry.usage, { input_tokens: 10, output_tokens: 2 }, 'successful message usage is recorded');
  await entry._writePromise;
});
