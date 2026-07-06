'use strict';

// #142: unified context-usage color thresholds — pct>80 red / pct>=40 yellow / else safe.
// Contract test locks the band boundaries (39/40/80/81) on both sides.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── client: load miller-columns.js in a browser-like VM and read ctxColor ──
function loadClient() {
  const publicDir = path.join(__dirname, '..', 'public');
  const el = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, insertBefore() {},
    querySelector: () => el(), querySelectorAll: () => [], remove() {},
  });
  const context = {
    console, window: {},
    document: { getElementById: () => el(), createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el() },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`
    function updateSysPromptBadge() {} function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; } function setInterval() { return 0; }
    function clearInterval() {} window.ccxraySettings = { visibleProviders: [] };
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  return context;
}

describe('#142 client ctxColor(pct) band boundaries', () => {
  const ctx = loadClient();
  it('exposes ctxColor', () => assert.equal(typeof ctx.ctxColor, 'function'));
  it('39 -> safe (null)', () => assert.equal(ctx.ctxColor(39), null));
  it('40 -> yellow', () => assert.equal(ctx.ctxColor(40), 'var(--yellow)'));
  it('80 -> yellow (not red at exactly 80)', () => assert.equal(ctx.ctxColor(80), 'var(--yellow)'));
  it('81 -> red', () => assert.equal(ctx.ctxColor(81), 'var(--red)'));
  it('0 -> safe (null)', () => assert.equal(ctx.ctxColor(0), null));
  it('100 -> red', () => assert.equal(ctx.ctxColor(100), 'var(--red)'));
});

// ── server: helpers.js exports ctxBarColor + named thresholds ──
const helpers = require('../server/helpers');
describe('#142 server ctxBarColor(pct) + thresholds', () => {
  it('exports named thresholds 80/40', () => {
    assert.equal(helpers.CTX_RED_PCT, 80);
    assert.equal(helpers.CTX_YELLOW_PCT, 40);
  });
  it('39 -> green', () => assert.equal(helpers.ctxBarColor(39), '\x1b[32m'));
  it('40 -> yellow', () => assert.equal(helpers.ctxBarColor(40), '\x1b[33m'));
  it('80 -> yellow (not red at exactly 80)', () => assert.equal(helpers.ctxBarColor(80), '\x1b[33m'));
  it('81 -> red', () => assert.equal(helpers.ctxBarColor(81), '\x1b[31m'));
});
