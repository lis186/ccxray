'use strict';

// #196: cache-creation 5m/1h TTL split in the turn-detail cache row.
// The Anthropic ephemeral breakdown (usage.cache_creation.{ephemeral_5m,
// ephemeral_1h}_input_tokens) is parsed server-side but was never shown; the
// client only read the flat cache_creation_input_tokens. These tests lock the
// display-layer helper cacheCreateParts(usage) that renderSectionsCol feeds.
//
// Fixture provenance: synthetic. usage shape follows
// server/wire-parsers/anthropic.js:34-39 and docs/wire-protocol-reference.md
// §4.3 — no real logs embedded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load miller-columns.js in a browser-like VM and read cacheCreateParts.
// Same harness shape as test/ctx-color.test.js.
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

describe('#196 cache-creation TTL split (cacheCreateParts)', () => {
  const ctx = loadClient();

  it('exposes cacheCreateParts', () => {
    assert.equal(typeof ctx.cacheCreateParts, 'function');
  });

  // ── target metric: object present + 5m+1h === flat → two tagged nodes ──
  it('renders 5m and 1h as two nodes with correct values', () => {
    const parts = ctx.cacheCreateParts({
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1200, ephemeral_1h_input_tokens: 1800 },
    });
    assert.equal(parts.length, 1, 'one cache-create part');
    const html = parts[0];
    const ttlNodes = html.match(/data-cache-ttl=/g) || [];
    assert.equal(ttlNodes.length, 2, 'exactly two TTL-tagged nodes');
    assert.match(html, /data-cache-ttl="5m">5m 1,200</, '5m node shows 1,200');
    assert.match(html, /data-cache-ttl="1h">1h 1,800</, '1h node shows 1,800');
  });

  // ── consistency guard: 5m + 1h must equal the flat total ──
  it('sum of the two tiers equals the flat cache_creation_input_tokens', () => {
    const flat = 3000, m5 = 1200, h1 = 1800;
    assert.equal(m5 + h1, flat, 'fixture is internally consistent');
    const parts = ctx.cacheCreateParts({
      cache_creation_input_tokens: flat,
      cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 },
    });
    assert.match(parts[0], /data-cache-ttl="5m"/);
    assert.match(parts[0], /data-cache-ttl="1h"/);
  });

  // ── obs-fragile guard: object absent → flat fallback, no fake split ──
  it('falls back to a single flat node when cache_creation object is absent', () => {
    const parts = ctx.cacheCreateParts({ cache_creation_input_tokens: 2500 });
    assert.equal(parts.length, 1);
    assert.doesNotMatch(parts[0], /data-cache-ttl/, 'no TTL nodes');
    assert.doesNotMatch(parts[0], /5m 0|1h 0/, 'no fake `5m 0 / 1h 0`');
    assert.match(parts[0], /new 2,500/, 'flat value shown');
  });

  // ── drift guard: 5m + 1h !== flat → prefer flat, no split ──
  it('prefers the flat value when the tiers do not sum to it', () => {
    const parts = ctx.cacheCreateParts({
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    });
    assert.equal(parts.length, 1);
    assert.doesNotMatch(parts[0], /data-cache-ttl/, 'no split on drift');
    assert.match(parts[0], /new 3,000/, 'flat value shown');
  });

  // ── single-tier is truthful, not a fake split ──
  it('renders one tagged node when all cache creation is a single tier', () => {
    const parts = ctx.cacheCreateParts({
      cache_creation_input_tokens: 1500,
      cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 0 },
    });
    assert.equal((parts[0].match(/data-cache-ttl=/g) || []).length, 1);
    assert.match(parts[0], /data-cache-ttl="5m">5m 1,500</);
    assert.doesNotMatch(parts[0], /1h/, 'no zero-valued 1h node');
  });

  // ── no cache creation → empty (nothing to render) ──
  it('returns an empty array when there is no cache creation', () => {
    // length checks (not deepEqual) — the array is created in the VM realm,
    // so its Array.prototype differs from this realm's under deepStrictEqual.
    assert.equal(ctx.cacheCreateParts({ cache_creation_input_tokens: 0 }).length, 0);
    assert.equal(ctx.cacheCreateParts({}).length, 0);
    assert.equal(ctx.cacheCreateParts(null).length, 0);
  });
});
