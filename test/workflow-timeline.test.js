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
      // compact-style request: isSubagent flag but orchestrator prompt → main
      mkEntry('t3', 's1', 'claude-fable-5', 8000, 2, { agentKey: 'orchestrator', agentLabel: 'Orchestrator', isSubagent: true }),
      mkEntry('t4', 's1', 'claude-haiku-4-5', 9000, 2, { agentKey: 'explore', agentLabel: 'Explore', isSubagent: true }),
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
    const lane = ctx.wfState.lanes[0];
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

// ── #142: workflow ctx zone color must share the >80/>=40 band contract ──────
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
