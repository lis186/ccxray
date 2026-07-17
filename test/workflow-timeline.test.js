'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

// Load workflow-timeline.js in a browser-like global context
function loadWfModule() {
  const formatSrc = fs.readFileSync(require('path').join(__dirname, '../public/format.js'), 'utf8');
  const src = fs.readFileSync(require('path').join(__dirname, '../public/workflow-timeline.js'), 'utf8');
  const ctx = {
    document: { createElement: () => ({ appendChild() {}, style: {}, id: '' }), createElementNS: () => ({ setAttribute() {}, innerHTML: '' }), getElementById: () => null, body: { appendChild() {} }, documentElement: {} },
    window: { innerHeight: 800, addEventListener() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => 1,
    cancelAnimationFrame() {},
    clearTimeout() {},
    setTimeout: (fn) => 1,
    allEntries: [],
    sessionsMap: new Map(),
    colTurns: { clientWidth: 600, appendChild() {}, querySelectorAll: () => [] },
    colSections: { innerHTML: '' },
    colDetail: { innerHTML: '' },
    selectTurn() {},
    isHttpStatusOk: (s) => s === 101 || (s >= 200 && s < 300),
    selectedSessionId: null,
    console,
    Set,
    Map,
  };
  vm.createContext(ctx);
  vm.runInContext(formatSrc, ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

function mkEntry(id, sessionId, model, receivedAt, elapsed, opts) {
  return Object.assign({
    id, sessionId, model, receivedAt, elapsed,
    maxContext: 200000, ctxUsed: 50000,
    usage: { input_tokens: 30000, output_tokens: 5000, cache_read_input_tokens: 15000, cache_creation_input_tokens: 5000 },
    toolCalls: { Bash: 1 }, isSubagent: false, sessionInferred: false,
    status: 200, cost: 0.01, displayNum: 1,
  }, opts || {});
}

describe('workflow-timeline data layer', () => {
  it('loads without errors', () => {
    const ctx = loadWfModule();
    assert.equal(typeof ctx.wfBuildState, 'function');
    assert.equal(typeof ctx.wfInferLanes, 'function');
    assert.equal(typeof ctx.wfAddEntry, 'function');
  });

  it('single model → single main lane', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, {}),
      mkEntry('t3', 's1', 'claude-opus-4-6', 10000, 4, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 3);
  });

  it('isSubagent entries → separate lane by model', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, {}),
      mkEntry('t3', 's1', 'claude-haiku-4-5', 8000, 2, { isSubagent: true }),
      mkEntry('t4', 's1', 'claude-opus-4-6', 11000, 3, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 3);
    assert.equal(lanes[1].name, 'subagent-haiku-4-5');
    assert.equal(lanes[1].turns.length, 1);
  });

  it('model mismatch without isSubagent → orphan lane', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-sonnet-4-6', 6000, 3, {}),
      mkEntry('t3', 's1', 'claude-opus-4-6', 10000, 4, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 2);
    assert.ok(lanes[1].name.includes('sonnet'));
    assert.equal(lanes[1].turns.length, 1);
  });

  it('child session entries → their own lane', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, {}),
    ];
    var childEntries = [
      mkEntry('c1', 'child-s2', 'claude-haiku-4-5', 3000, 2, {}),
      mkEntry('c2', 'child-s2', 'claude-haiku-4-5', 5000, 1, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, childEntries);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.ok(lanes[1].name.includes('child-s2'));
    assert.equal(lanes[1].turns.length, 2);
  });

  it('agentKey classification: model switch stays in main, subagents lane by agent', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      // model switch mid-session — must NOT leave the main lane
      mkEntry('t2', 's1', 'claude-fable-5', 6000, 3, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      // compact-style request: isSubagent flag but orchestrator prompt → main.
      // Starts after t2 ends (9000) — real compact requests are sequential;
      // a genuinely overlapping start would now split per ADR 0008.
      mkEntry('t3', 's1', 'claude-fable-5', 9500, 2, { agentKey: 'orchestrator', agentLabel: 'Orchestrator', isSubagent: true }),
      mkEntry('t4', 's1', 'claude-haiku-4-5', 12000, 2, { agentKey: 'explore', agentLabel: 'Explore', isSubagent: true }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 3);
    assert.equal(lanes[1].name, 'agent-explore');
    assert.equal(lanes[1].agentLabel, 'Explore');
  });

  it('wfAddEntry uses agentKey classification', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    // model switch with orchestrator identity → stays in main
    ctx.wfAddEntry(mkEntry('t2', 's1', 'claude-fable-5', 6000, 2, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }));
    assert.equal(ctx.wfState.lanes.length, 1);
    assert.equal(ctx.wfState.lanes[0].turns.length, 2);
    // subagent identity → own agent lane
    ctx.wfAddEntry(mkEntry('t3', 's1', 'claude-haiku-4-5', 8000, 2, { agentKey: 'explore', agentLabel: 'Explore', isSubagent: true }));
    assert.equal(ctx.wfState.lanes.length, 2);
    assert.equal(ctx.wfState.lanes[1].name, 'agent-explore');
  });

  it('convId splits parallel same-agent instances into separate lanes (#117)', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-fable-5', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      // two parallel Explore instances, interleaved turns
      mkEntry('e1a', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }),
      mkEntry('e2a', 's1', 'claude-sonnet-4-6', 2100, 3, { agentKey: 'explore', agentLabel: 'Explore', convId: 'bbbb2222' }),
      mkEntry('e1b', 's1', 'claude-sonnet-4-6', 6000, 2, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }),
      // legacy entry without convId keeps the shared agent lane
      mkEntry('e3', 's1', 'claude-sonnet-4-6', 7000, 2, { agentKey: 'explore', agentLabel: 'Explore' }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 4);
    var names = lanes.map(function(l) { return l.name; }).sort().join(',');
    assert.equal(names, 'agent-explore,agent-explore:aaaa1111,agent-explore:bbbb2222,main');
    var laneA = lanes.find(function(l) { return l.name === 'agent-explore:aaaa1111'; });
    assert.equal(laneA.turns.length, 2);
    assert.equal(laneA.convId, 'aaaa1111');
  });

  it('wfAddEntry routes by convId lane key', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-fable-5', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1a', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.lanes.length, 2);
    // same conv → same lane; new conv → new lane
    ctx.wfAddEntry(mkEntry('e1b', 's1', 'claude-sonnet-4-6', 5000, 2, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }));
    assert.equal(ctx.wfState.lanes.length, 2);
    assert.equal(ctx.wfState.lanes[1].turns.length, 2);
    ctx.wfAddEntry(mkEntry('e2a', 's1', 'claude-sonnet-4-6', 5100, 2, { agentKey: 'explore', agentLabel: 'Explore', convId: 'bbbb2222' }));
    assert.equal(ctx.wfState.lanes.length, 3);
    assert.equal(ctx.wfState.lanes[2].name, 'agent-explore:bbbb2222');
  });

  it('wfBuildState computes time bounds', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, {}),
      mkEntry('t3', 's2', 'claude-opus-4-6', 2000, 1, {}),
    ];
    var state = ctx.wfBuildState('s1');
    assert.ok(state);
    assert.equal(state.tMin, 1000);
    assert.equal(state.tMax, 6000 + 3000); // receivedAt + elapsed*1000
    assert.equal(state.lanes.length, 1);
    assert.equal(state.lanes[0].turns.length, 2);
  });

  it('#143: sentinel does not clobber valid tMax when receivedAt is falsy', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 0, 10, {}), // receivedAt = 0 (falsy)
    ];
    var state = ctx.wfBuildState('s1');
    assert.equal(state.tMax, 10000); // 0 + 10*1000, NOT sentinel 1
  });

  it('wfAddEntry assigns to correct lane and extends tMax', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    var newEntry = mkEntry('t2', 's1', 'claude-haiku-4-5', 8000, 2, { isSubagent: true });
    var result = ctx.wfAddEntry(newEntry);
    assert.equal(result.lanesChanged, true);
    assert.equal(ctx.wfState.lanes.length, 2);
  });

  it('wfLaneSummary computes stats', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { cost: 0.05 }),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, { cost: 0.03 }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    var summary = ctx.wfLaneSummary(lanes[0]);
    assert.equal(summary.turnCount, 2);
    assert.ok(summary.totalCost > 0.07);
    assert.ok(summary.peakCtx > 0);
  });

  it('wfDetectEvents maps entry signals to v8 events', () => {
    const ctx = loadWfModule();
    // vm realm arrays fail deepStrictEqual prototype check → compare joined strings
    var ev = function(t, prev) { return ctx.wfDetectEvents(t, prev).join(','); };
    // mkEntry default usage is 30% cache-read (= cache-miss); healthy = 90% read
    var healthy = { usage: { input_tokens: 2000, cache_read_input_tokens: 45000, cache_creation_input_tokens: 3000, output_tokens: 5000 } };
    assert.equal(ev(mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, healthy), null), '');
    var ok = mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, healthy);
    // error + compaction + file write + credential
    var bad = mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, Object.assign({
      status: 500, isCompacted: true, hasCredential: true, toolCalls: { Edit: 2 },
    }, healthy));
    assert.equal(ev(bad, ok), 'error,compaction,file-write,credential');
    // 429 → rate-limit, retry flag wins over status
    assert.equal(ev(mkEntry('t3', 's1', 'm', 1, 1, Object.assign({ status: 429 }, healthy)), ok), 'rate-limit');
    assert.equal(ev(mkEntry('t4', 's1', 'm', 1, 1, Object.assign({ status: 429, isRetry: true }, healthy)), ok), 'retry');
    // cache miss: read ratio < 50%
    var miss = mkEntry('t5', 's1', 'm', 1, 1, { usage: { input_tokens: 30000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 10 } });
    assert.equal(ev(miss, ok), 'cache-miss');
    // ctx80 fires only on crossing
    var high = mkEntry('t6', 's1', 'm', 1, 1, Object.assign({ ctxUsed: 170000 }, healthy));
    assert.equal(ev(high, ok), 'ctx80');
    assert.equal(ev(high, high), '');
  });

  it('wfLaneCostMedian caches and invalidates on wfAddEntry', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { cost: 0.01 }),
      mkEntry('t2', 's1', 'claude-opus-4-6', 7000, 5, { cost: 0.05 }),
      mkEntry('t3', 's1', 'claude-opus-4-6', 13000, 5, { cost: 0.09 }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    var lane = ctx.wfState.lanes[0];
    assert.equal(ctx.wfLaneCostMedian(lane), 0.05);
    ctx.wfAddEntry(mkEntry('t4', 's1', 'claude-opus-4-6', 19000, 5, { cost: 0.2 }));
    assert.equal(lane._costMedian, null);
    assert.equal(ctx.wfLaneCostMedian(lane), 0.09);
  });

  it('wfOverviewHeight scales with lane count, clamped 28-48', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfOverviewHeight(1), 28);   // floor: single lane
    assert.equal(ctx.wfOverviewHeight(3), 28);   // 3*7+6=27 → floor
    assert.equal(ctx.wfOverviewHeight(4), 34);
    assert.equal(ctx.wfOverviewHeight(6), 48);   // 6*7+6=48 → exactly cap
    assert.equal(ctx.wfOverviewHeight(18), 48);  // cap: many lanes
  });

  it('wfOverviewBarGeom keeps every lane inside the canvas (no clipping)', () => {
    const ctx = loadWfModule();
    // codex R1: old formula (barH floor 2 + fixed 1px gap) clipped trailing
    // lanes once laneCount * 3 > MH — e.g. 18 lanes at MH=48 drew 54px
    for (const [MH, n] of [[28, 1], [28, 2], [34, 4], [48, 6], [48, 18], [28, 12]]) {
      const g = ctx.wfOverviewBarGeom(MH, n);
      const startY = Math.max(1, (MH - n * g.laneStep) / 2);
      assert.ok(startY + n * g.laneStep <= MH, `MH=${MH} n=${n} overflows`);
      assert.ok(g.barH >= 1 && g.barH <= 8);
      assert.ok(g.laneStep >= g.barH);
    }
    // roomy case keeps the 1px gap and 8px cap
    assert.equal(ctx.wfOverviewBarGeom(28, 1).barH, 8);
    assert.equal(ctx.wfOverviewBarGeom(28, 1).laneStep, 9);
  });

  it('_wfNearestTurn hit-tests the full bar span, not just the start x (#126)', () => {
    const ctx = loadWfModule();
    // long turn (100s) followed by a short one, full session in view
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 100, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 201000, 1, {}),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.wfState.viewT0 = ctx.wfState.tMin;
    ctx.wfState.viewT1 = ctx.wfState.tMax;
    const lane = ctx.wfState.lanes[0];
    const s1 = ctx._wfBarSpan(lane.turns[0]);
    const s2 = ctx._wfBarSpan(lane.turns[1]);

    // deep inside the long bar, >40px from its left edge — the old start-x
    // distance rejected this as empty space (dist would be ~mid-bar width)
    const mid = (s1.x0 + s1.x1) / 2;
    assert.ok(mid - s1.x0 > 40, `test setup: bar must be wide (${s1.x1 - s1.x0}px)`);
    let near = ctx._wfNearestTurn(lane, mid);
    assert.equal(near.idx, 0);
    assert.equal(near.dist, 0);

    // just past the long bar's right edge → small edge distance, still turn 0
    near = ctx._wfNearestTurn(lane, s1.x1 + 5);
    assert.equal(near.idx, 0);
    assert.ok(Math.abs(near.dist - 5) < 0.01);

    // near the short bar's start → turn 1
    near = ctx._wfNearestTurn(lane, s2.x0 - 3);
    assert.equal(near.idx, 1);
    assert.ok(Math.abs(near.dist - 3) < 0.01);
  });

  it('_wfNearestTurn prefers the later turn on overlap (SVG paint order)', () => {
    const ctx = loadWfModule();
    // t2 starts while t1 is still running — spans overlap; later bar draws on top
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 100, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('t2', 's1', 'claude-opus-4-6', 51000, 100, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.wfState.viewT0 = ctx.wfState.tMin;
    ctx.wfState.viewT1 = ctx.wfState.tMax;
    // Hand-built lane: since ADR 0008, temporally overlapping turns no longer
    // share a lane, but bars can still overlap in PIXELS (min-width floor,
    // equal starts) — this tests _wfNearestTurn's paint-order preference on
    // overlapping pixel spans in isolation.
    const lane = { turns: ctx.allEntries };
    const s1 = ctx._wfBarSpan(lane.turns[0]);
    const s2 = ctx._wfBarSpan(lane.turns[1]);
    const overlapMid = (s2.x0 + s1.x1) / 2;
    assert.ok(overlapMid > s2.x0 && overlapMid < s1.x1, 'test setup: spans must overlap');
    const near = ctx._wfNearestTurn(lane, overlapMid);
    assert.equal(near.idx, 1);
    assert.equal(near.dist, 0);
  });

  it('lanes sorted by first turn receivedAt', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 10000, 5, {}),
      mkEntry('t2', 's1', 'claude-haiku-4-5', 2000, 3, { isSubagent: true }),
      mkEntry('t3', 's1', 'claude-sonnet-4-6', 5000, 2, { isSubagent: true }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes[0].name, 'main');
    assert.ok(lanes[1].name.includes('haiku'));
    assert.ok(lanes[2].name.includes('sonnet'));
  });
});

