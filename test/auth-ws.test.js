'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Unit-test the warn-only auth gate helper that ws-proxy.js uses to decide
// whether an upgrade request is missing X-Ccxray-Auth. The actual WebSocket
// upgrade is tested in websocket-proxy.test.js; here we test the classification
// logic in isolation.

const wsProxy = require('../server/ws-proxy');

describe('WS header stripping (1.4c)', () => {
  it('buildWebSocketHeaders strips X-Ccxray-Auth and X-Ccxray-Bootstrap from upstream', () => {
    const { buildWebSocketHeaders } = wsProxy;
    const clientHeaders = {
      'x-ccxray-auth': 'secret-token',
      'x-ccxray-bootstrap': 'bootstrap-token',
      'authorization': 'Bearer sk-test',
      'openai-beta': 'responses_websockets=v1',
      'host': 'localhost:5577',
    };
    const upstream = { host: 'api.openai.com', port: 443 };
    const result = buildWebSocketHeaders(clientHeaders, upstream);

    assert.equal(result['x-ccxray-auth'], undefined);
    assert.equal(result['x-ccxray-bootstrap'], undefined);
    assert.equal(result['authorization'], 'Bearer sk-test');
    assert.equal(result['openai-beta'], 'responses_websockets=v1');
    assert.equal(result.host, 'api.openai.com');
  });
});

describe('WS auth gate classification (1.4b)', () => {
  describe('classifyUpstreamAuth', () => {
    it('returns "authed" when X-Ccxray-Auth is present', () => {
      const headers = { 'x-ccxray-auth': 'some-token-value' };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'authed');
    });

    it('returns "warn" when no X-Ccxray-Auth and no ChatGPT-OAuth markers', () => {
      const headers = { 'openai-beta': 'responses_websockets=v1' };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'warn');
    });

    it('returns "chatgpt-oauth" for ChatGPT-OAuth carve-out (no X-Ccxray-Auth + chatgpt-account-id + JWT authorization)', () => {
      const headers = {
        'chatgpt-account-id': 'acct-123',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fake',
      };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'chatgpt-oauth');
    });

    it('returns "warn" when chatgpt-account-id present but Authorization is not JWT-shaped', () => {
      const headers = {
        'chatgpt-account-id': 'acct-123',
        authorization: 'Bearer sk-proj-abc123',
      };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'warn');
    });

    it('returns "warn" when JWT-shaped Authorization present but no chatgpt-account-id', () => {
      const headers = {
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'warn');
    });

    it('returns "authed" when X-Ccxray-Auth is present even with ChatGPT-OAuth markers', () => {
      const headers = {
        'x-ccxray-auth': 'token',
        'chatgpt-account-id': 'acct-123',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      };
      assert.equal(wsProxy.classifyUpstreamAuth(headers), 'authed');
    });
  });
});
