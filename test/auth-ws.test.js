'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Unit-test ws-proxy's internal-header stripping. The upstream auth decision
// (verifyUpstreamCredential) is tested in auth-upstream-credential.test.js, and
// the live WS gate in websocket-proxy.test.js.

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

describe('WS gate: ChatGPT-login headers from a non-loopback peer', () => {
  const JWT = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';

  function fakeSocket() {
    return {
      destroyed: false,
      written: '',
      write(chunk) { this.written += chunk; },
      destroy() { this.destroyed = true; },
    };
  }

  it('is answered 401 without a ccxray credential', () => {
    const saved = process.env.CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN;
    delete process.env.CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN;
    try {
      const socket = fakeSocket();
      const req = {
        url: '/v1/responses',
        headers: {
          'openai-beta': 'responses_websockets=v1',
          'chatgpt-account-id': 'acct-1',
          authorization: JWT,
          upgrade: 'websocket',
          connection: 'Upgrade',
        },
        socket: { remoteAddress: '192.168.1.50' },
      };
      assert.equal(wsProxy.handleWebSocketUpgrade(req, socket, Buffer.alloc(0)), true);
      assert.match(socket.written, /^HTTP\/1\.1 401 /);
      assert.equal(socket.destroyed, true);
    } finally {
      if (saved !== undefined) process.env.CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN = saved;
    }
  });
});
