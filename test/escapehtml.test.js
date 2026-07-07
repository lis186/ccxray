'use strict';

// #150: escapeHtml must escape " and ' to prevent attribute-injection XSS.
// Old implementation only escaped & < >. These tests fail on old code, pass on fixed code.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Malicious wire-derived values for XSS repro
const EVIL_RESUME = 'codex resume sid");globalThis.__xss=1;//';
const EVIL_SID = 'session-id");globalThis.__xss=1;//';

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
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'session-label.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  // Expose a helper for tests to populate const-scoped VM variables like sessionStatusMap
  context.__setSessionStatus = (sid, status) => vm.runInContext(
    `sessionStatusMap.set(${JSON.stringify(sid)}, ${JSON.stringify(status)})`, context
  );
  return context;
}

describe('#150 escapeHtml quote escaping', () => {
  const ctx = loadClient();

  it('exposes escapeHtml', () => assert.equal(typeof ctx.escapeHtml, 'function'));

  // All five special chars in one shot — the key assertion that flips old(FAIL)->new(PASS)
  it('escapes & < > " \' all together', () => {
    assert.equal(ctx.escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
  });

  // Attribute-breakout XSS vector: raw " must not survive
  it('attribute-breakout vector: no raw double-quote in output', () => {
    const result = ctx.escapeHtml('" onmouseover="alert(1)');
    assert.ok(!result.includes('"'), `raw " present in: ${result}`);
    assert.ok(result.includes('&quot;'), `&quot; missing in: ${result}`);
  });

  // Single-quote breakout
  it('single-quote vector: no raw single-quote in output', () => {
    const result = ctx.escapeHtml("' onmouseover='alert(1)");
    assert.ok(!result.includes("'"), `raw ' present in: ${result}`);
    assert.ok(result.includes('&#39;'), `&#39; missing in: ${result}`);
  });

  // Normal string passes through untouched
  it('normal string with no special chars is unchanged', () => {
    assert.equal(ctx.escapeHtml('hello world'), 'hello world');
  });

  // Non-string branch still JSON.stringifies without throwing
  it('non-string input JSON.stringifies', () => {
    const result = ctx.escapeHtml({ x: 1 });
    assert.ok(result.includes('&quot;x&quot;'), `expected escaped JSON keys in: ${result}`);
  });
});

// ── Inline-handler XSS: data-* extraction fix (#150 blocking finding) ──────
// These tests reproduce the JS-string injection vector that persisted even after
// the escapeHtml quote-escaping fix, because HTML entities are decoded by the
// browser BEFORE the inline onclick JS compiles. The fix moves wire values OUT
// of JS-string arguments and into data-* attributes, which are pure HTML-attribute
// context and therefore correctly protected by the now-fixed escapeHtml.
//
// Test shape: old code embedded escapeHtml(value) directly in onclick JS args
// (payload reachable after HTML-decode). New code has this.dataset.* in onclick
// and the value in a data-* attribute (payload confined to HTML attribute context).

describe('#150 inline-handler XSS: data-* extraction', () => {
  const ctx = loadClient();

  // Minimal sess object that exercises both the sdot (toggleIntercept) and
  // copyBtn (copySessionContinue) render paths.
  function makeSessionHtml(resumeCmd, sid) {
    const sess = {
      model: 'claude-3-5-sonnet',
      totalCost: 0,
      count: 1,
      retryCount: 0,
      resumeCommand: resumeCmd,
      lastAssistantText: null,
      latestMainCtxPct: 0,
      lastReceivedAt: Date.now(),
      firstTs: '2026-07-07T00:00:00',
    };
    // getStatusClass reads sessionStatusMap (const in VM scope); set via the VM helper
    // so that the sdot button is rendered as online and sdotOnclick is populated.
    ctx.__setSessionStatus(sid, { active: true, lastSeenAt: Date.now() });
    return ctx.renderSessionItem(sess, sid);
  }

  // ── copySessionContinue sink (resumeCmd) ────────────────────────────────

  it('copyBtn onclick contains this.dataset.resume, not the raw payload', () => {
    const html = makeSessionHtml(EVIL_RESUME, 'safe-sid-resume');
    // The onclick attribute value must reference this.dataset.resume
    assert.ok(
      html.includes('this.dataset.resume'),
      `expected "this.dataset.resume" in onclick, got: ${html.slice(0, 500)}`
    );
    // The payload must NOT appear inside any onclick="..." attribute value.
    // Extract all onclick values and check none contain the payload.
    const onclickValues = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
    for (const v of onclickValues) {
      assert.ok(
        !v.includes('globalThis.__xss'),
        `payload "globalThis.__xss" found inside onclick="${v}"`
      );
    }
  });

  it('copyBtn data-resume attribute holds the &quot;-escaped value', () => {
    const html = makeSessionHtml(EVIL_RESUME, 'safe-sid-resume2');
    // The data-resume attribute must exist and contain &quot; (not raw ")
    assert.ok(
      html.includes('data-resume='),
      `expected data-resume attribute in: ${html.slice(0, 500)}`
    );
    // Raw double-quote must not appear inside the data-resume="..." attribute value
    // (the value is bounded by the outer " delimiters, so any unescaped " would be a breakout)
    const match = html.match(/data-resume="([^"]*)"/);
    assert.ok(match, `data-resume attribute not found in: ${html.slice(0, 500)}`);
    assert.ok(
      !match[1].includes('"'),
      `raw double-quote in data-resume value: ${match[1]}`
    );
    assert.ok(
      match[1].includes('&quot;'),
      `expected &quot; in data-resume value: ${match[1]}`
    );
  });

  // ── toggleIntercept sink (sid) ───────────────────────────────────────────

  it('sdot onclick contains this.dataset.sid, not the raw sid payload', () => {
    const html = makeSessionHtml(null, EVIL_SID);
    // The onclick must reference this.dataset.sid
    assert.ok(
      html.includes('this.dataset.sid'),
      `expected "this.dataset.sid" in onclick, got: ${html.slice(0, 500)}`
    );
    // Extract the sdot button onclick specifically (the button with class "sdot ...")
    // and confirm it does NOT contain the payload. The sdot button is the first <button>
    // in si-row1 and its onclick must only reference this.dataset.sid.
    const sdotMatch = html.match(/<button class="sdot[^"]*"[^>]*onclick="([^"]*)"/);
    assert.ok(sdotMatch, `sdot button with onclick not found in: ${html.slice(0, 400)}`);
    assert.ok(
      !sdotMatch[1].includes('globalThis.__xss'),
      `payload "globalThis.__xss" found in sdot onclick="${sdotMatch[1]}"`
    );
    assert.ok(
      sdotMatch[1].includes('this.dataset.sid'),
      `expected "this.dataset.sid" in sdot onclick="${sdotMatch[1]}"`
    );
  });

  it('sdot data-sid attribute holds the &quot;-escaped sid', () => {
    const html = makeSessionHtml(null, EVIL_SID);
    assert.ok(
      html.includes('data-sid='),
      `expected data-sid attribute in: ${html.slice(0, 500)}`
    );
    const match = html.match(/data-sid="([^"]*)"/);
    assert.ok(match, `data-sid attribute not found in: ${html.slice(0, 500)}`);
    assert.ok(
      !match[1].includes('"'),
      `raw double-quote in data-sid value: ${match[1]}`
    );
    assert.ok(
      match[1].includes('&quot;'),
      `expected &quot; in data-sid value: ${match[1]}`
    );
  });
});
