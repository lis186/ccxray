'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildEditSummary } = require('../server/forward');

describe('buildEditSummary', () => {
  it('returns no diffs when nothing changed', () => {
    const body = { model: 'claude', messages: [{ role: 'user', content: 'hi' }] };
    assert.deepEqual(buildEditSummary(body, JSON.parse(JSON.stringify(body))), []);
  });

  it('shows old → new content for an edited message (not just a count)', () => {
    const orig = { model: 'claude', messages: [{ role: 'user', content: 'say X' }] };
    const mod = { model: 'claude', messages: [{ role: 'user', content: 'say BANANA' }] };
    const diffs = buildEditSummary(orig, mod);
    // The whole point of the enhancement: the actual before/after text is visible.
    assert.ok(diffs.some(l => l.includes('"say X"') && l.includes('"say BANANA"')),
      'expected a diff line containing both old and new text, got: ' + JSON.stringify(diffs));
    // And it is attributed to the right message index/role.
    assert.ok(diffs.some(l => l.startsWith('user[0]:')));
    // Regression guard: it must NOT fall back to the old count-only wording.
    assert.ok(!diffs.some(l => /message\(s\) edited$/.test(l) && !l.includes('more')),
      'should not emit the old count-only "N message(s) edited" line');
  });

  it('flattens newlines and truncates long content to one line', () => {
    const longNew = 'A'.repeat(200);
    const orig = { messages: [{ role: 'user', content: 'a\nb\nc' }] };
    const mod = { messages: [{ role: 'user', content: longNew }] };
    const diffs = buildEditSummary(orig, mod);
    const line = diffs.find(l => l.startsWith('user[0]:'));
    assert.ok(line);
    assert.ok(!line.includes('\n'), 'diff line must be single-line');
    assert.ok(line.includes('…'), 'long content should be truncated with an ellipsis');
  });

  it('caps the number of shown message edits and summarizes the rest', () => {
    const mk = (txt) => ({ role: 'user', content: txt });
    const orig = { messages: Array.from({ length: 8 }, (_, i) => mk('old' + i)) };
    const mod = { messages: Array.from({ length: 8 }, (_, i) => mk('new' + i)) };
    const diffs = buildEditSummary(orig, mod, { maxShown: 5 });
    const shown = diffs.filter(l => /^user\[\d+\]:/.test(l));
    assert.equal(shown.length, 5);
    assert.ok(diffs.some(l => l === '…and 3 more message(s) edited'));
  });

  it('reports model, message-count, tools and system-prompt changes', () => {
    const orig = { model: 'a', messages: [{ role: 'user', content: 'hi' }], tools: [{}], system: 'old sys' };
    const mod = { model: 'b', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x' }], tools: [{}, {}, {}], system: 'new sys' };
    const diffs = buildEditSummary(orig, mod);
    assert.ok(diffs.some(l => l === 'Model: a → b'));
    assert.ok(diffs.some(l => l === 'Messages: 1 → 2'));
    assert.ok(diffs.some(l => l.startsWith('Tools: 1 → 3')));
    assert.ok(diffs.some(l => l.includes('System prompt:') && l.includes('old sys') && l.includes('new sys')));
  });

  it('returns empty for missing inputs', () => {
    assert.deepEqual(buildEditSummary(null, {}), []);
    assert.deepEqual(buildEditSummary({}, null), []);
  });
});
