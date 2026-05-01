'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { msgNorm, findSharedPrefix, findSharedPrefixFromLast } = require('../server/delta-helpers');

// ── msgNorm ──────────────────────────────────────────────────────────

describe('msgNorm', () => {
  it('strips cache_control from content blocks', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'world' },
      ],
    };
    const out = msgNorm(msg);
    assert.equal(out.content[0].text, 'hello');
    assert.ok(!('cache_control' in out.content[0]));
    assert.deepEqual(out.content[1], { type: 'text', text: 'world' });
  });

  it('returns input unchanged when content is not an array', () => {
    const msg = { role: 'user', content: 'plain string' };
    assert.equal(msgNorm(msg), msg);
  });

  it('returns input unchanged when content has no cache_control', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    const out = msgNorm(msg);
    assert.deepEqual(out, msg);
  });

  it('handles null/undefined input', () => {
    assert.equal(msgNorm(null), null);
    assert.equal(msgNorm(undefined), undefined);
  });

  it('preserves non-cache_control fields on content blocks', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' }, cache_control: { type: 'ephemeral' } }],
    };
    const out = msgNorm(msg);
    assert.equal(out.content[0].type, 'tool_use');
    assert.equal(out.content[0].id, 'tu_1');
    assert.equal(out.content[0].name, 'Bash');
    assert.deepEqual(out.content[0].input, { cmd: 'ls' });
    assert.ok(!('cache_control' in out.content[0]));
  });

  it('treats two messages differing only in cache_control as JSON-equal post-norm', () => {
    const a = { role: 'user', content: [{ type: 'text', text: 'x' }] };
    const b = { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] };
    assert.equal(JSON.stringify(msgNorm(a)), JSON.stringify(msgNorm(b)));
  });
});

// ── findSharedPrefix ─────────────────────────────────────────────────

describe('findSharedPrefix', () => {
  const m = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

  it('returns 0 when prev is empty', () => {
    assert.equal(findSharedPrefix([], [m('a')]), 0);
    assert.equal(findSharedPrefix(null, [m('a')]), 0);
    assert.equal(findSharedPrefix(undefined, [m('a')]), 0);
  });

  it('returns 0 when curr is not an array', () => {
    assert.equal(findSharedPrefix([m('a')], null), 0);
    assert.equal(findSharedPrefix([m('a')], 'not-an-array'), 0);
  });

  it('returns 0 when prev length >= curr length (compaction or retry)', () => {
    assert.equal(findSharedPrefix([m('a'), m('b')], [m('a')]), 0);
    assert.equal(findSharedPrefix([m('a'), m('b')], [m('a'), m('b')]), 0);
  });

  it('returns prev.length when prev is a prefix of curr (append-only)', () => {
    const prev = [m('a'), m('b')];
    const curr = [m('a'), m('b'), m('c')];
    assert.equal(findSharedPrefix(prev, curr), 2);
  });

  it('returns 0 when last shared message diverges (fork or compaction-then-edit)', () => {
    const prev = [m('a'), m('b')];
    const curr = [m('a'), m('b-edited'), m('c')];
    assert.equal(findSharedPrefix(prev, curr), 0);
  });

  it('treats cache_control-only differences as matching', () => {
    const a = m('hello');
    const b = { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] };
    const prev = [m('first'), a];
    const curr = [m('first'), b, m('extra')];
    assert.equal(findSharedPrefix(prev, curr), 2);
  });

  it('returns 0 when message position differs (last shared msg moved)', () => {
    const prev = [m('a'), m('b'), m('c')];
    const curr = [m('a'), m('b'), m('different'), m('c')]; // c moved one slot right
    assert.equal(findSharedPrefix(prev, curr), 0);
  });
});

// ── findSharedPrefixFromLast (memory-minimal variant for migration script) ──

describe('findSharedPrefixFromLast', () => {
  const m = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

  it('returns 0 when prevCount is 0 or prevLastMsg missing', () => {
    assert.equal(findSharedPrefixFromLast(null, 5, [m('a')]), 0);
    assert.equal(findSharedPrefixFromLast(m('a'), 0, [m('a')]), 0);
  });

  it('returns 0 when prevCount >= curr.length (retry/compaction)', () => {
    assert.equal(findSharedPrefixFromLast(m('b'), 2, [m('a'), m('b')]), 0);
    assert.equal(findSharedPrefixFromLast(m('a'), 1, [m('a')]), 0);
  });

  it('returns prevCount when last-msg matches at correct position', () => {
    const curr = [m('a'), m('b'), m('c')];
    assert.equal(findSharedPrefixFromLast(m('b'), 2, curr), 2);
  });

  it('returns 0 when last-msg disagrees', () => {
    const curr = [m('a'), m('b-different'), m('c')];
    assert.equal(findSharedPrefixFromLast(m('b'), 2, curr), 0);
  });

  it('survives cache_control rotation on the last shared message', () => {
    const prevLast = m('shared');
    const currLastWithCache = { role: 'user', content: [{ type: 'text', text: 'shared', cache_control: { type: 'ephemeral' } }] };
    const curr = [m('first'), currLastWithCache, m('new')];
    assert.equal(findSharedPrefixFromLast(prevLast, 2, curr), 2);
  });
});
