'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const hub = require('../server/hub');
const auth = require('../server/auth');
const { checkHttpRoute } = require('../server/request-routing');
const { isJwtShaped } = require('../server/request-signals');
const { forwardRequest } = require('../server/forward');
const { isOpenAIWebSocket } = require('../server/ws-proxy');

for (const path of ['/v1/alpha/search', '/v1/memories', '/v1/images']) {
  it(`routing fix: ${path} uses the OpenAI upstreams`, () => {
    for (const url of [path, `${path}/child`, `${path}?probe=synthetic`]) {
      assert.equal(config.getProviderForRequest(url), 'openai');
      assert.equal(config.getUpstreamForRequest(url), config.UPSTREAMS.openai);
      assert.equal(config.getUpstreamForRequestAndHeaders(url), config.UPSTREAMS.openai);
      const headers = { 'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature' };
      const upstream = config.getUpstreamForRequestAndHeaders(url, headers);
      assert.equal(upstream, config.UPSTREAMS.openaiChatGPT);
      assert.equal(config.joinUpstreamPath(upstream, url), `/backend-api/codex${url.slice(3)}`);
      assert.equal(checkHttpRoute({ method: 'POST', url, headers: {} }, {
        writeHead() { assert.fail('routing fix: listed path should be forwarded'); }, end() {},
      }, config.getUpstreamForRequestAndHeaders(url)), true);
      const previous = process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
      process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
      try {
        assert.equal(auth.isUpstreamAuthenticated({
          url, headers, socket: { remoteAddress: '127.0.0.1' },
        }), true);
      } finally {
        if (previous === undefined) delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
        else process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = previous;
      }
    }
    assert.equal(config.getProviderForRequest(`${path}-unlisted`), null);
  });
}

it('unknown-path handling resolves request signals', () => {
  const url = '/v1/alpha/unlisted?q=synthetic';
  for (const headers of [
    { 'chatgpt-account-id': 'acct' }, { originator: 'codex_cli_rs' },
    { 'openai-beta': 'synthetic' }, { 'x-openai-test': 'synthetic' },
    { 'x-codex-turn-metadata': '{}' }, { 'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature' },
    { 'user-agent': 'grok-shell/0.2.93' },
    { 'user-agent': 'codex_cli_rs/0.163.0 (Linux)' },
    { originator: 'codex_exec' },
    { authorization: 'bearer sk-proj-synthetic', 'user-agent': 'codex_cli_rs/0.163.0' },
  ]) {
    assert.equal(config.getProviderForRequest(url, headers), 'openai');
    assert.equal(config.getUpstreamForRequestAndHeaders(url, headers).provider, 'openai');
    assert.equal(config.getProviderForRequest(url, { ...headers, 'anthropic-version': '2023-06-01' }), null);
    assert.equal(config.getUpstreamForRequestAndHeaders(url, { ...headers, 'anthropic-version': '2023-06-01' }), null);
  }
  for (const headers of [{ 'anthropic-version': '2023-06-01' }, { 'anthropic-beta': 'synthetic' },
    { 'x-api-key': 'synthetic' }, { authorization: 'Bearer sk-ant-synthetic' }]) {
    assert.equal(config.getProviderForRequest(url, headers), 'anthropic');
  }
  assert.equal(config.getProviderForRequest(url), null);
  assert.equal(config.getUpstreamForRequestAndHeaders(url), null);
  assert.equal(config.getUpstream('unlisted'), null);
  assert.equal(config.getUpstream('toString'), null);
  for (const method of ['HEAD', 'GET']) {
    assert.equal(config.getProviderForRequest('/', {}, { method }), 'anthropic');
    assert.equal(config.getProviderForRequest('/', {}, { method, bodySize: 1 }), null);
  }
  assert.equal(config.getProviderForRequest('/', {}, { method: 'POST' }), null);
  assert.equal(config.getProviderForRequest('/', { 'content-length': '1' }, { method: 'GET' }), null);
  assert.equal(config.getProviderForRequest('/', { 'x-codex-turn-metadata': '{}' }, { method: 'HEAD' }), 'openai');
  assert.equal(config.getUpstreamForRequestAndHeaders(url, { 'chatgpt-account-id': 'acct' }), config.UPSTREAMS.openaiChatGPT);
});

it('unknown-path handling uses attached client identity', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const [agentType, expected] of [['codex', 'openai'], ['grok', 'openai'], ['claude', 'anthropic']]) {
      hub.lookupClientIdentityForRequest = () => ({ agentType });
      assert.equal(config.getProviderForRequest('/v1/files', {}, {}), expected);
      const opposite = agentType === 'claude' ? { 'x-codex-turn-metadata': '{}' } : { 'anthropic-version': '2023-06-01' };
      assert.equal(config.getProviderForRequest('/v1/files', opposite, {}), null);
      if (agentType === 'claude') {
        assert.equal(config.getProviderForRequest('/v1/files', { authorization: 'bearer sk-proj-synthetic' }, {}), null);
      }
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('provider header hygiene rejects Anthropic forwarding', () => {
  for (const headers of [{ 'chatgpt-account-id': 'acct' }, { 'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature' }, { 'x-codex-turn-metadata': '{}' }]) {
    let status, body;
    const req = { method: 'POST', url: '/v1/messages?q=synthetic', headers };
    assert.equal(checkHttpRoute(req, { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } }, config.UPSTREAMS.anthropic), false);
    assert.equal(status, 421);
    assert.equal(body.error.type, 'ccxray_unknown_route');
    assert.ok(!body.error.message.includes('?'));
    assert.equal(isOpenAIWebSocket({ ...req, headers: { upgrade: 'websocket' } }, config.UPSTREAMS.anthropic), false);
  }
});

