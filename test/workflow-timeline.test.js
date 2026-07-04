'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

// Load workflow-timeline.js in a browser-like global context
function loadWfModule() {
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
  };
  vm.createContext(ctx);
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
      mkEntry('t2', 's1', 'claude-opus-4-6', 3000, 5, { cost: 0.05 }),
      mkEntry('t3', 's1', 'claude-opus-4-6', 5000, 5, { cost: 0.09 }),
    ];
    ctx.wfState = ctx.wfBuildState('s1');
    var lane = ctx.wfState.lanes[0];
    assert.equal(ctx.wfLaneCostMedian(lane), 0.05);
    ctx.wfAddEntry(mkEntry('t4', 's1', 'claude-opus-4-6', 7000, 5, { cost: 0.2 }));
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
      mkEntry('t1', 's1', 'claude-opus-4-6', 1000, 100, {}),
      mkEntry('t2', 's1', 'claude-opus-4-6', 51000, 100, {}),
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
