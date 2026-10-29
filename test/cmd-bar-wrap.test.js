'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/keyboard-nav.js'), 'utf8');

// Declaration contracts only: this is not a browser cascade or geometry engine.
function rules(selector) {
  const result = {};
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(',').some(s => s.trim() === selector)) continue;
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon >= 0) result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}

test('hint row grows by whole lines without scrolling or splitting a hint', () => {
  const row = rules('#cmd-bar-row1');
  assert.equal(row.display, 'flex');
  assert.equal(row['flex-wrap'], 'wrap');
  assert.equal(row['min-height'], '28px');
  assert.ok(!row.height || row.height === 'auto');
  assert.ok(!row['max-height'] || row['max-height'] === 'none');
  assert.notEqual(row['white-space'], 'nowrap');
  assert.ok(!row['overflow-x'] || row['overflow-x'] === 'visible');
  assert.ok(!row.overflow || row.overflow === 'visible');
  assert.equal(rules('.cmd-key')['white-space'], 'nowrap');
  assert.equal(rules('.cmd-key').flex, '0 0 auto');
  assert.equal(rules('.cmd-key')['min-height'], '28px');
  assert.equal(rules('.cmd-key-btn').margin, '0 -5px');
});

test('viewport flex layout reserves the bar and lets content shrink; visibility states remain', () => {
  assert.equal(rules('#app').display, 'flex');
  assert.equal(rules('#app')['flex-direction'], 'column');
  assert.equal(rules('#app').height, '100svh');
  assert.equal(rules('#columns').flex, '1');
  assert.equal(rules('#columns')['min-height'], '0');
  assert.equal(rules('#cmd-bar')['flex-shrink'], '0');
  assert.equal(rules('#cmd-bar.hidden').display, 'none');
  assert.equal(rules('#cmd-bar.overlay-active').opacity, '0');
  assert.equal(rules('#cmd-bar.overlay-active')['pointer-events'], 'none');
  assert.equal(rules('#cmd-bar-row2').display, 'none');
  assert.ok(!rules('.cmd-key.disabled').display);
  assert.ok(Number(rules('.cmd-key.disabled').opacity) > 0);
});

function fixture(options = {}) {
  const nodes = Object.fromEntries(['cmd-bar', 'cmd-bar-row1', 'cmd-bar-row2'].map(id =>
    [id, { className: '', innerHTML: '', classList: { remove() {} } }]));
  const events = [];
  const context = vm.createContext({
    window: { getComputedStyle: el => ({ display: el.display }) },
    document: {
      getElementById: id => nodes[id], addEventListener() {},
      querySelectorAll: () => options.overlay ? [{ display: 'flex' }] : [],
      dispatchEvent: event => events.push(event),
    },
    KeyboardEvent: function(type, init) { Object.assign(this, { type }, init); },
    _loading: false, activeTab: 'dashboard', focusedCol: 'projects',
    selectedSessionId: 'fixture-session', selectedTurnIdx: 0, selectedSection: 'messages',
    projectsMap: new Map([['fixture-project', {}]]), colSessions: { querySelectorAll: () => [{}] },
    inSplitView: () => !!options.split, isSidebarCollapsed: () => false,
    targetsEnabled: options.enabled !== false,
    ...options.state,
  });
  vm.runInContext(source, context);
  // Synthetic eligibility inputs; getCmdBarState, isEnabled and renderCmdBar run unchanged.
  vm.runInContext(`
    getStarTargetFromSelection = () => targetsEnabled ? { starred: false } : null;
    _hasBadgeDescendants = _hasStarNavTargets = _hasTimelineStarNavTargets =
      _hasTimelineStepType = () => targetsEnabled;
  `, context);
  return { context, nodes, events };
}

const modes = [
  ...['projects', 'sessions', 'turns', 'sections'].map(focusedCol => ({ name: focusedCol, state: { focusedCol } })),
  { name: 'split', split: true },
  { name: 'timeline', split: true, state: { selectedSection: 'timeline' } },
  { name: 'workflow timeline', split: true, state: { selectedSection: 'timeline', wfState: {} } },
];

for (const mode of modes) {
  for (const enabled of [true, false]) {
    test(`${mode.name}: all hints rendered together and enabled clicks dispatch keys (targets ${enabled})`, () => {
      const { context, nodes, events } = fixture({ ...mode, enabled });
      const state = context.getCmdBarState();
      const items = [...state.row1, ...(state.row2 || [])];
      context.renderCmdBar();
      const html = nodes['cmd-bar-row1'].innerHTML;
      const rendered = [...html.matchAll(/<(button|span) class="cmd-key([^\"]*)"([^>]*)><kbd>(.*?)<\/kbd> (.*?)<\/(?:button|span)>/g)];
      assert.equal(rendered.length, items.length);
      items.forEach((item, i) => {
        const [, tag, classes, attrs, key, label] = rendered[i];
        assert.equal(key, item.key);
        assert.equal(label, item.label);
        assert.doesNotMatch(attrs, /hidden|display|visibility/);
        const eligible = !item.id || context.isEnabled(item.id);
        assert.equal(classes.includes('disabled'), !eligible);
        assert.equal(tag, item.clickKey && eligible ? 'button' : 'span');
        if (tag === 'button') {
          const handler = attrs.match(/onclick="([^"]+)"/)[1];
          vm.runInContext(handler, context);
          assert.equal(events.at(-1).key, item.clickKey);
          assert.equal(events.at(-1).type, 'keydown');
          assert.equal(events.at(-1).bubbles, true);
        }
      });
      assert.equal(nodes['cmd-bar-row2'].innerHTML, '');
      assert.equal(nodes['cmd-bar'].className, '');
    });
  }
}

test('loading, other tabs, unknown focus and overlays preserve bar visibility behavior', () => {
  const { context, nodes } = fixture({ overlay: true });
  context.renderCmdBar();
  assert.equal(nodes['cmd-bar'].className, 'overlay-active');
  for (const state of [{ _loading: true }, { activeTab: 'usage' }, { focusedCol: 'unknown' }]) {
    Object.assign(context, { _loading: false, activeTab: 'dashboard', focusedCol: 'projects' }, state);
    context.renderCmdBar();
    assert.equal(nodes['cmd-bar'].className, 'hidden');
  }
});
