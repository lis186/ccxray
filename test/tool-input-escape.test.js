'use strict';

// renderToolInput must escape inp.timeout before interpolating it into HTML.
// The value comes from logged request data (tool input), the same trust level
// as inp.command, which already goes through escapeHtml. Old code interpolated
// it raw, so a non-numeric payload injected markup. Fails on old code, passes
// on fixed code.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Same sandbox loader shape as test/escapehtml.test.js
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
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'session-label.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  return context;
}

describe('renderToolInput escapes Bash timeout meta line', () => {
  const ctx = loadClient();

  it('exposes renderToolInput', () => assert.equal(typeof ctx.renderToolInput, 'function'));

  it('a markup payload in timeout does not survive as raw HTML', () => {
    const html = ctx.renderToolInput({
      name: 'Bash',
      input: { command: 'ls', timeout: '<img src=x onerror=alert(1)>' },
    });
    assert.ok(!html.includes('<img'), 'raw <img must not appear in output');
    assert.ok(html.includes('&lt;img'), 'payload must appear escaped');
  });

  it('a normal non-default numeric timeout still renders', () => {
    const html = ctx.renderToolInput({
      name: 'Bash',
      input: { command: 'ls', timeout: 60000 },
    });
    assert.ok(html.includes('timeout: 60000ms'));
  });

  it('the default 120000 timeout stays hidden', () => {
    const html = ctx.renderToolInput({
      name: 'Bash',
      input: { command: 'ls', timeout: 120000 },
    });
    assert.ok(!html.includes('timeout:'));
  });
});
