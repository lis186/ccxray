'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');

function reset() {
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
  for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
}

// #223 edge case 1: inferParentSession only considers sessions with
// lastSeenAt within the last 30s. Long streaming turns (>30s) used to
// only refresh lastSeenAt at stream end, so a subagent spawned mid-stream
// couldn't find its parent. forward.js now refreshes lastSeenAt on
// message_start/content_block_start SSE events; this exercises the
// window check that fix relies on.
describe('store.inferParentSession 30s window (#223 edge case 1)', () => {
  beforeEach(reset);

  it('a session last seen just outside the window is not selected', () => {
    store.sessionMeta.sA = { lastSeenAt: Date.now() - 40000 };
    assert.equal(store.inferParentSession(), null);
  });

  it('a session last seen within the window is selected', () => {
    store.sessionMeta.sA = { lastSeenAt: Date.now() - 1000 };
    assert.equal(store.inferParentSession(), 'sA');
  });

  it('refreshing lastSeenAt (simulating a mid-stream SSE refresh) brings a stale session back into the window', () => {
    store.sessionMeta.sA = { lastSeenAt: Date.now() - 40000 };
    assert.equal(store.inferParentSession(), null);

    // Simulates the refresh forward.js now performs on message_start /
    // content_block_start events during a long stream.
    store.sessionMeta.sA.lastSeenAt = Date.now();
    assert.equal(store.inferParentSession(), 'sA');
  });
});
