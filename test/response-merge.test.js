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

  it('#339: ORs the monotone beta1m fact so a copy that saw 1M heals one that did not', () => {
    // beta1m is add-only + monotone. The canonical (earliest copy) may lack it while a
    // later copy saw the 1M header; the fold must carry it over so sessionCtxWindow reads
    // 1M. Never fabricates it, never downgrades true→false.
    const canonNoB = { id: 'p1', responseId: 'R1', receivedAt: 1, usage: { output_tokens: 5 } };
    const laterB = { id: 'p2', responseId: 'R1', receivedAt: 2, beta1m: true };
    const out = mergeByResponseId([canonNoB, laterB]);
    assert.equal(out[0].id, 'p1', 'canonical is the earliest copy (which had no beta1m of its own)');
    assert.equal(out[0].beta1m, true, 'beta1m OR-ed in from the later copy (fail-on-old: was dropped)');
    // No 1M signal in any copy → the fact stays absent.
    const n1 = { id: 'q1', responseId: 'R2', receivedAt: 1 };
    const n2 = { id: 'q2', responseId: 'R2', receivedAt: 2 };
    assert.ok(!mergeByResponseId([n1, n2])[0].beta1m, 'no beta1m anywhere → none fabricated');
  });

  it('carries the raw context-* beta across a merge, not just its interpretation (fail-on-old)', () => {
    // The merge already ORs beta1m. Keeping the conclusion while dropping the
    // observation it was drawn from loses the more fundamental fact — and with it
    // any tier the boolean cannot express — e.g. a canonical copy written before the
    // header was observed on a later copy of the same response.
    const canonNoHeader = { id: 'p1', responseId: 'R9', receivedAt: 1, usage: { output_tokens: 5 } };
    const laterSawHeader = { id: 'p2', responseId: 'R9', receivedAt: 2, beta1m: true, ctxBeta: 'context-1m-2025-08-07' };
    const out = mergeByResponseId([canonNoHeader, laterSawHeader]);
    assert.equal(out[0].id, 'p1', 'canonical is the earliest copy, which had no header of its own');
    assert.equal(out[0].ctxBeta, 'context-1m-2025-08-07');
    assert.equal(out[0].beta1m, true);
    // Never overwrites an observation the canonical already has.
    const a = { id: 'a1', responseId: 'R10', receivedAt: 1, ctxBeta: 'context-1m-2025-08-07' };
    const b = { id: 'b1', responseId: 'R10', receivedAt: 2, ctxBeta: 'context-400k-2026-01-01' };
    assert.equal(mergeByResponseId([a, b])[0].ctxBeta, 'context-1m-2025-08-07');
  });

  it('#420 codex R2 M2: on equal usage a priced cost beats an unpriced canonical', () => {
    // Chained-proxy shape: an outdated hop has no rate (unknown, cost null),
    // the updated hop priced the same response. Identical usage tuples tied the
    // old strict-> richness rule, pinning the merged turn to cost null forever —
    // the aggregate `+` marker then survived a copy that had a real price.
    const usage = { input_tokens: 1200, output_tokens: 42 };
    const unknownFirst = { id: 'p1', responseId: 'R', receivedAt: 1, usage: { ...usage }, cost: { cost: null, confidence: 'unknown' } };
    const pricedLater = { id: 'p2', responseId: 'R', receivedAt: 2, usage: { ...usage }, cost: { cost: 0.25, confidence: 'fallback' } };
    const out = mergeByResponseId([unknownFirst, pricedLater]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'p1', 'earliest copy stays canonical');
    assert.equal(out[0].cost.cost, 0.25, 'priced unit wins the equal-richness tie');
    assert.equal(out[0].cost.confidence, 'fallback');
    // R3 M1: a metadata-poor priced winner must not wipe a real maxContext.
    const unk1m = { id: 'w1', responseId: 'R3', receivedAt: 1, usage: { ...usage }, cost: { cost: null, confidence: 'unknown' }, maxContext: 1000000 };
    const pricedNoCtx = { id: 'w2', responseId: 'R3', receivedAt: 2, usage: { ...usage }, cost: { cost: 0.25, confidence: 'exact' } };
    const out3 = mergeByResponseId([unk1m, pricedNoCtx]);
    assert.equal(out3[0].cost.cost, 0.25);
    assert.equal(out3[0].maxContext, 1000000, 'canonical maxContext survives a tie-break cost adoption');
    // R3 M2: a legacy NUMERIC cost never wins the tie — session-index cannot
    // aggregate the numeric shape, so promoting it would desync the fold.
    const unkFirst2 = { id: 'v1', responseId: 'R4', receivedAt: 1, usage: { ...usage }, cost: { cost: null, confidence: 'unknown' } };
    const legacyNum = { id: 'v2', responseId: 'R4', receivedAt: 2, usage: { ...usage }, cost: 0.25 };
    const out4 = mergeByResponseId([unkFirst2, legacyNum]);
    assert.equal(out4[0].cost.cost, null, 'numeric legacy cost does not win the tie-break');
    // Reverse arrival: priced canonical must NOT be downgraded by an unpriced copy.
    const pricedFirst = { id: 'q1', responseId: 'R2', receivedAt: 1, usage: { ...usage }, cost: { cost: 0.25, confidence: 'exact' } };
    const unknownLater = { id: 'q2', responseId: 'R2', receivedAt: 2, usage: { ...usage }, cost: { cost: null, confidence: 'unknown' } };
    const out2 = mergeByResponseId([pricedFirst, unknownLater]);
    assert.equal(out2[0].cost.cost, 0.25, 'priced canonical retained');
    assert.equal(out2[0].cost.confidence, 'exact');
  });

  it('a copy with unknown receivedAt never wins canonical over a timed copy (m2)', () => {
    // A rebuild-generated orphan (receivedAt=null) must not displace a fully-timed
    // proxy copy as canonical — that would erase the turn's timeline placement.
    const orphan = { id: '2026-07-20T09-00-00-000', responseId: 'R', receivedAt: null, agentKey: 'orchestrator' };
    const timed = { id: '2026-07-20T10-00-00-000', responseId: 'R', receivedAt: 5000, usage: { output_tokens: 5 } };
    const out = mergeByResponseId([orphan, timed]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, timed.id, 'timed copy is canonical, not the untimed orphan');
    assert.equal(out[0].receivedAt, 5000);
    assert.equal(out[0].agentKey, 'orchestrator', 'orphan metadata still folds in');
  });

  it('adopts sessionId + isSubagent + sessionInferred as one consistent unit (M8)', () => {
    // Copy A: real explicit session but no agentKey. Copy B: agentKey + real
    // session + isSubagent=true. The identity triple must come from B (agentKey +
    // real session), not be split so sessionId says one thing and isSubagent another.
    const a = { id: 'a', responseId: 'R', receivedAt: 1, sessionId: 's-real', sessionInferred: false, isSubagent: false };
    const b = { id: 'b', responseId: 'R', receivedAt: 2, sessionId: 's-real', sessionInferred: false, isSubagent: true, agentKey: 'general-purpose' };
    const out = mergeByResponseId([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, 's-real');
    assert.equal(out[0].sessionInferred, false);
    assert.equal(out[0].isSubagent, true, 'isSubagent travels with the agentKey copy, consistent with its session');
    assert.equal(out[0].agentKey, 'general-purpose');
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

  it('ORs boolean evidence and fills empty maps (thinkingStripped/toolSources) (R3-m1)', () => {
    // canonical=false/{} must not read as authoritative and block the other copy's
    // real values.
    const canonical = { id: 'a', responseId: 'R', receivedAt: 1, thinkingStripped: false, toolSources: {} };
    const other = { id: 'b', responseId: 'R', receivedAt: 2, thinkingStripped: true, toolSources: { mcp: 2 } };
    const out = mergeByResponseId([canonical, other]);
    assert.equal(out.length, 1);
    assert.equal(out[0].thinkingStripped, true, 'false ORs up to true');
    assert.deepEqual(out[0].toolSources, { mcp: 2 }, 'empty {} is filled by a real map');
  });

  it('an identity copy lacking isSubagent does not wipe a real value (R4 minor)', () => {
    // Proxy copy: inferred session, no agentKey, but classified isSubagent=true.
    // Importer copy: real explicit session (scores higher) but never sets isSubagent.
    // The importer wins sessionId, but its undefined isSubagent must NOT overwrite true.
    const proxy = { id: 'p', responseId: 'R', receivedAt: 1, sessionId: 'direct-api', sessionInferred: true, isSubagent: true };
    const imp = { id: 'i', responseId: 'R', receivedAt: 2, sessionId: 's-real', sessionInferred: false, imported: true };
    const out = mergeByResponseId([proxy, imp]);
    assert.equal(out.length, 1);
    assert.equal(out[0].sessionId, 's-real', 'real session adopted from importer copy');
    assert.equal(out[0].isSubagent, true, 'undefined importer isSubagent did not wipe the proxy true');
  });

  // #503 addendum: turnToolResults union by callId. The old fill-if-empty rule
  // dropped `other` whenever the canonical array was non-empty, which loses the
  // complementary half of an import×proxy pair — the proxy writes
  // `toolFail: is_error === true` (absent ⇒ false) while the importer writes
  // tri-state undefined for the ~48% of historical tool_results with no is_error.
  describe('turnToolResults union by callId (ADR 0018 tri-state per result)', () => {
    it('a failure only the imported copy saw survives the merge — and reaches weather', () => {
      // Turn 0 issues two Bash calls; turn 1 carries their results in two copies.
      const callTurn = {
        id: 'c0', responseId: 'msg_A', receivedAt: 1000,
        turnToolCallIds: { t1: 'Bash', t2: 'Bash' },
      };
      const proxyCopy = {
        id: 'r1', responseId: 'msg_B', receivedAt: 2000,
        turnToolResults: [
          { callId: 't1', toolFail: false, eligible: true },
          { callId: 't2', toolFail: false, eligible: true },
        ],
      };
      const importedCopy = {
        id: 'r2', responseId: 'msg_B', receivedAt: 2001, imported: true,
        turnToolResults: [
          { callId: 't1', eligible: true },                 // transcript had no is_error
          { callId: 't2', toolFail: true, eligible: true },  // …and this one failed
        ],
      };
      const out = mergeByResponseId([callTurn, proxyCopy, importedCopy]);
      assert.equal(out.length, 2);
      const merged = out[1];
      const byId = Object.fromEntries(merged.turnToolResults.map(r => [r.callId, r]));
      assert.equal(byId.t2.toolFail, true, 'the imported copy\'s failure is not dropped');
      assert.equal(byId.t1.toolFail, false, 'undefined does not downgrade a known false');
      assert.equal(merged.turnToolResults.length, 2, 'same callId folds — no duplicate rows');

      // The user-visible consequence: without the union this session renders sunny.
      const { assessWeather } = require('../public/weather');
      const w = assessWeather([callTurn, merged]);
      assert.equal(w.stats.toolSignal, 'failure', 'sigToolFailure sees the failure');
      assert.equal(w.stats.errTurns, 1);
      assert.equal(w.stats.toolTurns, 2);
    });

    it('never downgrades a known failure, and unions unseen callIds', () => {
      const canonical = {
        id: 'a', responseId: 'R', receivedAt: 1,
        turnToolResults: [{ callId: 't3', toolFail: true, eligible: true }],
      };
      const other = {
        id: 'b', responseId: 'R', receivedAt: 2,
        turnToolResults: [
          { callId: 't3', toolFail: false, eligible: true },
          { callId: 't4', toolFail: true, eligible: true },
        ],
      };
      const out = mergeByResponseId([canonical, other]);
      const byId = Object.fromEntries(out[0].turnToolResults.map(r => [r.callId, r]));
      assert.equal(byId.t3.toolFail, true, 'true is never downgraded to false');
      assert.equal(byId.t4.toolFail, true, 'a callId only the other copy saw is appended');
      assert.equal(out[0].turnToolResults.length, 2);
    });

    it('ORs eligible so a decodable copy beats an async-start placeholder', () => {
      const canonical = {
        id: 'a', responseId: 'R', receivedAt: 1,
        turnToolResults: [{ callId: 't5', eligible: false }],
      };
      const other = {
        id: 'b', responseId: 'R', receivedAt: 2,
        turnToolResults: [{ callId: 't5', toolFail: false, eligible: true }],
      };
      const out = mergeByResponseId([canonical, other]);
      assert.deepEqual(out[0].turnToolResults, [{ callId: 't5', toolFail: false, eligible: true }]);
    });

    it('folds without mutating the other copy\'s array', () => {
      const canonical = {
        id: 'a', responseId: 'R', receivedAt: 1,
        turnToolResults: [{ callId: 't6', toolFail: false, eligible: true }],
      };
      const otherResults = [{ callId: 't6', toolFail: true, eligible: true }];
      const other = { id: 'b', responseId: 'R', receivedAt: 2, turnToolResults: otherResults };
      const out = mergeByResponseId([canonical, other]);
      assert.equal(out[0].turnToolResults[0].toolFail, true);
      assert.deepEqual(otherResults, [{ callId: 't6', toolFail: true, eligible: true }],
        'source array untouched');
      assert.notEqual(out[0].turnToolResults[0], otherResults[0], 'elements are copies, not aliases');
    });

    it('still fills an empty canonical array, by copy', () => {
      const canonical = { id: 'a', responseId: 'R', receivedAt: 1, turnToolResults: [] };
      const src = [{ callId: 't7', toolFail: true, eligible: true }];
      const out = mergeByResponseId([canonical, { id: 'b', responseId: 'R', receivedAt: 2, turnToolResults: src }]);
      assert.deepEqual(out[0].turnToolResults, src);
      assert.notEqual(out[0].turnToolResults, src, 'not the same array reference');
    });
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

  it('adopts the incoming identity triple atomically when it outranks canonical (R2-M2)', () => {
    store.responseIndex.clear();
    store.entryIndex.clear();
    // Canonical registered first: inferred/direct-api but WITH an agentKey, marked
    // subagent. Then an explicit-session copy arrives — it outranks (real session),
    // so sessionId + sessionInferred + isSubagent must ALL flip together, matching
    // what the batch pass would decide on reload.
    const first = { id: 'c1', responseId: 'R', receivedAt: 1, sessionId: 'direct-api', sessionInferred: true, isSubagent: true, agentKey: 'general-purpose' };
    store.registerOrMerge(first);
    const explicit = { id: 'c2', responseId: 'R', receivedAt: 2, sessionId: 's-real', sessionInferred: false, isSubagent: false };
    const { merged, canonical } = store.registerOrMerge(explicit);
    assert.equal(merged, true);
    assert.equal(canonical.sessionId, 's-real');
    assert.equal(canonical.sessionInferred, false);
    assert.equal(canonical.isSubagent, false, 'classification flips with the session as one unit — no subagent+main desync');
  });

  it('absorbs an incoming batch group\'s aliases so trim can clean them (R2-M4)', () => {
    store.responseIndex.clear();
    store.entryIndex.clear();
    const live = { id: 'live1', responseId: 'R', receivedAt: 1 };
    store.registerOrMerge(live);
    // A restored batch canonical carrying its own merged-away ids folds into live.
    const restoredCanonical = { id: 'r1', responseId: 'R', receivedAt: 2, _mergedIds: ['r2', 'r3'] };
    const { canonical } = store.registerOrMerge(restoredCanonical);
    assert.equal(canonical, live);
    for (const aid of ['r1', 'r2', 'r3']) {
      assert.equal(store.getEntryById(aid), live, `${aid} aliases to the live canonical`);
      assert.ok(canonical._mergedIds.includes(aid), `${aid} tracked in _mergedIds for trim`);
    }
  });
});
