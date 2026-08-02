'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load format.js in a VM context to test browser globals
function loadFormatModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'format.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx;
}

// Reuse the retry-grouping.test.js VM harness pattern — loads the real
// entry-rendering.js so addEntry / _patchEntryInPlace are the shipped code.
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
  vm.runInContext(`
    function updateSysPromptBadge() {}
    function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; }
    function setInterval() { return 0; }
    function clearInterval() {}
    window.ccxraySettings = { visibleProviders: [] };
    function _apiQ(url) { return url; }
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
    var wfState = { sessionId: null, mainCoreHash: null, mainConvIds: new Set() };
    function wfBuildState() {}
    function renderNotifyButton() {}
    function prepareTimelineSteps() {}
    function requestAnimationFrame(cb) { cb(); }
    function renderProjectsCol() {}
    function renderSessionsCol() {}
    var currentSteps = [];
    var selectedEntryId = null;
    function layoutMinimapBlocks() {}
    function initMinimapInteractions() {}
    function renderSectionsCol() {}
    function ResizeObserver() { this.observe = function(){}; this.disconnect = function(){}; }
    function wfAddEntry() { return { lanesChanged: false }; }
    function wfRenderTimeline() {}
    function wfDeferRender() {}
  `, context);
  for (const f of ['format.js', 'session-label.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.addEntry = addEntry;
    this._patchEntryInPlace = _patchEntryInPlace;
    _loading = true;
  `, context);
  return context;
}

function makeEntry(overrides) {
  return {
    id: '2026-08-02T10-00-00-000', ts: '10:00:00', model: 'claude-opus-4-6',
    status: 200, elapsed: '5.0', method: 'POST', sessionId: 'sess-conf-test',
    usage: { input_tokens: 5000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    maxContext: 200000, isSubagent: false, sessionInferred: false,
    toolCalls: {}, provider: 'anthropic', receivedAt: Date.now(),
    ...overrides,
  };
}

describe('#420 Phase 2: cost confidence UI', () => {
  describe('formatCostText', () => {
    const { formatCostText } = loadFormatModule();

    it('exact confidence → normal $', () => {
      assert.equal(formatCostText(0.1234, 'exact'), '$0.1234');
    });

    it('prefix confidence → normal $', () => {
      assert.equal(formatCostText(0.1234, 'prefix'), '$0.1234');
    });

    it('fallback confidence → ~$ prefix', () => {
      assert.equal(formatCostText(0.5678, 'fallback'), '~$0.5678');
    });

    it('unknown confidence → —', () => {
      assert.equal(formatCostText(null, 'unknown'), '—');
    });

    it('null confidence (legacy data) → normal $', () => {
      assert.equal(formatCostText(0.1234, null), '$0.1234');
    });

    it('undefined confidence (legacy data) → normal $', () => {
      assert.equal(formatCostText(0.1234, undefined), '$0.1234');
    });

    it('respects decimal override', () => {
      assert.equal(formatCostText(0.1234, 'exact', 2), '$0.12');
      assert.equal(formatCostText(0.1234, 'fallback', 2), '~$0.12');
    });

    it('cost null + confidence null → —', () => {
      assert.equal(formatCostText(null, null), '—');
    });

    it('cost zero + exact → $0.0000', () => {
      assert.equal(formatCostText(0, 'exact'), '$0.0000');
    });
  });

  describe('formatCost (HTML version)', () => {
    const { formatCost } = loadFormatModule();

    it('fallback → span with title tooltip', () => {
      const html = formatCost(0.1234, 'fallback');
      assert.ok(html.includes('~$0.1234'), 'should have ~$ prefix');
      assert.ok(html.includes('title='), 'should have title attribute');
    });

    it('exact → span without title', () => {
      const html = formatCost(0.1234, 'exact');
      assert.ok(html.includes('$0.1234'));
      assert.ok(!html.includes('title='), 'should not have title attribute');
    });

    it('unknown → — (no span wrapper)', () => {
      assert.equal(formatCost(null, 'unknown'), '—');
    });
  });

  describe('addEntry extracts costConfidence from real code', () => {
    it('exact confidence stored on allEntries entry', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ cost: { cost: 0.1234, rates: {}, confidence: 'exact' } }));
      const e = ctx.allEntries[ctx.allEntries.length - 1];
      assert.equal(e.cost, 0.1234);
      assert.equal(e.costConfidence, 'exact');
    });

    it('fallback confidence stored on allEntries entry', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ cost: { cost: 0.5678, rates: {}, confidence: 'fallback' } }));
      const e = ctx.allEntries[ctx.allEntries.length - 1];
      assert.equal(e.cost, 0.5678);
      assert.equal(e.costConfidence, 'fallback');
    });

    it('legacy bare-number cost → costConfidence null', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ cost: 0.1234 }));
      const e = ctx.allEntries[ctx.allEntries.length - 1];
      assert.equal(e.cost, 0.1234);
      assert.equal(e.costConfidence, null);
    });

    it('unknown confidence with null cost', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ cost: { cost: null, confidence: 'unknown' } }));
      const e = ctx.allEntries[ctx.allEntries.length - 1];
      assert.equal(e.cost, null);
      assert.equal(e.costConfidence, 'unknown');
    });
  });

  describe('_patchEntryInPlace preserves costConfidence (as-a-unit, real code)', () => {
    it('patches cost and confidence together', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ id: 'patch-test-1', cost: { cost: 0.1, confidence: 'exact' } }));
      ctx._patchEntryInPlace({ id: 'patch-test-1', cost: { cost: 0.2, confidence: 'fallback' } });
      const e = ctx.allEntries.find(x => x.id === 'patch-test-1');
      assert.equal(e.cost, 0.2);
      assert.equal(e.costConfidence, 'fallback');
    });

    it('null-cost patch does NOT poison existing confidence (fable MINOR-1)', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ id: 'patch-test-2', cost: { cost: 0.1234, confidence: 'exact' } }));
      ctx._patchEntryInPlace({ id: 'patch-test-2', cost: { cost: null, confidence: 'unknown' } });
      const e = ctx.allEntries.find(x => x.id === 'patch-test-2');
      assert.equal(e.cost, 0.1234, 'cost must not change');
      assert.equal(e.costConfidence, 'exact', 'confidence must not change');
    });

    it('bare-number patch preserves existing confidence', () => {
      const ctx = loadDashboardContext();
      ctx.addEntry(makeEntry({ id: 'patch-test-3', cost: { cost: 0.1, confidence: 'exact' } }));
      ctx._patchEntryInPlace({ id: 'patch-test-3', cost: 0.2 });
      const e = ctx.allEntries.find(x => x.id === 'patch-test-3');
      assert.equal(e.cost, 0.2);
      assert.equal(e.costConfidence, 'exact', 'confidence preserved');
    });
  });
});
