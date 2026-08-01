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

  it('grok headers + xai upstream → billing refresh is invoked', async () => {
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

    // Gate uses UPSTREAMS.xai identity — point xai at the loopback mock for this case.
    const config = require('../server/config');
    const mockUpstream = {
      provider: 'openai',
      host: '127.0.0.1',
      port: mockPort,
      protocol: 'http',
      basePath: '/v1',
    };
    const origXai = config.UPSTREAMS.xai;
    config.UPSTREAMS.xai = mockUpstream;

    try {
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
            upstream: mockUpstream,
          });
        } catch (e) {
          reject(e);
        }
      });
    } finally {
      config.UPSTREAMS.xai = origXai;
    }

    assert.equal(calls, 1, `grok headers + xai upstream must trigger billing; calls=${calls}`);
  });

  // T2a: grok-looking headers routed to a non-xai upstream must not fire billing.
  it('T2a: grok headers on non-xai upstream → no billing call', async () => {
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
          id: 't2a-non-xai',
          ts: 'test',
          startTime: Date.now(),
          parsedBody: body,
          rawBody,
          clientReq: { method: 'POST', url: '/v1/responses', headers },
          clientRes,
          fwdHeaders: { ...headers },
          reqSessionId: 'direct-api',
          skipEntry: true,
          // Deliberately NOT config.UPSTREAMS.xai — e.g. ChatGPT/openai host profile
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

    assert.equal(calls, 0, `non-xai upstream must not refresh billing; calls=${calls}`);
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

describe('T2b: throttle keyed on credential digest', () => {
  let dir;

  beforeEach(() => {
    _resetBillingThrottleForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bill-t2b-'));
  });

  afterEach(() => {
    _resetBillingThrottleForTests();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('two different Authorization values inside TTL each get a refresh; same value throttled', async () => {
    const stub = makeRequestStub();
    const upstream = resolveXaiUpstream({ XAI_BASE_URL: 'http://127.0.0.1:9/v1' }, 0);
    const now = 5_000_000;

    refreshGrokBillingFromAuth({ authorization: 'Bearer alpha' }, dir, 'default', {
      request: stub.request, upstream, ttlMs: 60_000, nowMs: now,
    });
    await wait(30);
    refreshGrokBillingFromAuth({ authorization: 'Bearer beta' }, dir, 'default', {
      request: stub.request, upstream, ttlMs: 60_000, nowMs: now + 1_000,
    });
    await wait(30);
    refreshGrokBillingFromAuth({ authorization: 'Bearer alpha' }, dir, 'default', {
      request: stub.request, upstream, ttlMs: 60_000, nowMs: now + 2_000,
    });
    await wait(30);

    assert.equal(stub.calls.length, 2, `expected 2 (alpha+beta), got ${stub.calls.length}`);
  });
});

describe('T2c: 200 with unusable body does not start TTL', () => {
  let dir;

  beforeEach(() => {
    _resetBillingThrottleForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bill-t2c-'));
  });

  afterEach(() => {
    _resetBillingThrottleForTests();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('200 without usable snap → next request inside TTL still issues a billing call', async () => {
    const stub = makeRequestStub({ statusCode: 200, body: JSON.stringify({ ok: true }) }); // no config
    const upstream = resolveXaiUpstream({ XAI_BASE_URL: 'http://127.0.0.1:9/v1' }, 0);
    const headers = { authorization: 'Bearer t' };
    const now = 6_000_000;

    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request, upstream, ttlMs: 60_000, nowMs: now,
    });
    await wait(30);
    refreshGrokBillingFromAuth(headers, dir, 'default', {
      request: stub.request, upstream, ttlMs: 60_000, nowMs: now + 1_000,
    });
    await wait(30);

    assert.equal(stub.calls.length, 2, `unusable 200 must not throttle; got ${stub.calls.length}`);
  });
});
