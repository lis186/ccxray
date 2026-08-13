#!/usr/bin/env node
'use strict';

// Weather calibration replay — runs assessWeather over real index data and
// adjudicates the toggle-ON gate defined in docs/solutions/weather-evidence-audit.md
// §5b–§5c (#484).
//
// Usage:
//   node scripts/weather-replay.js [--index PATH] [--provider anthropic|openai]
//                                  [--list-bad] [--golden]
//
// Reports all three gate prongs plus the per-turn failure-rate distribution, and
// prints a `ready` / `not ready` verdict. Readiness is still the owner's call —
// the verdict states what the DATA says, per §5b.
//
// Two dedup semantics are reported side by side, because production has two:
//   first-seen — index rebuild path, no field merge (session-index.js:113-117)
//   merged     — store.mergeByResponseId, real field merge; what _recomputeWeather
//                sees via store.entries, and what cold-load serves (api.js:122)
// A turn whose tool evidence is split across duplicate copies is invisible to the
// first pass and visible to the second, so the gap between the two columns is the
// cost of the rebuild path's cheaper dedup.
//
// READ-ONLY: never writes to ~/.ccxray, never mutates index.ndjson.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
// sessionIssuedBashCall is the ADR 0018-correct presence test, shared with the
// escalation rule in weather.js rather than reimplemented here (#509).
const { assessWeather, sessionIssuedBashCall } = require('../public/weather');
const store = require('../server/store');

// docs/solutions/weather-evidence-audit.md §5c, as revised 2026-08-11 (owner-signed).
// Prong 1 and 2 are no longer toggle conditions: prong 1 reports whether a manual
// review sample exists, prong 2 supplies the fixtures for it. The one machine-checkable
// gate is FALSE-SUNNY = 0. Prong 3 (corpus-wide no_data share) is retired — it gated a
// per-session display on corpus age, and ~85% of the index structurally cannot carry
// paired fields, so no amount of new data moved it. It is still printed for continuity
// with the runs recorded in the audit doc, labelled as retired.
const SAMPLE_MIN_PAIRED_SESSIONS = 100; // prong 1, now a sample-size indicator
const SAMPLE_MIN_DEGRADED = 20;         // prong 2, now a fixture-count indicator
const QUALIFY_PAIRED = 5;               // §4c: ≥5 paired results makes a session measurable
const DEGRADED_RATE = 0.10;             // §5c: "failure rate > 10%"

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Mirrors weather.js:22-28 (linear interpolation) so the reported distribution
// uses the same percentile definition the signals themselves do.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k), hi = Math.ceil(k);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

const pct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');

// ── ingest ─────────────────────────────────────────────────────────
// Keeps every line that has a sessionId, INCLUDING subagent lines: the merged
// pass needs them because a merge group can span copies whose isSubagent flags
// disagree, and the canonical's flag is what store.entries would hold.
async function ingest(lines, provider) {
  const all = [];
  let consumed = 0, malformed = 0, skippedProvider = 0, skippedNoSid = 0;
  for await (const line of lines) {
    if (!line) continue;
    consumed++;
    let m;
    try { m = JSON.parse(line); } catch { malformed++; continue; }
    if (!m.sessionId) { skippedNoSid++; continue; }
    if (provider && m.provider !== provider) { skippedProvider++; continue; }
    all.push(m);
  }
  return { all, consumed, malformed, skippedProvider, skippedNoSid };
}

// ── the two dedup semantics ────────────────────────────────────────
// Both return Map<sid, turns[]>.

// Mirrors _rebuildCore (session-index.js:110-119) exactly, including the ordering
// detail that a subagent line returns BEFORE the responseId set is touched — so a
// subagent copy never consumes the dedup slot of its main-lane twin.
function groupFirstSeen(all) {
  const bySid = new Map();
  const seenRid = new Set();
  for (const m of all) {
    if (m.isSubagent) continue;
    if (m.responseId) {
      if (seenRid.has(m.responseId)) continue;
      seenRid.add(m.responseId);
    }
    let arr = bySid.get(m.sessionId);
    if (!arr) { arr = []; bySid.set(m.sessionId, arr); }
    arr.push(m);
  }
  return bySid;
}

