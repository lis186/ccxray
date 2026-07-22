'use strict';

// Golden tests for store.mergeByResponseId — the read-time merge that collapses
// multi-instance duplicate logs (#333, ADR 0012). Fixture shapes model the
// reported evidence session 40633ce5, where each turn had 2–8 copies carrying
// complementary partial metadata.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../server/store');
const { mergeByResponseId } = store;

describe('store.mergeByResponseId (#333)', () => {
  it('folds complementary partial copies into one richest record', () => {
    // Three copies of one logical response (msg_01A): the metadata is split
    // across them exactly as chained proxies produce.
    const proxyEarly = {
      id: '2026-07-22T10-00-00-000', ts: '10:00:00', responseId: 'msg_01A',
      receivedAt: 1000, elapsed: '2.0',
      agentKey: 'orchestrator', agentLabel: 'Claude Code', coreHash: 'core1',
      sessionId: 's-real', sessionInferred: false, isSubagent: false,
      usage: null, cost: null, convId: null,
    };
    const proxyLate = {
      id: '2026-07-22T10-00-01-000', ts: '10:00:01', responseId: 'msg_01A',
      receivedAt: 2000, elapsed: '1.0',
      agentKey: null, coreHash: null,
      sessionId: 'direct-api', sessionInferred: true, isSubagent: false,
      usage: { input_tokens: 1200, output_tokens: 42 }, cost: { cost: 0.03 }, maxContext: 200000,
      convId: null,
    };
    const importedCopy = {
      id: '2026-07-22T10-00-02-000', ts: '10:00:02', responseId: 'msg_01A',
      receivedAt: 500, elapsed: '9.9', // earliest by time, but imported
      imported: true, importSource: 'transcript',
      convId: 'conv77', agentKey: null,
      usage: { input_tokens: 1200, output_tokens: 42 }, cost: { cost: 0.03 },
    };

    const out = mergeByResponseId([proxyEarly, proxyLate, importedCopy]);
    assert.equal(out.length, 1, 'three copies collapse to one');
    const m = out[0];

    // Canonical = earliest-receivedAt PROXY copy (imported is earlier but excluded).
    assert.equal(m.id, proxyEarly.id, 'canonical id is earliest proxy, not the earlier import');
    assert.equal(m.ts, '10:00:00');
    assert.equal(m.elapsed, '2.0', 'canonical elapsed stays paired with its receivedAt');

    // Complementary fields reconstructed from whichever copy had them.
    assert.equal(m.agentKey, 'orchestrator', 'agentKey filled from the copy that had it');
    assert.equal(m.coreHash, 'core1');
    assert.equal(m.convId, 'conv77', 'convId filled from the imported copy');
    assert.equal(m.usage.output_tokens, 42, 'usage filled from the copy with real tokens');

    // Cost counted once (the richest-usage copy's), never summed.
    assert.deepEqual(m.cost, { cost: 0.03 });

    // A proxy observation supersedes the import reconstruction.
    assert.ok(!m.imported, 'imported cleared when a proxy copy is canonical');
    assert.ok(!m.importSource);

    // Session identity from the real explicit-session copy.
    assert.equal(m.sessionId, 's-real');
    assert.equal(m.sessionInferred, false);

    // Dropped copy ids recorded for alias registration (Phase 3).
    assert.deepEqual([...m._mergedIds].sort(), [proxyLate.id, importedCopy.id].sort());
  });

  it('passes through entries without a responseId untouched, preserving order', () => {
    const a = { id: 'a', responseId: null };
    const b = { id: 'b' }; // no responseId key at all
    const c = { id: 'c', responseId: 'msg_01C', agentKey: 'orchestrator' };
    const out = mergeByResponseId([a, b, c]);
    assert.equal(out.length, 3);
    assert.equal(out[0], a, 'null-responseId entry is the same object, unmerged');
    assert.equal(out[1], b);
    assert.equal(out[2].id, 'c');
  });

  it('returns a singleton responseId group as the same object', () => {
    const only = { id: 'x', responseId: 'msg_01X', agentKey: 'orchestrator' };
    const out = mergeByResponseId([only]);
    assert.equal(out.length, 1);
    assert.equal(out[0], only);
  });

  it('preserves first-encounter order across mixed groups', () => {
    const list = [
      { id: 'p1', responseId: 'R1', receivedAt: 1 },
      { id: 'n1', responseId: null },
      { id: 'p2', responseId: 'R2', receivedAt: 1 },
      { id: 'p1b', responseId: 'R1', receivedAt: 2 }, // second copy of R1
    ];
    const out = mergeByResponseId(list);
    assert.deepEqual(out.map(e => e.id), ['p1', 'n1', 'p2'],
      'R1 canonical keeps its first slot; second R1 copy folded away');
  });

  it('flags edited when a hash conflict indicates an intercept-edit hop', () => {
    const out = mergeByResponseId([
      { id: 'a', responseId: 'R', receivedAt: 1, sysHash: 'h1' },
      { id: 'b', responseId: 'R', receivedAt: 2, sysHash: 'h2' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].sysHash, 'h1', 'canonical hash kept');
    assert.equal(out[0].edited, true, 'differing hash flags edited');
  });

  it('does not resurrect req/res or load state across copies', () => {
    const canonical = { id: 'a', responseId: 'R', receivedAt: 1, req: null, res: null, _loaded: false };
    const other = { id: 'b', responseId: 'R', receivedAt: 2, req: { big: 1 }, res: [1, 2], _loaded: true };
    const out = mergeByResponseId([canonical, other]);
    assert.equal(out[0].req, null, 'released req stays null — not resurrected from another copy');
    assert.equal(out[0].res, null);
    assert.equal(out[0]._loaded, false);
  });
});

describe('store.registerOrMerge (#333 live path)', () => {
  it('registers a first copy, then folds a duplicate and aliases its id', () => {
    store.responseIndex.clear();
    store.entryIndex.clear();
    const first = { id: 'a1', responseId: 'R', receivedAt: 1, agentKey: 'orchestrator',
      usage: null, cost: null, sessionId: 's', sessionInferred: false, isSubagent: false };
    const r1 = store.registerOrMerge(first);
    assert.equal(r1.merged, false, 'first copy is not a merge');
    assert.equal(r1.canonical, first);

    const dup = { id: 'a2', responseId: 'R', receivedAt: 2, agentKey: null,
      usage: { input_tokens: 100, output_tokens: 9 }, cost: { cost: 0.02 } };
    const r2 = store.registerOrMerge(dup);
    assert.equal(r2.merged, true, 'a known responseId folds in');
    assert.equal(r2.canonical, first, 'the first-registered stays canonical (no swap)');
    assert.equal(first.usage.output_tokens, 9, 'duplicate usage folded into canonical');
    assert.equal(first.agentKey, 'orchestrator', 'canonical keeps its identity');
    assert.equal(store.getEntryById('a2'), first, 'the duplicate id aliases to canonical');
    assert.deepEqual(first._mergedIds, ['a2']);
  });

  it('never merges when responseId is absent (OpenAI/WS exemption path)', () => {
    store.responseIndex.clear();
    assert.equal(store.registerOrMerge({ id: 'x', responseId: null }).merged, false);
    assert.equal(store.registerOrMerge({ id: 'y' }).merged, false);
  });
});
