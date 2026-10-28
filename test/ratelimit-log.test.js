'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { collectRatelimitHeaders } = require('../server/ratelimit-log');

// Evaluate the actual modules with an isolated home and a socket-free transport.
function loadModule(name, overrides, consoleOverride = console) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server', name), 'utf8'), {
    module, exports: module.exports, Buffer, process, console: consoleOverride,
    setTimeout, setImmediate,
    require(id) {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (!id.startsWith('.')) return require(id);
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename: name });
  return module.exports;
}

function fixture(t, { missingHome = false, appendFile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimit-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = missingHome ? path.join(root, 'samples') : root;
  const warnings = [];
  const logger = loadModule('ratelimit-log.js', {
    './paths': { resolveCcxrayHome: () => home, HOME_DIR_MODE: 0o700 },
    fs: appendFile ? { ...fs, promises: { ...fs.promises, appendFile } } : fs,
  }, { ...console, warn: (...args) => warnings.push(args.join(' ')) });
  return { logger, warnings, home };
}

async function waitFor(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'expected asynchronous sample result');
}

function readSamples(logger) {
  if (!fs.existsSync(logger.SAMPLES_FILE)) return [];
  const text = fs.readFileSync(logger.SAMPLES_FILE, 'utf8').trim();
  return text ? text.split('\n').map(line => JSON.parse(line)) : [];
}

const unifiedHeaders = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.25',
  'anthropic-ratelimit-unified-5h-reset': '1800000000',
  'anthropic-ratelimit-unified-7d-utilization': '0.50',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
};

// Run the production forwardRequest response handler without starting a server.
async function proxyResponse(logger, headers) {
  let status, responseHeaders;
  const chunks = [];
  const clientRes = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
  clientRes.writeHead = (code, values) => { status = code; responseHeaders = values; };
  const finished = new Promise(resolve => clientRes.on('finish', resolve));
  const forward = loadModule('forward.js', {
    http: { request(options, callback) {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.headers = headers;
        response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from('{"ok":true}'));
        response.emit('end');
      });
      return request;
    } },
    './config': { joinUpstreamPath: (_upstream, url) => url },
    './request-routing': { checkHttpRoute: () => true },
    './store': { setRateLimitState() {} },
    './ratelimit-log': logger,
    './url-sanitize': { stripAuthParams: url => url },
    './wire-parsers': { getParser: () => ({}) },
    './providers': { matchOpenAIWireClient: () => null },
    './adapters/grok-adapter': { isGrokBillingPath: () => false },
    './delta-helpers': {}, './pricing': {}, './helpers': {}, './sse-broadcast': {},
    './hub': {}, './entry': {}, './paths': {}, './session-index': {}, './openai-response': {},
  });
  forward.forwardRequest({
    parsedBody: { model: 'synthetic-model' }, rawBody: Buffer.from('{}'),
    clientReq: { url: '/v1/messages', method: 'POST', headers: {} }, clientRes,
    fwdHeaders: {}, skipEntry: true,
    upstream: { protocol: 'http', host: 'upstream.invalid', port: 1, provider: 'anthropic' },
  });
  await finished;
  assert.equal(status, 200);
  assert.equal(responseHeaders, headers);
  assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}');
}

