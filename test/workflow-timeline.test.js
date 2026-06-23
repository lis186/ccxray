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
