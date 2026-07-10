'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadImageHelpers() {
  function el() {
    return {
      style: {}, dataset: {}, innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild(c) { this._children = this._children || []; this._children.push(c); return c; },
      insertBefore() {}, querySelector: () => el(), querySelectorAll: () => [],
      remove() {},
    };
  }
  // During script load, return stubs for init-time getElementById calls.
  // After load, return null for unknown IDs so showImageOverlay hits the create path.
  const namedEls = {};
  let initPhase = true;
  const bodyEl = el();
  const origAppend = bodyEl.appendChild.bind(bodyEl);
  bodyEl.appendChild = function(c) { if (c.id) namedEls[c.id] = c; return origAppend(c); };
  const context = {
    console, window: {},
    document: {
      getElementById: (id) => namedEls[id] || (initPhase ? el() : null),
      createElement: (tag) => { const e = el(); e._tag = tag; return e; },
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: bodyEl,
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
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  for (const f of ['format.js', 'session-label.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), context);
  }
  initPhase = false;
  vm.runInContext(`
    this.buildSafeImageDataUrl = buildSafeImageDataUrl;
    this.renderToolOutput = renderToolOutput;
    this.showImageOverlay = showImageOverlay;
  `, context);
  return context;
}

describe('image XSS prevention', () => {
  const ctx = loadImageHelpers();

  describe('buildSafeImageDataUrl', () => {
    it('accepts valid png base64', () => {
      const url = ctx.buildSafeImageDataUrl({ media_type: 'image/png', data: 'iVBOR' });
      assert.equal(url, 'data:image/png;base64,iVBOR');
    });

    it('accepts valid jpeg', () => {
      const url = ctx.buildSafeImageDataUrl({ media_type: 'image/jpeg', data: 'abc=' });
      assert.equal(url, 'data:image/jpeg;base64,abc=');
    });

    it('rejects svg (script vector)', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'image/svg+xml', data: 'PHN2Zz4=' }), null);
    });

    it('rejects non-image mime', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'text/html', data: 'abc' }), null);
    });

    it('rejects data with quote characters', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'image/png', data: 'abc"onerror=alert(1)' }), null);
    });

    it('rejects data with angle brackets', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'image/png', data: '<script>' }), null);
    });

    it('rejects empty data', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'image/png', data: '' }), null);
    });

    it('rejects non-string data', () => {
      assert.equal(ctx.buildSafeImageDataUrl({ media_type: 'image/png', data: 123 }), null);
    });
  });

  describe('renderToolOutput', () => {
    it('renders valid image block', () => {
      const html = ctx.renderToolOutput({
        result: [{ type: 'image', source: { media_type: 'image/png', data: 'iVBOR' } }],
      });
      assert.ok(html.includes('data:image/png;base64,iVBOR'));
      assert.ok(html.includes('showImageOverlay'));
    });

    it('renders placeholder for malicious payload', () => {
      const html = ctx.renderToolOutput({
        result: [{ type: 'image', source: { media_type: 'image/png', data: '" onerror="alert(1)' } }],
      });
      assert.ok(html.includes('[invalid image data]'));
      assert.ok(!html.includes('onerror'));
    });
  });

  describe('showImageOverlay', () => {
    it('creates overlay via DOM, not innerHTML', () => {
      ctx.showImageOverlay('data:image/png;base64,iVBOR');
      const overlay = ctx.document.getElementById('img-overlay');
      assert.ok(overlay, 'overlay should be created and tracked via body.appendChild');
      assert.ok(overlay._children?.length > 0, 'img should be appended as child');
      const img = overlay._children[overlay._children.length - 1];
      assert.equal(img._tag, 'img');
      assert.equal(img.src, 'data:image/png;base64,iVBOR');
      assert.equal(overlay.innerHTML, '', 'innerHTML must not be used');
    });
  });
});