describe('workflow-timeline section state sync (#136)', () => {
  function setupLaneSelected(ctx) {
    ctx.selectedSection = 'timeline'; // stale global left by a prior turn
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, {}),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.wfState.selectedTurnId = null; // lane selected, no turn locked
  }

  // Invariant: the module-global selectedSection (drives renderDetailCol) must
  // stay in lockstep with wfState.selectedSection (drives nav highlight) in
  // EVERY branch, including the lane-summary branch that today skips the sync.
  it('wfSelectSection mirrors global selectedSection in the lane-summary branch', () => {
    const ctx = loadWfModule();
    setupLaneSelected(ctx);
    ctx.wfSelectSection('system'); // non-timeline, no turn locked → _wfRenderLaneSummary branch
    assert.equal(ctx.wfState.selectedSection, 'system');
    assert.equal(ctx.selectedSection, 'system'); // RED before fix: stays 'timeline'
  });

  it('wfRenderCurrentSection mirrors global selectedSection for a non-timeline lane summary', () => {
    const ctx = loadWfModule();
    setupLaneSelected(ctx);
    ctx.wfState.selectedSection = 'cost-efficiency';
    ctx.wfRenderCurrentSection(); // lane summary branch, no turn locked
    assert.equal(ctx.selectedSection, 'cost-efficiency'); // RED before fix: stays 'timeline'
  });
});

describe('workflow-timeline incremental child-session filing (#137)', () => {
  function withChild(ctx) {
    ctx.sessionsMap = new Map([
      ['s1', { parentSessionId: null }],
      ['cs2', { parentSessionId: 's1' }], // genuine child session of the parent we view
    ]);
    ctx.allEntries = [ mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}) ];
    ctx.wfState = ctx.wfBuildState('s1');
  }

  it('wfBuildState exposes childSids so the incremental path can see child sessions', () => {
    const ctx = loadWfModule();
    withChild(ctx);
    assert.ok(ctx.wfState.childSids instanceof Set); // RED before fix: undefined
    assert.ok(ctx.wfState.childSids.has('cs2'));
  });

  it('wfAddEntry files a live same-model child-session turn into a child lane, not main', () => {
    const ctx = loadWfModule();
    withChild(ctx);
    assert.equal(ctx.wfState.lanes.length, 1); // only main before the child streams

    // Live child turn, SAME model as main → today (no child awareness) it is
    // misfiled straight into the main lane; a full rebuild would give it a lane.
    ctx.wfAddEntry(mkEntry('c1', 'cs2', 'claude-opus-4-6', 3000, 2, {}));

    assert.equal(ctx.wfState.lanes[0].turns.length, 1); // main not polluted (RED: 2)
    const child = ctx.wfState.lanes.find((l) => l.childSessionId === 'cs2');
    assert.ok(child, 'dedicated child lane created'); // RED: undefined
    assert.equal(child.turns.length, 1);
    assert.equal(ctx.wfState.lanes.length, 2);
    // turnIndex must point the new turn at its child lane, not main
    assert.equal(ctx.wfState.turnIndex.get('c1').laneIdx, ctx.wfState.lanes.indexOf(child));
  });

  it('files a child session that spawned AFTER wfBuildState (late child, no rebuild)', () => {
    const ctx = loadWfModule();
    // at build time only the parent exists — the child hasn't spawned yet
    ctx.sessionsMap = new Map([['s1', { parentSessionId: null }]]);
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {})];
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.childSids.has('cs2'), false); // unknown at snapshot time
    // child session spawns live and registers in the (live) sessionsMap
    ctx.sessionsMap.set('cs2', { parentSessionId: 's1' });
    // its first turn streams in (same model as main → would misfile into main)
    ctx.wfAddEntry(mkEntry('c1', 'cs2', 'claude-opus-4-6', 3000, 2, {}));
    assert.equal(ctx.wfState.lanes[0].turns.length, 1); // main not polluted (RED: 2)
    const child = ctx.wfState.lanes.find((l) => l.childSessionId === 'cs2');
    assert.ok(child, 'late child routed to its own child lane'); // RED: undefined
    assert.equal(ctx.wfState.childSids.has('cs2'), true); // childSids kept live
  });

  it('live childSids refresh only adds direct children (grandchild / unrelated excluded)', () => {
    const ctx = loadWfModule();
    ctx.sessionsMap = new Map([['s1', { parentSessionId: null }]]);
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {})];
    ctx.wfState = ctx.wfBuildState('s1');
    // a grandchild (parent is a child of s1, not s1 itself) and an unrelated session
    ctx.sessionsMap.set('cs2', { parentSessionId: 's1' });   // real child
    ctx.sessionsMap.set('gc3', { parentSessionId: 'cs2' });  // grandchild
    ctx.sessionsMap.set('other', { parentSessionId: 'zzz' }); // unrelated
    ctx.wfAddEntry(mkEntry('g1', 'gc3', 'claude-opus-4-6', 3000, 2, {}));
    ctx.wfAddEntry(mkEntry('o1', 'other', 'claude-opus-4-6', 4000, 2, {}));
    assert.equal(ctx.wfState.childSids.has('gc3'), false); // parent != viewed session
    assert.equal(ctx.wfState.childSids.has('other'), false);
    assert.equal(ctx.wfState.lanes.find((l) => l.childSessionId === 'gc3'), undefined);
  });

  it('incremental child filing matches a full rebuild (no lane jump on re-select)', () => {
    const ctx = loadWfModule();
    withChild(ctx);
    ctx.wfAddEntry(mkEntry('c1', 'cs2', 'claude-opus-4-6', 3000, 2, {}));

    ctx.allEntries.push(mkEntry('c1', 'cs2', 'claude-opus-4-6', 3000, 2, {}));
    const rebuilt = ctx.wfBuildState('s1');
    assert.equal(rebuilt.lanes.length, ctx.wfState.lanes.length); // RED: 2 vs 1
    const rc = rebuilt.lanes.find((l) => l.childSessionId === 'cs2');
    assert.ok(rc && rc.turns.length === 1);
  });
});

