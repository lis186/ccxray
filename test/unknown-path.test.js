'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const hub = require('../server/hub');
const { checkHttpRoute } = require('../server/request-routing');
const { isOpenAIWebSocket } = require('../server/ws-proxy');

it('unknown-path handling resolves request signals', () => {
  const url = '/v1/alpha/search?q=synthetic';
  for (const headers of [
    { 'chatgpt-account-id': 'acct' }, { originator: 'codex_cli_rs' },
    { 'openai-beta': 'synthetic' }, { 'x-openai-test': 'synthetic' },
    { 'x-codex-test': 'synthetic' }, { authorization: 'Bearer syntheticheader.payload.signature' },
    { 'user-agent': 'grok-shell/0.2.93' },
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
  assert.equal(config.getProviderForRequest('/', { 'x-codex-test': 'synthetic' }, { method: 'HEAD' }), 'openai');
  assert.equal(config.getUpstreamForRequestAndHeaders(url, { 'chatgpt-account-id': 'acct' }), config.UPSTREAMS.openaiChatGPT);
});

it('unknown-path handling uses attached client identity', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const [agentType, expected] of [['codex', 'openai'], ['grok', 'openai'], ['claude', 'anthropic']]) {
      hub.lookupClientIdentityForRequest = () => ({ agentType });
      assert.equal(config.getProviderForRequest('/v1/files', {}, {}), expected);
      const opposite = agentType === 'claude' ? { 'x-codex-test': 'synthetic' } : { 'anthropic-version': '2023-06-01' };
      assert.equal(config.getProviderForRequest('/v1/files', opposite, {}), null);
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('provider header hygiene rejects Anthropic forwarding', () => {
  for (const headers of [{ 'chatgpt-account-id': 'acct' }, { authorization: 'Bearer syntheticheader.payload.signature' }, { 'x-codex-test': 'synthetic' }]) {
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
  const { forwardRequest } = require('../server/forward');
  for (const [url, headers, upstream] of [
    ['/v1/alpha/search', {}, undefined],
    ['/v1/messages', { 'x-codex-test': 'synthetic' }, undefined],
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
