'use strict';

// #230 / ADR 0009 — entry-rendering.js side of the sequential-interleave
// contract (ADR 0005: the turn list and the swimlane must classify the same
// turn identically). Harness mirrors test/retry-grouping.test.js, plus
// workflow-timeline.js loaded FIRST (same order as public/index.html) so the
// shared tracker (wfCreateSeqTracker) is available to addEntry.

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
  `, context);
  for (const f of ['format.js', 'session-label.js', 'workflow-timeline.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.selectedSessionId = null;
    _loading = true;
  `, context);
  return context;
}

const SID = 'seq_sess';
let _autoId = 0;

// Real shape (86949194 / 4b15c248): fork and teammate turns carry the
// authoritative 'orchestrator' agentKey — never agentKey:null (the Batch 11
// fake-fixture trap).
function mkTurn(at, elapsed, conv, msg, overrides) {
  _autoId++;
  return Object.assign({
    id: 'e' + String(_autoId).padStart(3, '0'), ts: '10:00:00',
    sessionId: SID, model: 'claude-opus-4-6', provider: 'anthropic',
    status: 200, elapsed: String(elapsed), method: 'POST',
    usage: { input_tokens: 30000, output_tokens: 500, cache_read_input_tokens: 15000, cache_creation_input_tokens: 5000 },
    maxContext: 200000, isSubagent: false, sessionInferred: false,
    toolCalls: {}, title: 'turn', receivedAt: String(at),
    agentKey: 'orchestrator', agentLabel: 'Orchestrator',
    convId: conv, msgCount: msg,
  }, overrides || {});
}

describe('#230 entry-rendering sequential interleave (ADR 0005/0009)', () => {
  it('R1: A-B-A teammate run retro-flips to subagent and renumbers the session', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 10));
    ctx.addEntry(mkTurn(7000, 5, 'convA', 12));
    ctx.addEntry(mkTurn(13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }));
    ctx.addEntry(mkTurn(19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }));
    // provisional: foreign conv counts as main until the trunk returns
    assert.equal(ctx.sessionsMap.get(SID).mainCount, 4);
    ctx.addEntry(mkTurn(25000, 5, 'convA', 14));
    const sess = ctx.sessionsMap.get(SID);
    assert.equal(sess.mainCount, 3, 'B run no longer counted as main');
    assert.equal(sess.subCount, 2);
    assert.equal(ctx.allEntries.map(e => e.displayNum).join(','), '1,2,s1,s2,3');
    assert.equal(ctx.allEntries.map(e => e.isSubagent).join(','), 'false,false,true,true,false');
  });

  it('R2: sequential fork dip flips immediately when a split-out frontier exists (fail-on-old)', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 53));
    ctx.addEntry(mkTurn(10000, 60, 'convA', 55));  // long main turn 10000..70000
    ctx.addEntry(mkTurn(20000, 5, 'convA', 51));   // starts inside → overlap → subagent (frontier)
    assert.equal(ctx.allEntries[2].isSubagent, true, 'precondition: overlap split the concurrent fork turn');
    ctx.addEntry(mkTurn(71000, 5, 'convA', 51));   // sequential continuation — overlap-blind
    assert.equal(ctx.allEntries[3].isSubagent, true, 'dip with frontier must flip before numbering');
    assert.equal(ctx.allEntries[3].displayNum, 's2');
    ctx.addEntry(mkTurn(80000, 5, 'convA', 57));
    assert.equal(ctx.allEntries[4].displayNum, '3');
    assert.equal(ctx.sessionsMap.get(SID).mainCount, 3);
  });

  it('rewind: same-conv dip with no frontier stays main (7e1d9272 540→493 shape)', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 540));
    ctx.addEntry(mkTurn(7000, 5, 'convA', 493));
    ctx.addEntry(mkTurn(13000, 5, 'convA', 495));
    assert.equal(ctx.allEntries.map(e => e.isSubagent).join(','), 'false,false,false');
    assert.equal(ctx.sessionsMap.get(SID).mainCount, 3);
  });

  it('compaction: conv advance that never returns stays main (no retro)', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 100));
    ctx.addEntry(mkTurn(7000, 5, 'convA', 102));
    ctx.addEntry(mkTurn(13000, 5, 'convB', 10));
    ctx.addEntry(mkTurn(19000, 5, 'convB', 12));
    assert.equal(ctx.allEntries.map(e => e.isSubagent).join(','), 'false,false,false,false');
    assert.equal(ctx.sessionsMap.get(SID).mainCount, 4);
  });

  it('AC5: turn-list classification matches wfInferLanes lane placement on the same entries', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 10));
    ctx.addEntry(mkTurn(7000, 5, 'convA', 12));
    ctx.addEntry(mkTurn(13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }));
    ctx.addEntry(mkTurn(19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }));
    ctx.addEntry(mkTurn(25000, 60, 'convA', 14));  // long turn 25000..85000
    ctx.addEntry(mkTurn(30000, 5, 'convA', 13));   // overlaps → subagent + frontier
    ctx.addEntry(mkTurn(86000, 5, 'convA', 13));   // sequential fork dip
    ctx.addEntry(mkTurn(90000, 5, 'convA', 16));
    const sessEntries = ctx.allEntries.filter(e => e.sessionId === SID);
    const lanes = ctx.wfInferLanes(sessEntries, []);
    const mainIds = new Set(lanes[0].turns.map(t => t.id));
    for (const en of sessEntries) {
      assert.equal(!en.isSubagent, mainIds.has(en.id),
        'entry ' + en.id + ': turn list says isSubagent=' + en.isSubagent +
        ' but swimlane says ' + (mainIds.has(en.id) ? 'main' : 'sub-lane'));
    }
  });
});

