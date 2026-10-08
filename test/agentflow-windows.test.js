'use strict';

// Ask-window fixtures from docs/agentflow-integration.md (F3, F7-F10, F17). The
// spec's common premise holds unless a case says otherwise: one notebook, every
// earlier Ask has a Reply stamp, every stated submission is within its bounds.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildWindows, disclose, resolveTurn } = require('../server/agentflow/windows');

const MIN = 60 * 1000;
const T = m => Date.UTC(2026, 5, 1, 10, 0, 0) + m * MIN;
const NOW = T(1000);
const ask = (id, bullets, stampMin = null, extra = {}) => ({ id, bullets, hasReply: stampMin != null, stamp: stampMin == null ? null : T(stampMin), identity: null, stampUnreadable: false, ...extra });
const sub = (key, sid, m, text) => ({ key, sessionIds: [sid], at: T(m), text });
const run = (asks, subs, opts = {}) => buildWindows(asks, subs, { now: NOW, ...opts });
const win = (r, id) => r.windows.find(w => w.id === id);

describe('W3/W4/W6: start by ordered alignment', () => {
  it('starts at the matched submission and ends at stamp + tail, capped at the next start', () => {
    const r = run([ask('A-001', ['hello'], 10), ask('A-002', ['next'], 30)],
      [sub('u1', 'S1', 1, 'hello'), sub('u2', 'S1', 11, 'next')]);
    assert.deepEqual([win(r, 'A-001').start, win(r, 'A-001').end], [T(1), T(11)]);
    assert.deepEqual([win(r, 'A-002').start, win(r, 'A-002').end], [T(11), T(32)]);
    assert.deepEqual(win(r, 'A-001').hostSessions, ['S1']);
  });

  it('caps a tail at a matched next start', () => {
    const r = run([ask('A-001', ['hello'], 10), ask('A-002', ['next'], 20)], [sub('u1', 'S1', 1, 'hello'), sub('u2', 'S1', 10.5, 'next')]);
    assert.equal(win(r, 'A-001').end, T(10.5));
  });

  it('an estimated start begins after the previous tail, so wrap-up turns stay with the previous Ask', () => {
    const r = run([ask('A-001', ['hello'], 10), ask('A-002', ['typed into the notebook'], 20)],
      [sub('u1', 'S1', 1, 'hello'), sub('u2', 'S1', 15, 'chat that matches no bullet')]);
    assert.equal(win(r, 'A-001').end, T(12));
    assert.deepEqual([win(r, 'A-002').startKind, win(r, 'A-002').start], ['estimated', T(12)]);
    assert.equal(resolveTurn(r.windows, T(11)).id, 'A-001');
  });

  it('an Ask with no local owner submission in its bounds is `no local evidence` and takes no host turn', () => {
    const r = run([ask('A-001', ['hello'], 10), ask('A-002', ['ran on another machine'], 20), ask('A-003', ['back here'], 30)],
      [sub('u1', 'S1', 1, 'hello'), sub('u3', 'S1', 25, 'back here')]);
    const w = win(r, 'A-002');
    assert.deepEqual([w.startKind, w.labels], ['no local evidence', ['no local evidence']]);
    assert.equal(win(r, 'A-001').end, T(12), 'it does not cap the previous tail');
    assert.equal(resolveTurn(r.windows, T(15)), null);
    assert.equal(resolveTurn(r.windows, T(26)).id, 'A-003');
  });

  it('F7: the same text matches its own round on each side of a stamp', () => {
    const r = run([ask('A-001', ['start', 'continue'], 10), ask('A-002', ['continue'], 20)],
      [sub('u1', 'S1', 1, 'start'), sub('u2', 'S1', 5, 'continue'), sub('u3', 'S1', 12, 'continue')]);
    assert.equal(win(r, 'A-002').start, T(12));
    assert.equal(win(r, 'A-001').labels.includes('reopened (unsupported)'), false);
    assert.equal(disclose(win(r, 'A-001'), 'S1', r).unmatched, 0);
  });

  it('W3 strictness: a submission exactly at the previous stamp belongs to neither side', () => {
    const r = run([ask('A-001', ['a'], 10), ask('A-002', ['b'], 20)], [sub('u1', 'S1', 1, 'a'), sub('u2', 'S1', 10, 'b')]);
    assert.notEqual(win(r, 'A-002').startKind, 'matched');
  });

  it('F8: skips a tag-only bullet and matches three bullets to three paragraphs of one submission', () => {
    const r = run([ask('A-001', ['one', 'two', 'three'], 10)],
      [sub('u1', 'S1', 1, '<pasted_content>\n\none\n\ntwo\n\nthree')]);
    assert.equal(win(r, 'A-001').start, T(1));
    assert.equal(r.consumed.has('u1'), true);
  });

  // W3 already keeps an earlier Ask's submissions out of a later Ask's bounds;
  // these two rules bite only where an earlier Ask has no stamp to bound it.
  it('a submission consumed by one Ask is never consumed by another', () => {
    const r = run([ask('A-001', ['one']), ask('A-002', ['two'], 20)], [sub('u1', 'S1', 1, 'one\n\ntwo')]);
    assert.equal(win(r, 'A-001').start, T(1));
    assert.equal(win(r, 'A-002').start, null);
    assert.deepEqual(win(r, 'A-002').labels, ['unmeasured']);
  });

  it('bullets consume paragraphs in order: a bullet cannot match a paragraph before the last one consumed', () => {
    const r = run([ask('A-001', ['b', 'a'], 10)], [sub('u1', 'S1', 1, 'a'), sub('u2', 'S1', 2, 'b')]);
    assert.equal(win(r, 'A-001').start, T(2));
    assert.equal(r.consumed.has('u1'), false);
  });

  it('F10: a hand-written bullet is skipped; with no owner bullet the start is estimated', () => {
    const r = run([ask('A-001', ['x'], 10), ask('A-002', ['hand written', 'owner prompt'], 20), ask('A-003', ['hand only'], 30)],
      [sub('u1', 'S1', 1, 'x'), sub('u2', 'S1', 12, 'owner prompt'), sub('u4', 'S1', 25, 'owner text the notebook renders differently')]);
    assert.equal(win(r, 'A-002').start, T(12));
    assert.equal(win(r, 'A-002').unmatchedBullets, 1);
    assert.deepEqual([win(r, 'A-003').start, win(r, 'A-003').startKind], [T(22), 'estimated']);
    assert.ok(win(r, 'A-003').labels.includes('estimated start'));
  });

  it('a first Ask with no match and no earlier stamp is unmeasured; an empty scaffold has no window', () => {
    const r = run([ask('A-001', ['typed'], 10), ask('A-002', [])], []);
    assert.deepEqual(win(r, 'A-001').labels, ['unmeasured']);
    assert.deepEqual(win(r, 'A-002').labels, ['empty']);
    assert.equal(win(r, 'A-002').start, null);
  });

  it('a closed Ask with an unreadable stamp has no window and is never treated as open', () => {
    const r = run([ask('A-001', ['x'], null, { hasReply: true, stampUnreadable: true }), ask('A-002', ['y'], 20)],
      [sub('u1', 'S1', 1, 'x'), sub('u2', 'S1', 5, 'y')]);
    assert.deepEqual(win(r, 'A-001').labels, ['stamp unreadable']);
    assert.equal(win(r, 'A-001').end, null);
    assert.equal(r.consumed.has('u1'), false, 'an Ask without bounds consumes nothing');
    assert.equal(win(r, 'A-002').start, T(5));
  });

  it('an unreadable stamp gives no lower bound to the next Ask', () => {
    const r = run([ask('A-001', ['x'], null, { hasReply: true, stampUnreadable: true }), ask('A-002', ['y'], 20)], [sub('u2', 'S1', 0.5, 'y')]);
    assert.equal(win(r, 'A-002').start, T(0.5));
  });

  it('an open Ask ends now', () => {
    const r = run([ask('A-001', ['x'], 10), ask('A-002', ['y'])], [sub('u1', 'S1', 1, 'x'), sub('u2', 'S1', 15, 'y')]);
    assert.deepEqual([win(r, 'A-002').end, win(r, 'A-002').labels], [NOW, ['open']]);
  });
});

