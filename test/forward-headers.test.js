'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const { buildForwardHeaders, upstreamFamily } = require('../server/forward-headers');
const headerNames = require('./fixtures/routing/header-names.json');

it('header allowlist: resolved upstream identity', () => {
  for (const [key, family] of Object.entries({ anthropic: 'anthropic', openai: 'openai',
    openaiChatGPT: 'chatgpt', openaiChatGPTPlatform: 'chatgpt', openaiChatGPTAppsMcp: 'chatgpt', xai: 'xai' })) {
    assert.equal(upstreamFamily(config.UPSTREAMS[key]), family);
  }
});

it('header allowlist: observed names and transport handling', () => {
  for (const [shape, names] of Object.entries(headerNames)) {
    const websocket = shape.includes('WS UPGRADE');
    const upstream = shape.startsWith('claude') ? config.UPSTREAMS.anthropic
      : shape.startsWith('grok') ? config.UPSTREAMS.xai : config.UPSTREAMS.openaiChatGPT;
    const headers = Object.fromEntries(names.map(name => [name, 'synthetic']));
    headers.connection = 'keep-alive, X-Request-Id';
    headers['x-request-id'] = 'synthetic';
    headers['x-foo'] = 'synthetic';
    headers['x-ccxray-future'] = 'synthetic';
    const actual = buildForwardHeaders(headers, upstream, { websocket });
    const omitted = new Set(['host', 'accept-encoding', 'connection', 'upgrade']);
    for (const name of names) {
      if (websocket && name.startsWith('sec-websocket-')) omitted.add(name);
    }
    assert.deepEqual(actual, Object.fromEntries([
      ...names.filter(name => !omitted.has(name)).map(name => [name, 'synthetic']),
      ['host', upstream.host],
    ]), shape);
  }
});

it('header allowlist: family names, prefixes, and foreign names', () => {
  const common = ['accept', 'content-type', 'content-length', 'content-encoding', 'user-agent',
    'x-request-id', 'x-client-request-id'];
  const families = {
    anthropic: ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta',
      'anthropic-dangerous-direct-browser-access', 'x-app', 'x-claude-code-session-id',
      'anthropic-extra', 'x-stainless-extra', 'x-claude-extra'],
    openai: ['authorization', 'chatgpt-account-id', 'originator', 'version', 'session-id',
      'session_id', 'thread-id', 'thread_id', 'conversation_id', 'openai-organization',
      'openai-project', 'openai-extra', 'x-openai-extra', 'x-codex-extra', 'x-stainless-extra'],
    xai: ['authorization', 'x-api-key', 'x-grok-extra', 'x-stainless-extra', 'openai-extra',
      'openai-organization', 'openai-project'],
  };
  const allNames = new Set([...common, ...Object.values(families).flat(), 'x-foo', 'cookie',
    'x-ccxray-future', 'accept-encoding', 'sec-websocket-key', 'upgrade', 'transfer-encoding']);
  const input = Object.fromEntries([...allNames].map(name => [name, 'synthetic']));
  for (const [key, family] of Object.entries({ anthropic: 'anthropic', openai: 'openai',
    openaiChatGPT: 'openai', openaiChatGPTPlatform: 'openai', openaiChatGPTAppsMcp: 'openai', xai: 'xai' })) {
    assert.deepEqual(buildForwardHeaders(input, config.UPSTREAMS[key]), Object.fromEntries([
      ...new Set([...common, ...families[family]])].map(name => [name, 'synthetic'])
      .concat([['host', config.UPSTREAMS[key].host]])), key);
  }
});
