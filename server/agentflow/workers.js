'use strict';

// External worker attribution, steps E1-E7 of docs/agentflow-integration.md.
// Pure apart from `originOf` (the E4 reflog read), which callers may inject.

const path = require('path');
const { CLONE_PATTERN } = require('./runner');
const { canonicalPath, reverseDiscovered, chainEvidence, cloneOrigin } = require('./chains');
const { resolveTurn } = require('./windows');

const LEVELS = ['dispatch', 'completion', 'launch-chain', 'window'];
const OPEN = undefined;
// E5 weak chains: a runner starts its worker within seconds, so an older launch
// started some other worker.
const WEAK_LAUNCH_GAP_MS = 2 * 60 * 1000;

function stripSlash(p) { return p && p.length > 1 ? p.replace(/\/+$/u, '') : p; }
const pairKey = p => `${p.notebook ?? '?'}\0${p.ask ?? '?'}`;

// Which notebook a dispatch record names: a stream's own artifacts name it;
// `<ws>/artifacts/` names the root only when it is the one notebook directly in
// the workspace (notebook-only streams share it, so the dimension stays open).
function dispatchNotebook(rec, notebooks, workspaceRel) {
  const f = /^features\/(.+)$/u.exec(rec.scope);
  if (f) return `${workspaceRel}/features/${f[1]}/${f[1]}.devlog.md`;
  const direct = notebooks.filter(n => path.posix.dirname(n.rel) === workspaceRel);
  return direct.length === 1 ? direct[0].rel : OPEN;
}

function windowAt(nb, at) { return resolveTurn(nb.windows, at); }

// launch-chain candidates for a launch by host session `host` at time `at`:
// the window holding it (W7 resolution, so never `no local evidence`) in each
// notebook the host works on; else those notebooks with the Ask open.
function launchCandidates(host, at, notebooks, hostOf) {
  const idx = hostOf.get(host) || [];
  const held = idx.map(i => ({ i, w: windowAt(notebooks[i], at) })).filter(x => x.w);
  if (held.length) return held.map(x => ({ notebook: notebooks[x.i].rel, ask: x.w.id }));
  return idx.map(i => ({ notebook: notebooks[i].rel, ask: OPEN }));
}

// E3 combination: strongest level first; a weaker level fills only open
// dimensions, only with a pair that agrees with every fixed one; several values
// make a dimension ambiguous; values all candidates agree on are fixed.
function combine(evidenceByLevel) {
  const fixed = { notebook: OPEN, ask: OPEN };
  const ambiguous = new Set();
  const labels = new Set();
  let level = null;
  for (const lv of LEVELS) {
    const cands = evidenceByLevel[lv];
    if (!cands || !cands.length) continue;
    const agrees = p => ['notebook', 'ask'].every(d => fixed[d] === OPEN || p[d] === OPEN || p[d] === fixed[d]);
    const ok = cands.filter(agrees);
    if (ok.length < cands.length) labels.add('evidence conflict');
    let used = false;
    for (const d of ['notebook', 'ask']) {
      if (fixed[d] !== OPEN || ambiguous.has(d)) continue;
      const vals = new Set(ok.map(p => p[d]).filter(v => v !== OPEN));
      if (vals.size === 1) { fixed[d] = [...vals][0]; used = true; }
      else if (vals.size > 1) { ambiguous.add(d); used = true; }
    }
    if (used && !level) level = lv;
  }
  return { fixed, ambiguous, labels: [...labels], level };
}