it('routing fix checks the forwarding fallback', () => {
  for (const [url, headers, upstream] of [
    ['/v1/alpha/unlisted', {}, undefined],
    ['/v1/messages', { 'x-codex-turn-metadata': '{}' }, undefined],
    ['/v1/responses', { 'chatgpt-account-id': 'acct' }, config.UPSTREAMS.anthropic],
  ]) {
    let status, body;
    forwardRequest({
      clientReq: { method: 'POST', url, headers }, upstream,
      clientRes: { writeHead: value => { status = value; }, end: value => { body = JSON.parse(value); } },
    });
    assert.equal(status, 421);
    assert.equal(body.error.type, 'ccxray_unknown_route');
  }
});

it('unknown-path handling keeps Claude JWT shapes on Anthropic', () => {
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const authorization = `${scheme} syntheticheader.payload.signature`;
    assert.equal(isJwtShaped(authorization), true);
    for (const url of ['/v1/messages', '/v1/files']) {
      const req = { method: 'POST', url, headers: { 'anthropic-version': '2023-06-01', authorization } };
      const upstream = config.getUpstreamForRequestAndHeaders(url, req.headers, req);
      assert.equal(upstream.provider, 'anthropic');
      assert.equal(checkHttpRoute(req, { writeHead() {}, end() {} }, upstream), true);
    }
    for (const url of ['/api/event_logging/batch', '/v1/alpha/unlisted']) {
      const req = { method: 'POST', url, headers: { authorization } };
      const upstream = config.getUpstreamForRequestAndHeaders(url, req.headers, req);
      assert.equal(upstream, null);
      let status;
      assert.equal(checkHttpRoute(req, { writeHead: value => { status = value; }, end() {} }, upstream), false);
      assert.equal(status, 421);
    }
  }
});

it('provider header hygiene uses wire and attached client shapes', () => {
  const original = hub.lookupClientIdentityForRequest;
  const res = { writeHead() {}, end() {} };
  try {
    for (const headers of [
      { 'user-agent': 'codex_cli_rs/0.163.0 (Linux)' }, { originator: 'codex_exec' },
      { authorization: 'bearer sk-proj-synthetic' }, { 'user-agent': 'grok-shell/0.2.93' },
      { 'x-grok-client-version': '0.2.93' },
    ]) {
      assert.equal(checkHttpRoute({ method: 'POST', url: '/v1/messages', headers }, res, config.UPSTREAMS.anthropic), false);
    }
    for (const agentType of ['codex', 'grok']) {
      hub.lookupClientIdentityForRequest = () => ({ agentType });
      assert.equal(checkHttpRoute({ method: 'POST', url: '/v1/messages', headers: {} }, res, config.UPSTREAMS.anthropic), false);
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
  assert.equal(config.getProviderForRequest('/v1/files', { authorization: 'bEaReR sk-proj-synthetic' }), 'openai');
  assert.equal(config.getProviderForRequest('/v1/files', { authorization: 'bearer sk-proj-synthetic', 'anthropic-version': '2023-06-01' }), 'anthropic');
  assert.equal(config.getProviderForRequest('/v1/files', { authorization: 'bearer sk-ant-synthetic' }), 'anthropic');
});

it('unknown-path handling logs only method and pathname once per 60 seconds', () => {
  const originalWarn = console.warn;
  const originalNow = Date.now;
  const lines = [];
  let now = 1000000;
  console.warn = (...args) => lines.push(args.join(' '));
  Date.now = () => now;
  const refuse = (method, query) => checkHttpRoute({ method, url: `/v1/rate-limit?${query}`, headers: { authorization: 'synthetic-header-value' } }, { writeHead() {}, end() {} }, null);
  try {
    refuse('POST', 'first-query');
    now += 59999;
    refuse('POST', 'second-query');
    assert.deepEqual(lines, ['[ccxray] POST /v1/rate-limit']);
    refuse('GET', 'third-query');
    now += 1;
    refuse('POST', 'fourth-query');
    assert.deepEqual(lines, ['[ccxray] POST /v1/rate-limit', '[ccxray] GET /v1/rate-limit', '[ccxray] POST /v1/rate-limit']);
  } finally { console.warn = originalWarn; Date.now = originalNow; }
});

it('provider header hygiene accepts bearer scheme variants for existing callers', () => {
  for (const scheme of ['Bearer', 'bearer', 'bEaReR']) {
    const authorization = `${scheme} syntheticheader.payload.signature`;
    assert.equal(auth.verifyUpstreamCredential({ authorization, 'chatgpt-account-id': 'acct' }), 'chatgpt-oauth');
    assert.equal(auth.verifyUpstreamCredential({ authorization }), 'reject');
  }
  assert.equal(isJwtShaped('Basic syntheticheader.payload.signature'), false);
  assert.equal(isJwtShaped(null), false);
});