describe('workflow-timeline stable lane .key (#139)', () => {
  it('every lane carries a stable .key = its map key, distinct from display .name', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes(
      [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {})],
      [mkEntry('c1', 'sid-aaaa', 'claude-haiku-4-5', 2000, 2, {})]
    );
    var main = lanes.find((l) => l.name === 'main');
    assert.equal(main.key, 'main'); // RED before fix: undefined
    var child = lanes.find((l) => l.childSessionId === 'sid-aaaa');
    assert.equal(child.key, 'child-sid-aaaa'); // stable map key
    assert.notEqual(child.key, child.name); // .name is the display label
  });

  it('sub-lane .key equals its map key (the string wfAddEntry find relies on)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore' }),
    ], []);
    var sub = lanes.find((l) => l.agentKey === 'explore');
    assert.equal(sub.key, 'agent-explore'); // RED before fix: undefined
    assert.equal(sub.key, sub.name); // today they coincide — the fragile coupling
  });

  it('colliding child display labels stay distinct by .key (no multi-lane selection)', () => {
    const ctx = loadWfModule();
    // two child sessions, same model + same first-8 hex → identical display .name
    var lanes = ctx.wfInferLanes(
      [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {})],
      [
        mkEntry('c1', 'abcd1234-one', 'claude-haiku-4-5', 2000, 2, {}),
        mkEntry('c2', 'abcd1234-two', 'claude-haiku-4-5', 3000, 2, {}),
      ]
    );
    var a = lanes.find((l) => l.childSessionId === 'abcd1234-one');
    var b = lanes.find((l) => l.childSessionId === 'abcd1234-two');
    assert.equal(a.name, b.name); // labels collide (same model + first-8 hex)
    assert.notEqual(a.key, b.key); // RED before fix: undefined === undefined
    // the render-time selection predicate (selectedLane.key === lane.key) must
    // match exactly one lane, not two.
    var selected = lanes.filter((l) => a.key === l.key);
    assert.equal(selected.length, 1); // RED before fix: 3 (all keys undefined)
  });

  it('wfAddEntry appends to the right sub-lane even if .name later becomes a label', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    var sub = ctx.wfState.lanes.find((l) => l.agentKey === 'explore');
    // simulate a future world where sub .name is a display label ≠ its key
    sub.name = 'Explore #1';
    ctx.wfAddEntry(mkEntry('e2', 's1', 'claude-sonnet-4-6', 5000, 2, { agentKey: 'explore', agentLabel: 'Explore', convId: 'aaaa1111' }));
    // find-by-key must still hit the existing lane → no duplicate
    assert.equal(ctx.wfState.lanes.length, 2); // RED before fix: 3 (find-by-name missed)
    assert.equal(sub.turns.length, 2);
  });
});

describe('workflow-timeline lock-turn convergence (#140)', () => {
  function twoLanes(ctx) {
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
  }

  // Invariant A==B: the expanded lane (selectedLane) must equal the lane that
  // holds the locked turn (selectedTurnId). Two of the 13 setters set turnId
  // without lane; converge them on a single helper that derives lane from
  // turnIndex.laneIdx.
  it('wfLockTurn sets selectedLane to the locked turn\'s lane (A==B)', () => {
    const ctx = loadWfModule();
    twoLanes(ctx);
    const exploreLane = ctx.wfState.lanes.find((l) => l.agentKey === 'explore');
    assert.notEqual(ctx.wfState.selectedLane, exploreLane); // precondition: A(main) ≠ B(explore)
    ctx.wfLockTurn('e1'); // RED before fix: wfLockTurn is undefined
    assert.equal(ctx.wfState.selectedTurnId, 'e1');
    assert.equal(ctx.wfState.selectedLane, exploreLane); // expanded lane == locked-turn lane
  });

  it('wfLockTurn bridges to selectTurn so the detail pane syncs', () => {
    const ctx = loadWfModule();
    let picked = -1;
    ctx.selectTurn = (i) => { picked = i; };
    twoLanes(ctx);
    ctx.wfLockTurn('e1');
    assert.equal(picked, 1); // selectTurn called with allEntries index of e1
  });

  it('wfLockTurn is a no-op when the turn id is unknown (no phantom lock)', () => {
    const ctx = loadWfModule();
    twoLanes(ctx);
    const before = ctx.wfState.selectedLane;
    ctx.wfLockTurn('nope');
    // unknown id: leave both fields untouched rather than pointing the lock at a
    // turn that lives in no lane (the #8 soft-desync gap).
    assert.equal(ctx.wfState.selectedLane, before);
    assert.equal(ctx.wfState.selectedTurnId, null);
  });
});

describe('workflow-timeline zoom predicate (#138)', () => {
  it('wfIsZoomed reflects viewport vs full range (single source of truth)', () => {
    const ctx = loadWfModule();
    ctx.wfState = { tMin: 0, tMax: 100000, viewT0: 0, viewT1: 100000 };
    assert.equal(ctx.wfIsZoomed(), false); // full range → not zoomed
    ctx.wfState.viewT0 = 5000;
    assert.equal(ctx.wfIsZoomed(), true); // zoomed from the left
    ctx.wfState.viewT0 = 0; ctx.wfState.viewT1 = 90000;
    assert.equal(ctx.wfIsZoomed(), true); // zoomed from the right
    ctx.wfState.viewT0 = 50; ctx.wfState.viewT1 = 99950; // within the 100ms slop
    assert.equal(ctx.wfIsZoomed(), false);
  });
});

describe('workflow-timeline model color resolver (A: unify lane/card color)', () => {
  it('wfModelColor: exact, prefix, and a hex fallback safe to alpha-suffix', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfModelColor('claude-sonnet-4-6'), '#ffa657'); // exact
    assert.equal(ctx.wfModelColor('claude-haiku-4-5-20251001'), '#f0883e'); // exact
    assert.ok(ctx.wfModelColor('claude-opus-4-8-preview').startsWith('#')); // prefix → hex
    // unknown (e.g. a non-Claude/Codex model) and null must fall back to a HEX,
    // not 'var(--dim)', so the agent-card chip's `color + '22'` alpha stays valid.
    assert.equal(ctx.wfModelColor('gpt-5.5')[0], '#'); // RED before fix: 'v' (var(--dim))
    assert.equal(ctx.wfModelColor(null)[0], '#'); // RED before fix: 'v'
  });
});

describe('workflow-timeline focus dim follows selectedLane', () => {
  function twoLanes(ctx) {
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
  }

  // The cross-lane dim must key off selectedLane, not selectedTurnId — so
  // selecting a lane (even with no turn locked) recedes the others consistently.
  it('_wfFocusLaneIdx tracks selectedLane regardless of lock', () => {
    const ctx = loadWfModule();
    twoLanes(ctx);
    // default: main (lanes[0]) selected, no turn locked
    assert.equal(ctx.wfState.selectedTurnId, null);
    assert.equal(ctx._wfFocusLaneIdx(), 0);
    // select the subagent lane WITHOUT locking a turn — focus must follow it
    ctx.wfState.selectedLane = ctx.wfState.lanes[1];
    ctx.wfState.selectedTurnId = null;
    assert.equal(ctx._wfFocusLaneIdx(), 1); // RED before fix: helper undefined
    // no selection → no focus
    ctx.wfState.selectedLane = null;
    assert.equal(ctx._wfFocusLaneIdx(), -1);
  });
});

describe('workflow-timeline lane-focus hit-testing (codex round 4)', () => {
  function threeLanes(ctx) {
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      mkEntry('e1', 's1', 'claude-sonnet-4-6', 2000, 3, { agentKey: 'explore', agentLabel: 'Explore' }),
      mkEntry('g1', 's1', 'claude-sonnet-4-6', 2500, 3, { agentKey: 'general-purpose', agentLabel: 'General' }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
  }

  // Focus mode draws only the selected sub-lane (see _wfRenderSvgContent), at
  // y=WF_PAD — walking 1..lanes.length as if all sub-lanes are stacked (the old
  // behavior) hit-tests against a layout that isn't actually on screen.
  it('_wfLaneIdxAtY returns the focused lane, not whatever unfocused lane occupies that y-slot', () => {
    const ctx = loadWfModule();
    threeLanes(ctx);
    assert.equal(ctx.wfState.lanes.length, 3); // main + explore + general-purpose
    ctx.wfState.laneFocusMode = true;
    ctx.wfState.selectedLane = ctx.wfState.lanes[2]; // focus the 3rd lane (general-purpose)
    var my = 9; // WF_PAD(4) + 5 — inside lane[1]'s slot under the old sequential walk
    assert.equal(ctx._wfLaneIdxAtY({ id: 'wf-sub-svg' }, my), 2); // RED before fix: 1
    // main SVG hit-testing is untouched by focus mode
    assert.equal(ctx._wfLaneIdxAtY({ id: 'wf-main-svg' }, 30), 0);
    // focus on main itself → sub SVG has nothing to hit-test
    ctx.wfState.selectedLane = ctx.wfState.lanes[0];
    assert.equal(ctx._wfLaneIdxAtY({ id: 'wf-sub-svg' }, my), -1);
  });
});

describe('workflow-timeline agentKey classification agrees with entry-rendering.js (codex round 4)', () => {
  // 'unknown'/'agent' are extractAgentType()'s catch-all defaults — could be a
  // genuinely new main-agent variant, not necessarily a subagent. Both the batch
  // build (wfInferLanes) and the live-update path (wfAddEntry) must fall back to
  // the raw isSubagent flag for these, matching AGENT_KEY_UNRELIABLE in
  // entry-rendering.js — otherwise the same turn classifies differently in the
  // turn list (main) vs the workflow lanes (subagent).
  it('wfInferLanes keeps an unreliable-agentKey, non-subagent turn in main', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator' }),
      mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, { agentKey: 'unknown', isSubagent: false }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 1); // RED before fix: 2 (t2 split into its own 'agent-unknown' lane)
    assert.equal(lanes[0].turns.length, 2);
  });

  it('wfAddEntry (live update) keeps an unreliable-agentKey, non-subagent turn in main', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator' })];
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.lanes.length, 1);
    var t2 = mkEntry('t2', 's1', 'claude-opus-4-6', 6000, 3, { agentKey: 'unknown', isSubagent: false });
    ctx.wfAddEntry(t2);
    assert.equal(ctx.wfState.lanes.length, 1); // RED before fix: 2 (routed into an 'agent-unknown' sub-lane)
    assert.equal(ctx.wfState.lanes[0].turns.length, 2);
  });
});

