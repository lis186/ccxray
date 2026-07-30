'use strict';

// #339: sessionCtxWindow folds a per-session context% denominator so all turns of one
// session render against ONE window (no 1M/200K sawtooth). Classification keeps raw
// per-turn maxContext — this fold is display-only. See
// docs/decisions/0013-beta1m-persist-session-window-derive.md

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'public');

function loadCtx(includeEntryRendering) {
  function el() {
    return {
      style: {}, dataset: {}, innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, insertBefore() {},
      insertAdjacentHTML() {},
      querySelector: () => el(), querySelectorAll: () => [],
      remove() {},
    };
  }
  const context = {
    console, window: {},
    document: {
      getElementById: () => el(), createElement: () => el(),
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(),
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  // Deliberately DO NOT define DEFAULT_MAX_CTX (app.js is not loaded) — this harness also
  // proves sessionCtxWindow's guard: the win===0 fallback must not throw a ReferenceError.
  vm.runInContext(`
    function updateSysPromptBadge() {}
    function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; }
    function setInterval() { return 0; }
    function clearInterval() {}
    window.ccxraySettings = { visibleProviders: [] };
    function _apiQ(url) { return url; }
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  const scripts = ['session-label.js', 'format.js', 'weather.js', 'miller-columns.js'];
  if (includeEntryRendering) scripts.push('entry-rendering.js');
  for (const f of scripts) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  // Bridge the const/let declarations (they don't attach to the context global) for test access.
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.sessionCtxWindow = sessionCtxWindow;
    this.turnCtxWindow = turnCtxWindow;
    ${includeEntryRendering ? 'this.recomputeSessionStats = recomputeSessionStats;' : ''}
  `, context);
  return context;
}

function seed(ctx, turns) {
  ctx.allEntries.length = 0;
  for (const t of turns) ctx.allEntries.push(t);
}

describe('#339 sessionCtxWindow — per-session context% denominator fold', () => {
  let ctx;
  beforeEach(() => { ctx = loadCtx(); });

  it('mixed-signal session: turn0 beta1m/1M, turns1-3 200K → all fold to ONE window (1M)', () => {
    // The exact #339 bug shape: the beta1m header is not echoed on every turn, so raw
    // per-turn maxContext is [1M, 200K, 200K, 200K] — the sawtooth. The fold collapses it.
    seed(ctx, [
      { sessionId: 's1', isSubagent: false, beta1m: true,  maxContext: 1000000 },
      { sessionId: 's1', isSubagent: false, beta1m: false, maxContext: 200000 },
      { sessionId: 's1', isSubagent: false, beta1m: false, maxContext: 200000 },
      { sessionId: 's1', isSubagent: false, beta1m: false, maxContext: 200000 },
    ]);
    // Raw per-turn windows are mixed (the bug): 2 distinct values.
    const rawWindows = new Set(ctx.allEntries.map(e => e.maxContext));
    assert.equal(rawWindows.size, 2, 'raw per-turn maxContext is mixed (bug present in the data)');
    // The fold returns one consistent window for every turn of the session.
    assert.equal(ctx.sessionCtxWindow('s1'), 1000000);
  });

  it('legacy heal (no beta1m persisted): a lone 1M fossil promotes the whole session', () => {
    // Legacy turns predate beta1m persistence. One turn whose usage crossed 200K carries a
    // 1M maxContext fossil; the fold uses it so the session still reads 1M.
    seed(ctx, [
      { sessionId: 's2', isSubagent: false, maxContext: 200000 },
      { sessionId: 's2', isSubagent: false, maxContext: 1000000 },
      { sessionId: 's2', isSubagent: false, maxContext: 200000 },
    ]);
    assert.equal(ctx.sessionCtxWindow('s2'), 1000000);
  });

  it('#377 truncated entries: server session fold promotes a surviving 200K turn to 1M', () => {
    seed(ctx, [
      { sessionId: 'trimmed', isSubagent: false, maxContext: 200000 },
    ]);
    ctx.sessionsMap.set('trimmed', { beta1m: true, maxContext: 1000000 });

    assert.equal(ctx.sessionCtxWindow('trimmed'), 1000000);
  });

  it('#211 over-latch guard: a true 200K session with no 1M signal stays 200K', () => {
    seed(ctx, [
      { sessionId: 's3', isSubagent: false, beta1m: false, maxContext: 200000 },
      { sessionId: 's3', isSubagent: false, beta1m: false, maxContext: 200000 },
    ]);
    assert.equal(ctx.sessionCtxWindow('s3'), 200000);
  });

  it('subagents are excluded: a subagent beta1m turn does not promote the main window', () => {
    seed(ctx, [
      { sessionId: 's4', isSubagent: false, beta1m: false, maxContext: 200000 },
      { sessionId: 's4', isSubagent: true,  beta1m: true,  maxContext: 1000000 },
    ]);
    assert.equal(ctx.sessionCtxWindow('s4'), 200000);
  });

  it('guard does not throw when DEFAULT_MAX_CTX is absent and there is no main turn (win===0)', () => {
    seed(ctx, [{ sessionId: 's5', isSubagent: true, maxContext: 1000000 }]);
    assert.equal(ctx.sessionCtxWindow('s5'), 200000); // typeof guard → literal 200000 fallback
  });
});

describe('#339 turnCtxWindow — per-turn minimap denominator (main=session, subagent=own conv)', () => {
  let ctx;
  beforeEach(() => { ctx = loadCtx(); });

  it('a main turn delegates to the session window (folds to 1M)', () => {
    seed(ctx, [
      { sessionId: 'm1', isSubagent: false, beta1m: true, maxContext: 1000000 },
      { sessionId: 'm1', isSubagent: false, maxContext: 200000, convId: 'cA' },
    ]);
    const mainTurn = ctx.allEntries[1];
    assert.equal(ctx.turnCtxWindow(mainTurn), 1000000, 'main turn uses the 1M session fold, not its own 200K');
  });

  it('a subagent uses its OWN conversation window, not the session 1M (#211 guard, one level down)', () => {
    // A 200K haiku subagent inside a 1M-capable session must stay 200K.
    seed(ctx, [
      { sessionId: 's', isSubagent: false, beta1m: true, maxContext: 1000000 },      // main is 1M
      { sessionId: 's', isSubagent: true, convId: 'sub1', maxContext: 200000 },        // subagent turn A
      { sessionId: 's', isSubagent: true, convId: 'sub1', maxContext: 200000 },        // subagent turn B (same conv)
    ]);
    const subTurn = ctx.allEntries[1];
    assert.equal(ctx.turnCtxWindow(subTurn), 200000, 'subagent stays 200K despite the 1M main session');
  });

  it('a subagent conversation that itself ran 1M folds to 1M across its turns', () => {
    seed(ctx, [
      { sessionId: 's', isSubagent: true, convId: 'sub2', beta1m: true, maxContext: 1000000 },
      { sessionId: 's', isSubagent: true, convId: 'sub2', maxContext: 200000 }, // no beta1m, but same conv ran 1M
    ]);
    const later = ctx.allEntries[1];
    assert.equal(ctx.turnCtxWindow(later), 1000000, 'the 200K turn folds up to the conv 1M window');
  });

  it('a subagent with no convId falls back to its own maxContext', () => {
    seed(ctx, [{ sessionId: 's', isSubagent: true, maxContext: 200000 }]);
    assert.equal(ctx.turnCtxWindow(ctx.allEntries[0]), 200000);
  });

  it('does NOT promote across sessions that share an 8-char convId hash (codex round 3)', () => {
    // Two unrelated sessions opened with the same subagent prompt → identical convId hash.
    // The 1M subagent in session X must not promote session Y's 200K subagent.
    seed(ctx, [
      { sessionId: 'sX', isSubagent: true, convId: 'dup8', beta1m: true, maxContext: 1000000 },
      { sessionId: 'sY', isSubagent: true, convId: 'dup8', maxContext: 200000 },
    ]);
    assert.equal(ctx.turnCtxWindow(ctx.allEntries[1]), 200000, "session Y's subagent stays 200K, not promoted by session X");
  });
});

describe('#377 recomputeSessionStats — truncated client weather uses the server session fold', () => {
  it('keeps a 180K surviving turn sunny when the complete session ran with a 1M window', () => {
    const ctx = loadCtx(true);
    const sid = 'trimmed-weather';
    seed(ctx, [{
      id: 'survivor',
      sessionId: sid,
      isSubagent: false,
      isRetry: false,
      model: 'claude-opus-4-6',
      elapsed: '?',
      stopReason: 'end_turn',
      maxContext: 200000,
      usage: {
        input_tokens: 180000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      toolCalls: {},
    }]);
    const sess = { beta1m: true, maxContext: 1000000 };
    ctx.sessionsMap.set(sid, sess);

    ctx.recomputeSessionStats(sid);

    assert.equal(sess.weather.level, 'sunny');
  });
});