describe('#230 codex P2: entry-rendering arrival-order independence', () => {
  it('early-arriving nested foreign conv is retro-flipped when the real trunk returns (fail-on-old)', () => {
    const ctx = loadDashboardContext();
    // completion order: nested teammate turn b1 arrives before the long a1
    ctx.addEntry(mkTurn(13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }));  // b1: 13000..18000
    ctx.addEntry(mkTurn(1000, 60, 'convA', 10));                               // a1: 1000..61000, arrives second
    ctx.addEntry(mkTurn(62000, 5, 'convA', 12));                               // a2 → trunk A returns
    assert.equal(ctx.allEntries.map(e => e.isSubagent).join(','), 'true,false,false',
      'the first-arrived foreign-conv turn must not poison the trunk');
    assert.equal(ctx.allEntries.map(e => e.displayNum).join(','), 's1,1,2');
    const sess = ctx.sessionsMap.get(SID);
    assert.equal(sess.mainCount, 2);
    assert.equal(sess.subCount, 1);
  });
});

describe('#230 codex P2 round 6: reordered arrival recomputes the turn list seq layer', () => {
  it('overturned closed excursion flips back to main; displayNums match batch classification (fail-on-old)', () => {
    const ctx = loadDashboardContext();
    // completion order: A1, B1, A2 close the B bracket (B1 → s1), then B0 —
    // same conv as B1, starts earliest, spans A1 — arrives last
    ctx.addEntry(mkTurn(130000, 5, 'convA', 10));   // A1
    ctx.addEntry(mkTurn(140000, 5, 'convB', 12));   // B1
    ctx.addEntry(mkTurn(150000, 5, 'convA', 12));   // A2 → bracket closes
    assert.equal(ctx.allEntries[1].isSubagent, true, 'precondition: B1 retro-flipped by A-B-A');
    assert.equal(ctx.allEntries[1].displayNum, 's1');
    ctx.addEntry(mkTurn(1000, 136, 'convB', 8));    // B0: 1000..137000, reordered arrival
    // chronological truth B0-A1-B1-A2: trunk = conv B, A1 is the excursion,
    // B1 flips BACK to main, A2 stays main (trunk-advance pending tail)
    assert.equal(ctx.allEntries.map(e => e.isSubagent).join(','), 'true,false,false,false');
    assert.equal(ctx.allEntries.map(e => e.displayNum).join(','), 's1,1,2,3');
    const sess = ctx.sessionsMap.get(SID);
    assert.equal(sess.mainCount, 3);
    assert.equal(sess.subCount, 1);
    // AC5: the turn list and the swimlane agree on every turn
    const sessEntries = ctx.allEntries.filter(e => e.sessionId === SID);
    const lanes = ctx.wfInferLanes(sessEntries, []);
    const mainIds = new Set(lanes[0].turns.map(t => t.id));
    for (const en of sessEntries) {
      assert.equal(!en.isSubagent, mainIds.has(en.id),
        'entry ' + en.id + ': turn list isSubagent=' + en.isSubagent +
        ' vs swimlane ' + (mainIds.has(en.id) ? 'main' : 'sub-lane'));
    }
  });

  // #236 live retry parity: a retry arriving while the timeline is open must
  // reach wfAddEntry (entry-rendering.js dropped its !isRetry gate on the wf
  // dispatch), where the eligibility gate fault-marks it — matching a refresh
  // (batch wfInferLanes). The SEPARATE seq-tracker feed stays !isRetry-gated.
  it('#236: a retry arriving live is routed to the main fault track via addEntry', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(mkTurn(1000, 5, 'convA', 10));           // establishes the session
    vm.runInContext('selectedSessionId = ' + JSON.stringify(SID), ctx);
    ctx.wfState = ctx.wfBuildState(SID);                  // open the timeline on this session
    // a retry: non-2xx, no output → addEntry computes isRetry=true
    ctx.addEntry(mkTurn(6000, 3, 'convA', 10, { id: 'rLive', status: 500, usage: null }));
    const rEntry = ctx.allEntries.find(e => e.id === 'rLive');
    assert.equal(rEntry.isRetry, true, 'precondition: the entry classified as a retry');
    const faults = (ctx.wfState.lanes[0].faultEntries || []).map(f => f.id);
    assert.ok(faults.indexOf('rLive') !== -1, 'live retry fault-marked by wfAddEntry (parity with batch)');
    const inLane = ctx.wfState.lanes.some(l => l.turns.some(t => t.id === 'rLive'));
    assert.equal(inLane, false, 'retry is never placed in a lane');
    // seq tracker must NOT have seen the retry (its feed stays !isRetry-gated)
    assert.equal(ctx.sessionsMap.get(SID).retryCount, 1, 'retry counted as a retry, not a main/sub turn');
    assert.equal(ctx.sessionsMap.get(SID).mainCount, 1, 'retry did not inflate mainCount');
  });
});