describe('workflow-timeline tail-follow sliding window (#138 Fix B)', () => {
  it('slides a fixed-span window instead of expanding while following the tail', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 10, {})]; // ends at 11000
    ctx.wfState = ctx.wfBuildState('s1'); // tMin=1000, tMax=11000, view=[1000,11000] (at tail)
    ctx.wfAddEntry(mkEntry('t2', 's1', 'claude-opus-4-6', 21000, 10, {})); // tMax→31000
    assert.equal(ctx.wfState.viewT1, ctx.wfState.tMax); // tracks the tail (31000)
    assert.equal(ctx.wfState.viewT1 - ctx.wfState.viewT0, 10000); // span frozen (RED: 30000)
    assert.equal(ctx.wfState.viewT0, 21000); // slid to tMax - span (RED: 1000)
  });

  it('does not yank a scrolled-back (non-following) view', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 10, {})];
    ctx.wfState = ctx.wfBuildState('s1'); // tMax=11000
    ctx.wfState.viewT0 = 1000; ctx.wfState.viewT1 = 4000; // user zoomed to an early window
    ctx.wfAddEntry(mkEntry('t2', 's1', 'claude-opus-4-6', 21000, 10, {})); // tMax→31000
    assert.equal(ctx.wfState.viewT0, 1000);
    assert.equal(ctx.wfState.viewT1, 4000); // untouched — not at the tail
  });

  it('child-lane live turns also tail-follow with a fixed span', () => {
    const ctx = loadWfModule();
    ctx.sessionsMap = new Map([
      ['s1', { parentSessionId: null }],
      ['cs2', { parentSessionId: 's1' }],
    ]);
    ctx.allEntries = [mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 10, {})];
    ctx.wfState = ctx.wfBuildState('s1'); // tMax=11000, view=[1000,11000]
    ctx.wfAddEntry(mkEntry('c1', 'cs2', 'claude-opus-4-6', 21000, 10, {})); // child turn, tMax→31000
    assert.equal(ctx.wfState.viewT1, ctx.wfState.tMax); // RED: stays 11000 (old guard false)
    assert.equal(ctx.wfState.viewT1 - ctx.wfState.viewT0, 10000); // fixed span
  });
});

// ── #144 option B: per-agent identity color ──────────────────────────────────
describe('#144 wfLaneColor — per-agent identity color', () => {
  it('exposes wfLaneColor + wfComputeLaneColors', () => {
    const ctx = loadWfModule();
    assert.equal(typeof ctx.wfLaneColor, 'function');
    assert.equal(typeof ctx.wfComputeLaneColors, 'function');
  });

  it('main lane gets a stable pinned color', () => {
    const ctx = loadWfModule();
    const a = ctx.wfLaneColor({ key: 'main', name: 'main' });
    const b = ctx.wfLaneColor({ key: 'main', name: 'main' });
    assert.ok(a, 'main color is non-empty');
    assert.equal(a, b);
  });

  it('same lane.key -> same color across calls (stable identity)', () => {
    const ctx = loadWfModule();
    assert.equal(
      ctx.wfLaneColor({ key: 'agent-general-purpose:abc123' }),
      ctx.wfLaneColor({ key: 'agent-general-purpose:abc123' }),
    );
  });

  it('main color differs from every hashed lane color', () => {
    const ctx = loadWfModule();
    const main = ctx.wfLaneColor({ key: 'main', name: 'main' });
    for (const key of ['agent-a:1', 'agent-b:2', 'agent-c:3', 'agent-d:4', 'agent-e:5']) {
      assert.notEqual(ctx.wfLaneColor({ key }), main);
    }
  });

  it('wfComputeLaneColors: main + 5 concurrent hashed lanes are all distinct (open-addressing)', () => {
    const ctx = loadWfModule();
    const lanes = [
      { key: 'main', name: 'main' },
      { key: 'agent-a:1' }, { key: 'agent-b:2' }, { key: 'agent-c:3' },
      { key: 'agent-d:4' }, { key: 'agent-e:5' },
    ];
    const map = ctx.wfComputeLaneColors(lanes);
    const colors = lanes.map((l) => map.get(l.key));
    assert.ok(colors.every(Boolean), 'every lane got a color');
    assert.equal(new Set(colors).size, colors.length, 'all 6 lanes distinct');
  });

  it('lane and card read the same resolver -> same color for a lane', () => {
    const ctx = loadWfModule();
    const lane = { key: 'agent-explore:zzz', model: 'claude-haiku-4-5' };
    // both the gutter and the card call wfLaneColor(lane); one source of truth
    assert.equal(ctx.wfLaneColor(lane), ctx.wfLaneColor(lane));
  });
});

// ── #149: shape/glyph second channel for lane identity ──────────────────────
describe('#149 wfLaneShape — per-agent identity glyph', () => {
  it('exposes wfLaneShape + wfComputeLaneStyles + WF_LANE_GLYPHS', () => {
    const ctx = loadWfModule();
    assert.equal(typeof ctx.wfLaneShape, 'function');
    assert.equal(typeof ctx.wfComputeLaneStyles, 'function');
    assert.ok(ctx.WF_LANE_GLYPHS);
    assert.ok(ctx.WF_LANE_GLYPHS.main);
    assert.ok(Array.isArray(ctx.WF_LANE_GLYPHS.hashed));
  });

  it('main lane gets pinned glyph (circle)', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfLaneShape({ key: 'main', name: 'main' }), 'circle');
    assert.equal(ctx.wfLaneShape({ key: 'main', name: 'main' }), ctx.WF_LANE_GLYPHS.main);
  });

  it('same lane.key -> same glyph across calls (stable identity)', () => {
    const ctx = loadWfModule();
    assert.equal(
      ctx.wfLaneShape({ key: 'agent-general-purpose:abc123' }),
      ctx.wfLaneShape({ key: 'agent-general-purpose:abc123' }),
    );
  });

  it('wfComputeLaneStyles returns {color, glyph} per key', () => {
    const ctx = loadWfModule();
    const lanes = [
      { key: 'main', name: 'main' },
      { key: 'agent-a:1' },
    ];
    const map = ctx.wfComputeLaneStyles(lanes);
    const m = map.get('main');
    assert.ok(m.color && m.glyph);
    assert.equal(m.glyph, 'circle');
    const a = map.get('agent-a:1');
    assert.ok(a.color && a.glyph);
  });

  it('combined (color, glyph): >palette-size concurrent lanes each unique pair', () => {
    const ctx = loadWfModule();
    // 10 hashed lanes = well beyond color palette size (7)
    const lanes = [{ key: 'main', name: 'main' }];
    for (let i = 0; i < 10; i++) lanes.push({ key: 'agent-x:' + i });
    const map = ctx.wfComputeLaneStyles(lanes);
    const pairs = new Set();
    for (const [, v] of map) pairs.add(v.color + ':' + v.glyph);
    assert.equal(pairs.size, lanes.length, 'all 11 lanes have distinct (color,glyph) pairs');
  });

  it('adversarial: 20 same-hash-bucket lanes still get distinct pairs', () => {
    const ctx = loadWfModule();
    const lanes = [{ key: 'main', name: 'main' }];
    for (let i = 0; i < 20; i++) lanes.push({ key: 'agent-x:' + i });
    const map = ctx.wfComputeLaneStyles(lanes);
    const pairs = new Set();
    for (const [, v] of map) pairs.add(v.color + ':' + v.glyph);
    assert.equal(pairs.size, lanes.length, 'all 21 lanes have distinct (color,glyph) pairs');
  });

  it('49-lane capacity: 7 colors × 7 shapes = 49 unique hashed pairs', () => {
    const ctx = loadWfModule();
    const lanes = [{ key: 'main', name: 'main' }];
    for (let i = 0; i < 49; i++) lanes.push({ key: 'lane-' + i });
    const map = ctx.wfComputeLaneStyles(lanes);
    const pairs = new Set();
    for (const [, v] of map) pairs.add(v.color + ':' + v.glyph);
    assert.equal(pairs.size, 50, 'full Cartesian capacity: 49 hashed + 1 main = 50');
  });

  it('lane and card resolve the same glyph (single resolver)', () => {
    const ctx = loadWfModule();
    const lane = { key: 'agent-explore:zzz' };
    assert.equal(ctx.wfLaneShape(lane), ctx.wfLaneShape(lane));
  });

  it('wfGlyphSvg returns SVG markup for each glyph in the pool', () => {
    const ctx = loadWfModule();
    const all = [ctx.WF_LANE_GLYPHS.main, ...ctx.WF_LANE_GLYPHS.hashed];
    for (const g of all) {
      const svg = ctx.wfGlyphSvg(g, 5, 5, 8, '#fff');
      assert.ok(svg.length > 0, g + ' produces SVG');
      assert.ok(svg.includes('#fff'), g + ' uses the fill color');
    }
  });

  it('wfGlyphHtml returns inline <svg> for HTML contexts', () => {
    const ctx = loadWfModule();
    const html = ctx.wfGlyphHtml('circle', 10, '#42a3fd');
    assert.ok(html.startsWith('<svg'));
    assert.ok(html.includes('</svg>'));
  });
});

// ── #142/#253: workflow ctx zone color must share the >80/>=40 band contract ──
describe('#142 wfCtxZoneColor band boundaries', () => {
  const t = (pct) => ({ ctxUsed: pct / 100 * 200000, maxContext: 200000 });
  it('80% -> yellow, not red (boundary is >80)', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfCtxZoneColor(t(80)), '#d29922');
  });
  it('81% -> red', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfCtxZoneColor(t(81)), '#f85149');
  });
  it('40% -> yellow', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfCtxZoneColor(t(40)), '#d29922');
  });
  it('39% -> green', () => {
    const ctx = loadWfModule();
    assert.equal(ctx.wfCtxZoneColor(t(39)), '#3fb950');
  });
});

