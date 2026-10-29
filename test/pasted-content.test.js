'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pasted-content-'));
process.env.CCXRAY_HOME = home;
const store = require('../server/store');
after(() => fs.rmSync(home, { recursive: true, force: true }));

describe('pasted content in firstPrompt', () => {
  for (const [name, text] of [
    ['closed wrapper', '<pasted_content id="x">hello world</pasted_content>'],
    ['unclosed wrapper', '<pasted_content id="x">hello world'],
  ]) {
    it(`keeps the pasted text from a ${name}`, () => {
      const sid = `pasted-${name}`;
      store.recordFirstUserMsg(sid, {
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      });
      assert.equal(store.sessionMeta[sid].firstPrompt, 'hello world');
    });
  }

  it('preserves surrounding text and other tag names', () => {
    assert.equal(store.stripInjectedTags('before <pasted_content id="x">hello</pasted_content> after'), 'before hello after');
    assert.equal(store.stripInjectedTags('<pasted_content_extra>hello</pasted_content_extra>'), '<pasted_content_extra>hello</pasted_content_extra>');
  });

  it('still removes injected content inside pasted wrappers', () => {
    assert.equal(store.stripInjectedTags('<pasted_content id="x"><system-reminder>injected</system-reminder>hello world</pasted_content>'), 'hello world');
    assert.equal(store.stripInjectedTags('<pasted_content id="x"></pasted_content>'), null);
  });
});
