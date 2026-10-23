'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const hub = require('../server/hub');
const auth = require('../server/auth');
const { checkHttpRoute } = require('../server/request-routing');
const { isJwtShaped, isOpenAISide } = require('../server/request-signals');
const { forwardRequest } = require('../server/forward');
const { isOpenAIWebSocket, handleWebSocketUpgrade } = require('../server/ws-proxy');

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
  assert.equal(config.getProviderForRequest('/v1/files', { authorization: 'bEaReR sk-proj-synthetic' }), null);
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
    assert.deepEqual(lines, ['[ccxray] refused POST /v1/rate-limit (unknown route, not forwarded)']);
    refuse('GET', 'third-query');
    now += 1;
    refuse('POST', 'fourth-query');
    assert.deepEqual(lines, ['[ccxray] refused POST /v1/rate-limit (unknown route, not forwarded)', '[ccxray] refused GET /v1/rate-limit (unknown route, not forwarded)', '[ccxray] refused POST /v1/rate-limit (unknown route, not forwarded)']);
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

it('header-aware routing (#745): shared and OpenAI paths', () => {
  const signals = [
    { 'x-api-key': 'synthetic' }, { 'anthropic-version': '2023-06-01' },
    { 'anthropic-beta': 'synthetic' }, { authorization: 'Bearer sk-ant-synthetic' },
  ];
  const paths = ['/v1/responses', '/v1/realtime', '/v1/alpha/search', '/v1/memories',
    '/v1/images', '/v1/codex', '/v1/plugins', '/v1/ps/plugins', '/v1/connectors',
    '/v1/api/codex/ps/mcp'];
  for (const headers of signals) {
    for (const path of ['/v1/models', '/v1/models/child?probe=synthetic']) {
      assert.equal(config.getUpstreamForRequestAndHeaders(path, headers), config.UPSTREAMS.anthropic);
      assert.equal(config.getUpstreamForRequestAndHeaders(path, { ...headers, 'chatgpt-account-id': 'acct' }), null);
    }
    for (const path of paths.flatMap(path => [path, `${path}/child?probe=synthetic`])) {
      assert.equal(config.getUpstreamForRequestAndHeaders(path, headers), null);
    }
    for (const upstream of [config.UPSTREAMS.openai, config.UPSTREAMS.openaiChatGPT, config.UPSTREAMS.xai]) {
      let status;
      assert.equal(checkHttpRoute({ method: 'GET', url: '/v1/models', headers }, {
        writeHead: value => { status = value; }, end() {},
      }, upstream), false);
      assert.equal(status, 421);
    }
  }
  assert.equal(config.getUpstreamForRequestAndHeaders('/v1/models'), config.UPSTREAMS.openai);
  for (const headers of [{ 'user-agent': 'codex_cli_rs/0.163.0' }, { 'chatgpt-account-id': 'acct' }]) {
    for (const url of ['/v1/models', '/v1/responses']) {
      assert.equal(config.getUpstreamForRequestAndHeaders(url, headers).provider, 'openai');
    }
  }
  const original = hub.lookupClientIdentityForRequest;
  try {
    hub.lookupClientIdentityForRequest = () => ({ agentType: 'claude' });
    assert.equal(config.getUpstreamForRequestAndHeaders('/v1/models', {}, {}), config.UPSTREAMS.anthropic);
    for (const path of paths) assert.equal(config.getUpstreamForRequestAndHeaders(path, {}, {}), null);
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('header-aware routing (#745): WebSocket upgrades', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const attached of [false, true]) {
      hub.lookupClientIdentityForRequest = () => attached ? { agentType: 'claude' } : null;
      for (const url of ['/v1/responses', '/v1/realtime']) {
        const headers = { upgrade: 'websocket', ...(attached ? {} : { 'x-api-key': 'synthetic' }) };
        let response, destroyed = false;
        const socket = { write: value => { response = value; }, destroy() { destroyed = true; } };
        assert.equal(handleWebSocketUpgrade({ url, headers }, socket, Buffer.alloc(0)), true);
        assert.match(response, /^HTTP\/1.1 404 /);
        assert.equal(destroyed, true);
      }
    }
    const resolveUpstream = config.getUpstreamForRequestAndHeaders;
    try {
      for (const upstream of [config.UPSTREAMS.openai, config.UPSTREAMS.openaiChatGPT, config.UPSTREAMS.xai]) {
        config.getUpstreamForRequestAndHeaders = () => upstream;
        let response;
        handleWebSocketUpgrade({ url: '/v1/responses', headers: { upgrade: 'websocket' } }, {
          write: value => { response = value; }, destroy() {},
        }, Buffer.alloc(0));
        assert.match(response, /^HTTP\/1.1 404 /);
      }
    } finally { config.getUpstreamForRequestAndHeaders = resolveUpstream; }
    hub.lookupClientIdentityForRequest = () => ({ agentType: 'codex' });
    const req = { url: '/v1/responses', headers: { upgrade: 'websocket', 'user-agent': 'codex_cli_rs/0.163.0', 'chatgpt-account-id': 'acct' } };
    assert.equal(isOpenAIWebSocket(req, config.getUpstreamForRequestAndHeaders(req.url, req.headers, req)), true);
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('routing fix (#745): Grok hub identity selects xAI', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    hub.lookupClientIdentityForRequest = () => ({ agentType: 'grok' });
    for (const url of ['/v1/responses', '/v1/models', '/v1/alpha/title', '/api/title', '/v1/codex']) {
      assert.equal(config.getUpstreamForRequestAndHeaders(url, {}, {}), config.UPSTREAMS.xai);
    }
    assert.equal(checkHttpRoute({ url: '/v1/messages', method: 'POST', headers: {} }, {
      writeHead() {}, end() {},
    }, config.getUpstreamForRequestAndHeaders('/v1/messages', {}, {})), false);
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('routing fix (#745): bare bearer', () => {
  const headers = { authorization: 'Bearer sk-proj-synthetic' };
  assert.equal(isOpenAISide(headers), true);
  assert.equal(config.getUpstreamForRequestAndHeaders('/v1/unlisted', { authorization: 'Bearer sk-synthetic' }), null);
  assert.equal(config.getUpstreamForRequestAndHeaders('/v1/unlisted', headers), null);
  assert.equal(config.getUpstreamForRequestAndHeaders('/v1/unlisted', {
    ...headers, 'user-agent': 'codex_cli_rs/0.163.0',
  }), config.UPSTREAMS.openai);
});

it('routing fix (#745): preconnect', () => {
  const headers = { authorization: 'Bearer sk-proj-synthetic' };
  const original = console.warn;
  console.warn = () => assert.fail('routing fix (#745)');
  try {
    for (const method of ['HEAD', 'GET']) {
      const req = { method, url: '/api/hello', headers: {} };
      assert.equal(checkHttpRoute(req, { writeHead() {}, end() {} },
        config.getUpstreamForRequestAndHeaders(req.url, req.headers, req)), true);
      assert.equal(config.getProviderForRequest(req.url, {}, { method, bodySize: 1 }), null);
      assert.equal(config.getProviderForRequest(req.url, { 'transfer-encoding': 'chunked' }, { method }), null);
      assert.equal(config.getProviderForRequest(req.url, headers, { method }), null);
    }
  } finally { console.warn = original; }
});

it('routing fix (#745): warning cap', () => {
  const originalWarn = console.warn, originalNow = Date.now;
  const lines = [];
  console.warn = value => lines.push(value);
  Date.now = () => 2000000;
  const refuse = path => checkHttpRoute({ method: 'POST', url: path, headers: {} }, { writeHead() {}, end() {} }, null);
  try {
    for (let i = 0; i < 501; i++) refuse(`/v1/cap-${i}`);
    refuse('/v1/cap-500');
    assert.equal(lines.length, 501);
    refuse('/v1/cap-0');
    assert.equal(lines.length, 502);
    assert.equal(lines[0], '[ccxray] refused POST /v1/cap-0 (unknown route, not forwarded)');
  } finally { console.warn = originalWarn; Date.now = originalNow; }
});

it('routing fix (#745): gateway bearer with Anthropic headers', () => {
  for (const scheme of ['Bearer', 'bearer', 'bEaReR']) {
    for (const signal of [{'anthropic-version': '2023-06-01'}, {'anthropic-beta': 'synthetic'}, {'x-api-key': 'synthetic'}]) {
      const headers = { authorization: `${scheme} sk-gw-123`, ...signal };
      assert.equal(isOpenAISide(headers), false);
      for (const url of ['/v1/messages', '/v1/models', '/v1/files']) {
        const req = { method: 'POST', url, headers };
        const upstream = config.getUpstreamForRequestAndHeaders(url, headers, req);
        assert.equal(upstream, config.UPSTREAMS.anthropic);
        assert.equal(checkHttpRoute(req, { writeHead() { assert.fail('routing fix (#745)'); }, end() {} }, upstream), true);
      }
    }
  }
});

it('header-aware routing (#745): empty header values', () => {
  for (const value of ['', '   ', undefined, null, [], ['']]) {
    for (const name of ['anthropic-version', 'anthropic-beta', 'x-api-key']) {
      const headers = { [name]: value, 'user-agent': 'codex_cli_rs/0.163.0' };
      const req = { method: 'POST', url: '/v1/responses', headers };
      const upstream = config.getUpstreamForRequestAndHeaders(req.url, headers, req);
      assert.equal(upstream, config.UPSTREAMS.openai);
      assert.equal(checkHttpRoute(req, { writeHead() {}, end() {} }, upstream), true);
      assert.equal(config.getProviderForRequest('/v1/unlisted', { [name]: value }), null);
    }
    for (const name of ['chatgpt-account-id', 'openai-beta', 'x-openai-test', 'x-codex-turn-metadata', 'x-grok-client-version']) {
      assert.equal(isOpenAISide({ [name]: value }), false);
      assert.equal(config.getProviderForRequest('/v1/unlisted', { [name]: value }), null);
    }
  }
});

it('header-aware routing (#745): Grok x-api-key', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const attached of [false, true]) {
      hub.lookupClientIdentityForRequest = () => attached ? { agentType: 'grok' } : null;
      for (const marker of attached ? [{}] : [{ 'user-agent': 'grok-shell/0.2.93' }, { 'x-grok-client-version': '0.2.93' }]) {
        const headers = { 'x-api-key': 'xai-synthetic', ...marker };
        for (const url of ['/v1/responses', '/v1/models', '/v1/settings']) {
          const req = { method: 'POST', url, headers };
          const upstream = config.getUpstreamForRequestAndHeaders(url, headers, req);
          assert.equal(upstream, config.UPSTREAMS.xai);
          assert.equal(checkHttpRoute(req, { writeHead() {}, end() {} }, upstream), true);
          for (const signal of [{ 'anthropic-version': '2023-06-01' }, { 'anthropic-beta': 'synthetic' }, { authorization: 'Bearer sk-ant-synthetic' }]) {
            assert.equal(config.getUpstreamForRequestAndHeaders(url, { ...headers, ...signal }, req), null);
          }
        }
      }
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
  const headers = { 'x-api-key': 'xai-synthetic', 'user-agent': 'codex_cli_rs/0.163.0' };
  assert.equal(config.getUpstreamForRequestAndHeaders('/v1/responses', headers), null);
});

it('routing fix (#745): Grok with Anthropic-shaped x-api-key', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const source of ['ua', 'header', 'hub']) {
      hub.lookupClientIdentityForRequest = () => source === 'hub' ? { agentType: 'grok' } : null;
      const marker = source === 'ua' ? { 'user-agent': 'grok-shell/0.2' }
        : source === 'header' ? { 'x-grok-model-override': 'synthetic' } : {};
      for (const value of ['sk-ant-synthetic', '  SK-ANT-synthetic  ', ['xai-synthetic', '  sk-ant-synthetic  ']]) {
        for (const url of ['/v1/files', '/v1/models', '/v1/responses']) {
          const req = { method: 'GET', url, headers: { ...marker, 'x-api-key': value } };
          const upstream = config.getUpstreamForRequestAndHeaders(url, req.headers, req);
          assert.equal(upstream, null);
          let status;
          assert.equal(checkHttpRoute(req, { writeHead: v => { status = v; }, end() {} }, upstream), false);
          assert.equal(status, 421);
        }
      }
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('routing fix (#745): Grok conflicts with explicit Codex and ChatGPT markers', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const source of ['ua', 'header', 'hub']) {
      hub.lookupClientIdentityForRequest = () => source === 'hub' ? { agentType: 'grok' } : null;
      const marker = source === 'ua' ? { 'user-agent': 'grok-shell/0.2' }
        : source === 'header' ? { 'x-grok-client-version': '0.2' } : {};
      for (const explicit of [{ 'chatgpt-account-id': 'acct' }, { 'x-codex-test': 'synthetic' },
        { 'user-agent': 'codex_cli_rs/0.163.0' }, { originator: 'codex' }]) {
        if (source === 'ua' && explicit['user-agent']) continue;
        for (const url of ['/v1/files', '/v1/models', '/v1/responses', '/v1/plugins/test', '/v1/api/codex/test', '/v1/api/codex/ps/mcp']) {
          const req = { method: 'GET', url, headers: { ...marker, ...explicit } };
          const upstream = config.getUpstreamForRequestAndHeaders(url, req.headers, req);
          assert.equal(upstream, null);
          let status;
          assert.equal(checkHttpRoute(req, { writeHead: v => { status = v; }, end() {} }, upstream), false);
          assert.equal(status, 421);
        }
      }
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('header-aware routing (#745): Grok path consistency', () => {
  const original = hub.lookupClientIdentityForRequest;
  try {
    for (const source of ['ua', 'header', 'hub']) {
      hub.lookupClientIdentityForRequest = () => source === 'hub' ? { agentType: 'grok' } : null;
      const headers = source === 'ua' ? { 'user-agent': 'grok-shell/0.2' }
        : source === 'header' ? { 'x-grok-client-version': '0.2' } : {};
      for (const url of ['/v1/plugins/test', '/v1/api/codex/test', '/v1/api/codex/ps/mcp']) {
        const req = { method: 'GET', url, headers };
        const upstream = config.getUpstreamForRequestAndHeaders(url, headers, req);
        assert.equal(upstream, config.UPSTREAMS.xai);
        assert.equal(checkHttpRoute(req, { writeHead() {}, end() {} }, upstream), true);
      }
    }
  } finally { hub.lookupClientIdentityForRequest = original; }
});

it('routing fix (#745): both gates use the request identity', () => {
  const original = hub.lookupClientIdentityForRequest;
  const previous = process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
  process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
  const req = { url: '/v1/responses', headers: {
    'chatgpt-account-id': 'acct', authorization: 'Bearer syntheticheader.payload.signature',
  }, socket: { remoteAddress: '127.0.0.1' } };
  try {
    for (const [agentType, accepted] of [['codex', true], ['grok', false]]) {
      hub.lookupClientIdentityForRequest = request => request === req ? { agentType } : null;
      assert.equal(auth.isUpstreamAuthenticated(req), accepted);
      const upstream = config.getUpstreamForRequestAndHeaders(req.url, req.headers, req);
      assert.equal(upstream, accepted ? config.UPSTREAMS.openaiChatGPT : null);
    }
  } finally {
    hub.lookupClientIdentityForRequest = original;
    if (previous === undefined) delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    else process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = previous;
  }
});

it('routing fix: bearer whitespace and trimmed values', () => {
  for (const gap of [' ', '  ', '\t']) {
    const authorization = `  bEaReR${gap}sk-ant-synthetic  `;
    for (const url of ['/v1/responses', '/v1/alpha/search', '/v1/codex/x']) {
      assert.equal(config.getUpstreamForRequestAndHeaders(url, { authorization }), null);
    }
    assert.equal(config.getUpstreamForRequestAndHeaders('/v1/models', { authorization }), config.UPSTREAMS.anthropic);
    assert.equal(config.getUpstreamForRequestAndHeaders('/v1/models', {
      authorization, 'chatgpt-account-id': 'synthetic',
    }), null);
    assert.equal(isJwtShaped(`  bEaReR${gap}syntheticheader.payload.signature  `), true);
    assert.equal(isOpenAISide({ authorization: `  Bearer${gap}sk-proj-synthetic  ` }), true);
  }
});

it('routing fix: every duplicate header value with raw, distinct, and joined headers', () => {
  for (const name of ['x-api-key', 'authorization']) {
    const anthropic = name === 'x-api-key' ? 'sk-ant-synthetic' : 'Bearer\tsk-ant-synthetic';
    const other = name === 'x-api-key' ? 'xai-synthetic' : 'Bearer sk-proj-synthetic';
    for (const values of [[other, anthropic], [anthropic, other]]) {
      for (const source of ['raw', 'distinct', 'joined', 'array']) {
        const headers = { 'user-agent': 'grok-shell/0.2.93', [name]: values.join(', ') };
        const req = { headers };
        if (source === 'raw') {
          headers[name] = values[0];
          req.rawHeaders = [name.toUpperCase(), values[0], name, values[1]];
        } else if (source === 'distinct') {
          headers[name] = values[0];
          req.headersDistinct = { [name]: values };
        } else if (source === 'array') headers[name] = values;
        for (const url of ['/v1/models', '/v1/responses', '/v1/alpha/search', '/v1/codex/x', '/v1/files']) {
          assert.equal(config.getUpstreamForRequestAndHeaders(url, headers, req), null, `${name}: ${source}: ${url}`);
        }
      }
    }
  }
});
