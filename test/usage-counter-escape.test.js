'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Usage counters come from response bodies and are not guaranteed numeric, so
// every formatted counter must reach HTML as text (entities only).
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const BAD = '<i a="1">&';
const BAD_ESC = '&lt;i a=&quot;1&quot;&gt;&amp;';
function assertNoRawChars(html) {
  assert.ok(!/<i a=/.test(html), html);
  assert.ok(html.includes(BAD_ESC), html);
}

function mkCtx(extra) {
  const ctx = Object.assign({
    console, Set, Map, URLSearchParams,
    window: { innerHeight: 800, innerWidth: 1200, addEventListener() {} },
    localStorage: { getItem: () => null },
    location: { search: '' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
    allEntries: [], sessionsMap: new Map(),
    isHttpStatusOk: (s) => s >= 200 && s < 300,
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(pub('agent-classification.js'), ctx);
  vm.runInContext(pub('format.js'), ctx);
  return ctx;
}

describe('usage counters: format helpers', () => {
  it('formats normal numbers as before', () => {
    const ctx = mkCtx();
    assert.equal(ctx.fmtNum(1234567), (1234567).toLocaleString());
    assert.equal(ctx.fmtNum(null, '—'), '—');
    assert.equal(ctx.fmtFixed(1.25, 1), (1.25).toFixed(1));
  });
  it('formats non-numeric counters as escaped text', () => {
    const ctx = mkCtx();
    assertNoRawChars(ctx.fmtNum(BAD));
    assert.equal(ctx.fmtFixed(BAD, 1), '?');
    assert.equal(ctx.fmtNum(NaN), '?');
  });
  it('context total ignores non-numeric counters', () => {
    const ctx = mkCtx();
    assert.equal(ctx.computeCtxUsed({ input_tokens: 5, output_tokens: BAD, cache_read_input_tokens: 10 }), 15);
  });
});

describe('usage counters: sections column', () => {
  function load() {
    const ctx = mkCtx();
    const src = pub('miller-columns.js');
    const a = src.indexOf('function fmt(');
    const b = src.indexOf('function cacheCreateParts(');
    const c = src.indexOf('\nfunction ', b + 1);
    assert.ok(a >= 0 && b > a && c > b);
    vm.runInContext(src.slice(a, src.indexOf('\n', a)), ctx);
    vm.runInContext(src.slice(b, c), ctx);
    return ctx;
  }
  it('keeps numeric output unchanged', () => {
    const ctx = load();
    assert.equal(ctx.fmt(12345), (12345).toLocaleString());
    assert.equal(ctx.fmt(undefined), '—');
    const parts = ctx.cacheCreateParts({ cache_creation_input_tokens: 15, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 } });
    assert.equal(parts[0], 'new <span data-cache-ttl="5m">5m 10</span> / <span data-cache-ttl="1h">1h 5</span>');
    assert.deepEqual(Array.from(ctx.cacheCreateParts({ cache_creation_input_tokens: 7 })), ['new 7']);
  });
  it('escapes non-numeric counters, including cache creation parts', () => {
    const ctx = load();
    assertNoRawChars(ctx.fmt(BAD));
    assertNoRawChars(ctx.cacheCreateParts({ cache_creation_input_tokens: BAD })[0]);
    assertNoRawChars(ctx.cacheCreateParts({ cache_creation_input_tokens: BAD, cache_creation: { ephemeral_5m_input_tokens: BAD, ephemeral_1h_input_tokens: 0 } }).join(''));
  });
});

describe('usage counters: workflow views', () => {
  function load() {
    const els = {};
    const mkEl = () => ({ style: {}, innerHTML: '', appendChild() {}, offsetWidth: 0, offsetHeight: 0 });
    const ctx = mkCtx({
      document: {
        createElement: mkEl, createElementNS: mkEl, body: { appendChild() {} }, documentElement: {},
        getElementById: (id) => els[id] || null,
      },
      colTurns: { clientWidth: 600, appendChild() {}, querySelectorAll: () => [] },
      colSections: { innerHTML: '' }, colDetail: { innerHTML: '' }, selectTurn() {},
    });
    ctx.__els = els;
    vm.runInContext(pub('workflow-timeline.js'), ctx);
    return ctx;
  }
  const badTurn = () => ({
    id: 't1', sessionId: 's', model: 'claude-x', receivedAt: 1000, elapsed: 1, maxContext: 200000,
    usage: { input_tokens: BAD, output_tokens: BAD, cache_read_input_tokens: BAD, cache_creation_input_tokens: BAD },
    status: BAD, displayNum: BAD, toolCalls: {}, cost: 0.01,
  });

  it('formats normal token counts unchanged', () => {
    const ctx = load();
    assert.equal(ctx._wfFmtTok(500), '500');
    assert.equal(ctx._wfFmtTok(1500), '1.5k');
    assert.equal(ctx._wfFmtSessTok(1500000), '1.5M');
    assert.equal(ctx._wfFmtSessTok(2500), '3K');
    assert.equal(ctx._wfFmtSessTok(0), '0');
  });
  it('formats non-numeric counters as escaped text', () => {
    const ctx = load();
    assertNoRawChars(ctx._wfFmtTok(BAD));
    assertNoRawChars(ctx._wfFmtSessTok(BAD));
    assert.equal(ctx._wfFmtSessTok(Infinity), '?');
  });
  it('tooltip escapes counters', () => {
    const ctx = load();
    const lane = { name: 'main', key: 'main', turns: [] };
    ctx._wfShowTooltip({ clientX: 0, clientY: 0 }, badTurn(), lane);
    const html = vm.runInContext('_wfTooltipEl.innerHTML', ctx);
    assertNoRawChars(html);
  });
  it('turn card and hover preview escape counters', () => {
    const ctx = load();
    const panel = { innerHTML: '', classList: { add() {}, remove() {} } };
    ctx.__els['wf-agent-card-panel'] = panel;
    const turn = badTurn();
    const lane = { name: 'main', key: 'main', turns: [turn] };
    vm.runInContext('wfState = Object.assign(wfState || {}, { selectedLane: null, lanes: [] });', ctx);
    ctx.__lane = lane;
    vm.runInContext('wfState.selectedLane = __lane;', ctx);
    ctx.wfRenderTurnCard(turn);
    assertNoRawChars(panel.innerHTML);
    const hp = ctx._wfRenderHoverPreview(turn, lane);
    if (typeof hp === 'string') assertNoRawChars(hp);
  });
  it('agent card session totals escape counters', () => {
    const ctx = load();
    const panel = { innerHTML: '', classList: { add() {}, remove() {} } };
    ctx.__els['wf-agent-card-panel'] = panel;
    const turn = badTurn();
    const lane = { name: 'main', key: 'main', turns: [turn] };
    ctx.sessionsMap.set('s', { inputTokens: BAD, outputTokens: BAD, cacheBreaks: 0 });
    ctx.__lane = lane;
    vm.runInContext("wfState = Object.assign(wfState || {}, { sessionId: 's', lanes: [__lane], selectedLane: __lane });", ctx);
    ctx.wfRenderAgentCard(lane);
    assertNoRawChars(panel.innerHTML);
  });
});
