'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #170 — extract-and-test pure logic from public/intercept-ui.js.
//
// This file is mostly DOM-event wiring, but a handful of functions build HTML
// from `currentPending` (a module-level global normally owned by
// miller-columns.js) or mutate it in response to editor input, with no DOM
// access at all. We stub the handful of externals it needs to load
// (evtSource, currentPending, etc. — all implicit globals in the browser
// bundle) and exercise those functions directly.
function loadContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  const context = {
    console,
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    // top-level code in intercept-ui.js reassigns evtSource.onmessage — must pre-exist
    evtSource: { onmessage: null },
    // implicit globals referenced only inside function bodies (not at load time)
    currentPending: null,
    sessionsMap: new Map(),
    interceptSessionIds: new Set(),
    countdownInterval: null,
    interceptTimeoutSec: 30,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
  vm.createContext(context);
  // messages.js defines getMessagePreview, used by the "messages" tab renderer.
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'messages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'intercept-ui.js'), 'utf8'), context);
  return context;
}

describe('intercept-ui: renderInterceptTabContent(tab)', () => {
  it('returns "" when there is no pending request', () => {
    const ctx = loadContext();
    ctx.currentPending = null;
    assert.equal(ctx.renderInterceptTabContent('system'), '');
  });
  it('renders the escaped raw JSON of the pending body on the "raw" tab', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { model: 'claude-opus-4-6', messages: [] } };
    const html = ctx.renderInterceptTabContent('raw');
    assert.ok(html.includes('<textarea'));
    assert.ok(html.includes('claude-opus-4-6'));
  });
  it('renders a placeholder when there is no system prompt', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { messages: [] } };
    const html = ctx.renderInterceptTabContent('system');
    assert.ok(html.includes('<textarea'));
  });
  it('renders one checkbox per tool on the "tools" tab', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { tools: [{ name: 'Bash' }, { name: 'Read', _enabled: false }] } };
    const html = ctx.renderInterceptTabContent('tools');
    assert.ok(html.includes('Bash'));
    assert.ok(html.includes('Read'));
    // Bash defaults to enabled (checked), Read was explicitly disabled
    assert.match(html, /id="ie-tool-0" checked/);
    assert.doesNotMatch(html, /id="ie-tool-1" checked/);
  });
  it('renders "No tools" when the tools array is empty', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { tools: [] } };
    assert.ok(ctx.renderInterceptTabContent('tools').includes('No tools'));
  });
  it('renders one row per message on the "messages" tab, newest first', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello there' }] } };
    const html = ctx.renderInterceptTabContent('messages');
    // index 1 (assistant) should appear before index 0 (user) — reverse order
    assert.ok(html.indexOf('data-msg-idx="1"') < html.indexOf('data-msg-idx="0"'));
  });
});

describe('intercept-ui: onInterceptMsgEdit / onInterceptSystemEdit / onInterceptRawEdit', () => {
  it('onInterceptMsgEdit parses valid JSON content', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { messages: [{ content: 'old' }] } };
    ctx.onInterceptMsgEdit(0, { value: '{"a":1}' });
    // JSON.parse ran inside the vm context, so the result isn't reference-equal to a
    // literal built in this realm (different Object.prototype) — compare via JSON.
    assert.equal(JSON.stringify(ctx.currentPending.body.messages[0].content), JSON.stringify({ a: 1 }));
  });
  it('onInterceptMsgEdit falls back to the raw string on invalid JSON', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { messages: [{ content: 'old' }] } };
    ctx.onInterceptMsgEdit(0, { value: 'not json' });
    assert.equal(ctx.currentPending.body.messages[0].content, 'not json');
  });
  it('onInterceptMsgEdit is a no-op when there is no pending request', () => {
    const ctx = loadContext();
    ctx.currentPending = null;
    assert.doesNotThrow(() => ctx.onInterceptMsgEdit(0, { value: 'x' }));
  });
  it('onInterceptSystemEdit parses/falls back the same way for body.system', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: {} };
    ctx.onInterceptSystemEdit({ value: '"a system prompt"' });
    assert.equal(ctx.currentPending.body.system, 'a system prompt');
    ctx.onInterceptSystemEdit({ value: 'plain text' });
    assert.equal(ctx.currentPending.body.system, 'plain text');
  });
  it('onInterceptRawEdit replaces the whole body on valid JSON, ignores invalid JSON', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { model: 'old-model' } };
    ctx.onInterceptRawEdit({ value: '{"model":"new-model"}' });
    assert.equal(JSON.stringify(ctx.currentPending.body), JSON.stringify({ model: 'new-model' }));
    ctx.onInterceptRawEdit({ value: 'not json' });
    assert.equal(JSON.stringify(ctx.currentPending.body), JSON.stringify({ model: 'new-model' }));
  });
});

describe('intercept-ui: onInterceptToolToggle / onInterceptModelChange', () => {
  it('disabling a tool sets _enabled to false', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { tools: [{ name: 'Bash' }] } };
    ctx.onInterceptToolToggle(0, false);
    assert.equal(ctx.currentPending.body.tools[0]._enabled, false);
  });
  it('re-enabling a tool removes the _enabled marker entirely', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { tools: [{ name: 'Bash', _enabled: false }] } };
    ctx.onInterceptToolToggle(0, true);
    assert.equal('_enabled' in ctx.currentPending.body.tools[0], false);
  });
  it('onInterceptModelChange overwrites body.model', () => {
    const ctx = loadContext();
    ctx.currentPending = { body: { model: 'claude-opus-4-6' } };
    ctx.onInterceptModelChange('claude-haiku-4-5');
    assert.equal(ctx.currentPending.body.model, 'claude-haiku-4-5');
  });
});

describe('intercept-ui: approveIntercept() override filters disabled tools before sending', () => {
  it('strips tools marked _enabled:false and clears the marker on the rest', async () => {
    const ctx = loadContext();
    let sentBody = null;
    ctx.fetch = (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    ctx.currentPending = {
      requestId: 'req-1',
      body: { tools: [{ name: 'Bash', _enabled: false }, { name: 'Read' }, { name: 'Write', _enabled: true }] },
    };
    ctx.approveIntercept();
    assert.deepEqual(ctx.currentPending.body.tools.map(t => t.name), ['Read', 'Write']);
    assert.ok(ctx.currentPending.body.tools.every(t => !('_enabled' in t)));
    assert.deepEqual(sentBody.body.tools.map(t => t.name), ['Read', 'Write']);
  });
});