// CAUTION: store.mergeByResponseId MUTATES each group's canonical copy (it folds
// the other copies' fields into it). Every first-seen measurement must therefore
// be fully computed BEFORE this runs — see the call order in run().
// The merge is global (not per-session) because store.entries is: a duplicate pair
// whose copies disagree on sessionId resolves to the highest-identity copy's
// session, which is the behaviour _recomputeWeather actually sees.
function groupMerged(all) {
  const bySid = new Map();
  for (const m of store.mergeByResponseId(all)) {
    if (m.isSubagent) continue;
    let arr = bySid.get(m.sessionId);
    if (!arr) { arr = []; bySid.set(m.sessionId, arr); }
    arr.push(m);
  }
  return bySid;
}

// ── measurement ────────────────────────────────────────────────────
function measure(bySid) {
  const levels = {};
  const availability = {};
  const sessions = [];

  for (const [sid, turns] of bySid) {
    turns.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
    // No sessionWindow opt: the rebuild path (session-index.js:126) passes none
    // either, so weather folds the window from the turns it was given (#377).
    const w = assessWeather(turns);
    // stats.toolTurns / errTurns are the paired-and-decoded counts from
    // sigErrorCumulative. The rate is recomputed from those integers rather than
    // read from stats.errRate, which is rounded to 2dp and would move sessions
    // across the 10% boundary.
    const paired = w.stats.toolTurns || 0;
    const errs = w.stats.errTurns || 0;
    sessions.push({
      sid, turns: turns.length, level: w.level, score: w.score,
      paired, errs,
      rate: paired ? errs / paired : null,
      toolSignal: w.stats.toolSignal,
      // Derived HERE from raw fields, deliberately NOT from weather's own helper:
      // the false-sunny check below compares two independent derivations, so a
      // divergence between them shows up as a non-zero rate instead of cancelling out.
      capable: _capableBashSession(turns),
      issuedBash: sessionIssuedBashCall(turns),
      top: w.factors[0] ? w.factors[0].type : null,
    });
    levels[w.level] = (levels[w.level] || 0) + 1;
    availability[w.stats.toolSignal] = (availability[w.stats.toolSignal] || 0) + 1;
  }

  const qualifying = sessions.filter(s => s.paired >= QUALIFY_PAIRED);
  const degraded = qualifying.filter(s => s.rate > DEGRADED_RATE);
  const rates = qualifying.map(s => s.rate).sort((a, b) => a - b);
  const noData = availability.no_data || 0;

  // The gate statistic (#509): evidence-capable sessions that recorded NO paired
  // evidence and still render sunny. Denominator is evidence-capable only — a
  // session that never issued a Bash call, or whose turns predate the #486 results
  // pipeline, structurally cannot produce evidence and must not sit in it (that was
  // prong 3's defect: it measured corpus age).
  const capable = sessions.filter(s => s.capable);
  const noEvidence = s => s.toolSignal === 'no_data' || s.toolSignal === 'unmeasured';
  const falseSunny = capable.filter(s => noEvidence(s) && s.level === 'sunny');
  // Sessions the escalation caught — the population that USED to be false-sunny.
  const escalated = sessions.filter(s => s.toolSignal === 'unmeasured');

  // The p90 tail is the manual-review sample the revised §5c asks for; list it so
  // "manually check the tail" is an actionable set of ids rather than an instruction.
  const tail = qualifying.filter(s => s.rate > DEGRADED_RATE)
    .sort((a, b) => b.rate - a.rate).slice(0, 20);

  return {
    sessions, levels, availability,
    count: sessions.length,
    prong1: qualifying.length,
    prong2: degraded.length,
    capableCount: capable.length,
    issuedBashCount: sessions.filter(s => s.issuedBash).length,
    escalatedCount: escalated.length,
    falseSunny,
    falseSunnyRate: capable.length ? falseSunny.length / capable.length : 0,
    // Retired as a gate, kept for continuity with the runs already recorded in the
    // audit doc (99.5% on 2026-08-11).
    retiredNoDataRate: sessions.length ? noData / sessions.length : 0,
    tail,
    dist: {
      n: rates.length,
      p25: percentile(rates, 0.25), p50: percentile(rates, 0.50),
      p75: percentile(rates, 0.75), p90: percentile(rates, 0.90),
    },
    badRate: sessions.length ? sessions.filter(s => s.level === 'rainy' || s.level === 'stormy').length / sessions.length : 0,
  };
}

