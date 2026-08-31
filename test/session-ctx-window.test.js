'use strict';

// #339: sessionCtxWindow folds a per-session context% denominator so all turns of one
// session render against ONE window (no 1M/200K sawtooth). Classification keeps raw
// per-turn maxContext — this fold is display-only. See
// docs/decisions/0013-beta1m-persist-session-window-derive.md

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { missionControlSnapshot, sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
const { normalizeIndexEntry } = require('../server/routes/api');

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
    console, window: { addEventListener() {} },
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
  const scripts = ['session-label.js', 'format.js', 'weather.js'];
  if (includeEntryRendering) scripts.push('agent-classification.js', 'workflow-timeline.js');
  scripts.push('miller-columns.js');
  if (includeEntryRendering) scripts.push('entry-rendering.js');
  for (const f of scripts) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  // Bridge the const/let declarations (they don't attach to the context global) for test access.
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.sessionCtxWindow = sessionCtxWindow;
    this.sessionCtxWindowSource = sessionCtxWindowSource;
    this.ctxWindowUnverified = ctxWindowUnverified;
    this.turnCtxWindow = turnCtxWindow;
    this.renderSessionItem = renderSessionItem;
    ${includeEntryRendering ? `
      this.mergeColdSessions = mergeColdSessions;
      this.recomputeSessionStats = recomputeSessionStats;
      this.addEntry = addEntry;
      this.wfInferLanes = wfInferLanes;
      this._wfLaneWindow = _wfLaneWindow;
      this._wfLaneWindowSource = _wfLaneWindowSource;
    ` : ''}
  `, context);
  return context;
}

function seed(ctx, turns) {
  ctx.allEntries.length = 0;
  for (const t of turns) ctx.allEntries.push(t);
}

function weatherTurn(sid) {
  return {
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
  };
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

describe('#603 imported 1M facts survive the cold-load entry pipeline', () => {
  it('normalizes through summarizeEntry, copies through addEntry, then gives the swimlane an unverified 1M', () => {
    const ctx = loadCtx(true);
    const cold = normalizeIndexEntry({
      id: 'cold-imported-1m', sessionId: 'cold-imported-session',
      provider: 'anthropic', model: 'claude-opus-4-6', isSubagent: false,
      receivedAt: 1000, elapsed: '1', status: 200,
      usage: { input_tokens: 170000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      maxContext: 200000, imported1mCostState: true, imported1mSettings: true,
    });

    assert.equal(cold.imported1mCostState, true, 'cold summary keeps the transcript cost-state fact');
    assert.equal(cold.imported1mSettings, true, 'cold summary keeps the settings fact');

    ctx.addEntry(cold);
    const rendered = ctx.allEntries[0];
    assert.equal(rendered.imported1mCostState, true, 'addEntry keeps cost-state evidence for the client');
    assert.equal(rendered.imported1mSettings, true, 'addEntry keeps settings evidence for the client');

    const lane = ctx.wfInferLanes(ctx.allEntries, [])[0];
    ctx.wfState = { lanes: [lane] };
    assert.equal(ctx._wfLaneWindow(lane), 1000000, 'the swimlane display fold widens to 1M');
    assert.equal(ctx._wfLaneWindowSource(lane), 'imported', 'the swimlane retains the unverified ? provenance');
  });

  it('keeps the imported 1M display + marker, but styles a session card from its verified 200K window', () => {
    const ctx = loadCtx();
    const sid = 'imported-card-attention';
    seed(ctx, [{
      sessionId: sid, isSubagent: false, maxContext: 200000,
      imported1mSettings: true,
    }]);
    ctx.sessionsMap.set(sid, {
      model: 'claude-opus-4-6', count: 1, retryCount: 0, totalCost: 0,
      latestMainCtxUsed: 170000, lastReceivedAt: Date.now(),
    });

    const html = ctx.renderSessionItem(ctx.sessionsMap.get(sid), sid, { title: '' });

    assert.match(html, /ctx-alert ctx-alert-red/, '170K / verified 200K reaches the red threshold');
    assert.match(html, /si-ctx-bar over-compact/, 'the compact line uses the verified 85%');
    assert.match(html, />17% <span style="color:var\(--dim\)">of 1M\?<\/span>/,
      'the displayed percentage keeps the imported 1M denominator and its ? marker');
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
  it('cold session: mergeColdSessions creates the 1M server fold and keeps a 180K turn sunny', () => {
    const ctx = loadCtx(true);
    const sid = 'cold-weather';
    seed(ctx, [weatherTurn(sid)]);

    assert.equal(ctx.sessionsMap.has(sid), false, 'exercise the cold-session creation branch');
    ctx.mergeColdSessions([{ sid, beta1m: true, maxContext: 1000000, weather: { level: 'rainy' } }]);

    assert.equal(ctx.sessionCtxWindow(sid), 1000000);
    assert.equal(ctx.sessionsMap.get(sid).weather.level, 'rainy', 'cold sessions keep server stats');
    ctx.recomputeSessionStats(sid);

    assert.equal(ctx.sessionsMap.get(sid).weather.level, 'sunny');
  });

  it('hot truncated session: widening the server fold immediately recomputes rainy weather', () => {
    const ctx = loadCtx(true);
    const sid = 'hot-weather';
    seed(ctx, [weatherTurn(sid)]);
    ctx.sessionsMap.set(sid, { _cold: false, beta1m: false, maxContext: 200000 });
    ctx.recomputeSessionStats(sid);

    assert.equal(ctx.sessionsMap.get(sid).weather.level, 'rainy');
    ctx.mergeColdSessions([{ sid, beta1m: true, maxContext: 1000000 }]);

    assert.equal(ctx.sessionCtxWindow(sid), 1000000);
    assert.equal(ctx.sessionsMap.get(sid).weather.level, 'sunny');
  });

  it('#603 keeps hot-session weather on the observed window when display has only an imported 1M hint', () => {
    const ctx = loadCtx(true);
    const sid = 'hot-imported-weather';
    seed(ctx, [{ ...weatherTurn(sid), imported1mSettings: true }]);
    ctx.sessionsMap.set(sid, { _cold: false, beta1m: false, maxContext: 200000 });

    assert.equal(ctx.sessionCtxWindow(sid), 1000000, 'display still widens to the imported 1M tier');
    ctx.recomputeSessionStats(sid);

    assert.equal(ctx.sessionsMap.get(sid).weather.level, 'rainy',
      'the imported display hint cannot suppress hot-session weather');
  });

  it('#603 re-renders a hot session card when its imported window fact arrives', () => {
    const ctx = loadCtx(true);
    const sid = 'hot-imported-card';
    const sess = {
      _cold: false, beta1m: false, maxContext: 200000,
      model: 'claude-opus-4-6', count: 1, retryCount: 0, totalCost: 0,
      latestMainCtxUsed: 170000, lastReceivedAt: Date.now(),
    };
    ctx.sessionsMap.set(sid, sess);

    const card = { title: '', renders: 0, html: '' };
    Object.defineProperty(card, 'innerHTML', {
      set(html) { this.renders++; this.html = html; },
    });
    ctx.document.getElementById = (id) => id === 'sess-' + sid.slice(0, 8) ? card : null;

    ctx.mergeColdSessions([{ sid, imported1mSettings: true }]);

    assert.equal(sess.imported1mSettings, true, 'the aggregate retains the monotone imported fact');
    assert.equal(card.renders, 1, 'the already-visible hot card is redrawn');
    assert.match(card.html, />17% <span style="color:var\(--dim\)">of 1M\?<\/span>/,
      'the redraw exposes the newly imported display window');
  });

  it('hot session merge is monotone: a smaller server fold cannot narrow an existing 1M window', () => {
    const ctx = loadCtx(true);
    const sid = 'hot-monotone';
    const weather = { level: 'rainy' };
    const sess = { _cold: false, beta1m: true, maxContext: 1000000, weather };
    ctx.sessionsMap.set(sid, sess);

    ctx.mergeColdSessions([{ sid, beta1m: false, maxContext: 200000 }]);

    assert.equal(sess.beta1m, true);
    assert.equal(sess.maxContext, 1000000);
    assert.equal(sess.weather, weather, 'an unchanged window does not trigger recomputation');
  });
});

// A window is either measured or assumed, and the display cannot tell the
// difference from the number alone: 200K with no evidence and 200K proven by a
// declaration render identically, while only the first makes its percentage an
// assumption too. See ADR 0013 — derived at render time, never stored.
describe('sessionCtxWindowSource — measured vs assumed denominator', () => {
  let ctx;
  beforeEach(() => { ctx = loadCtx(false); });

  const turn = (over) => ({
    sessionId: 's1', isSubagent: false, maxContext: 200000,
    usage: { input_tokens: over ? 260000 : 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  it('reports default when nothing proves the window', () => {
    ctx.allEntries.push(turn(false));
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'default');
    assert.equal(ctx.sessionCtxWindow('s1'), 200000);
  });

  it('reports declared only when the declaration resolved the window', () => {
    ctx.allEntries.push({ ...turn(false), beta1m: true, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'declared');
  });

  it('#603 folds positive imported declarations to 1M but keeps their provenance unverified', () => {
    ctx.allEntries.push({ ...turn(false), imported1mCostState: true });
    assert.equal(ctx.sessionCtxWindow('s1'), 1000000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'imported');
    assert.equal(ctx.ctxWindowUnverified('s1'), true, 'an imported declaration does not grant alarm authority');
  });

  it('#603 gives dashboard, Sidebar, and Mission Control one imported aggregate fixture', () => {
    const sid = 'imported-parity';
    const nowMs = Date.parse('2026-08-31T12:00:00.000Z');
    const entry = {
      id: 'imported-parity-turn', sessionId: sid, model: 'claude-fable-5',
      agentKey: 'orchestrator', isSubagent: false, imported: true,
      receivedAt: nowMs - 1000, maxContext: 200000,
      usage: { input_tokens: 192182, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    // The fact lives only in the aggregate, the #588 cold-session shape.
    const aggregate = { sid, maxContext: 200000, imported1mSettings: true };
    ctx.allEntries.push(entry);
    ctx.sessionsMap.set(sid, aggregate);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-603-parity-'));
    const roots = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-603-no-transcripts-'));
    try {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify(entry) + '\n');
      fs.writeFileSync(path.join(home, 'logs', 'sessions.json'), JSON.stringify(aggregate) + '\n');
      const env = { ...process.env, CCXRAY_HOME: home, CCXRAY_IMPORT_HOMES: roots, CCXRAY_IMPORT_CODEX_HOMES: roots };
      for (const key of Object.keys(env)) {
        if (key.startsWith('HERDR_')) delete env[key];
      }

      const sidebar = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
        env, sessionId: sid, nowMs, allowRepair: false, sidebarCols: 40,
      });
      const row = missionControlSnapshot({
        env, entries: [entry], nowMs, agentReport: { ok: true, agents: [] },
      }).rows[0];

      assert.equal(ctx.sessionCtxWindow(sid), 1000000);
      assert.equal(ctx.sessionCtxWindowSource(sid), 'imported');
      assert.equal(Math.round(sidebar.ctxPct), 19);
      assert.equal(sidebar.ctxWindowSource, 'imported');
      assert.equal(sidebar.ctxWindowMarker, '?');
      assert.equal(Math.round(row.ctxPct), 19);
      assert.equal(row.ctxWindowSource, 'imported');
      assert.equal(row.ctxWindowMarker, '?');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(roots, { recursive: true, force: true });
    }
  });

  it('#603 orders observed and declared evidence above an imported declaration', () => {
    ctx.allEntries.push({ ...turn(false), imported1mSettings: true, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'observed');
    ctx.allEntries.push({ ...turn(false), beta1m: true, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'declared');
  });

  it('#603 lets a 1.5M observed fossil outrank an imported 1M declaration', () => {
    ctx.allEntries.push({ ...turn(false), imported1mCostState: true, maxContext: 200000 });
    ctx.allEntries.push({ ...turn(false), maxContext: 1500000 });
    assert.equal(ctx.sessionCtxWindow('s1'), 1500000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'observed');
  });

  it('a header the gate refused must NOT count as declared (fail-on-old)', () => {
    // The header rides every request on a beta account, including turns whose
    // declaration was refused — a haiku title-gen turn, or the next model the
    // gate does not know yet. If bare presence counted, the marker would go
    // quiet in exactly the case it exists for: an unlisted 1M model rendering
    // its usage against an assumed 200K.
    ctx.allEntries.push({ ...turn(false), ctxBeta: 'context-1m-2025-08-07' });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'default');
  });

  it('a window the session\'s own usage exceeded is contradicted, not merely assumed (fail-on-old)', () => {
    // 260K of context cannot fit the 200K this session is divided by. That is a
    // stronger claim than "unverified": the denominator is known wrong, so the
    // percentage is a floor. Sharing the assumed marker flattened the two.
    ctx.allEntries.push(turn(true));
    assert.equal(ctx.sessionCtxWindow('s1'), 200000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'contradicted');
  });

  it('contradiction is keyed on evidence, not on provenance (fail-on-old)', () => {
    // A declared or fossil-backed window can be exceeded too — by a later turn on
    // a model switch, or by a fossil that under-states the real window. Evidence
    // beats provenance in both directions.
    ctx.allEntries.push({ ...turn(false), beta1m: true, maxContext: 1000000,
      usage: { input_tokens: 1200000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    assert.equal(ctx.sessionCtxWindow('s1'), 1000000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'contradicted');
  });

  it('a turn at exactly the window is not a contradiction', () => {
    ctx.allEntries.push({ ...turn(false),
      usage: { input_tokens: 200000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'default');
  });

  it('a subagent that exceeds the parent window does not contradict it', () => {
    ctx.allEntries.push(turn(false));
    ctx.allEntries.push({ ...turn(true), isSubagent: true });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'default');
  });

  it('reports observed once the window itself reflects the evidence', () => {
    ctx.allEntries.push({ ...turn(true), maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindow('s1'), 1000000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'observed');
  });

  it('a model-specific window below the default is measured, not assumed (fail-on-old)', () => {
    // A 128K fossil is a real per-model capability; calling it assumed would put a
    // "?" on a number that was derived, not guessed.
    ctx.allEntries.push({ ...turn(false), maxContext: 128000 });
    assert.equal(ctx.sessionCtxWindow('s1'), 128000);
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'observed');
  });

  it('ignores subagent turns, like the window fold does', () => {
    ctx.allEntries.push(turn(false));
    ctx.allEntries.push({ ...turn(true), isSubagent: true, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s1'), 'default');
  });

  it('reports contradicted from the fold when the overflowing turn is gone (fail-on-old)', () => {
    // The card divides `latestMainCtxUsed` from the server fold, not the entries the
    // client happens to hold. With the overflowing turn evicted (or a cold-load row
    // that carries no usage), an entry scan alone reported a resolved window for a
    // ratio already over 100%.
    ctx.sessionsMap.set('s4', { latestMainCtxUsed: 260000, maxContext: 200000, beta1m: false });
    assert.equal(ctx.sessionCtxWindow('s4'), 200000);
    assert.equal(ctx.sessionCtxWindowSource('s4'), 'contradicted');
    // …and it outranks a declaration carried by that same fold.
    ctx.sessionsMap.set('s5', { latestMainCtxUsed: 1200000, maxContext: 1000000, beta1m: true });
    assert.equal(ctx.sessionCtxWindowSource('s5'), 'contradicted');
  });

  it('ctxWindowUnverified covers every state that must not read as resolved', () => {
    ctx.sessionsMap.set('s6', { latestMainCtxUsed: 260000, maxContext: 200000, beta1m: false });
    assert.equal(ctx.ctxWindowUnverified('s6'), true, 'contradicted');
    ctx.allEntries.push(turn(false));
    assert.equal(ctx.ctxWindowUnverified('s1'), true, 'default');
    ctx.allEntries.push({ ...turn(false), sessionId: 's7', beta1m: true, maxContext: 1000000 });
    assert.equal(ctx.ctxWindowUnverified('s7'), false, 'declared');
  });

  it('reads the server fold when the client no longer holds the turns', () => {
    ctx.sessionsMap.set('s2', { beta1m: true, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s2'), 'declared');
    ctx.sessionsMap.set('s3', { beta1m: false, maxContext: 1000000 });
    assert.equal(ctx.sessionCtxWindowSource('s3'), 'observed');
  });

  it('#603 reads an imported declaration from the cold session aggregate', () => {
    ctx.sessionsMap.set('s8', { maxContext: 200000, imported1mSettings: true });
    assert.equal(ctx.sessionCtxWindow('s8'), 1000000);
    assert.equal(ctx.sessionCtxWindowSource('s8'), 'imported');
  });
});
