'use strict';

// #358 — auto-expand collapsed sidebar when boot ends with no session selected.
// Loads the real public/app.js in a vm with minimal DOM stubs (same pattern as
// test/sysprompt-ui-logic.test.js) and exercises maybeAutoExpandSidebar().

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement() {
  const classes = new Set();
  return {
    textContent: '',
    title: '',
    inert: false,
    style: {},
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
      },
      contains: (n) => classes.has(n),
    },
  };
}

function loadAppJs({ collapsed }) {
  const store = { 'ccxray-sidebar-collapsed': collapsed ? '1' : '0' };
  const elements = new Map();
  const context = {
    console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById(id) {
        if (id === 'proxy-config') return { textContent: '{}' };
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      documentElement: { getAttribute: () => null, setAttribute() {} },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    history: { pushState() {}, replaceState() {} },
    location: { search: '', pathname: '/' },
    addEventListener() {},
    URLSearchParams,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { ctx: context, store };
}

describe('#358 maybeAutoExpandSidebar', () => {
  it('exists in app.js (fail-on-old)', () => {
    const { ctx } = loadAppJs({ collapsed: true });
    assert.equal(typeof ctx.maybeAutoExpandSidebar, 'function');
  });

  it('collapsed + no session selected → expands and persists to localStorage', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(ctx.maybeAutoExpandSidebar(), true);
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });

  it('collapsed + session selected (?s= deep link, #206) → stays collapsed', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    ctx.selectedSessionId = 'abc123';
    assert.equal(ctx.maybeAutoExpandSidebar(), false);
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
  });

  it('already expanded → no-op (never toggles toward collapsed)', () => {
    const { ctx, store } = loadAppJs({ collapsed: false });
    assert.equal(ctx.maybeAutoExpandSidebar(), false);
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });

  it('boot chain wiring: entry-rendering.js calls it after deep-link/auto-select', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'entry-rendering.js'), 'utf8');
    const autoSelectIdx = src.indexOf('initAutoSelect()');
    const callIdx = src.indexOf('maybeAutoExpandSidebar()');
    assert.ok(autoSelectIdx > 0, 'initAutoSelect call present');
    assert.ok(callIdx > autoSelectIdx, 'maybeAutoExpandSidebar called after the auto-select block');
  });
});