// Evidence-capable: a Bash call appears in some turn's `turnToolCallIds`. That field's
// presence is the #486/#475 capability marker — the response-side writer ran and listed
// the turn's calls — so a Bash call in it with no matching result is a real measurement
// gap. Mirrors weather.js's `_issuedCapableBashCall` by intent, kept as a separate
// implementation on purpose (see the `capable` field comment above).
function _capableBashSession(turns) {
  for (const t of turns) {
    const ids = t.turnToolCallIds;
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) continue;
    for (const callId in ids) if (ids[callId] === 'Bash') return true;
  }
  return false;
}

// Revised §5c (owner-signed 2026-08-11): the machine-checkable condition is
// false-sunny = 0. The remaining condition is a MANUAL qualitative check of the
// degraded tail, which no script can assert — so this never prints a bare "ready".
function verdict(m) {
  if (m.falseSunny.length > 0) {
    return {
      pass: false,
      text: 'NOT READY — ' + m.falseSunny.length + ' of ' + m.capableCount
        + ' evidence-capable sessions render sunny with no recorded evidence ('
        + pct(m.falseSunnyRate) + '); the #509 escalation does not cover them',
    };
  }
  const sample = m.prong1 >= SAMPLE_MIN_PAIRED_SESSIONS && m.prong2 >= SAMPLE_MIN_DEGRADED;
  return {
    pass: true,
    text: 'machine checks pass (false-sunny 0/' + m.capableCount + ') — MANUAL REVIEW OUTSTANDING: '
      + (sample
        ? 'confirm the ' + m.tail.length + ' tail sessions below are actually degraded'
        : 'review sample is thin (' + m.prong1 + ' measurable, ' + m.prong2 + ' degraded) — judge on what exists'),
  };
}

