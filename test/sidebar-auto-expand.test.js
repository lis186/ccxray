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
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
  };
}

function loadAppJs({ collapsed, search = '' }) {
  const store = { 'ccxray-sidebar-collapsed': collapsed ? '1' : '0' };
  const elements = new Map();
  const focusCalls = [];
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
    location: { search, pathname: '/' },
    addEventListener() {},
    URLSearchParams,
    loadCostPage() {},
    openSystemPromptPanel() {},
    selectedProjectName: null,
    focusedCol: 'projects',
    setFocus(col) { focusCalls.push(col); },
    renderCmdBar() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { ctx: context, store, focusCalls };
}

describe('#358 maybeAutoExpandSidebar', () => {
  it('exists in app.js (fail-on-old)', () => {
    const { ctx } = loadAppJs({ collapsed: true });
    assert.equal(typeof ctx.maybeAutoExpandSidebar, 'function');
  });

  it('collapsed + no session selected → expands and persists to localStorage', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    ctx._entriesLoading = false; // boot settled
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(ctx.maybeAutoExpandSidebar(), true);
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });

  it('collapsed + session selected (?s= deep link, #206) → stays collapsed', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    ctx._entriesLoading = false;
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

  it('auto-expand refocuses to projects when no project selected (codex r5)', () => {
    const { ctx, focusCalls } = loadAppJs({ collapsed: true });
    ctx._entriesLoading = false;
    ctx.maybeAutoExpandSidebar();
    assert.equal(focusCalls.at(-1), 'projects');
  });

  it('auto-expand refocuses to sessions when a project is selected (codex r5)', () => {
    const { ctx, focusCalls } = loadAppJs({ collapsed: true });
    ctx._entriesLoading = false;
    ctx.selectedProjectName = 'my-project';
    ctx.maybeAutoExpandSidebar();
    assert.equal(focusCalls.at(-1), 'sessions');
  });

  it('selectProject wiring: maybeAutoExpandSidebar gated on name===null (r7/r8)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'miller-columns.js'), 'utf8');
    const fnStart = src.indexOf('function selectProject');
    const clearIdx = src.indexOf('selectedSessionId = null', fnStart);
    const expandIdx = src.indexOf('maybeAutoExpandSidebar()', clearIdx);
    assert.ok(clearIdx > 0, 'selectProject clears selectedSessionId');
    assert.ok(expandIdx > clearIdx, 'maybeAutoExpandSidebar called after clearing session');
    // r8: gated on name===null so initAutoSelect/deep-link don't mis-expand
    const gateIdx = src.lastIndexOf('name === null', expandIdx);
    assert.ok(gateIdx > fnStart && gateIdx < expandIdx, 'gated on name===null');
  });

  it('boot chain wiring: entry-rendering.js calls it after restoreTabFromUrl (view gate, codex r1)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'entry-rendering.js'), 'utf8');
    const autoSelectIdx = src.indexOf('initAutoSelect()');
    const restoreTabIdx = src.indexOf('restoreTabFromUrl()');
    const callIdx = src.indexOf('maybeAutoExpandSidebar()');
    assert.ok(autoSelectIdx > 0, 'initAutoSelect call present');
    assert.ok(restoreTabIdx > autoSelectIdx, 'restoreTabFromUrl after auto-select block');
    assert.ok(callIdx > restoreTabIdx, 'maybeAutoExpandSidebar called after restoreTabFromUrl');
  });

  it('?view=usage boot → gated off, localStorage stays 1 (codex r1)', () => {
    const { ctx, store } = loadAppJs({ collapsed: true, search: '?view=usage' });
    ctx.restoreTabFromUrl(); // boot chain switches tab before the expand check
    assert.equal(ctx.maybeAutoExpandSidebar(), false);
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
  });

  it('switch back to dashboard, still nothing selected → expands at that moment', () => {
    const { ctx, store } = loadAppJs({ collapsed: true, search: '?view=usage' });
    ctx._entriesLoading = false; // boot settled
    ctx.restoreTabFromUrl();
    ctx.maybeAutoExpandSidebar(); // boot-end check: no-op off-dashboard
    assert.equal(ctx.isSidebarCollapsed(), true);
    ctx.switchTab('dashboard'); // dashboard branch calls maybeAutoExpandSidebar
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });

  it('switch back to dashboard with a session selected → stays collapsed', () => {
    const { ctx, store } = loadAppJs({ collapsed: true, search: '?view=usage' });
    ctx._entriesLoading = false;
    ctx.restoreTabFromUrl();
    ctx.selectedSessionId = 'abc123';
    ctx.switchTab('dashboard');
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
  });

  it('_entriesLoading undefined (entry-rendering.js not yet loaded) → no expand, localStorage stays 1 (codex r4)', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    // window._entriesLoading is undefined — app.js loaded, entry-rendering.js hasn't
    assert.equal(ctx._entriesLoading, undefined);
    assert.equal(ctx.maybeAutoExpandSidebar(), false);
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
  });

  it('tab-return during boot (_entriesLoading) → deferred; after boot settles → expands (codex r3)', () => {
    const { ctx, store } = loadAppJs({ collapsed: true, search: '?view=usage' });
    ctx.restoreTabFromUrl();
    ctx._entriesLoading = true; // window === context: boot restore in flight
    ctx.switchTab('dashboard'); // selection transiently null — must NOT rewrite
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
    ctx._entriesLoading = false; // boot settled, still nothing selected
    ctx.switchTab('usage');
    ctx.switchTab('dashboard'); // same path now expands
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });

  // ── R6: source prevention — toggleSidebar gate ──

  it('expanded + no session → toggleSidebar refuses to collapse (r6 prevention)', () => {
    const { ctx, store } = loadAppJs({ collapsed: false });
    ctx.toggleSidebar(); // attempt collapse with no selectedSessionId
    assert.equal(ctx.isSidebarCollapsed(), false, 'must stay expanded');
    assert.equal(store['ccxray-sidebar-collapsed'], '0', 'localStorage must not flip');
  });

  it('expanded + session selected → toggleSidebar collapses normally (#206 compat)', () => {
    const { ctx, store } = loadAppJs({ collapsed: false });
    ctx.selectedSessionId = 'abc123';
    ctx.toggleSidebar();
    assert.equal(ctx.isSidebarCollapsed(), true);
    assert.equal(store['ccxray-sidebar-collapsed'], '1');
  });

  it('collapsed + no session → toggleSidebar still expands (rescue direction always allowed)', () => {
    const { ctx, store } = loadAppJs({ collapsed: true });
    ctx.toggleSidebar(); // expand direction — always permitted
    assert.equal(ctx.isSidebarCollapsed(), false);
    assert.equal(store['ccxray-sidebar-collapsed'], '0');
  });
});
