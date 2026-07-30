'use strict';

// Unit tests for Grok billing fetch: header-only gate (T1), throttle +
// injectable upstream + path join (T2). Never hits real network.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  refreshGrokBillingFromAuth,
  _resetBillingThrottleForTests,
} = require('../server/adapters/grok-adapter');
const { joinUpstreamPath, resolveXaiUpstream } = require('../server/config');
const { forwardRequest } = require('../server/forward');

const SAMPLE_BODY = JSON.stringify({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: new Date(Date.now() - 4 * 86400000).toISOString(),
      end: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
    creditUsagePercent: 10,
  },
});

/** Minimal Node-style request stub that records options and returns status/body. */
function makeRequestStub({ statusCode = 200, body = SAMPLE_BODY } = {}) {
  const calls = [];
  function request(options, cb) {
    calls.push(options);
    const req = {
      on() { return req; },
      setTimeout() { return req; },
      destroy() {},
      end() {
        process.nextTick(() => {
          const res = {
            statusCode,
            on(ev, fn) {
              if (ev === 'data') process.nextTick(() => fn(Buffer.from(body)));
              if (ev === 'end') process.nextTick(fn);
              return res;
            },
          };
          cb(res);
        });
      },
    };
    return req;
  }
  return { request, calls };
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

describe('T1: forward.js does not refresh billing on model name alone', () => {
  let home;
  let adapter;
  let origRefresh;
  let mockServer;
  let mockPort;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bill-fwd-'));
    process.env.CCXRAY_HOME = home;
    adapter = require('../server/adapters/grok-adapter');
    origRefresh = adapter.refreshGrokBillingFromAuth;
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_mock', object: 'response', model: 'grok-4.5', status: 'completed',
        output: [], usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    mockPort = await new Promise(r => mockServer.listen(0, '127.0.0.1', () => r(mockServer.address().port)));
  });

  afterEach(async () => {
    adapter.refreshGrokBillingFromAuth = origRefresh;
    await new Promise(r => mockServer.close(r));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('model=grok-4.5 without grok headers → billing refresh never invoked', async () => {
    let calls = 0;
    adapter.refreshGrokBillingFromAuth = () => { calls += 1; };

    const body = {
      model: 'grok-4.5',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = {
      authorization: 'Bearer openrouter-se',
      'user-agent': 'my-app/1.0',
      'content-type': 'application/json',
      'content-length': String(rawBody.length),
    };

    await new Promise((resolve, reject) => {
      const clientRes = {
        destroyed: false,
        writableEnded: false,
        writeHead() {},
        write() {},
        end() {
          clientRes.writableEnded = true;
          setTimeout(resolve, 50);
        },
      };
      try {
        forwardRequest({
          id: 't1-probe',
          ts: 'test',
          startTime: Date.now(),
          parsedBody: body,
          rawBody,
          clientReq: { method: 'POST', url: '/v1/responses', headers },
          clientRes,
          fwdHeaders: { ...headers },
          reqSessionId: 'direct-api',
          skipEntry: true,
          upstream: {
            provider: 'openai',
            host: '127.0.0.1',
            port: mockPort,
            protocol: 'http',
            basePath: '/v1',
          },
        });
      } catch (e) {
        reject(e);
      }
    });

    assert.equal(calls, 0, `billing refresh must not run for model-only match; calls=${calls}`);
  });

  it('grok headers → billing refresh is invoked', async () => {
    let calls = 0;
    adapter.refreshGrokBillingFromAuth = () => { calls += 1; };

    const body = {
      model: 'grok-4.5',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = {
      authorization: 'Bearer tok',
      'user-agent': 'grok-shell/0.2.93',
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-version': '0.2.93',
      'content-type': 'application/json',
      'content-length': String(rawBody.length),
    };

    await new Promise((resolve, reject) => {
      const clientRes = {
        destroyed: false,
        writableEnded: false,
        writeHead() {},
        write() {},
        end() {
          clientRes.writableEnded = true;
          setTimeout(resolve, 50);
        },
      };
      try {
        forwardRequest({
          id: 't1-grok',
          ts: 'test',
          startTime: Date.now(),
          parsedBody: body,
          rawBody,
          clientReq: { method: 'POST', url: '/v1/responses', headers },
          clientRes,
          fwdHeaders: { ...headers },
          reqSessionId: 'direct-api',
          skipEntry: true,
          upstream: {
            provider: 'openai',
            host: '127.0.0.1',
            port: mockPort,
            protocol: 'http',
            basePath: '/v1',
          },
        });
      } catch (e) {
        reject(e);
      }
    });

    assert.equal(calls, 1, `grok headers must trigger billing refresh; calls=${calls}`);
  });
});

describe('T2: billing throttle + injectable upstream + single /v1 path', () => {
  let dir;

  beforeEach(() => {
    _resetBillingThrottleForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bill-t2-'));
  });

  afterEach(() => {
    _resetBillingThrottleForTests();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('two calls inside TTL ⇒ one request', async () => {
    const stub = makeRequestStub();
    const upstream = resolveXaiUpstream({ XAI_BASE_URL: 'http://127.0.0.1:9/v1' }, 0);
    const headers = { authorization: 'Bearer t' };

    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request,
      upstream,
      ttlMs: 60_000,
      nowMs: 1_000_000,
    });
    await wait(30);
    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request,
      upstream,
      ttlMs: 60_000,
      nowMs: 1_000_000 + 5_000, // still inside TTL
    });
    await wait(30);

    assert.equal(stub.calls.length, 1, `expected 1 request inside TTL, got ${stub.calls.length}`);
  });

  it('non-200 does not start the TTL (second call still fires)', async () => {
    const stub = makeRequestStub({ statusCode: 503, body: 'err' });
    const upstream = resolveXaiUpstream({ XAI_BASE_URL: 'http://127.0.0.1:9/v1' }, 0);
    const headers = { authorization: 'Bearer t' };

    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request,
      upstream,
      ttlMs: 60_000,
      nowMs: 2_000_000,
    });
    await wait(30);
    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request,
      upstream,
      ttlMs: 60_000,
      nowMs: 2_000_000 + 1_000,
    });
    await wait(30);

    assert.equal(stub.calls.length, 2, `non-200 must not throttle; got ${stub.calls.length}`);
  });

  it('injected XAI-style upstream hits override host with a single /v1 in the path', async () => {
    const stub = makeRequestStub();
    const upstream = resolveXaiUpstream(
      { XAI_BASE_URL: 'http://billing-mock.local:18080/v1' },
      0,
    );
    assert.equal(upstream.host, 'billing-mock.local');
    assert.equal(upstream.basePath, '/v1');

    refreshGrokBillingFromAuth({ authorization: 'Bearer t' }, dir, 'default', {
      request: stub.request,
      upstream,
      ttlMs: 0,
    });
    await wait(30);

    assert.equal(stub.calls.length, 1);
    const opts = stub.calls[0];
    assert.equal(opts.hostname, 'billing-mock.local');
    assert.equal(opts.port, 18080);
    // joinUpstreamPath dedupes basePath /v1 + /v1/billing → single /v1
    assert.equal(opts.path, '/v1/billing?format=credits');
    assert.ok(!opts.path.includes('/v1/v1'), `double /v1: ${opts.path}`);
    // Sanity: joinUpstreamPath itself
    assert.equal(joinUpstreamPath(upstream, '/v1/billing?format=credits'), '/v1/billing?format=credits');
  });
});