// ── reporting ──────────────────────────────────────────────────────
function reportPass(label, note, m, listBad) {
  const v = verdict(m);
  console.log('\n--- dedup semantics: ' + label + ' ---');
  console.log('  ' + note);
  console.log('  sessions: ' + m.count);
  console.log('  levels: ' + Object.keys(m.levels).map(k => k + ' ' + m.levels[k]).join(' · '));
  console.log('  tool signal: ' + Object.keys(m.availability).map(k => k + ' ' + m.availability[k]).join(' · '));
  console.log('  GATE     false-sunny (capable, no evidence, sunny) : '
    + m.falseSunny.length + '/' + m.capableCount + ' = ' + pct(m.falseSunnyRate)
    + '  (need 0)  ' + (m.falseSunny.length === 0 ? 'PASS' : 'FAIL'));
  console.log('           evidence-capable ' + m.capableCount + ' · issued Bash by any signal '
    + m.issuedBashCount + ' · escalated to ❔ by #509 ' + m.escalatedCount);
  console.log('  sample   sessions with ≥' + QUALIFY_PAIRED + ' paired Bash results : '
    + m.prong1 + '  (' + (m.prong1 >= SAMPLE_MIN_PAIRED_SESSIONS ? 'sample available' : 'thin, was prong 1 ≥' + SAMPLE_MIN_PAIRED_SESSIONS) + ')');
  console.log('  fixtures degraded samples (failure rate >' + pct(DEGRADED_RATE) + ')  : '
    + m.prong2 + '  (' + (m.prong2 >= SAMPLE_MIN_DEGRADED ? 'enough for review' : 'thin, was prong 2 ≥' + SAMPLE_MIN_DEGRADED) + ')');
  console.log('  retired  corpus-wide no_data rate               : '
    + pct(m.retiredNoDataRate) + '  (was prong 3 <50%; retired 2026-08-11 — measured corpus age, not signal quality)');
  console.log('  per-turn failure rate (n=' + m.dist.n + ' qualifying): p25 ' + pct(m.dist.p25)
    + ' · p50 ' + pct(m.dist.p50) + ' · p75 ' + pct(m.dist.p75) + ' · p90 ' + pct(m.dist.p90));
  console.log('  bad rate (rainy+stormy): ' + pct(m.badRate));
  console.log('  verdict: ' + v.text);

  if (m.tail.length) {
    console.log('  manual-review tail (highest failure rate first):');
    for (const t of m.tail) {
      console.log('    ' + t.sid.slice(0, 8) + '  ' + pct(t.rate) + '  ' + t.errs + '/' + t.paired
        + ' Bash results failed · ' + t.turns + ' turns · ' + t.level);
    }
  }
  if (m.falseSunny.length) {
    console.log('  FALSE-SUNNY sessions (should be empty):');
    for (const f of m.falseSunny.slice(0, 20)) {
      console.log('    ' + f.sid.slice(0, 8) + '  signal=' + f.toolSignal + '  ' + f.turns + ' turns');
    }
  }

  const bad = m.sessions.filter(s => s.level === 'rainy' || s.level === 'stormy')
    .sort((a, b) => b.score - a.score);
  if (bad.length) {
    const show = listBad ? bad : bad.slice(0, 15);
    console.log('  rainy/stormy (' + bad.length + '):');
    for (const b of show) {
      console.log('    ' + b.sid.slice(0, 8) + ' (' + b.turns + ' turns) — ' + b.level
        + ' score=' + b.score + ' top=' + b.top);
    }
    if (show.length < bad.length) console.log('    … and ' + (bad.length - show.length) + ' more (--list-bad for all)');
  }
  return v;
}

function reportDelta(a, b) {
  const byA = new Map(a.sessions.map(s => [s.sid, s]));
  const byB = new Map(b.sessions.map(s => [s.sid, s]));
  let levelDiff = 0, qualGain = 0, degradedGain = 0, evidenceGain = 0, evidenceLoss = 0;
  for (const s of b.sessions) {
    const p = byA.get(s.sid);
    if (!p) continue;
    if (p.level !== s.level) levelDiff++;
    if (s.paired >= QUALIFY_PAIRED && p.paired < QUALIFY_PAIRED) qualGain++;
    if (s.rate > DEGRADED_RATE && !(p.rate > DEGRADED_RATE)) degradedGain++;
    if (s.paired > p.paired) evidenceGain++;
    // A merge can only add evidence, so a loss means a copy carried a DIFFERENT
    // session id and the turn moved (ADR 0012's cross-session limitation) — worth
    // surfacing rather than hiding in an aggregate.
    if (s.paired < p.paired) evidenceLoss++;
  }
  console.log('\n=== first-seen → merged delta ===');
  console.log('  sessions only in first-seen: ' + a.sessions.filter(s => !byB.has(s.sid)).length
    + ' · only in merged: ' + b.sessions.filter(s => !byA.has(s.sid)).length);
  console.log('  sessions gaining paired evidence: ' + evidenceGain + ' · losing: ' + evidenceLoss);
  console.log('  sessions crossing into ≥' + QUALIFY_PAIRED + ' paired: ' + qualGain);
  console.log('  sessions crossing into degraded: ' + degradedGain);
  console.log('  sessions changing weather level: ' + levelDiff);
}