// ── #221: subagents carrying the parent's session_id ─────────────────────────
describe('#221 subagent lane inference when session_id no longer separates agents', () => {
  it('agentKey-identified subagent lanes by agentKey regardless of isSubagent flag', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      // server now sets agentKey from the B2 prompt even though session_id
      // matches the parent (isSubagent stays false) — agentKey must still win
      mkEntry('t2', 's1', 'claude-sonnet-4-6', 7000, 3, { agentKey: 'general-purpose', agentLabel: 'General Purpose', isSubagent: false }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 1);
    assert.equal(lanes[1].name, 'agent-general-purpose');
    assert.equal(lanes[1].turns.length, 1);
  });

  it('wfInferLanes post-pass splits temporally overlapping main-lane turns into a parallel lane', () => {
    const ctx = loadWfModule();
    var entries = [
      // t1 runs 1000..6000
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
      // t2 starts at 3000, while t1 is still running — no agentKey, so only
      // the temporal-overlap post-pass can catch this
      mkEntry('t2', 's1', 'claude-opus-4-6', 3000, 4, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 1);
    assert.equal(lanes[0].turns[0].id, 't1');
    assert.equal(lanes[1].name, 'parallel-opus-4-6');
    assert.equal(lanes[1].turns.length, 1);
    assert.equal(lanes[1].turns[0].id, 't2');
  });

  it('wfAddEntry splits a temporally overlapping incremental entry into a parallel lane', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}), // runs 1000..6000
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.lanes.length, 1);
    // arrives at 3000, overlapping t1's 1000..6000 span
    var result = ctx.wfAddEntry(mkEntry('t2', 's1', 'claude-opus-4-6', 3000, 4, {}));
    assert.equal(result.lanesChanged, true);
    assert.equal(ctx.wfState.lanes.length, 2);
    assert.equal(ctx.wfState.lanes[0].turns.length, 1);
    assert.equal(ctx.wfState.lanes[1].name, 'parallel-opus-4-6');
    assert.equal(ctx.wfState.lanes[1].turns.length, 1);
    assert.equal(ctx.wfState.lanes[1].turns[0].id, 't2');
  });

  it('non-overlapping same-model turns stay in main (no false positive)', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),   // ends at 6000
      mkEntry('t2', 's1', 'claude-opus-4-6', 7000, 3, {}),   // starts after t1 ends
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 2);

    ctx.allEntries = entries.slice(0, 1);
    ctx.wfState = ctx.wfBuildState('s1');
    var result = ctx.wfAddEntry(entries[1]);
    assert.equal(result.lanesChanged, false);
    assert.equal(ctx.wfState.lanes.length, 1);
    assert.equal(ctx.wfState.lanes[0].turns.length, 2);
  });

  it('completion-order mismatch: earlier-starting turn stays in main even if it finishes last (codex R1)', () => {
    const ctx = loadWfModule();
    // t2 completes first but started after t1 — arrival order ≠ start order
    var entries = [
      mkEntry('t2', 's1', 'claude-opus-4-6', 3000, 1, {}),
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].turns[0].id, 't1');
    assert.equal(lanes[1].turns[0].id, 't2');
  });
});

// ── #222: fork subagent false-positive guards ────────────────────────────────
describe('#222 temporal overlap does not false-positive on compaction or model switch', () => {
  it('compaction (msgCount drop) with sequential turns stays in main', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { msgCount: 40 }),
      // compaction: msgCount drops from 40 to 10, but turns are sequential
      mkEntry('t2', 's1', 'claude-opus-4-6', 7000, 3, { msgCount: 10, isCompacted: true }),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 2);
  });

  it('fork-style parallel with orchestrator agentKey is correctly split', () => {
    const ctx = loadWfModule();
    var entries = [
      // main orchestrator turn running from 1000 to 31000
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 30, { agentKey: 'orchestrator', agentLabel: 'Orchestrator' }),
      // fork: same agentKey, same model, overlapping time — no agentKey or
      // isSubagent signal, only temporal overlap catches this
      mkEntry('t2', 's1', 'claude-opus-4-6', 5000, 10, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.length, 1);
    assert.equal(lanes[0].turns[0].id, 't1');
  });
});

// ── #221/#222 redo: overlap overrides authoritative agentKey (ADR 0008) ─────
// Fixture shape mirrors real fork traffic (e.g. session 86949194 on 2026-07-10):
// forks inherit the parent's full prompt → agentKey 'orchestrator'
// (authoritative main key), same convId, same model. The Batch 11 post-pass
// exempted authoritative keys from the overlap split, so these stayed in main.
describe('#221/#222 redo: overlap overrides authoritative agentKey (ADR 0008)', () => {
  function mkFork(id, at, elapsed) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed,
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: 'c0ffee' });
  }
  function assertNoIntraLaneOverlap(lanes, opts) {
    for (var li = 0; li < lanes.length; li++) {
      // #261: same-convId parallel lanes allow intra-lane overlap
      if (opts && opts.skipConvId && (lanes[li].key || '').indexOf('parallel-') === 0 && lanes[li].convId) continue;
      var spans = lanes[li].turns.map(function(t) {
        var s = Number(t.receivedAt) || 0;
        return [s, s + (parseFloat(t.elapsed) || 0) * 1000];
      }).sort(function(a, b) { return a[0] - b[0]; });
      for (var i = 1; i < spans.length; i++) {
        assert.ok(spans[i][0] >= spans[i - 1][1] || spans[i][0] === spans[i - 1][0],
          'lane ' + lanes[li].key + ': turn @' + spans[i][0] + ' overlaps previous ending @' + spans[i - 1][1]);
      }
    }
  }

  it('fork with authoritative orchestrator agentKey is split out of main (fail-on-old)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkFork('parent', 1000, 60),  // 1000..61000
      mkFork('fork1', 11000, 55),  // starts strictly inside parent's span
    ], []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].name, 'main');
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), ['parent'].join(','));
    assert.equal(lanes[1].turns[0].id, 'fork1');
  });

  it('fan-out: same-convId forks collapse into one parallel lane (#261)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkFork('parent', 1000, 60),
      mkFork('f1', 11000, 50),
      mkFork('f2', 13000, 55),
      mkFork('f3', 15000, 52),
    ], []);
    assert.equal(lanes.length, 2); // main + 1 parallel (resource pool)
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'parent');
    assert.equal(lanes[1].turns.length, 3);
    assert.equal(lanes[1].turns.map(function(t) { return t.id; }).join(','), 'f1,f2,f3');
  });

  it("a fork's own serial turns reconstruct into one parallel lane (best-fit)", () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkFork('parent', 1000, 60),
      mkFork('f1a', 11000, 10),  // 11000..21000
      mkFork('f1b', 22000, 10),  // starts after f1a ends, still inside parent's span
    ], []);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[1].turns.map(function(t) { return t.id; }).join(','), ['f1a', 'f1b'].join(','));
  });

  it('live path (wfAddEntry) collapses same-convId forks into one lane (#261)', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkFork('parent', 1000, 60)];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.wfAddEntry(mkFork('f1', 11000, 10));
    ctx.wfAddEntry(mkFork('f2', 13000, 10));
    ctx.wfAddEntry(mkFork('f1b', 22000, 10));
    assert.equal(ctx.wfState.lanes.length, 2); // main + 1 parallel (was 3)
    assert.equal(ctx.wfState.lanes[0].turns.map(function(t) { return t.id; }).join(','), 'parent');
    assert.equal(ctx.wfState.lanes[1].turns.map(function(t) { return t.id; }).join(','), 'f1,f2,f1b');
  });

  it('equal receivedAt stays sequential in main (entry-rendering predicate alignment)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([mkFork('t1', 1000, 5), mkFork('t2', 1000, 3)], []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 2);
  });

  it('serial orchestrator turns never split (no false positives)', () => {
    const ctx = loadWfModule();
    var entries = [];
    for (var i = 0; i < 6; i++) entries.push(mkFork('t' + i, 1000 + i * 10000, 8));
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 6);
  });

  it('null-convId turns still get #N split (legacy behavior, #261)', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('parent', 's1', 'claude-opus-4-6', 1000, 60, { agentKey: 'orchestrator' }),
      mkEntry('f1', 's1', 'claude-opus-4-6', 5000, 40, {}),
      mkEntry('f2', 's1', 'claude-opus-4-6', 7000, 40, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.ok(lanes.length >= 3, 'null-convId overlapping turns should split into separate lanes');
    assertNoIntraLaneOverlap(lanes);
  });
});

// ── #261 codex review fixes: pooled-lane duration, live/batch insert-order
// parity, legacy #1 label ───────────────────────────────────────────────────
describe('#261 codex review fixes', () => {
  function mkFork(id, at, elapsed) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed,
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: 'c0ffee' });
  }

  it('P2: pooled-lane duration uses min-start/max-end, not last-turn-by-array-order', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkFork('parent', 1000, 60),     // 1000..61000 (anchors main)
      mkFork('flong', 11000, 50),     // 11000..61000 (long overlapping fork)
      mkFork('fnested', 13000, 5),    // 13000..18000 (nested, ends BEFORE flong)
    ], []);
    assert.equal(lanes.length, 2); // main + 1 pooled parallel lane
    var pooled = lanes[1];
    assert.equal(pooled.turns.map(function(t) { return t.id; }).join(','), 'flong,fnested');
    var summary = ctx.wfLaneSummary(pooled);
    // old bug: last-by-array-order (fnested, ends 18000) - first (11000) = 7000
    assert.equal(summary.duration, 50000, 'duration must span max-end(61000) - min-start(11000)');
  });

  it('P2: live path (wfAddEntry) inserts pooled turns sorted by receivedAt regardless of arrival order', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkFork('parent', 1000, 60)];
    ctx.wfState = ctx.wfBuildState('s1');
    // Arrival order = completion order: the nested (later-start, earlier-end)
    // turn completes and arrives BEFORE the longer, earlier-starting turn.
    ctx.wfAddEntry(mkFork('fnested', 13000, 5));
    ctx.wfAddEntry(mkFork('flong', 11000, 50));
    assert.equal(ctx.wfState.lanes.length, 2);
    var liveIds = ctx.wfState.lanes[1].turns.map(function(t) { return t.id; }).join(',');
    assert.equal(liveIds, 'flong,fnested', 'live insert must sort by receivedAt, not arrival order');

    // Batch/live parity: wfInferLanes on the same set (fed in start order,
    // since batch always sorts internally) must produce the same pooled order.
    const batchCtx = loadWfModule();
    var batchLanes = batchCtx.wfInferLanes([
      mkFork('parent', 1000, 60),
      mkFork('fnested', 13000, 5),
      mkFork('flong', 11000, 50),
    ], []);
    var batchIds = batchLanes[1].turns.map(function(t) { return t.id; }).join(',');
    assert.equal(batchIds, liveIds);
  });

  it('P3: legacy null-convId families keep the first lane\'s #1 ordinal', () => {
    const ctx = loadWfModule();
    var entries = [
      mkEntry('parent', 's1', 'claude-opus-4-6', 1000, 60, { agentKey: 'orchestrator' }),
      mkEntry('f1', 's1', 'claude-opus-4-6', 5000, 40, {}),
      mkEntry('f2', 's1', 'claude-opus-4-6', 7000, 40, {}),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.ok(lanes.length >= 3);
    var mainConvs = ctx._wfMainConvSet(lanes);
    var name1 = ctx._wfLaneDispName(lanes[1], 1, mainConvs);
    var name2 = ctx._wfLaneDispName(lanes[2], 2, mainConvs);
    assert.ok(name1.indexOf('#1') !== -1, 'first legacy lane must keep #1, got: ' + name1);
    assert.ok(name2.indexOf('#2') !== -1, 'second legacy lane must show #2, got: ' + name2);
  });
});