function attributeWorkers({ turns, checkoutRoot, workspaceRel, notebooks, report = 0, hostOf, toolEvents, dispatch = [], completion = [], originOf = cloneOrigin, now }) {
  const root = stripSlash(checkoutRoot);
  // The span in which the reported notebook's hosts were active on this machine.
  const ourHostTimes = turns.filter(e => (hostOf.get(e.sessionId) || []).includes(report) && e.receivedAt != null).map(e => e.receivedAt);
  const hostSpan = ourHostTimes.length ? [Math.min(...ourHostTimes), Math.max(...ourHostTimes)] : null;
  const notebookByRel = new Map(notebooks.map(n => [n.rel, n]));

  // E1: clones from worker cwds, every record, and runner-shaped tool results,
  // each resolved (canonicalPath) so that both sides of a join name one path.
  const cwdOf = new Map();
  const cwd = e => { if (!e.cwd) return null; if (!cwdOf.has(e.cwd)) cwdOf.set(e.cwd, canonicalPath(e.cwd)); return cwdOf.get(e.cwd); };
  const clones = new Set();
  for (const e of turns) if (e.cwd && CLONE_PATTERN.test(e.cwd)) clones.add(cwd(e));
  for (const r of dispatch) if (r.clone) clones.add(canonicalPath(r.clone));
  for (const r of completion) for (const c of r.clones) clones.add(canonicalPath(c));
  for (const c of reverseDiscovered(toolEvents, { checkoutRoots: [root] })) clones.add(c);
  clones.delete(root);
  const workerTurns = turns.filter(e => e.cwd && clones.has(cwd(e)));
  const byClone = new Map();
  for (const e of workerTurns) {
    const c = cwd(e);
    if (!byClone.has(c)) byClone.set(c, []);
    byClone.get(c).push(e);
  }
  for (const list of byClone.values()) list.sort((a, b) => a.receivedAt - b.receivedAt);

  // E5 evidence; strong chains bind their launches.
  const ev = chainEvidence(toolEvents, clones, { checkoutRoots: [root] });
  const bound = new Set(ev.strong.map(s => s.launch));

  // E2 intervals: strong chains and timed dispatch records.
  const intervals = [];
  for (const s of ev.strong) {
    intervals.push({ level: 'launch-chain', clone: s.clone, start: s.interval[0], end: s.interval[1] ?? now,
      target: launchCandidates(s.launch.sessionId, s.launch.inputAt, notebooks, hostOf), chain: s });
  }
  for (const r of dispatch) {
    if (!r.clone || r.started == null) continue;
    intervals.push({ level: 'dispatch', clone: canonicalPath(r.clone), start: r.started, end: r.finished ?? now,
      target: [{ notebook: dispatchNotebook(r, notebooks, workspaceRel), ask: r.ask }], record: r });
  }
  const sameTarget = (a, b) => a.target.length === b.target.length && a.target.every((p, i) => pairKey(p) === pairKey(b.target[i]));

  const runs = [];
  const ambiguousTurns = [];
  for (const [clone, cturns] of byClone) {
    const ivs = intervals.filter(iv => iv.clone === clone);
    const parent = ivs.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    // Same-level intervals that overlap and agree on the target are one run.
    for (let i = 0; i < ivs.length; i++) for (let j = i + 1; j < ivs.length; j++) {
      if (ivs[i].level === ivs[j].level && ivs[i].start <= ivs[j].end && ivs[j].start <= ivs[i].end && sameTarget(ivs[i], ivs[j])) union(i, j);
    }
    const residual = [];
    const placed = [];
    for (const t of cturns) {
      const inside = ivs.map((iv, i) => i).filter(i => t.receivedAt >= ivs[i].start && t.receivedAt <= ivs[i].end);
      if (!inside.length) { residual.push(t); continue; }
      // Same-level intervals that overlap here and disagree on the target.
      const clash = inside.some(i => inside.some(j => j !== i && ivs[i].level === ivs[j].level && find(i) !== find(j)));
      if (clash) { ambiguousTurns.push(t); continue; }
      // Overlapping intervals of different levels sharing this turn (hence its
      // worker session) describe one run.
      for (const i of inside.slice(1)) union(inside[0], i);
      placed.push([t, inside[0]]);
    }
    // Grouped only once every union is made: a later turn can join an earlier
    // turn's component to another, and its root then changes.
    const members = new Map(); // component → turns
    for (const [t, i] of placed) {
      const c = find(i);
      if (!members.has(c)) members.set(c, []);
      members.get(c).push(t);
    }
    for (const [c, ts] of members) {
      const comp = ivs.filter((_, i) => find(i) === c);
      runs.push({ clone, turns: ts, intervals: comp, residual: false, labels: comp.some(iv => iv.record && iv.record.finished == null) ? ['incomplete'] : [] });
    }
    const bySession = new Map();
    for (const t of residual) {
      if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
      bySession.get(t.sessionId).push(t);
    }
    for (const ts of bySession.values()) runs.push({ clone, turns: ts, intervals: [], residual: true, labels: [] });
  }
  for (const r of runs) { r.first = r.turns[0].receivedAt; r.last = r.turns[r.turns.length - 1].receivedAt; }

  // E5 weak chains: residual runs of every clone, in time order of first turn.
  for (const run of runs.filter(r => r.residual).sort((a, b) => a.first - b.first)) {
    const origins = new Set(ev.results.filter(b => b.clone === run.clone && b.ev.resultAt != null && b.ev.resultAt >= run.last).map(b => b.ev.origin));
    const launches = ev.launches.map(l => l.ev).filter(l => origins.has(l.origin) && !bound.has(l) && l.inputAt != null && l.inputAt < run.first && run.first - l.inputAt <= WEAK_LAUNCH_GAP_MS);
    if (!launches.length) continue;
    const cands = launches.map(l => ({ l, pairs: launchCandidates(l.sessionId, l.inputAt, notebooks, hostOf) }));
    const keys = new Set(cands.map(c => c.pairs.map(pairKey).sort().join('|')));
    run.labels.push('weak');
    if (keys.size === 1) {
      const latest = cands.sort((a, b) => b.l.inputAt - a.l.inputAt)[0];
      bound.add(latest.l);
      run.weak = { pairs: latest.pairs };
    } else {
      run.weak = { pairs: cands.flatMap(c => c.pairs), ambiguous: true };
    }
  }

  // Time-less dispatch records: evidence only for a clone holding one run.
  const runsOfClone = clone => runs.filter(r => r.clone === clone);
  for (const rec of dispatch) {
    if (!rec.clone || rec.started != null) continue;
    const rs = runsOfClone(canonicalPath(rec.clone));
    if (rs.length === 1) (rs[0].timeless = rs[0].timeless || []).push(rec);
  }

  // E4: only the earliest run of a clone can be bound by its `clone: from`.
  const originCache = new Map();
  const boundToCheckout = run => {
    const earliest = runsOfClone(run.clone).reduce((a, b) => (b.first < a.first ? b : a));
    if (earliest !== run) return false;
    if (!originCache.has(run.clone)) originCache.set(run.clone, originOf(run.clone));
    return stripSlash(originCache.get(run.clone)) === root;
  };

  // E3 per run, then E6.
  const out = { runs: [], ambiguousTurns, footer: { checkoutUnknown: 0, matchedNoNotebook: 0, heuristicParentIgnored: 0 } };
  const parentIgnored = new Set();
  for (const run of runs) {
    for (const t of run.turns) if (t.parentSessionId) parentIgnored.add(t.sessionId);
    const records = [...run.intervals.filter(iv => iv.record).map(iv => iv.record), ...(run.timeless || [])];
    const evidence = {
      dispatch: records.map(r => ({ notebook: dispatchNotebook(r, notebooks, workspaceRel), ask: r.ask })),
      completion: completion.filter(c => c.valid && c.clones.map(canonicalPath).includes(run.clone)).filter(c => {
        const nb = notebookByRel.get(c.notebook);
        const w = nb && nb.windows.find(x => x.id === c.ask);
        return w && w.start != null && run.turns.every(t => t.receivedAt >= w.start && t.receivedAt < w.end);
      }).map(c => ({ notebook: c.notebook, ask: c.ask })),
      'launch-chain': [...run.intervals.filter(iv => iv.chain).flatMap(iv => iv.target), ...(run.weak ? run.weak.pairs : [])],
      window: [],
    };
    const resolvedAbove = combine(evidence);
    let e4failed = false;
    if (resolvedAbove.fixed.notebook === OPEN || resolvedAbove.fixed.ask === OPEN) {
      if (boundToCheckout(run)) {
        evidence.window = notebooks.flatMap(nb => nb.windows.filter(w => (w.startKind === 'matched' || w.startKind === 'estimated') && run.first >= w.start && run.first < w.end).map(w => ({ notebook: nb.rel, ask: w.id })));
      } else e4failed = true;
    }
    const r = combine(evidence);
    if (run.weak && run.weak.ambiguous && r.fixed.ask === OPEN) r.ambiguous.add('ask');
    const labels = [...run.labels, ...r.labels];
    if (run.intervals.some(iv => iv.chain && iv.chain.truncated)) labels.push('truncated');
    const stage = records.find(x => x.stage)?.stage || null;
    const requested = { model: records.find(x => x.model)?.model || null, effort: records.find(x => x.effort)?.effort || null };

    let status;
    if (r.fixed.notebook === OPEN && !r.ambiguous.has('notebook')) {
      const onlyWindowLeft = !LEVELS.slice(0, 3).some(lv => evidence[lv].length);
      // Counted only while the reported notebook's hosts were active: a run of
      // unknown checkout cannot be claimed for this notebook, but the number
      // says how much worker activity on this machine went unplaced then.
      const duringOurHosts = hostSpan && run.first >= hostSpan[0] && run.first <= hostSpan[1];
      if (onlyWindowLeft && e4failed) { if (duringOurHosts) out.footer.checkoutUnknown++; }
      else out.footer.matchedNoNotebook++;
      continue;
    }
    if (r.ambiguous.has('notebook') || r.ambiguous.has('ask')) status = 'ambiguous';
    else if (r.fixed.ask === OPEN) status = 'unassigned';
    else status = 'unique';
    out.runs.push({ clone: run.clone, turns: run.turns, first: run.first, last: run.last, notebook: r.fixed.notebook, ask: r.fixed.ask, status,
      evidence: r.level || 'window', labels: [...new Set(labels)], stage, requested,
      candidates: Object.fromEntries(LEVELS.map(lv => [lv, evidence[lv]])) });
  }
  out.footer.heuristicParentIgnored = parentIgnored.size;
  return out;
}

module.exports = { dispatchNotebook, combine, attributeWorkers };