async function run() {
  const provider = argValue('--provider');
  if (provider && provider !== 'anthropic' && provider !== 'openai') {
    console.error('--provider must be anthropic or openai');
    process.exit(2);
  }
  const indexPath = argValue('--index')
    || path.join(process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray'), 'logs', 'index.ndjson');
  if (!fs.existsSync(indexPath)) {
    console.error('Index not found: ' + indexPath);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(indexPath), crlfDelay: Infinity });
  const ing = await ingest(rl, provider);

  console.log('\n=== Weather Replay ===');
  console.log('index: ' + indexPath);
  console.log('lines consumed: ' + ing.consumed + ' (kept ' + ing.all.length
    + ', malformed ' + ing.malformed + ', no sessionId ' + ing.skippedNoSid
    + ', other provider ' + ing.skippedProvider + ')');
  console.log('provider filter: ' + (provider || 'none (all)'));

  // ORDER IS LOAD-BEARING: measure first-seen before groupMerged mutates canonicals.
  const first = measure(groupFirstSeen(ing.all));
  const merged = measure(groupMerged(ing.all));

  const listBad = process.argv.includes('--list-bad');
  const vFirst = reportPass('first-seen', 'index rebuild path — responseId first-seen wins, no field merge', first, listBad);
  const vMerged = reportPass('merged', 'store.mergeByResponseId — what _recomputeWeather / cold-load see', merged, listBad);
  reportDelta(first, merged);

  // The verdict is the MERGED one: since #503 the rebuild path folds duplicates
  // with the same store.mergeByResponseId the store path and cold-load use, so
  // merged is what the dashboard actually renders. first-seen stays reported as
  // the counterfactual — it is the evidence for having made that change.
  console.log('\n=== Verdict (merged = the semantics production renders) ===');
  console.log('  ' + vMerged.text);
  console.log('  counterfactual (first-seen dedup): ' + vFirst.text);
  if (vFirst.pass !== vMerged.pass) {
    console.log('  NOTE: the two semantics would gate differently — the merge is what counts.');
  }
}