// ── #230: sequential interleave — convId bracketing + msgCount dip (ADR 0009) ─
// Overlap (ADR 0008) only catches PARALLEL agents. These fixtures mirror the
// two real residue shapes it cannot see:
//  - teammate: agentKey 'orchestrator' (inherits the standard CC prompt), own
//    convId, interleaved A-B-A with zero time overlap (session 4b15c248)
//  - sequential fork continuation: agentKey 'orchestrator', SAME convId as
//    main, msgCount dip continuing an overlap-split frontier (session
//    86949194's 55→51). Never agentKey:null — Batch 11's fake-fixture trap.
describe('#230 sequential interleave (ADR 0009)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }
  function assertSerialLanes(lanes) {
    for (var li = 0; li < lanes.length; li++) {
      var spans = lanes[li].turns.map(function(t) {
        var s = Number(t.receivedAt) || 0;
        return [s, s + (parseFloat(t.elapsed) || 0) * 1000];
      }).sort(function(a, b) { return a[0] - b[0]; });
      for (var i = 1; i < spans.length; i++) {
        assert.ok(spans[i][0] >= spans[i - 1][1] || spans[i][0] === spans[i - 1][0],
          'lane ' + lanes[li].key + ': turn @' + spans[i][0] + ' overlaps previous ending @' + spans[i - 1][1]);
      }
    }
  }
  function ids(lane) { return lane.turns.map(function(t) { return t.id; }).join(','); }

  it('AC1: A-B-A convId runs with zero overlap → B run splits to a sub-lane (fail-on-old)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('a1', 1000, 5, 'convA', 10),
      mkSeq('a2', 7000, 5, 'convA', 12),
      mkSeq('b1', 13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }),
      mkSeq('b2', 19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }),
      mkSeq('a3', 25000, 5, 'convA', 14),
    ], []);
    assert.equal(lanes.length, 2);
    assert.equal(ids(lanes[0]), 'a1,a2,a3');
    assert.equal(ids(lanes[1]), 'b1,b2');
    assertSerialLanes(lanes);
  });

  it('R2: sequential fork dip stitches onto its overlap-split frontier lane (fail-on-old)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('m1', 1000, 5, 'convA', 53),
      mkSeq('m2', 10000, 60, 'convA', 55),   // long main turn 10000..70000
      mkSeq('f1', 20000, 5, 'convA', 51),    // starts inside m2 → overlap split
      mkSeq('f2', 71000, 5, 'convA', 51),    // after m2 ends — overlap-blind
      mkSeq('m3', 80000, 5, 'convA', 57),
    ], []);
    assert.equal(lanes.length, 2);
    assert.equal(ids(lanes[0]), 'm1,m2,m3');
    assert.equal(ids(lanes[1]), 'f1,f2', 'dip must land in the same fork lane as its frontier');
    assertSerialLanes(lanes);
  });

  it('compaction: conv advance that never returns stays in main (isCompacted true)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('c1', 1000, 5, 'convA', 100),
      mkSeq('c2', 7000, 5, 'convA', 102),
      mkSeq('c3', 13000, 5, 'convB', 10, { isCompacted: true }),
      mkSeq('c4', 19000, 5, 'convB', 12),
    ], []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 4);
  });

  it('compaction variant: same shape without the isCompacted flag also stays in main', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('c1', 1000, 5, 'convA', 100),
      mkSeq('c2', 7000, 5, 'convA', 102),
      mkSeq('c3', 13000, 5, 'convB', 10),
      mkSeq('c4', 19000, 5, 'convB', 12),
    ], []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 4);
  });

  it('rewind: same-conv msgCount dip with no split-out frontier stays in main (7e1d9272 shape)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('r1', 1000, 5, 'convA', 540),
      mkSeq('r2', 7000, 5, 'convA', 493),
      mkSeq('r3', 13000, 5, 'convA', 495),
      mkSeq('r4', 19000, 5, 'convA', 497),
    ], []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 4);
  });

  it('fan-out: multi-conv interleave splits fully even when a first turn is mislabeled isCompacted (a7fef8a8 shape)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('m1', 1000, 5, 'convA', 294),
      mkSeq('x1', 7000, 5, 'convX', 2, { model: 'claude-opus-4-8', isCompacted: true }),
      mkSeq('m2', 13000, 5, 'convA', 296),
      mkSeq('y1', 19000, 5, 'convY', 2, { model: 'claude-opus-4-8' }),
      mkSeq('m3', 25000, 5, 'convA', 298),
      mkSeq('x2', 31000, 5, 'convX', 5, { model: 'claude-opus-4-8' }),
      mkSeq('m4', 37000, 5, 'convA', 300),
    ], []);
    assert.equal(ids(lanes[0]), 'm1,m2,m3,m4');
    for (var i = 0; i < lanes[0].turns.length; i++)
      assert.equal(lanes[0].turns[i].model, 'claude-opus-4-6', 'main must be model-pure after the split');
    assert.equal(lanes.length, 3); // main + convX lane + convY lane
    assertSerialLanes(lanes);
  });

  it('live path: R1 bracket retro-moves out of main when the trunk conv returns', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [mkSeq('a1', 1000, 5, 'convA', 10)];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.wfAddEntry(mkSeq('a2', 7000, 5, 'convA', 12));
    ctx.wfAddEntry(mkSeq('b1', 13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }));
    ctx.wfAddEntry(mkSeq('b2', 19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }));
    // provisional: foreign-conv turns sit in main until the trunk returns
    assert.equal(ctx.wfState.lanes[0].turns.length, 4);
    var res = ctx.wfAddEntry(mkSeq('a3', 25000, 5, 'convA', 14));
    assert.equal(res.lanesChanged, true);
    assert.equal(ids(ctx.wfState.lanes[0]), 'a1,a2,a3');
    var sub = ctx.wfState.lanes.find(function(l) { return l.key !== 'main' && l.turns.length; });
    assert.equal(ids(sub), 'b1,b2');
    // turnIndex must follow the retro-move (ADR 0003-style consistency)
    assert.equal(ctx.wfState.turnIndex.get('b1').laneIdx, ctx.wfState.lanes.indexOf(sub));
    assertSerialLanes(ctx.wfState.lanes);
  });

  it('live path: R2 dip routes to the frontier lane immediately (no retro needed)', () => {
    const ctx = loadWfModule();
    ctx.allEntries = [
      mkSeq('m1', 1000, 5, 'convA', 53),
      mkSeq('m2', 10000, 60, 'convA', 55),
      mkSeq('f1', 20000, 5, 'convA', 51),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.lanes.length, 2, 'overlap already split f1');
    ctx.wfAddEntry(mkSeq('f2', 71000, 5, 'convA', 51));
    assert.equal(ids(ctx.wfState.lanes[1]), 'f1,f2');
    ctx.wfAddEntry(mkSeq('m3', 80000, 5, 'convA', 57));
    assert.equal(ids(ctx.wfState.lanes[0]), 'm1,m2,m3');
    assertSerialLanes(ctx.wfState.lanes);
  });

  it('batch/live equivalence: incremental feed (with retro) matches one-shot wfInferLanes', () => {
    const ctx = loadWfModule();
    var entries = [
      mkSeq('a1', 1000, 5, 'convA', 10),
      mkSeq('a2', 7000, 5, 'convA', 12),
      mkSeq('b1', 13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }),
      mkSeq('b2', 19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }),
      mkSeq('a3', 25000, 60, 'convA', 14),   // long turn 25000..85000
      mkSeq('f1', 30000, 5, 'convA', 13),    // overlaps a3 → parallel
      mkSeq('f2', 86000, 5, 'convA', 13),    // sequential fork continuation (dip)
      mkSeq('a4', 90000, 5, 'convA', 16),
    ];
    function sig(lanes) {
      return lanes.filter(function(l) { return l.turns.length; })
        .map(function(l) { return l.turns.map(function(t) { return t.id; }).sort().join(','); })
        .sort().join('|');
    }
    var batch = ctx.wfInferLanes(entries.slice(), []);
    const ctx2 = loadWfModule();
    ctx2.allEntries = entries.slice(0, 1);
    ctx2.wfState = ctx2.wfBuildState('s1');
    for (var i = 1; i < entries.length; i++) ctx2.wfAddEntry(entries[i]);
    assert.equal(sig(ctx2.wfState.lanes), sig(batch));
    assertSerialLanes(ctx2.wfState.lanes);
  });

  it('legacy data without convId is inert: no boundaries, nothing moved', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 5, { msgCount: 40 }),
      mkEntry('t2', 's1', 'claude-opus-4-6', 7000, 5, { msgCount: 10 }),
      mkEntry('t3', 's1', 'claude-opus-4-6', 13000, 5, { msgCount: 42 }),
    ], []);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].turns.length, 3);
  });
});

