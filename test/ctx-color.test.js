'use strict';

// #142/#156/#253: unified context-usage color thresholds — pct>85 red / pct>=45 yellow / else safe.
// Contract test locks the band boundaries (44/45/85/86) on both sides.

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
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'format.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  return context;
}

describe('#156 client ctxZone(pct) band boundaries', () => {
  const ctx = loadClient();
  it('exposes ctxZone', () => assert.equal(typeof ctx.ctxZone, 'function'));
  it('44 -> safe (null cssVar)', () => {
    const z = ctx.ctxZone(44);
    assert.equal(z.zone, 'safe');
    assert.equal(z.cssVar, null);
  });
  it('45 -> yellow', () => assert.equal(ctx.ctxZone(45).cssVar, 'var(--yellow)'));
  it('85 -> yellow (not red at exactly 85)', () => assert.equal(ctx.ctxZone(85).cssVar, 'var(--yellow)'));
  it('86 -> red', () => assert.equal(ctx.ctxZone(86).cssVar, 'var(--red)'));
  it('0 -> safe (null cssVar)', () => assert.equal(ctx.ctxZone(0).cssVar, null));
  it('100 -> red', () => assert.equal(ctx.ctxZone(100).cssVar, 'var(--red)'));
});

describe('#156 client shortModel(model)', () => {
  const ctx = loadClient();
  it('exposes shortModel', () => assert.equal(typeof ctx.shortModel, 'function'));
  it('basic model name', () => assert.equal(ctx.shortModel('claude-opus-4-6'), 'opus-4-6'));
  it('strips trailing YYYYMMDD date suffix', () => assert.equal(ctx.shortModel('claude-sonnet-4-20250514'), 'sonnet-4'));
  it('missing -> ?', () => {
    assert.equal(ctx.shortModel(null), '?');
    assert.equal(ctx.shortModel(undefined), '?');
  });
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
