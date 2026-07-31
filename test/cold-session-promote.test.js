'use strict';

// #330 — mergeColdSessions race: the sessions API can resolve before the
// entries batch, so a HOT session is added to sessionsMap with `_cold: true`
// before its own batch entries reach addEntry. Those entries then find the
// session already present, skip the creation block, and (on the buggy code)
// leave `_cold` set forever — a permanent "Loading N turns" spinner.
//
// Fix (Option B, owner-approved): addEntry promotes a `_cold` session to hot
// ONLY while `_loading` (the batch-load window where the race lives). A
// post-load live entry to a genuine cold session is a normal resume whose
// history is still on disk and must stay `_cold`.
//
// Harness mirrors test/seq-interleave-rendering.test.js (same script load order
// as public/index.html so addEntry's cross-file globals resolve).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDashboardContext() {
  const publicDir = path.join(__dirname, '..', 'public');
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
    console, window: { innerHeight: 800, addEventListener() {} },
    document: {
      getElementById: () => el(), createElement: () => el(),
      createElementNS: () => el(),
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(), documentElement: {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Set, Map,
  };
  vm.createContext(context);
  vm.runInContext(`
    function updateSysPromptBadge() {}
    function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; }
    function setInterval() { return 0; }
    function clearInterval() {}
    window.ccxraySettings = { visibleProviders: [] };
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
    function _apiQ(u) { return u; }
  `, context);
  for (const f of ['format.js', 'session-label.js', 'agent-classification.js', 'workflow-timeline.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.selectedSessionId = null;
    _loading = true;
    _batchRestoring = true;
  `, context);
  return context;
}

function setLoading(ctx, v) { vm.runInContext('_loading = ' + (v ? 'true' : 'false') + ';', ctx); }
function setBatchRestoring(ctx, v) { vm.runInContext('_batchRestoring = ' + (v ? 'true' : 'false') + ';', ctx); }

// A session index row as /_api/sessions serves it (what mergeColdSessions eats).
function coldRow(sid, over) {
  return Object.assign({
    sid, count: 5, firstId: sid + '_first', lastId: sid + '_last',
    model: 'claude-opus-4-6', cwd: '/proj', title: null, provider: 'anthropic', agent: 'claude',
    lastReceivedAt: 1000,
  }, over || {});
}

let _autoId = 0;
function mkTurn(sid, over) {
  _autoId++;
  return Object.assign({
    id: 'e' + String(_autoId).padStart(3, '0'), ts: '2026-07-25T10-00-00-000',
    sessionId: sid, model: 'claude-opus-4-6', provider: 'anthropic',
    status: 200, elapsed: '5', method: 'POST',
    usage: { input_tokens: 30000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    maxContext: 200000, isSubagent: false, sessionInferred: false,
    toolCalls: {}, title: 'turn', receivedAt: '1000',
    agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: 'convA', msgCount: 10,
  }, over || {});
}

describe('#330 cold→hot session promotion (mergeColdSessions race)', () => {
  // G1 / fail-on-old: the race marks a hot session _cold during _loading; the
  // next batch addEntry must clear it. On the pre-fix code addEntry has no
  // promotion branch, so `_cold` stays true here and this assertion FAILS.
  it('promotes a raced-cold session when a batch entry arrives during _loading', () => {
    const ctx = loadDashboardContext();
    const SID = 'raced_hot';

    // Race: sessions API resolves first → hot session added as _cold.
    ctx.mergeColdSessions([coldRow(SID)]);
    const sess = ctx.sessionsMap.get(SID);
    assert.equal(sess._cold, true, 'setup: mergeColdSessions marks it _cold');
    assert.equal(sess.firstTs, null, 'setup: cold stub has firstTs=null');

    // Its own batch entry finally reaches addEntry (still _loading).
    const turn = mkTurn(SID);
    ctx.addEntry(turn);

    assert.ok(!sess._cold, 'batch entry must clear _cold (G1)');
    // The post-batch recompute skips `_cold` sessions; clearing _cold is what
    // lets it rebuild real stats. Also confirms the one metadata line ran.
    assert.equal(sess.firstTs, turn.ts, 'firstTs healed from the entry');
  });

  // G2 base case: a genuine cold session that never receives an entry stays cold
  // (still lazy-loads its on-disk history on click).
  it('leaves a genuine cold session (no entry) marked _cold (G2)', () => {
    const ctx = loadDashboardContext();
    const SID = 'genuine_cold';
    ctx.mergeColdSessions([coldRow(SID)]);
    assert.equal(ctx.sessionsMap.get(SID)._cold, true, 'no entry → stays _cold');
  });

  // G2 scoping (Option B vs unconditional): a post-load live entry to a genuine
  // cold session is a normal resume — its history is on disk, not in allEntries,
  // so promoting would drop that history from the view. Must stay _cold.
  // The promotion gate runs before any render, so a downstream stub gap in the
  // live path can't affect the decision under test — catch and assert.
  it('does NOT promote a cold session on a post-load live entry (G2)', () => {
    const ctx = loadDashboardContext();
    const SID = 'resumed_cold';
    ctx.mergeColdSessions([coldRow(SID)]);
    assert.equal(ctx.sessionsMap.get(SID)._cold, true, 'setup: cold');

    setBatchRestoring(ctx, false);
    setLoading(ctx, false);
    try { ctx.addEntry(mkTurn(SID)); } catch (_) { /* live render path unstubbed; gate already decided */ }

    assert.equal(ctx.sessionsMap.get(SID)._cold, true, 'post-load live entry must keep _cold (G2)');
  });

  // Codex review P2: SSE live entry arriving during _loading (but outside
  // _batchRestoring) must NOT promote a cold session. This catches the case
  // where a genuine cold session gets a live turn while the initial batch is
  // still loading — _loading is true but _batchRestoring is false between
  // requestAnimationFrame yields or before/after _restoreEntryBatch.
  it('does NOT promote a cold session on an SSE entry during _loading (G2, codex P2)', () => {
    const ctx = loadDashboardContext();
    const SID = 'sse_during_load';
    ctx.mergeColdSessions([coldRow(SID)]);
    assert.equal(ctx.sessionsMap.get(SID)._cold, true, 'setup: cold');

    // _loading=true but _batchRestoring=false simulates an SSE entry arriving
    // between batch chunks or before _restoreEntryBatch starts.
    setBatchRestoring(ctx, false);
    // _loading stays true (default from loadDashboardContext)
    try { ctx.addEntry(mkTurn(SID)); } catch (_) { /* live render path unstubbed */ }

    assert.equal(ctx.sessionsMap.get(SID)._cold, true, 'SSE during _loading must keep _cold (codex P2)');
  });
});
