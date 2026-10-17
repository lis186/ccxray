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

  it('inflight but lastSeenAt older than default 1s window → discard', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'hello', lastSeenAt: now - 5_000, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now), null);
  });

  it('30s-old candidate: discarded at anthropic 1s window, kept at grok 60s window', () => {
    const now = Date.now();
    seedSession('sA', { firstUserMsg: 'hello', lastSeenAt: now - 30_000, inflight: true });
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now, 1000), null, 'anthropic 1s');
    assert.equal(store.attributeTitleGen(titleGenReq('hello'), now, 60_000), 'sA', 'grok 60s');
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
    assert.equal(store.attributeTitleGen(titleReq, now, 60_000), mainSid);
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

// Claude Code 2.1.302 first-message shape: several <system-reminder> text
// blocks precede the typed prompt block. Synthetic text only.
function claude2302FirstMsg(prompt) {
  return {
    metadata: { user_id: '{"session_id":"a2302-0000-1111"}' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\nSynthetic skills list.\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nSynthetic CLAUDE.md context.\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nSynthetic date reminder.\n</system-reminder>' },
        { type: 'text', text: prompt },
      ],
    }],
  };
}

describe('firstPrompt skips injected-only blocks (Claude 2.1.302)', () => {
  beforeEach(reset);

  it('records the prompt block, not the leading system-reminder blocks', () => {
    store.detectSession(claude2302FirstMsg('refactor the export cursor'));
    assert.equal(store.getSessionFirstPrompt('a2302-0000-1111'), 'refactor the export cursor');
    assert.equal(store.sessionMeta['a2302-0000-1111'].firstUserMsg, 'refactor the export cursor');
  });

  it('extractFirstUserMsgText picks the first block that survives tag stripping', () => {
    assert.equal(store.extractFirstUserMsgText(claude2302FirstMsg('hello there')), 'hello there');
  });

  it('title-gen request carrying the bare prompt still attributes to the main session', () => {
    store.detectSession(claude2302FirstMsg('refactor the export cursor'));
    const now = Date.now();
    store.sessionMeta['a2302-0000-1111'].lastSeenAt = now;
    store.activeRequests['a2302-0000-1111'] = 1;
    assert.equal(store.attributeTitleGen(titleGenReq('refactor the export cursor'), now), 'a2302-0000-1111');
  });

  it('never latches an empty value: an all-reminder first request leaves both null, a later one fills them', () => {
    const sid = 'b0000-1a7c-2222';
    const reminderOnly = {
      metadata: { user_id: `{"session_id":"${sid}"}` },
      messages: [{ role: 'user', content: [
        { type: 'text', text: '<system-reminder>only scaffolding</system-reminder>' },
        { type: 'text', text: '<system-reminder>more scaffolding</system-reminder>' },
      ] }],
    };
    store.detectSession(reminderOnly);
    assert.equal(store.getSessionFirstPrompt(sid), null);
    assert.equal(store.sessionMeta[sid].firstUserMsg, undefined, 'an injected-only anchor is not latched');

    store.detectSession({
      ...reminderOnly,
      messages: [...reminderOnly.messages,
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'now do the real task' }] }],
    });
    assert.equal(store.getSessionFirstPrompt(sid), 'now do the real task');

    // Once set, later requests never overwrite it.
    store.detectSession({ ...reminderOnly, messages: [{ role: 'user', content: 'something else' }] });
    assert.equal(store.getSessionFirstPrompt(sid), 'now do the real task');
  });
});

describe('session index row carries firstPrompt recorded before the row existed', () => {
  beforeEach(reset);

  it('detectSession (no row yet) then the first entry → row.firstPrompt is set', () => {
    const si = require('../server/session-index');
    const sid = 'c0ffee00-2302-4444-5555-666666666666';
    store.detectSession({ metadata: { user_id: `{"session_id":"${sid}"}` }, messages: [{ role: 'user', content: 'wire up the branch field' }] });
    assert.equal(store.getSessionFirstPrompt(sid), 'wire up the branch field');
    assert.ok(!si.get(sid), 'precondition: no session row before the first entry');
    si.updateFromEntry({ id: '2026-10-17T00-00-00-000', sessionId: sid, receivedAt: 1 });
    assert.equal(si.get(sid).firstPrompt, 'wire up the branch field');
  });
});