// ── #230 codex P2 (round 1): arrival order must not poison the seq tracker ──
// Entries arrive in COMPLETION order. A nested turn (starts later, finishes
// first) arrives before the long turn that contains it — if the tracker
// derived run structure from arrival order, a foreign-conv turn arriving
// first would become the trunk and no bracket would ever close.
describe('#230 seq tracker arrival-order independence (codex P2)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }
  function mainIds(lanes) {
    return lanes[0].turns.map(function(t) { return t.id; }).sort().join(',');
  }
  function nonMainIds(lanes) {
    var out = [];
    for (var i = 1; i < lanes.length; i++)
      for (var j = 0; j < lanes[i].turns.length; j++) out.push(lanes[i].turns[j].id);
    return out.sort().join(',');
  }

  it('early-arriving nested foreign conv cannot become the trunk (fail-on-old)', () => {
    const ctx = loadWfModule();
    // b1 is nested inside a1's span and completes first → arrives first
    var b1 = mkSeq('b1', 13000, 5, 'convB', 4, { model: 'claude-sonnet-5' });
    var a1 = mkSeq('a1', 1000, 60, 'convA', 10); // 1000..61000, arrives second
    var a2 = mkSeq('a2', 62000, 5, 'convA', 12);
    ctx.allEntries = [b1];
    ctx.wfState = ctx.wfBuildState('s1');
    // real caller contract: entry-rendering pushes to allEntries BEFORE
    // calling wfAddEntry (the reorder-rebuild path reads allEntries)
    ctx.allEntries.push(a1); ctx.wfAddEntry(a1);
    ctx.allEntries.push(a2); ctx.wfAddEntry(a2);
    assert.equal(mainIds(ctx.wfState.lanes), 'a1,a2', 'trunk must be conv A (chronologically first), not the first-arrived conv B');
    assert.equal(nonMainIds(ctx.wfState.lanes), 'b1');
    // and the batch rebuild agrees on classification
    var batch = ctx.wfInferLanes([b1, a1, a2], []);
    assert.equal(mainIds(batch), 'a1,a2');
    assert.equal(nonMainIds(batch), 'b1');
  });

  it('classification is arrival-order independent: completion-order == chronological == batch', () => {
    function fixture() {
      return {
        a1: mkSeq('a1', 1000, 60, 'convA', 10),  // 1000..61000
        b1: mkSeq('b1', 13000, 5, 'convB', 4, { model: 'claude-sonnet-5' }),
        b2: mkSeq('b2', 19000, 5, 'convB', 6, { model: 'claude-sonnet-5' }),
        a2: mkSeq('a2', 62000, 5, 'convA', 12),
        a3: mkSeq('a3', 68000, 5, 'convA', 14),
      };
    }
    function liveFeed(order) {
      const c = loadWfModule();
      var f = fixture();
      c.allEntries = [f[order[0]]];
      c.wfState = c.wfBuildState('s1');
      for (var i = 1; i < order.length; i++) { c.allEntries.push(f[order[i]]); c.wfAddEntry(f[order[i]]); }
      return c.wfState.lanes;
    }
    var completion = liveFeed(['b1', 'b2', 'a1', 'a2', 'a3']); // nested b's finish first
    var chrono = liveFeed(['a1', 'b1', 'b2', 'a2', 'a3']);
    const cb = loadWfModule();
    var f = fixture();
    var batch = cb.wfInferLanes([f.a1, f.b1, f.b2, f.a2, f.a3], []);
    assert.equal(mainIds(completion), 'a1,a2,a3');
    assert.equal(mainIds(chrono), mainIds(completion));
    assert.equal(mainIds(batch), mainIds(completion));
    assert.equal(nonMainIds(chrono), nonMainIds(completion));
    assert.equal(nonMainIds(batch), nonMainIds(completion));
  });
});

// ── #230 lane naming: Fork vs Teammate (owner visual review, 2026-07-11) ────
// Display-name only — lane keys and classification are untouched. A parallel
// lane whose convId appears in main = a same-conversation twin ("Fork");
// a convId main never ran = an independent conversation ("Teammate").
describe('#230 lane naming: Fork vs Teammate', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }

  it('same-conv overlap fork lane reads "Fork <conv> #k"', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('m1', 1000, 5, '5212b91b', 53),
      mkSeq('m2', 10000, 60, '5212b91b', 55),
      mkSeq('f1', 20000, 5, '5212b91b', 51),   // overlap-split fork
      mkSeq('f2', 71000, 5, '5212b91b', 51),   // R2-stitched continuation
      mkSeq('m3', 80000, 5, '5212b91b', 57),
    ], []);
    assert.equal(lanes.length, 2);
    var mainConvs = ctx._wfMainConvSet(lanes);
    assert.equal(ctx._wfLaneDispName(lanes[1], 1, mainConvs), 'Fork 5212');
  });

  it('foreign-conv R1 excursion lane reads "Teammate <conv> #k"', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('a1', 1000, 5, 'aaaa1111', 10),
      mkSeq('a2', 7000, 5, 'aaaa1111', 12),
      mkSeq('b1', 13000, 5, 'f4ef1004', 4, { model: 'claude-sonnet-5' }),
      mkSeq('b2', 19000, 5, 'f4ef1004', 6, { model: 'claude-sonnet-5' }),
      mkSeq('a3', 25000, 5, 'aaaa1111', 14),
    ], []);
    assert.equal(lanes.length, 2);
    var mainConvs = ctx._wfMainConvSet(lanes);
    assert.equal(ctx._wfLaneDispName(lanes[1], 1, mainConvs), 'Teammate f4ef');
    // main lane name untouched
    assert.equal(ctx._wfLaneDispName(lanes[0], 0, mainConvs), 'main');
  });
});

// ── #230 codex P2 (round 3): per-conv frontiers — no FIFO eviction ──────────
// tails used to be a single 16-entry FIFO: after 16 split turns, an older
// but still-active fork frontier was evicted and its sequential
// continuation could no longer satisfy R2, silently staying in main.
describe('#230 seq tracker per-conv frontiers (codex P2 round 3)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }

  it('fork frontier survives 17 intervening split turns of other convs (fail-on-old)', () => {
    const ctx = loadWfModule();
    var entries = [
      mkSeq('m1', 1000, 5, 'convA', 53),
      mkSeq('m2', 10000, 60, 'convA', 55),   // 10000..70000
      mkSeq('f1', 20000, 5, 'convA', 51),    // overlap-split → frontier for convA
    ];
    // 17 agent-keyed split turns, each its own conv — the old shared FIFO
    // (cap 16) evicted convA's frontier here
    for (var i = 1; i <= 17; i++) {
      entries.push(mkSeq('w' + i, 25000 + i * 1000, 0.5, 'w' + i, 3,
        { agentKey: 'web-search', agentLabel: 'Web Search' }));
    }
    entries.push(mkSeq('f2', 71000, 5, 'convA', 51));  // sequential fork continuation
    entries.push(mkSeq('m3', 80000, 5, 'convA', 57));
    var lanes = ctx.wfInferLanes(entries, []);
    var forkLane = lanes.find(function(l) { return (l.key || '').indexOf('parallel-') === 0; });
    assert.equal(forkLane.turns.map(function(t) { return t.id; }).join(','), 'f1,f2',
      'the dip must still stitch onto its frontier after 17 unrelated split turns');
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2,m3');
  });

  it('same-conv concurrent forks keep separate frontiers; continuations stitch their own track', () => {
    const ctx = loadWfModule();
    var tr = ctx.wfCreateSeqTracker();
    ctx.wfSeqFeedMain(tr, { id: 'm1', convId: 'A', msgCount: 55, receivedAt: 1000, elapsed: 5 });
    ctx.wfSeqFeedSplit(tr, { convId: 'A', msgCount: 51, receivedAt: 20000, elapsed: 5 });  // track F1
    ctx.wfSeqFeedSplit(tr, { convId: 'A', msgCount: 45, receivedAt: 21000, elapsed: 5 });  // track F2
    var fr = tr.tails.get('A');
    assert.equal(fr.length, 2, 'two concurrent tracks → two frontiers');
    var r1 = ctx.wfSeqFeedMain(tr, { id: 'c1', convId: 'A', msgCount: 53, receivedAt: 30000, elapsed: 5 });
    assert.equal(r1.place, 'excursion', 'F1 continuation stitches');
    var r2 = ctx.wfSeqFeedMain(tr, { id: 'c2', convId: 'A', msgCount: 45, receivedAt: 31000, elapsed: 5 });
    assert.equal(r2.place, 'excursion', 'F2 continuation stitches');
    // each continuation advanced its own frontier — no cross-stealing
    assert.equal(fr.map(function(f) { return f.msg; }).sort().join(','), '45,53');
  });
});

// ── #230 re-audit regression: tail points are append-only, never merged ─────
// A fork branches concurrent tracks from the same historical msgCount. The
// merge variant (069246a) folded a later "continuation" split (53) into the
// branch point (51), erasing it — the other track's sequential continuation
// (dip 51) could no longer stitch and stayed in main (439-session re-audit:
// jumpreturn residue 3→8, sessions f38af1fd/a5d66419/67f906d9).
describe('#230 append-only tail points (re-audit regression)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }

  it('historical branch point survives a later continuation split (fail-on-old)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('m1', 1000, 5, 'convA', 53),
      mkSeq('m2', 10000, 60, 'convA', 55),   // 10000..70000
      mkSeq('s1', 20000, 5, 'convA', 51),    // overlap-split: branch point 51
      mkSeq('s2', 30000, 6, 'convA', 53),    // overlap-split: same-track continuation
      mkSeq('d1', 71000, 5, 'convA', 51),    // other track's sequential continuation
      mkSeq('m3', 80000, 5, 'convA', 57),
    ], []);
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2,m3',
      'dip 51 must stitch onto the preserved branch point, not stay in main');
    var forkLane = lanes.find(function(l) { return (l.key || '').indexOf('parallel-') === 0; });
    assert.equal(forkLane.turns.map(function(t) { return t.id; }).join(','), 's1,s2,d1');
  });
});

// ── #230 codex P2 (round 4): frontier TTL — stale branch points retire ──────
// Real stitch gaps: p50=22s, p90=3min, every verified-good stitch ≤2min
// (439-session audit). A dip landing on a branch point from an hour ago is
// an edit/rewind collision, not a fork continuation.
describe('#230 frontier TTL (codex P2 round 4)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }

  it('a dip 16 minutes after the frontier ended does not stitch — stays in main (fail-on-old)', () => {
    const ctx = loadWfModule();
    var lanes = ctx.wfInferLanes([
      mkSeq('m1', 1000, 5, 'convA', 53),
      mkSeq('m2', 10000, 60, 'convA', 55),                 // 10000..70000
      mkSeq('s1', 20000, 5, 'convA', 51),                  // overlap-split → frontier ends 25000
      mkSeq('d1', 25000 + 16 * 60 * 1000, 5, 'convA', 51), // 16min later: rewind-shaped
      mkSeq('m3', 25000 + 17 * 60 * 1000, 5, 'convA', 57),
    ], []);
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2,d1,m3',
      'a 16-minute-later dip is an edit/rewind, not a fork continuation');
    var forkLane = lanes.find(function(l) { return (l.key || '').indexOf('parallel-') === 0; });
    assert.equal(forkLane.turns.map(function(t) { return t.id; }).join(','), 's1');
  });
});

