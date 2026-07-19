'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');

function reset() {
  for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
  for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
}

function seedSession(sid, { firstUserMsg, lastSeenAt = Date.now(), inflight = false } = {}) {
  store.sessionMeta[sid] = { firstUserMsg, lastSeenAt };
  if (inflight) store.activeRequests[sid] = 1;
}

function titleGenReq(text) {
  return { messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}

describe('store.extractFirstUserMsgText', () => {
  it('handles string content', () => {
    const req = { messages: [{ role: 'user', content: 'hello' }] };
    assert.equal(store.extractFirstUserMsgText(req), 'hello');
  });
  it('handles block-array content', () => {
    const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    assert.equal(store.extractFirstUserMsgText(req), 'hi');
  });
  it('returns null when first message is not user', () => {
    const req = { messages: [{ role: 'assistant', content: 'nope' }] };
    assert.equal(store.extractFirstUserMsgText(req), null);
  });
  it('returns null when content has no text block', () => {
    const req = { messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] };
    assert.equal(store.extractFirstUserMsgText(req), null);
  });
});

describe('store.setSessionTitle monotonic guard', () => {
  beforeEach(reset);

  it('writes a title for the first time', () => {
    assert.equal(store.setSessionTitle('sA', 'Fix login', 100), true);
    assert.equal(store.getSessionTitle('sA'), 'Fix login');
  });
  it('replaces an older title with a newer one', () => {
    store.setSessionTitle('sA', 'old', 100);
    assert.equal(store.setSessionTitle('sA', 'new', 200), true);
    assert.equal(store.getSessionTitle('sA'), 'new');
  });
  it('rejects out-of-order responses', () => {
    store.setSessionTitle('sA', 'first', 200);
    assert.equal(store.setSessionTitle('sA', 'late', 100), false);
    assert.equal(store.getSessionTitle('sA'), 'first');
  });
  it('no-ops when title is unchanged', () => {
    store.setSessionTitle('sA', 'same', 100);
    assert.equal(store.setSessionTitle('sA', 'same', 200), false);
    assert.equal(store.getSessionTitle('sA'), 'same');
  });
  it('ignores empty / null titles', () => {
    assert.equal(store.setSessionTitle('sA', '', 100), false);
    assert.equal(store.setSessionTitle('sA', null, 100), false);
    assert.equal(store.getSessionTitle('sA'), null);
  });
});

describe('store.attributeTitleGen', () => {
  beforeEach(reset);

  it('single inflight session with content match → attributed', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: '繼續', lastSeenAt: now - 100, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('繼續'), now), 'sA');
  });

  it('two inflight sessions, content disambiguates', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'alpha', lastSeenAt: now - 50, inflight: true });
    seedSession('sB', { firstUserMsg: 'beta', lastSeenAt: now - 50, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('beta'), now), 'sB');
  });

  it('two inflight sessions with identical first message → discard', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'hi', lastSeenAt: now - 50, inflight: true });
    seedSession('sB', { firstUserMsg: 'hi', lastSeenAt: now - 50, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('hi'), now), null);
  });

  it('temporal match but content mismatch → discard', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'alpha', lastSeenAt: now - 50, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('beta'), now), null);
  });

  it('session outside window → discard', () => {
    const now = Date.now();
    // Not inflight; even a recent lastSeenAt is ignored
    seedSession('sA', { firstUserMsg: 'hello', lastSeenAt: now - 5000 });
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now), null);
  });

  it('inflight but lastSeenAt older than 60s window → discard', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'hello', lastSeenAt: now - 120_000, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now), null);
  });

  it('session within window but not inflight → discard', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'hello', lastSeenAt: now - 100, inflight: false });
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now), null);
  });

  it('returns null when title-gen req has no user text', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'x', lastSeenAt: now, inflight: true });
    assert.equal(store.attributeTitleGen({ messages: [] }, now), null);
  });

  it('Grok user_query anchor matches main turn despite user_info scaffolding', () => {
    const now = Date.now();
    const mainSid = '019f-main';
    store.sessionMeta[mainSid] = {
      firstUserMsg: 'Reply with exactly: ok',
      lastSeenAt: now - 5_000, // title-gen often finishes several seconds later
    };
    store.activeRequests[mainSid] = 1;
    const titleReq = {
      model: 'grok-build',
      tool_choice: { type: 'function', name: 'session_title' },
      input: [
        { role: 'system', content: 'Generate session title' },
        { role: 'user', content: '<user_query>\nReply with exactly: ok\n</user_query>' },
      ],
    };
    assert.equal(store.attributeTitleGen(titleReq, now), mainSid);
  });
});

describe('store.recordFirstUserMsg', () => {
  beforeEach(reset);

  it('stores the first user message exactly once', () => {
    store.recordFirstUserMsg('sA', { messages: [{ role: 'user', content: 'original' }] });
    store.recordFirstUserMsg('sA', { messages: [{ role: 'user', content: 'later' }] });
    assert.equal(store.sessionMeta.sA.firstUserMsg, 'original');
  });

  it('Grok main turn stores user_query body not user_info', () => {
    store.recordFirstUserMsg('sGrok', {
      input: [
        { role: 'system', content: 'You are Grok' },
        { role: 'user', content: '<user_info> Workspace Path: /tmp/x </user_info>' },
        { role: 'user', content: '<user_query> Reply with exactly: ok </user_query>' },
      ],
    });
    assert.equal(store.sessionMeta.sGrok.firstUserMsg, 'Reply with exactly: ok');
  });

  it('skips direct-api sessions', () => {
    store.recordFirstUserMsg('direct-api', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(store.sessionMeta['direct-api'], undefined);
  });
});

describe('store.detectSession populates firstUserMsg', () => {
  beforeEach(reset);

  it('records the user text on the first main-request attribution', () => {
    const req = {
      metadata: { user_id: '{"session_id":"abc-123"}' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the auth flow' }] }],
    };
    const out = store.detectSession(req);
    assert.equal(out.sessionId, 'abc-123');
    assert.equal(store.sessionMeta['abc-123'].firstUserMsg, 'inspect the auth flow');
  });
});
