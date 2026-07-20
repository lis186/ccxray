'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');
const sse = require('../server/sse-broadcast');

function makeFakeClient() {
  return { written: [], write(data) { this.written.push(data); } };
}

function reset() {
  sse._resetTitleDebounce();
  store.sseClients.length = 0;
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
}

describe('broadcastSessionTitleUpdate', () => {
  beforeEach(reset);
  afterEach(reset);

  it('immediate mode emits one event with latest title', () => {
    store.setSessionTitle('sA', 'first', 100);
    const client = makeFakeClient();
    store.sseClients.push(client);
    sse.broadcastSessionTitleUpdate('sA', { immediate: true });
    assert.equal(client.written.length, 1);
    const parsed = JSON.parse(client.written[0].split('\n').find(l => l.startsWith('data: ')).replace(/^data: /, ''));
    assert.equal(parsed._type, 'session_title_update');
    assert.equal(parsed.sessionId, 'sA');
    assert.equal(parsed.title, 'first');
  });

  it('debounced bursts collapse to one broadcast with final value', (_, done) => {
    const client = makeFakeClient();
    store.sseClients.push(client);

    store.setSessionTitle('sA', 'first', 100);
    sse.broadcastSessionTitleUpdate('sA');
    store.setSessionTitle('sA', 'second', 200);
    sse.broadcastSessionTitleUpdate('sA');
    store.setSessionTitle('sA', 'third', 300);
    sse.broadcastSessionTitleUpdate('sA');

    assert.equal(client.written.length, 0, 'nothing should flush before timeout');

    setTimeout(() => {
      assert.equal(client.written.length, 1, 'exactly one event after debounce window');
      const parsed = JSON.parse(client.written[0].split('\n').find(l => l.startsWith('data: ')).replace(/^data: /, ''));
      assert.equal(parsed.title, 'third');
      done();
    }, sse.TITLE_DEBOUNCE_MS + 100);
  });

  it('skips broadcast when session has no title', () => {
    const client = makeFakeClient();
    store.sseClients.push(client);
    sse.broadcastSessionTitleUpdate('unknown', { immediate: true });
    assert.equal(client.written.length, 0);
  });

  it('ignores null/empty sessionId', () => {
    const client = makeFakeClient();
    store.sseClients.push(client);
    sse.broadcastSessionTitleUpdate(null, { immediate: true });
    sse.broadcastSessionTitleUpdate('', { immediate: true });
    assert.equal(client.written.length, 0);
  });
});