describe('F3: one submission in two transcripts', () => {
  it('(a) identical uuids were merged upstream: one match, both sessions host rows', () => {
    const r = run([ask('A-001', ['go'], 10)], [{ key: 'u1', sessionIds: ['S1', 'S2'], at: T(1), text: 'go' }]);
    assert.deepEqual(win(r, 'A-001').hostSessions, ['S1', 'S2']);
    assert.equal(win(r, 'A-001').labels.includes('start tie'), false);
  });

  it('(b) rewritten uuids: the earlier copy matches, `start tie`, the other copy is unmatched', () => {
    const r = run([ask('A-001', ['go'], 10)], [sub('u1', 'S1', 1, 'go'), sub('u2', 'S2', 2, 'go')]);
    const w = win(r, 'A-001');
    assert.equal(w.start, T(1));
    assert.ok(w.labels.includes('start tie'));
    assert.deepEqual(w.hostSessions, ['S1']);
    assert.equal(disclose(w, 'S2', r).unmatched, 1);
  });

  it('(c) original deleted: one match', () => {
    const r = run([ask('A-001', ['go'], 10)], [sub('u2', 'S2', 2, 'go')]);
    assert.equal(win(r, 'A-001').start, T(2));
  });
});

describe('F9: uncaptured prompts in the tail', () => {
  it('are not bullets, stay in A-001 by window, and are disclosed as 4 unmatched', () => {
    const r = run([ask('A-001', ['work'], 10), ask('A-002', [])],
      [sub('u1', 'S1', 1, 'work'), ...['no-ag hi', 'no open ask', 'refused', 'godev'].map((t, i) => sub('t' + i, 'S1', 10.2 + i * 0.3, t))]);
    const w = win(r, 'A-001');
    assert.equal(w.end, T(12));
    assert.equal(disclose(w, 'S1', r).unmatched, 4);
    assert.equal(disclose(w, 'S1', r).after.length, 4);
  });
});

describe('F17: a bullet whose only equal submission is after the stamp', () => {
  it('stays unmatched and is disclosed; the window is not extended and no reopening is inferred', () => {
    const r = run([ask('A-001', ['first', 'added later'], 10)], [sub('u1', 'S1', 1, 'first'), sub('u2', 'S1', 15, 'added later')]);
    const w = win(r, 'A-001');
    assert.equal(w.unmatchedBullets, 1);
    assert.deepEqual(w.labels, []);
    assert.equal(w.end, T(12));
  });
});

describe('resolveTurn', () => {
  it('gives an overlapped turn to the latest start and flags the overlap', () => {
    const windows = [{ id: 'A-001', startKind: 'matched', start: T(0), end: T(12) }, { id: 'A-002', startKind: 'estimated', start: T(11), end: T(30) }, { id: 'A-003', startKind: null, start: null, end: null }];
    assert.deepEqual(resolveTurn(windows, T(11.5)), { id: 'A-002', overlap: true });
    assert.deepEqual(resolveTurn(windows, T(5)), { id: 'A-001', overlap: false });
    assert.equal(resolveTurn(windows, T(40)), null);
  });
});
