'use strict';

// #267: the ctx breakdown category scale factor must use an INPUT-ONLY API total.
// buildContextCategories emits input-side categories only (System / Messages / Tools),
// so a denominator that includes output_tokens smears output proportionally into every
// category and inflates the tooltip/table numbers. The occupancy total and the
// "of window" label stay output-inclusive — that is #253's design.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');

function loadCtx() {
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
  `, context);
  for (const f of ['format.js', 'session-label.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  return context;
}

// Ground truth pinned by hand: the categories below sum to exactly 100,000.
const ESTIMATED_TOTAL = 100000;
const TOK = {
  contextBreakdown: {
    systemBreakdown: { coreInstructions: 20000, customSkills: 10000 },
    claudeMd: { globalClaudeMd: 5000, projectClaudeMd: 5000 },
    messageTokens: 40000,
    toolsBreakdown: { toolTokens: { core: 15000, mcp: 5000 }, mcpPlugins: [] },
  },
};

const USAGE = {
  cache_creation_input_tokens: 50000,
  cache_read_input_tokens: 30000,
  input_tokens: 70000,
  output_tokens: 4000,
};
const API_TOTAL = 154000;       // output-inclusive — occupancy denominator
const API_INPUT_TOTAL = 150000; // output-exclusive — category scale denominator
const WINDOW = 200000;

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Segment tooltips read "<label>: <n>" (bar) or "<label>: <n> (x% of used)" (sticky).
// Separators are stripped so the assertion does not depend on the runtime locale.
function titleTokens(html, label) {
  const m = html.match(new RegExp('title="' + esc(label) + ': ([^"(]+)'));
  assert.ok(m, 'no segment titled "' + label + '"');
  return Number(m[1].replace(/[^0-9]/g, ''));
}

// Sticky table row: <td>…label</td><td>tokens</td><td>% of used</td>
function tableRow(html, label) {
  const m = html.match(new RegExp(esc(label) + '</td>\\s*<td[^>]*>([^<]+)</td>\\s*<td[^>]*>([^<]+)</td>'));
  assert.ok(m, 'no table row for "' + label + '"');
  return { tokens: Number(m[1].replace(/[^0-9]/g, '')), pctOfUsed: m[2].trim() };
}

// Only bar segments carry `width:<n>%;background:` — the swatch span uses width:7px.
function segmentWidths(html) {
  return [...html.matchAll(/<div style="width:([0-9.]+)%;background:/g)].map(m => Number(m[1]));
}

describe('#267 ctx breakdown scale — input-only denominator', () => {
  const ctx = loadCtx();

  it('fixture ground truth: buildContextCategories total is 100,000 and computeCtxUsed is output-inclusive', () => {
    assert.equal(ctx.buildContextCategories(TOK).total, ESTIMATED_TOTAL);
    assert.equal(ctx.computeCtxUsed(USAGE), API_TOTAL);
    assert.equal(API_TOTAL - USAGE.output_tokens, API_INPUT_TOTAL);
  });

  // ── Target metric: displayed per-category tokens use apiInputTotal, not apiTotal ──

  for (const [name, render] of [
    ['renderContextBreakdownBar', (c) => c.renderContextBreakdownBar(TOK, WINDOW, USAGE)],
    ['renderContextBreakdownSticky', (c) => c.renderContextBreakdownSticky(TOK, WINDOW, USAGE)],
  ]) {
    it(name + ': segment tooltips scale by apiInputTotal/estimatedTotal, not apiTotal/estimatedTotal', () => {
      const html = render(ctx);
      for (const [label, raw] of [['Core instructions', 20000], ['Messages', 40000], ['MCP tools', 5000]]) {
        const want = Math.round(raw * (API_INPUT_TOTAL / ESTIMATED_TOTAL));
        const smeared = Math.round(raw * (API_TOTAL / ESTIMATED_TOTAL));
        assert.notEqual(want, smeared, 'fixture must distinguish the two denominators');
        assert.equal(titleTokens(html, label), want, label + ' must not absorb output_tokens');
      }
    });

    it(name + ': relative segment ratios are unchanged (one scale for every category)', () => {
      const html = render(ctx);
      assert.equal(titleTokens(html, 'Messages') / titleTokens(html, 'Core instructions'), 40000 / 20000);
    });

    it(name + ': no upscale when the input-only total is below the estimate', () => {
      // apiTotal (110,000) exceeds estimatedTotal but apiInputTotal (90,000) does not,
      // so categories render at their raw estimate — output alone must never upscale.
      const small = { input_tokens: 90000, output_tokens: 20000 };
      assert.equal(ctx.computeCtxUsed(small), 110000);
      const html = name === 'renderContextBreakdownBar'
        ? ctx.renderContextBreakdownBar(TOK, WINDOW, small)
        : ctx.renderContextBreakdownSticky(TOK, WINDOW, small);
      assert.equal(titleTokens(html, 'Core instructions'), 20000);
    });
  }

  it('sticky table cells carry the scaled tokens and an UNSCALED "% of used" column', () => {
    const html = ctx.renderContextBreakdownSticky(TOK, WINDOW, USAGE);
    const row = tableRow(html, 'Core instructions');
    assert.equal(row.tokens, Math.round(20000 * (API_INPUT_TOTAL / ESTIMATED_TOTAL)));
    // c.tokens / estimatedTotal — deliberately not scaled (20000 / 100000).
    assert.equal(row.pctOfUsed, '20.0%');
  });

  // ── Guard 1: occupancy total and window % stay output-inclusive (#253) ──

  it('bar label reports the output-INCLUSIVE total and window %', () => {
    const html = ctx.renderContextBreakdownBar(TOK, WINDOW, USAGE);
    assert.match(html, new RegExp(esc(API_TOTAL.toLocaleString()) + ' / ' + esc(WINDOW.toLocaleString())));
    assert.ok(!html.includes(API_INPUT_TOTAL.toLocaleString() + ' / '), 'total must not drop output_tokens');
    assert.match(html, /\(77%\)/); // 154000/200000 — an input-only total would read 75%
  });

  it('sticky "Used" row reports the output-INCLUSIVE total and window %', () => {
    const html = ctx.renderContextBreakdownSticky(TOK, WINDOW, USAGE);
    const used = tableRow(html, 'Used');
    assert.equal(used.tokens, API_TOTAL);
    assert.equal(used.pctOfUsed, '77%');
  });

  // ── Guard 2: overflow (total > windowSize) stays inside the bar ──

  it('total > windowSize: bar segment widths sum to <= 100% and the label caps at 100%', () => {
    const html = ctx.renderContextBreakdownBar(TOK, 100000, USAGE); // total 154,000 > window
    const sum = segmentWidths(html).reduce((a, b) => a + b, 0);
    assert.ok(sum > 0 && sum <= 100, 'segment widths sum to ' + sum + '%');
    assert.match(html, /\(100%\)/);
  });

  it('total > windowSize: sticky segment widths sum to <= 100%', () => {
    const html = ctx.renderContextBreakdownSticky(TOK, 100000, USAGE);
    const sum = segmentWidths(html).reduce((a, b) => a + b, 0);
    assert.ok(sum > 0 && sum <= 100, 'segment widths sum to ' + sum + '%');
  });
});
