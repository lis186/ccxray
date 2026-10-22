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
      'openai-organization', 'openai-project', 'x-openai-extra'],
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

it('header allowlist: launcher declarations retain user names and omit foreign names', () => {
  const input = {
    'x-ccxray-forward-headers': ' X-User-Header, x-codex-turn-metadata, openai-project, chatgpt-account-id, originator, x-ccxray-extra, connection, sec-websocket-key',
    'x-user-header': 'retained', 'x-codex-turn-metadata': 'foreign',
    'openai-project': 'foreign', 'chatgpt-account-id': 'foreign', originator: 'foreign',
    'x-ccxray-extra': 'internal', connection: 'upgrade', 'sec-websocket-key': 'handshake',
  };
  assert.deepEqual(buildForwardHeaders(input, config.UPSTREAMS.anthropic), {
    'x-user-header': 'retained', host: config.UPSTREAMS.anthropic.host,
  });
  assert.equal(buildForwardHeaders({ 'x-user-header': 'omitted' }, config.UPSTREAMS.anthropic)['x-user-header'], undefined);
});

it('header allowlist: operator names apply per family with foreign names omitted', () => {
  const { parseForwardHeaders } = require('../server/config');
  const before = config.FORWARD_HEADERS;
  try {
    config.FORWARD_HEADERS = parseForwardHeaders('X-All, anthropic:X-Anthropic-Gateway, openai:x-platform-gateway, chatgpt:x-chatgpt-gateway, xai:x-xai-gateway, x-api-key, anthropic-extra, x-claude-extra, x-codex-extra, x-ccxray-future, connection, sec-websocket-key, bogus:x-no, x-bad value');
    const names = ['x-all', 'x-anthropic-gateway', 'x-platform-gateway', 'x-chatgpt-gateway', 'x-xai-gateway', 'x-api-key', 'anthropic-extra', 'x-claude-extra', 'x-codex-extra', 'x-ccxray-future', 'connection', 'sec-websocket-key', 'x-no', 'x-bad value'];
    for (const [key, allowed] of Object.entries({
      anthropic: ['x-all', 'x-anthropic-gateway', 'x-api-key', 'anthropic-extra', 'x-claude-extra'],
      openai: ['x-all', 'x-platform-gateway', 'x-codex-extra'],
      openaiChatGPT: ['x-all', 'x-chatgpt-gateway', 'x-codex-extra'],
      xai: ['x-all', 'x-xai-gateway', 'x-api-key', 'x-codex-extra'],
    })) {
      const input = Object.fromEntries(names.map(name => [name, 'synthetic']));
      const actual = buildForwardHeaders(input, config.UPSTREAMS[key]);
      assert.deepEqual(Object.keys(actual).sort(), [...allowed, 'host'].sort(), key);
    }
  } finally { config.FORWARD_HEADERS = before; }
});

it('header allowlist: WS uses the resolved family', () => {
  const input = { 'x-grok-session-id': 'grok', 'x-openai-session-id': 'session',
    'chatgpt-account-id': 'account', 'x-codex-turn-metadata': 'codex',
    upgrade: 'websocket', 'sec-websocket-key': 'handshake' };
  for (const key of ['openai', 'openaiChatGPT', 'xai']) {
    assert.deepEqual(buildForwardHeaders(input, config.UPSTREAMS[key], { websocket: true }),
      buildForwardHeaders(input, config.UPSTREAMS[key]), key);
  }
});

it('header allowlist: Grok OpenAI-wire names', () => {
  const names = ['x-openai-subagent', 'x-openai-session-id', 'x-openai-agent-type',
    'x-grok-session-id', 'x-grok-conv-id', 'x-grok-turn-idx', 'x-grok-req-id',
    'x-grok-model-override', 'x-grok-client-identifier', 'x-grok-agent-id',
    'x-request-id', 'x-client-request-id'];
  const input = Object.fromEntries(names.map(name => [name, 'synthetic']));
  assert.deepEqual(buildForwardHeaders(input, config.UPSTREAMS.xai), { ...input, host: config.UPSTREAMS.xai.host });
});

it('header allowlist: config reads operator names once at startup', () => {
  const modulePath = require.resolve('../server/config');
  const cached = require.cache[modulePath];
  const previous = process.env.CCXRAY_FORWARD_HEADERS;
  try {
    process.env.CCXRAY_FORWARD_HEADERS = 'X-All, anthropic:X-Gateway, chatgpt:X-Workspace, bogus:x-no, all:x-no, x-bad value';
    delete require.cache[modulePath];
    const fresh = require('../server/config');
    assert.deepEqual([...fresh.FORWARD_HEADERS.all], ['x-all']);
    assert.deepEqual([...fresh.FORWARD_HEADERS.anthropic], ['x-gateway']);
    assert.deepEqual([...fresh.FORWARD_HEADERS.chatgpt], ['x-workspace']);
    assert.equal(fresh.FORWARD_HEADERS.openai.size, 0);
    process.env.CCXRAY_FORWARD_HEADERS = 'x-later';
    assert.deepEqual([...fresh.FORWARD_HEADERS.all], ['x-all']);
  } finally {
    require.cache[modulePath] = cached;
    if (previous === undefined) delete process.env.CCXRAY_FORWARD_HEADERS;
    else process.env.CCXRAY_FORWARD_HEADERS = previous;
  }
});