describe('ratelimit-log', () => {
  describe('collectRatelimitHeaders', () => {
    it('returns null when no relevant headers present', () => {
      assert.equal(collectRatelimitHeaders({}), null);
      assert.equal(collectRatelimitHeaders({ 'content-type': 'text/event-stream' }), null);
    });

    it('extracts tokens/input/output/requests limits when present', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': '220000',
        'anthropic-ratelimit-tokens-remaining': '215000',
        'anthropic-ratelimit-tokens-reset': '2026-04-19T12:00:00Z',
        'anthropic-ratelimit-input-tokens-limit': '40000',
        'anthropic-ratelimit-input-tokens-remaining': '39500',
        'anthropic-ratelimit-input-tokens-reset': '2026-04-19T11:05:00Z',
        'anthropic-ratelimit-output-tokens-limit': '8000',
        'anthropic-ratelimit-output-tokens-remaining': '8000',
        'anthropic-ratelimit-output-tokens-reset': '2026-04-19T11:05:00Z',
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': '2026-04-19T11:05:00Z',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, 220000);
      assert.equal(result.tokensRemaining, 215000);
      assert.equal(result.tokensReset, '2026-04-19T12:00:00Z');
      assert.equal(result.inputLimit, 40000);
      assert.equal(result.outputLimit, 8000);
      assert.equal(result.requestsLimit, 50);
    });

    it('handles partial headers (only tokens, no input)', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': '220000',
        'anthropic-ratelimit-tokens-remaining': '215000',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, 220000);
      assert.equal(result.inputLimit, null);
      assert.equal(result.outputLimit, null);
    });

    it('returns null for malformed numeric values', () => {
      // NaN values should be null, not break
      const headers = {
        'anthropic-ratelimit-tokens-limit': 'garbage',
      };
      const result = collectRatelimitHeaders(headers);
      // tokensLimit null, and since inputLimit/requestsLimit also null → whole result null
      assert.equal(result, null);
    });

    it('still returns object if one of tokens/input/requests is valid', () => {
      const headers = {
        'anthropic-ratelimit-tokens-limit': 'garbage',
        'anthropic-ratelimit-input-tokens-limit': '40000',
      };
      const result = collectRatelimitHeaders(headers);
      assert.equal(result.tokensLimit, null);
      assert.equal(result.inputLimit, 40000);
    });

    it('accepts output-only limits', () => {
      assert.equal(collectRatelimitHeaders({ 'anthropic-ratelimit-output-tokens-limit': '8000' }).outputLimit, 8000);
    });

    it('preserves unified headers without retaining unrelated response headers', () => {
      const result = collectRatelimitHeaders({ ...unifiedHeaders, 'set-cookie': 'synthetic-cookie' });
      assert.ok(result);
      assert.deepEqual(JSON.parse(JSON.stringify(result.unified)), unifiedHeaders);
      assert.equal(result.tokensLimit, null);
    });
  });

  describe('appendSample', () => {
    it('appends unified-only headers through the real forward callback', async t => {
      const { logger } = fixture(t);
      await proxyResponse(logger, unifiedHeaders);
      await waitFor(() => readSamples(logger).length === 1);
      const [sample] = readSamples(logger);
      assert.equal(sample.model, 'synthetic-model');
      assert.deepEqual(sample.unified, unifiedHeaders);
      assert.ok(Number.isFinite(Date.parse(sample.ts)));
    });

    it('creates a missing sample directory before appending legacy headers', async t => {
      const { logger, home, warnings } = fixture(t, { missingHome: true });
      logger.appendSample({ headers: { 'anthropic-ratelimit-tokens-limit': '220000' }, model: 'synthetic-model' });
      await waitFor(() => readSamples(logger).length === 1);
      assert.equal(readSamples(logger)[0].tokensLimit, 220000);
      assert.equal(warnings.length, 0);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(home).mode & 0o777, 0o700);
        assert.equal(fs.statSync(logger.SAMPLES_FILE).mode & 0o777, 0o600);
      }
    });

    it('dedupes identical unified headers but records utilization and reset transitions', async t => {
      const { logger } = fixture(t);
      const append = headers => logger.appendSample({ headers, model: 'synthetic-model' });
      append(unifiedHeaders);
      await waitFor(() => readSamples(logger).length === 1);
      append(Object.fromEntries(Object.entries(unifiedHeaders).reverse()));
      append({ ...unifiedHeaders, 'anthropic-ratelimit-unified-5h-utilization': '0.26' });
      await waitFor(() => readSamples(logger).length === 2);
      append({ ...unifiedHeaders, 'anthropic-ratelimit-unified-5h-reset': '1800000100' });
      await waitFor(() => readSamples(logger).length === 3);
      assert.equal(readSamples(logger).length, 3);
    });

    it('reports a real directory failure and recovers on an identical response', async t => {
      const { logger, home, warnings } = fixture(t, { missingHome: true });
      fs.writeFileSync(home, 'synthetic obstruction');
      await proxyResponse(logger, unifiedHeaders);
      await waitFor(() => warnings.length === 1);
      assert.match(warnings[0], /EEXIST|ENOTDIR/);
      fs.unlinkSync(home);
      await proxyResponse(logger, unifiedHeaders);
      await waitFor(() => readSamples(logger).length === 1);
      assert.equal(warnings.length, 1);
    });

    it('reports asynchronous write failure once, retries identical samples, and preserves responses', async t => {
      let attempts = 0;
      const { logger, warnings } = fixture(t, { appendFile: async (...args) => {
        if (++attempts <= 2) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
        return fs.promises.appendFile(...args);
      } });
      const headers = { 'anthropic-ratelimit-tokens-limit': '220000' };
      await proxyResponse(logger, headers);
      await waitFor(() => warnings.length === 1);
      await proxyResponse(logger, headers);
      await waitFor(() => attempts === 2);
      await proxyResponse(logger, headers);
      await waitFor(() => readSamples(logger).length === 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /ratelimit.*EACCES/i);
      assert.ok(!warnings[0].includes('synthetic failure'));
    });

    it('contains synchronous write failures and reports only once', async t => {
      let attempts = 0;
      const { logger, warnings } = fixture(t, { appendFile: () => {
        attempts++;
        throw Object.assign(new Error('synthetic failure'), { code: 'EIO' });
      } });
      for (const model of ['synthetic-a', 'synthetic-b']) {
        assert.doesNotThrow(() => logger.appendSample({ headers: unifiedHeaders, model }));
      }
      await waitFor(() => attempts === 2 && warnings.length === 1);
    });

    it('dedupes legacy limits per model and ignores unrelated headers', async t => {
      const { logger } = fixture(t);
      const headers = { 'anthropic-ratelimit-tokens-limit': '220000' };
      logger.appendSample({ headers: {}, model: 'synthetic-a' });
      logger.appendSample({ headers, model: 'synthetic-a' });
      await waitFor(() => readSamples(logger).length === 1);
      logger.appendSample({ headers, model: 'synthetic-a' });
      logger.appendSample({ headers, model: 'synthetic-b' });
      await waitFor(() => readSamples(logger).length === 2);
      assert.equal(readSamples(logger).length, 2);
    });
  });
});
