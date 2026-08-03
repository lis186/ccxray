'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('#427 Phase 2: UI consumers prefer turnToolCalls over toolCalls', () => {
  it('entry-rendering hot path sums turnToolCalls (not cumulative toolCalls)', () => {
    // Simulate 3 turns with cumulative toolCalls and per-turn turnToolCalls
    const entries = [
      { toolCalls: { Bash: 1, Read: 1 }, turnToolCalls: { Bash: 1, Read: 1 } },
      { toolCalls: { Bash: 2, Read: 2 }, turnToolCalls: { Bash: 1, Read: 1 } },
      { toolCalls: { Bash: 3, Read: 2, Edit: 1 }, turnToolCalls: { Bash: 1, Edit: 1 } },
    ];
    // Replicate the hot path logic
    const sess = { toolCalls: {} };
    for (const e of entries) {
      const tc = e.turnToolCalls || null;
      const legacy = !tc && e.toolCalls && Object.keys(e.toolCalls).length > 0;
      const src = tc || (legacy ? e.toolCalls : null);
      if (src && Object.keys(src).length > 0) {
        for (const [name, cnt] of Object.entries(src)) {
          sess.toolCalls[name] = tc
            ? (sess.toolCalls[name] || 0) + cnt
            : Math.max(sess.toolCalls[name] || 0, cnt);
        }
      }
    }
    // With turnToolCalls: Bash=3 (1+1+1), Read=2 (1+1), Edit=1
    assert.deepEqual(sess.toolCalls, { Bash: 3, Read: 2, Edit: 1 });
  });

  it('falls back to per-tool max for legacy entries (no turnToolCalls)', () => {
    const entries = [
      { toolCalls: { Bash: 1, Read: 1 } },
      { toolCalls: { Bash: 2, Read: 2 } },
      { toolCalls: { Bash: 3, Read: 2, Edit: 1 } },
    ];
    const sess = { toolCalls: {} };
    for (const e of entries) {
      const tc = e.turnToolCalls || null;
      const legacy = !tc && e.toolCalls && Object.keys(e.toolCalls).length > 0;
      const src = tc || (legacy ? e.toolCalls : null);
      if (src && Object.keys(src).length > 0) {
        for (const [name, cnt] of Object.entries(src)) {
          sess.toolCalls[name] = tc
            ? (sess.toolCalls[name] || 0) + cnt
            : Math.max(sess.toolCalls[name] || 0, cnt);
        }
      }
    }
    // With max fallback: Bash=3 (max of 1,2,3), Read=2 (max), Edit=1
    assert.deepEqual(sess.toolCalls, { Bash: 3, Read: 2, Edit: 1 });
    // Key: WITHOUT the fix, summing cumulative would give Bash=6, Read=5, Edit=1
  });

  it('mixed session: new turnToolCalls entries sum, legacy entries max', () => {
    const entries = [
      { toolCalls: { Bash: 5 } },  // legacy (cumulative)
      { toolCalls: { Bash: 8 }, turnToolCalls: { Bash: 3 } },  // new
      { toolCalls: { Bash: 10 }, turnToolCalls: { Bash: 2 } },  // new
    ];
    const sess = { toolCalls: {} };
    for (const e of entries) {
      const tc = e.turnToolCalls || null;
      const legacy = !tc && e.toolCalls && Object.keys(e.toolCalls).length > 0;
      const src = tc || (legacy ? e.toolCalls : null);
      if (src && Object.keys(src).length > 0) {
        for (const [name, cnt] of Object.entries(src)) {
          sess.toolCalls[name] = tc
            ? (sess.toolCalls[name] || 0) + cnt
            : Math.max(sess.toolCalls[name] || 0, cnt);
        }
      }
    }
    // Legacy max(5)=5, then +3, then +2 = 10
    assert.equal(sess.toolCalls.Bash, 10);
  });
});
