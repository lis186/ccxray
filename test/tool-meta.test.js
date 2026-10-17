'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

const ctx = loadClient();
const render = (name, input) => ctx.renderToolMeta({ name, input });
const payload = '<img src=x onerror=alert(1)>';

it('escapes Read offset and limit without concatenating untrusted ranges', () => {
  for (const input of [{ offset: payload, limit: 5 }, { offset: 10, limit: payload }]) {
    const html = render('Read', input);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  }
});

it('handles non-string fields before string operations', () => {
  for (const value of [42, {}, [payload], null]) {
    for (const name of ['Grep', 'Glob']) assert.doesNotThrow(() => render(name, { path: value }));
    assert.doesNotThrow(() => render('Bash', { command: value }));
    assert.doesNotThrow(() => render('Bash', { cmd: value }));
    assert.doesNotThrow(() => render('Agent', { prompt: value }));
    assert.doesNotThrow(() => render('WebFetch', { url: value }));
  }
});

it('escapes every displayed tool input field, including task metadata', () => {
  const cases = { Bash: ['command', 'cmd', 'description'], Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], Grep: ['pattern', 'glob', 'path'], Glob: ['pattern', 'path'], Agent: ['description', 'prompt', 'subagent_type'], WebSearch: ['query'], WebFetch: ['url'], TaskCreate: ['subject'], TaskUpdate: ['taskId', 'status'] };
  for (const [name, fields] of Object.entries(cases)) {
    for (const field of fields) {
      const html = render(name, { [field]: payload });
      assert.ok(!html.includes('<img'), `${name}.${field}`);
      assert.ok(html.includes('&lt;img'), `${name}.${field}`);
    }
  }
});

it('omits non-finite and structured Read ranges', () => {
  for (const value of [Infinity, -Infinity, NaN, {}, ['10']]) {
    assert.equal(render('Read', { offset: value }), '<div class="detail-meta"><code></code></div>');
    assert.equal(render('Read', { offset: 10, limit: value }), '<div class="detail-meta"><code></code> <span class="detail-tag">L10+</span></div>');
  }
});

it('preserves normal Read, Grep and Bash markup', () => {
  assert.equal(render('Read', { file_path: '/tmp/file', offset: 10, limit: 20 }), '<div class="detail-meta"><code>/tmp/file</code> <span class="detail-tag">L10-30</span></div>');
  assert.equal(render('Read', { offset: 10 }), '<div class="detail-meta"><code></code> <span class="detail-tag">L10+</span></div>');
  assert.equal(render('Grep', { pattern: 'foo', glob: '*.js', path: '/tmp/src/lib' }), '<div class="detail-meta"><code>/foo/</code> <span class="detail-tag">*.js</span> in <code>src/lib</code></div>');
  assert.equal(render('Bash', { command: 'echo hi\npwd', description: 'check' }), '<div class="detail-meta"><code class="detail-cmd-block">$ echo hi ...</code><div class="detail-meta-line">check</div></div>');
});
