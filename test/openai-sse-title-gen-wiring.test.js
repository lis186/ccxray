'use strict';

// T1: resolveTitleGenTitle must run on the OpenAI SSE path (handleOpenAISSE).
// Existing session-title-attribution tests call store.attributeTitleGen directly
// and cannot catch an unwired forward.js path.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/store');
const { forwardRequest } = require('../server/forward');

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function grokTitleGenSse() {
  // Minimal OpenAI Responses SSE carrying session_title function_call args.
  const args = JSON.stringify({ session_title: 'Math demo' });
  const frames = [
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'session_title', arguments: args },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_title',
        status: 'completed',
        output: [{ type: 'function_call', name: 'session_title', arguments: args }],
      },
    })}\n\n`,
  ];
  return frames.join('');
}

describe('T1: OpenAI SSE title-gen attribution via forwardRequest', () => {
  let home;
  let mockServer;
  let mockPort;
  const parentSid = '019f-parent-main';

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-t1-title-'));
    process.env.CCXRAY_HOME = home;
    for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
    for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
    store.entries.length = 0;
    store.entryIndex.clear();

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(grokTitleGenSse());
    });
    mockPort = await new Promise(r => mockServer.listen(0, '127.0.0.1', () => r(mockServer.address().port)));
  });

  afterEach(async () => {
    await new Promise(r => mockServer.close(r));
    for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
    for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('SSE session_title function_call attributes title onto inflight parent', async () => {
    const now = Date.now();
    store.sessionMeta[parentSid] = {
      firstUserMsg: 'print 7*6',
      lastSeenAt: now - 5_000,
    };
    store.activeRequests[parentSid] = 1;

    const body = {
      model: 'grok-4.5',
      tool_choice: { type: 'function', name: 'session_title' },
      input: [
        { role: 'system', content: 'Generate session title' },
        { role: 'user', content: '<user_query>\nprint 7*6\n</user_query>' },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = {
      authorization: 'Bearer test-tok',
      'user-agent': 'grok-shell/0.2.103',
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-version': '0.2.103',
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
          setTimeout(resolve, 80);
        },
      };
      try {
        forwardRequest({
          id: 't1-sse-title',
          ts: 'test',
          startTime: now,
          parsedBody: body,
          rawBody,
          clientReq: { method: 'POST', url: '/v1/responses', headers },
          clientRes,
          fwdHeaders: { ...headers },
          reqSessionId: 'title-gen-child',
          sessionInferred: false,
          skipEntry: false,
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
    await wait(30);

    assert.equal(
      store.getSessionTitle(parentSid),
      'Math demo',
      `parent title must be set via OpenAI SSE path; got ${store.getSessionTitle(parentSid)}`,
    );
  });
});