// ── golden self-check ──────────────────────────────────────────────
// Ground truth hand-counted BEFORE the implementation existed (see the PR body /
// docs/verification-principles.md). Each expectation below is derived by reading
// _openAIToolEvidence + sigErrorCumulative + sigToolFailure by hand, not by
// running this script.
function goldenFixture() {
  const call = (n, ids) => { const o = {}; for (const id of ids) o[id] = n; return o; };
  const results = specs => specs.map(([callId, toolFail]) => ({ callId, toolFail, eligible: true }));
  const L = [];
  const push = o => L.push(JSON.stringify(o));

  // S1 — clean: 5 paired Bash results, 0 failures → qualifies, not degraded, 'clear'
  push({ id: 's1a', sessionId: 'S1', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['a1', 'a2', 'a3', 'a4', 'a5']) });
  push({ id: 's1b', sessionId: 'S1', provider: 'anthropic', receivedAt: 2, turnToolResults: results([['a1', false], ['a2', false], ['a3', false], ['a4', false], ['a5', false]]) });

  // S2 — degraded: 6 paired, 2 failures → rate 33.3% > 10%
  push({ id: 's2a', sessionId: 'S2', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']) });
  push({ id: 's2b', sessionId: 'S2', provider: 'anthropic', receivedAt: 2, turnToolResults: results([['b1', true], ['b2', true], ['b3', false], ['b4', false], ['b5', false], ['b6', false]]) });

  // S3 — thin: 3 paired → below the ≥5 qualifier, but 'clear' not no_data
  push({ id: 's3a', sessionId: 'S3', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['c1', 'c2', 'c3']) });
  push({ id: 's3b', sessionId: 'S3', provider: 'anthropic', receivedAt: 2, turnToolResults: results([['c1', false], ['c2', false], ['c3', false]]) });

  // S4 — no tool fields at all → no_data
  push({ id: 's4a', sessionId: 'S4', provider: 'anthropic', receivedAt: 1 });
  push({ id: 's4b', sessionId: 'S4', provider: 'anthropic', receivedAt: 2 });

  // S5 — one eligible result with toolFail null → known 0 < eligible 1 → 'unavailable'
  push({ id: 's5a', sessionId: 'S5', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['e1']) });
  push({ id: 's5b', sessionId: 'S5', provider: 'anthropic', receivedAt: 2, turnToolResults: [{ callId: 'e1', toolFail: null, eligible: true }] });

  // S6 — the semantics split. Two copies of responseId r1: the imported copy comes
  // first in the file and carries NO calls; the proxy copy carries all six. The
  // results land in a later turn. first-seen keeps the imported copy → zero
  // evidence → no_data. merged picks the proxy copy as canonical → 6 paired, 2
  // failures → qualifies AND degraded.
  push({ id: 's6a1', sessionId: 'S6', provider: 'anthropic', receivedAt: 1000, responseId: 'r1', imported: true, importSource: 'golden', sessionInferred: false });
  push({ id: 's6a2', sessionId: 'S6', provider: 'anthropic', receivedAt: 1001, responseId: 'r1', sessionInferred: false, turnToolCallIds: call('Bash', ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) });
  push({ id: 's6b', sessionId: 'S6', provider: 'anthropic', receivedAt: 2000, responseId: 'r2', sessionInferred: false, turnToolResults: results([['f1', true], ['f2', true], ['f3', false], ['f4', false], ['f5', false], ['f6', false]]) });

  // S7 — subagent: 6 paired results that must never be counted
  push({ id: 's7a', sessionId: 'S7', provider: 'anthropic', receivedAt: 1, isSubagent: true, turnToolCallIds: call('Bash', ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']) });
  push({ id: 's7b', sessionId: 'S7', provider: 'anthropic', receivedAt: 2, isSubagent: true, turnToolResults: results([['g1', true], ['g2', true], ['g3', false], ['g4', false], ['g5', false], ['g6', false]]) });

  // S8 — openai: 5 paired, 1 failure → rate 20% degraded. Excluded by --provider anthropic.
  push({ id: 's8a', sessionId: 'S8', provider: 'openai', receivedAt: 1, turnToolCallIds: call('Bash', ['h1', 'h2', 'h3', 'h4', 'h5']) });
  push({ id: 's8b', sessionId: 'S8', provider: 'openai', receivedAt: 2, turnToolResults: results([['h1', true], ['h2', false], ['h3', false], ['h4', false], ['h5', false]]) });

  // S9 — exercises the #503 union rule (not just canonical selection): both copies
  // of the results turn are non-empty and carry DIFFERENT callIds, so first-seen
  // sees 3 results (below the ≥5 qualifier, clean) while the union sees 6 with one
  // failure → 1/6 = 16.7% > 10%, i.e. it crosses BOTH prongs on merge alone.
  push({ id: 's9a', sessionId: 'S9', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']) });
  push({ id: 's9b1', sessionId: 'S9', provider: 'anthropic', receivedAt: 2000, responseId: 'r9', sessionInferred: false, turnToolResults: results([['i1', false], ['i2', false], ['i3', false]]) });
  push({ id: 's9b2', sessionId: 'S9', provider: 'anthropic', receivedAt: 2001, responseId: 'r9', imported: true, sessionInferred: false, turnToolResults: results([['i4', false], ['i5', false], ['i6', true]]) });

  // S10 — #509: a capable Bash call whose result was never recorded. Zero paired
  // evidence, so it is NOT in prong 1/2 or the distribution, but it must render ❔
  // (availability 'unmeasured') instead of sunny, and it must therefore NOT count as
  // false-sunny. This is the case the escalation exists for.
  push({ id: 's10a', sessionId: 'S10', provider: 'anthropic', receivedAt: 1, turnToolCallIds: call('Bash', ['j1']) });
  push({ id: 's10b', sessionId: 'S10', provider: 'anthropic', receivedAt: 2 });

  return L;
}

// Hand-derived expectations. Per-session failure rates:
//   S1 0/5=0 · S2 2/6=1/3 · S8 1/5=0.2 · S6 0 then (merged) 2/6=1/3 · S9 0 then 1/6.
// Qualifying (≥5 paired) rate sets, sorted, feeding the percentiles below:
//   first-seen n=3 [0, 0.2, 1/3]        merged n=5 [0, 1/6, 0.2, 1/3, 1/3]
// Evidence-capable (a Bash value in some turn's turnToolCallIds): S1 S2 S3 S5 S8 S9 S10,
// plus S6 only under `merged` (first-seen keeps the copy that carries no calls).
// Escalated to ❔ ('unmeasured'): S10 only. False-sunny must be 0 everywhere — that is
// the gate, and S10 is exactly the session that would break it without the escalation.
const GOLDEN = {
  all: {
    lines: 22,
    firstSeen: { count: 9, prong1: 3, prong2: 2, noData: 2, capable: 7, escalated: 1, falseSunny: 0, dist: { n: 3, p25: 0.1, p50: 0.2, p75: 0.2 + (1 / 3 - 0.2) * 0.5, p90: 0.2 + (1 / 3 - 0.2) * 0.8 } },
    merged: { count: 9, prong1: 5, prong2: 4, noData: 1, capable: 8, escalated: 1, falseSunny: 0, dist: { n: 5, p25: 1 / 6, p50: 0.2, p75: 1 / 3, p90: 1 / 3 } },
  },
  anthropic: {
    firstSeen: { count: 8, prong1: 2, prong2: 1, noData: 2, capable: 6, escalated: 1, falseSunny: 0 },
    merged: { count: 8, prong1: 4, prong2: 3, noData: 1, capable: 7, escalated: 1, falseSunny: 0 },
  },
  openai: {
    firstSeen: { count: 1, prong1: 1, prong2: 1, noData: 0, capable: 1, escalated: 0, falseSunny: 0 },
    merged: { count: 1, prong1: 1, prong2: 1, noData: 0, capable: 1, escalated: 0, falseSunny: 0 },
  },
};

async function golden() {
  const fails = [];
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const check = (label, got, want) => {
    const ok = typeof want === 'number' && !Number.isInteger(want) ? near(got, want) : got === want;
    if (!ok) fails.push(label + ': got ' + got + ', want ' + want);
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + ' = ' + got + (ok ? '' : ' (want ' + want + ')'));
  };

  for (const provider of [null, 'anthropic', 'openai']) {
    const key = provider || 'all';
    const exp = GOLDEN[key];
    console.log('\n[golden] provider filter: ' + key);
    const ing = await ingest(goldenFixture(), provider);
    if (exp.lines != null) check(key + '.linesConsumed', ing.consumed, exp.lines);
    // Same load-bearing order as run(): first-seen before the mutating merge.
    const first = measure(groupFirstSeen(ing.all));
    const merged = measure(groupMerged(ing.all));
    for (const [name, m, want] of [['firstSeen', first, exp.firstSeen], ['merged', merged, exp.merged]]) {
      check(key + '.' + name + '.sessions', m.count, want.count);
      check(key + '.' + name + '.prong1', m.prong1, want.prong1);
      check(key + '.' + name + '.prong2', m.prong2, want.prong2);
      check(key + '.' + name + '.noData', m.availability.no_data || 0, want.noData);
      check(key + '.' + name + '.capable', m.capableCount, want.capable);
      check(key + '.' + name + '.escalatedToQuestionMark', m.escalatedCount, want.escalated);
      check(key + '.' + name + '.falseSunny', m.falseSunny.length, want.falseSunny);
      if (want.dist) {
        check(key + '.' + name + '.dist.n', m.dist.n, want.dist.n);
        for (const p of ['p25', 'p50', 'p75', 'p90']) check(key + '.' + name + '.dist.' + p, m.dist[p], want.dist[p]);
      }
      // The gate passes on the fixture (false-sunny 0) while the manual review stays
      // outstanding — assert the shape, not a bare "ready".
      check(key + '.' + name + '.gatePasses', verdict(m).pass, true);
    }
  }

  console.log('\n[golden] ' + (fails.length ? fails.length + ' FAILURE(S)' : 'all checks passed'));
  if (fails.length) { fails.forEach(f => console.error('  ' + f)); process.exit(1); }
}

(process.argv.includes('--golden') ? golden() : run()).catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
