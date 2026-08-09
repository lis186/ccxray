'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const weatherSrc = fs.readFileSync(path.join(publicDir, 'weather.js'), 'utf8');

function element() {
  return {
    style: {}, dataset: {}, innerHTML: '', textContent: '', className: '',
    offsetWidth: 0, offsetHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, insertBefore() {}, insertAdjacentHTML() {},
    setAttribute() {}, querySelector: () => element(), querySelectorAll: () => [], remove() {},
  };
}

function storage(stored) {
  return {
    getItem: (key) => key === 'ccxray-weather-display' ? stored ?? null : null,
    setItem() {},
  };
}

function loadWeatherDisplay(opts = {}) {
  const context = {
    URLSearchParams,
    location: { search: opts.search || '' },
    localStorage: storage(opts.stored),
  };
  vm.createContext(context);
  vm.runInContext(weatherSrc, context);
  return context;
}

function loadMillerDisplay(stored) {
  const context = {
    console,
    window: {},
    document: {
      getElementById: () => element(), createElement: () => element(),
      querySelector: () => element(), querySelectorAll: () => [],
      addEventListener() {}, body: element(),
    },
    localStorage: storage(stored), sessionStorage: storage(null),
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`
    function updateSysPromptBadge() {}
    function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; }
    function setInterval() { return 0; }
    function clearInterval() {}
    window.ccxraySettings = { visibleProviders: [], autoCompactPct: 0.835 };
    function _apiQ(url) { return url; }
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  for (const file of ['session-label.js', 'format.js', 'weather.js', 'miller-columns.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context);
  }
  return context;
}

function loadWorkflowDisplay(stored) {
  const context = {
    console,
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
    document: {
      createElement: () => element(), createElementNS: () => element(),
      getElementById: () => null, body: element(), documentElement: {},
    },
    localStorage: storage(stored), location: { search: '' }, URLSearchParams,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
    allEntries: [], sessionsMap: new Map(),
    colTurns: { clientWidth: 600, appendChild() {}, querySelectorAll: () => [] },
    colSections: { innerHTML: '' }, colDetail: { innerHTML: '' },
    selectTurn() {}, isHttpStatusOk: (status) => status === 101 || (status >= 200 && status < 300),
    selectedSessionId: null, Set, Map,
  };
  vm.createContext(context);
  for (const file of ['agent-classification.js', 'format.js', 'weather.js', 'workflow-timeline.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context);
  }
  return context;
}

function weatherTurn() {
  return {
    id: 'turn-1', sessionId: 'session-1', model: 'claude-opus-4-6',
    receivedAt: 1000, elapsed: 5, maxContext: 200000, ctxUsed: 180000,
    usage: {
      input_tokens: 180000, output_tokens: 1000,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
    turnToolCalls: { Bash: 1 }, toolCalls: { Bash: 1 },
    stopReason: 'tool_use', toolFail: true, status: 200, cost: 0.01,
    displayNum: 1, agentKey: 'orchestrator', agentLabel: 'Orchestrator',
  };
}

function renderAllSites(stored) {
  const miller = loadMillerDisplay(stored);
  const sessionHtml = miller.renderSessionItem({
    model: 'claude-opus-4-6', count: 1, retryCount: 0, totalCost: 0,
    firstReceivedAt: 0, latestMainCtxUsed: 0,
    weather: { level: 'rainy', emoji: '🌧️', tooltip: 'Needs attention' },
  }, 'session-1', null);

  const workflow = loadWorkflowDisplay(stored);
  const turn = weatherTurn();
  const lane = {
    key: 'main', name: 'main', agentLabel: 'Orchestrator',
    spawnParent: null, turns: [turn],
  };
  workflow.wfState = {
    sessionId: 'session-1', lanes: [lane], selectedLane: lane,
    selectionLevel: 'L1', selectedSection: 'timeline',
  };
  workflow.sessionsMap.set('session-1', {
    toolCalls: { Bash: 1 }, toolFailKnownTurns: 1, toolFailTurns: 1,
    inputTokens: 180000, outputTokens: 1000,
  });

  const laneSvg = workflow.wfRenderLaneSvg(lane, 0, 600, (value) => value, new Set());
  workflow._wfShowTooltip({ clientX: 0, clientY: 0 }, turn, lane);
  const tooltipHtml = workflow._wfTooltipEl.innerHTML;

  const panel = element();
  workflow.document.getElementById = (id) => id === 'wf-agent-card-panel' ? panel : null;
  workflow.wfRenderAgentCard(lane);
  const agentHtml = panel.innerHTML;
  workflow.wfRenderTurnCard(turn);

  return { sessionHtml, laneSvg, tooltipHtml, agentHtml, turnHtml: panel.innerHTML };
}

describe('#484 weather display toggle', () => {
  it('defaults to OFF when no preference or URL override is present', () => {
    const ctx = loadWeatherDisplay();
    assert.equal(ctx.weatherDisplayEnabled(), false);
  });

  it("enables display when the stored preference is 'on'", () => {
    const ctx = loadWeatherDisplay({ stored: 'on' });
    assert.equal(ctx.weatherDisplayEnabled(), true);
  });

  it("keeps display disabled for stored 'off' and unknown values", () => {
    assert.equal(loadWeatherDisplay({ stored: 'off' }).weatherDisplayEnabled(), false);
    assert.equal(loadWeatherDisplay({ stored: 'unexpected' }).weatherDisplayEnabled(), false);
  });

  it('lets weather=on temporarily override a stored OFF preference', () => {
    const ctx = loadWeatherDisplay({ stored: 'off', search: '?weather=on' });
    assert.equal(ctx.weatherDisplayEnabled(), true);
  });

  it('accepts the debugLoad-style weather=1 one-shot override', () => {
    const ctx = loadWeatherDisplay({ stored: 'off', search: '?weather=1' });
    assert.equal(ctx.weatherDisplayEnabled(), true);
  });

  it('lets weather=0 temporarily override a stored ON preference', () => {
    const ctx = loadWeatherDisplay({ stored: 'on', search: '?weather=0' });
    assert.equal(ctx.weatherDisplayEnabled(), false);
  });
});

describe('#484 weather render gates', () => {
  it('hides all six weather/failure displays by default without hiding neighboring content', () => {
    const rendered = renderAllSites(null);

    assert.doesNotMatch(rendered.sessionHtml, /si-weather/);
    assert.match(rendered.sessionHtml, /opus-4-6/);
    assert.match(rendered.sessionHtml, /1t/);

    assert.doesNotMatch(rendered.laneSvg, /foreignObject/);
    assert.match(rendered.laneSvg, /main/);

    assert.doesNotMatch(rendered.tooltipHtml, />Health</);
    assert.match(rendered.tooltipHtml, />Context</);

    assert.doesNotMatch(rendered.agentHtml, /data-weather/);
    assert.doesNotMatch(rendered.agentHtml, /Turn failure rate/);
    assert.match(rendered.agentHtml, /1 turns/);

    assert.doesNotMatch(rendered.turnHtml, /data-weather/);
    assert.match(rendered.turnHtml, /#1/);
  });

  it('restores all six displays when the stored preference is ON', () => {
    const rendered = renderAllSites('on');

    assert.match(rendered.sessionHtml, /si-weather/);
    assert.match(rendered.laneSvg, /<foreignObject[^>]*>.*data-weather/);
    assert.match(rendered.tooltipHtml, />Health</);
    assert.match(rendered.agentHtml, /data-weather/);
    assert.match(rendered.agentHtml, /Turn failure rate/);
    assert.match(rendered.turnHtml, /data-weather/);
  });
});