// ── #230 codex P2 (round 5): closed excursions can be overturned via rebuild ─
// Live arrival A-B-A closes the B bracket (B retro-moved). Then B0 — same
// conv as B, starts earliest, spans A's turn — arrives late: chronological
// truth is B0-A-B-A, trunk is conv B, and the excursion is A. Closed turns
// left the tracker list, so the live path falls back to a full wfBuildState
// rebuild whenever an arrival lands before the list tail.
describe('#230 late-arrival overturns closed excursion (codex P2 round 5)', () => {
  function mkSeq(id, at, elapsed, conv, msg, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', convId: conv, msgCount: msg }, opts || {}));
  }
  function sig(lanes) {
    return lanes.filter(function(l) { return l.turns.length; })
      .map(function(l) { return l.turns.map(function(t) { return t.id; }).sort().join(','); })
      .sort().join('|');
  }

  it('span-all same-conv turn arriving after the bracket closed: live == batch (fail-on-old)', () => {
    const ctx = loadWfModule();
    var B0 = mkSeq('B0', 1000, 136, 'convB', 8);    // 1000..137000, arrives LAST
    var A1 = mkSeq('A1', 130000, 5, 'convA', 10);   // nested inside B0's span
    var B1 = mkSeq('B1', 140000, 5, 'convB', 12);
    var A2 = mkSeq('A2', 150000, 5, 'convA', 12);
    ctx.allEntries = [A1];
    ctx.wfState = ctx.wfBuildState('s1');
    ctx.allEntries.push(B1); ctx.wfAddEntry(B1);
    ctx.allEntries.push(A2); ctx.wfAddEntry(A2);
    // A-B-A prefix: B1 was retro-moved out of main
    assert.equal(ctx.wfState.lanes[0].turns.map(function(t) { return t.id; }).join(','), 'A1,A2');
    // user view state that the rebuild must migrate
    ctx.wfState.selectedTurnId = 'A2';
    ctx.wfState.laneFocusMode = true;
    ctx.wfState.viewT0 = 130000; ctx.wfState.viewT1 = 140000;
    ctx.allEntries.push(B0);
    var res = ctx.wfAddEntry(B0);
    assert.equal(res.lanesChanged, true);
    // chronological truth: trunk = conv B; A1 is the excursion (overlap with
    // B0); B1 rejoins main; A2 (trunk-advance pending tail) stays main
    assert.equal(ctx.wfState.lanes[0].turns.map(function(t) { return t.id; }).join(','), 'B0,B1,A2');
    var batch = loadWfModule().wfInferLanes([A1, B1, A2, B0], []);
    assert.equal(sig(ctx.wfState.lanes), sig(batch), 'live after rebuild must equal the batch pass');
    // migrated view state survives the wholesale wfState swap
    assert.equal(ctx.wfState.selectedTurnId, 'A2');
    assert.equal(ctx.wfState.laneFocusMode, true);
    assert.equal(ctx.wfState.viewT0, 130000);
    assert.equal(ctx.wfState.viewT1, 140000);
  });
});

// ── #258 coreHash identity routing ────────────────────────────────────────
describe('#258 coreHash identity routing', () => {
  function mkMain(id, at, elapsed, opts) {
    return mkEntry(id, 's1', 'claude-opus-4-6', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', coreHash: '85771', convId: 'ebffe2' }, opts || {}));
  }
  function mkTeammate(id, at, elapsed, convId, opts) {
    return mkEntry(id, 's1', 'claude-sonnet-5', at, elapsed, Object.assign(
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator', coreHash: 'e6aa4', convId: convId || '56a5def0' }, opts || {}));
  }

  it('teammates with same agentKey but different coreHash get identity lanes', () => {
    const ctx = loadWfModule();
    var m1 = mkMain('m1', 1000, 5);
    var m2 = mkMain('m2', 6000, 5);
    var m3 = mkMain('m3', 11000, 5);
    var t1 = mkTeammate('t1', 2000, 3, '56a5def0');
    var t2 = mkTeammate('t2', 6000, 3, '56a5def0');
    var t3 = mkTeammate('t3', 9000, 3, '56a5def0');
    var lanes = ctx.wfInferLanes([m1, m2, m3, t1, t2, t3], []);
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2,m3');
    var teamLane = lanes.find(function(l) { return l.key === 'agent-orchestrator:56a5def0'; });
    assert.ok(teamLane, 'expected an agent-orchestrator:56a5def0 lane');
    assert.equal(teamLane.turns.map(function(t) { return t.id; }).join(','), 't1,t2,t3');
  });

  it('multiple teammate convIds get separate lanes', () => {
    const ctx = loadWfModule();
    var m1 = mkMain('m1', 1000, 5);
    var t1 = mkTeammate('t1', 2000, 3, '56a5def0');
    var t2 = mkTeammate('t2', 6000, 3, '56a5def0');
    var t3 = mkTeammate('t3', 3000, 3, '16f4abcd');
    var t4 = mkTeammate('t4', 7000, 3, '16f4abcd');
    var lanes = ctx.wfInferLanes([m1, t1, t2, t3, t4], []);
    var lane56a5 = lanes.find(function(l) { return l.key === 'agent-orchestrator:56a5def0'; });
    var lane16f4 = lanes.find(function(l) { return l.key === 'agent-orchestrator:16f4abcd'; });
    assert.ok(lane56a5, 'expected 56a5def0 lane');
    assert.ok(lane16f4, 'expected 16f4abcd lane');
    assert.equal(lane56a5.turns.map(function(t) { return t.id; }).join(','), 't1,t2');
    assert.equal(lane16f4.turns.map(function(t) { return t.id; }).join(','), 't3,t4');
  });

  it('forks (same coreHash) still use overlap detection', () => {
    const ctx = loadWfModule();
    var m1 = mkMain('m1', 1000, 30);   // 1000..31000
    var f1 = mkMain('f1', 10000, 5);   // nested inside m1's span, same coreHash+convId
    var m2 = mkMain('m2', 31000, 5);
    var lanes = ctx.wfInferLanes([m1, f1, m2], []);
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2',
      'fork must not be absorbed by identity routing — same coreHash as main');
    var forkLane = lanes.find(function(l) { return (l.key || '').indexOf('parallel-') === 0; });
    assert.ok(forkLane, 'expected the fork to land in a parallel- lane via ADR 0008 overlap');
    assert.equal(forkLane.turns.map(function(t) { return t.id; }).join(','), 'f1');
  });

  it('null coreHash falls through (backward compat)', () => {
    const ctx = loadWfModule();
    var m1 = mkMain('m1', 1000, 5);
    var m2 = mkMain('m2', 6000, 5);
    // legacy entry: main-agent key, but no coreHash/convId captured
    var legacy = mkEntry('legacy1', 's1', 'claude-sonnet-5', 11000, 3,
      { agentKey: 'orchestrator', agentLabel: 'Orchestrator' });
    var lanes = ctx.wfInferLanes([m1, m2, legacy], []);
    assert.equal(lanes.length, 1, 'no identity lane should be created without coreHash/convId');
    assert.equal(lanes[0].turns.map(function(t) { return t.id; }).join(','), 'm1,m2,legacy1');
  });

  it('ADR-0005: wfBuildState computes mainCoreHash/mainConvIds for entry-rendering to share', () => {
    const ctx = loadWfModule();
    var m1 = mkMain('m1', 1000, 5);
    var m2 = mkMain('m2', 6000, 5);
    var t1 = mkTeammate('t1', 2000, 3, '56a5def0');
    ctx.allEntries = [m1, m2, t1];
    ctx.sessionsMap.set('s1', { entries: [] });
    var state = ctx.wfBuildState('s1');
    assert.equal(state.mainCoreHash, '85771');
    assert.ok(state.mainConvIds.has('ebffe2'));
    assert.ok(!state.mainConvIds.has('56a5def0'));
  });

  it('upgrade/noise: ≠coreHash but same convId stays main (convId AND-guard)', () => {
    const ctx = loadWfModule();
    // Mid-session coreHash divergence (e.g. #218/#219 bugs) but SAME convId as main
    // → convId ∈ mainConvIds → AND-guard blocks early-exit → stays main
    var entries = [
      mkMain('m1', 1000, 5),
      mkMain('m2', 6000, 5),
      mkEntry('noise', 's1', 'claude-opus-4-6', 11000, 3,
        { agentKey: 'orchestrator', coreHash: 'fffff', convId: 'ebffe2' }), // ≠coreHash, same convId
      mkMain('m3', 14000, 5),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.equal(lanes[0].turns.length, 4, 'noise entry must stay main — convId matches');
    assert.ok(lanes[0].turns.some(function(t) { return t.id === 'noise'; }));
  });

  it('null convId with non-null coreHash falls through (backward compat)', () => {
    const ctx = loadWfModule();
    var entries = [
      mkMain('m1', 1000, 5),
      // Different coreHash but no convId → early-exit cannot fire
      mkEntry('t1', 's1', 'claude-sonnet-5', 6000, 3,
        { agentKey: 'orchestrator', coreHash: 'e6aa4', convId: null }),
      mkMain('m2', 9000, 5),
    ];
    var lanes = ctx.wfInferLanes(entries, []);
    assert.ok(lanes[0].turns.some(function(t) { return t.id === 't1'; }),
      'entry without convId falls through to main');
  });

  it('live wfAddEntry routes teammate to identity lane', () => {
    const ctx = loadWfModule();
    // Build initial state with main entries
    ctx.allEntries = [
      mkMain('m1', 1000, 5),
      mkMain('m2', 6000, 5),
    ];
    ctx.sessionsMap.set('s1', { entries: [] });
    ctx.wfState = ctx.wfBuildState('s1');
    assert.equal(ctx.wfState.mainCoreHash, '85771');

    // Live: add a teammate entry
    var t1 = mkTeammate('t1', 8000, 3, '56a5def0');
    ctx.allEntries.push(t1);
    var result = ctx.wfAddEntry(t1);
    assert.ok(result.lanesChanged, 'new lane created');
    var tmLane = ctx.wfState.lanes.find(function(l) { return l.key === 'agent-orchestrator:56a5def0'; });
    assert.ok(tmLane, 'teammate routed to identity lane via wfAddEntry');
    assert.equal(tmLane.turns.length, 1);
    assert.equal(tmLane.turns[0].id, 't1');
  });

  it('_wfLaneDispName: identity-routed teammate shows Teammate label', () => {
    const ctx = loadWfModule();
    var lane = { key: 'agent-orchestrator:56a5def0', agentKey: 'orchestrator', name: 'orchestrator', convId: '56a5def0', turns: [] };
    var mainConvs = new Set(['ebffe2']);
    var name = ctx._wfLaneDispName(lane, 1, mainConvs);
    assert.ok(name.indexOf('Teammate') === 0, 'expected label to start with Teammate, got: ' + name);
    assert.ok(name.indexOf('56a5') !== -1, 'expected convId prefix in label, got: ' + name);
  });
});
