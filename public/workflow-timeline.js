// ── Workflow Swimlane Timeline (#91) ──────────────────────────────────────
// Renders SVG swimlane lanes inside #col-turns when a session is selected.
// Depends on globals from miller-columns.js: allEntries, selectedSessionId,
// sessionsMap, colTurns, colSections, selectTurn.

// A1: shared root resolver — all workflow-aware DOM queries go through this
function wfStepsRoot() {
  return (wfState && wfState.selectedSection)
    ? (document.getElementById('wf-steps-content') || colDetail)
    : colDetail;
}

// ── Constants ─────────────────────────────────────────────────────────────
// #144/#149: per-agent identity palette (docs/wf-color-identity/DESIGN.md).
// `main` pinned; hashed off lane.key. 7 hues × 7 shapes = 50 combos.
// CVD-verified: magenta (#d742a5) + indigo (#4242d7) clear all 9 reserved.
const WF_LANE_COLORS = { main: '#42a3fd', hashed: ['#ffdbaa', '#dc7d96', '#a1a716', '#45f8ef', '#d1d843', '#d742a5', '#4242d7'] };
const WF_LABEL_W = 240, WF_LANE_GAP = 4;
// v8 ctx-split (#121): 44px ctx% bars + 8px cost track + event tracks (8px collapsed / 4×8px expanded)
const WF_BAR_H = 44, WF_COST_TRACK_H = 8, WF_EV_H = 8, WF_EV_H_SEL = 32;
const WF_LANE_H = WF_BAR_H + WF_COST_TRACK_H + WF_EV_H + WF_LANE_GAP;          // 64px collapsed
const WF_LANE_H_SEL = WF_BAR_H + WF_COST_TRACK_H + WF_EV_H_SEL + WF_LANE_GAP;  // 88px expanded
const WF_AXIS_H = 18, WF_PAD = 4, WF_MIN_TURN_PX = 2;
const WF_MONO = "'SF Mono','Cascadia Code','Fira Code',monospace";

// v8 bar segment colors: 高=滿 · 色=區 · 位=勢 · 線=界 · 點=事 · 橘=貴
const WF_V8_CACHE_READ = '#39c5cf', WF_V8_CACHE_WRITE = '#f0883e', WF_V8_INPUT = '#8b5cf6';
const WF_V8_COST = '#484f58', WF_V8_COST_OUTLIER = '#f0883e';

// v8 event tracks: fixed order, exclusive color family, max 4 types/track.
// Only events detectable from SSE entry summaries are wired; unimplemented
// types from the design (perm-denied, git-commit, danger-bash, perm-prompt,
// unsafe-blocked) need richer server signals first.
const WF_TRACKS = [
  { key: 'faults',    label: 'faults', color: '#f85149' },
  { key: 'context',   label: 'ctx',    color: '#bc8cff' },
  { key: 'mutations', label: 'mutate', color: '#2ea043' },
  { key: 'safety',    label: 'safety', color: '#b87800' },
];
const WF_EV_INFO = {
  'error':      { ti: 0, shape: 'square',   color: '#f85149' },
  'rate-limit': { ti: 0, shape: 'triangle', color: '#ff9b8e' },
  'retry':      { ti: 0, shape: 'circle',   color: '#a82828' },
  'compaction': { ti: 1, shape: 'triangle', color: '#bc8cff' },
  'cache-miss': { ti: 1, shape: 'circle',   color: '#d2a8ff' },
  'ctx80':      { ti: 1, shape: 'square',   color: '#8957e5' },
  'file-write': { ti: 2, shape: 'circle',   color: '#2ea043' },
  'credential': { ti: 3, shape: 'square',   color: '#b87800' },
};

// ── State ─────────────────────────────────────────────────────────────────
var wfState = null;
// coreHash → {version, agentKey, agentLabel} for the gutter version chips
var _wfVerMap = null;
function _wfLoadVersions() {
  if (_wfVerMap) return;
  _wfVerMap = {}; // set before fetch resolves so concurrent renders don't refetch
  fetch('/_api/sysprompt/versions').then(function(r) { return r.json(); }).then(function(d) {
    (d.versions || []).forEach(function(v) { if (v.coreHash) _wfVerMap[v.coreHash] = v; });
    wfDeferRender();
  }).catch(function() {});
}
var _wfPendingRender = 0;
var _wfTooltipEl = null;
var _wfCssCache = null;
function _wfGetCssColors() {
  if (_wfCssCache) return _wfCssCache;
  var cs = getComputedStyle(document.documentElement);
  _wfCssCache = { surface: cs.getPropertyValue('--surface').trim() || '#161b22', dim: cs.getPropertyValue('--dim').trim() || '#8b949e', accent: cs.getPropertyValue('--accent').trim() || '#58a6ff', bg: cs.getPropertyValue('--bg').trim() || '#0d1117' };
  return _wfCssCache;
}

// ── Helpers ───────────────────────────────────────────────────────────────
// #156: moved to format.js — kept as local aliases so call sites are unchanged.
var wfModelColor = modelColor;
var wfShortModel = shortModel;
// #144: identity color keyed off lane.key (not model). One resolver for lane + card.
function _wfFnv1a(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// #149: shape/glyph second channel — all-filled SVG primitives at ~10px on #0d1117.
// main=circle (pinned); 7 hashed shapes × 7 hashed colors = 49+1 = 50 unique combos.
// Autoresearch design: 無意義>辨識度>一致性, scored 8.8/10 (combined 9/10).
var WF_LANE_GLYPHS = { main: 'circle', hashed: ['square', 'triangleUp', 'diamond', 'plus', 'semicircle', 'trapezoid', 'parallelogram'] };
function wfGlyphSvg(glyph, cx, cy, s, fill) {
  var r = s / 2, hw = s * 0.15;
  switch (glyph) {
    case 'circle': return '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+fill+'"/>';
    case 'square': return '<rect x="'+(cx-r)+'" y="'+(cy-r)+'" width="'+s+'" height="'+s+'" fill="'+fill+'"/>';
    case 'triangleUp': return '<polygon points="'+cx+','+(cy-r)+' '+(cx-r)+','+(cy+r)+' '+(cx+r)+','+(cy+r)+'" fill="'+fill+'"/>';
    case 'diamond': return '<polygon points="'+cx+','+(cy-r)+' '+(cx+r)+','+cy+' '+cx+','+(cy+r)+' '+(cx-r)+','+cy+'" fill="'+fill+'"/>';
    case 'plus': return '<polygon points="'+(cx-hw)+','+(cy-r)+' '+(cx+hw)+','+(cy-r)+' '+(cx+hw)+','+(cy-hw)+' '+(cx+r)+','+(cy-hw)+' '+(cx+r)+','+(cy+hw)+' '+(cx+hw)+','+(cy+hw)+' '+(cx+hw)+','+(cy+r)+' '+(cx-hw)+','+(cy+r)+' '+(cx-hw)+','+(cy+hw)+' '+(cx-r)+','+(cy+hw)+' '+(cx-r)+','+(cy-hw)+' '+(cx-hw)+','+(cy-hw)+'" fill="'+fill+'"/>';
    case 'semicircle': return '<path d="M'+(cx-r)+' '+cy+'A'+r+' '+r+' 0 1 1 '+(cx+r)+' '+cy+'Z" fill="'+fill+'"/>';
    case 'trapezoid': return '<polygon points="'+(cx-r*0.5)+','+(cy-r)+' '+(cx+r*0.5)+','+(cy-r)+' '+(cx+r)+','+(cy+r)+' '+(cx-r)+','+(cy+r)+'" fill="'+fill+'"/>';
    case 'parallelogram': return '<polygon points="'+(cx-r+r*0.35)+','+(cy-r)+' '+(cx+r)+','+(cy-r)+' '+(cx+r-r*0.35)+','+(cy+r)+' '+(cx-r)+','+(cy+r)+'" fill="'+fill+'"/>';
    default: return '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+fill+'"/>';
  }
}
function wfGlyphHtml(glyph, size, fill) {
  var s = size || 8;
  return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 '+s+' '+s+'" style="vertical-align:middle;display:inline-block">'+wfGlyphSvg(glyph, s/2, s/2, s*0.8, fill)+'</svg>';
}
// Per-render assignment: main pinned, hashed lanes placed by hash with live-set
// open-addressing on color; glyph hashed independently, bumped to keep
// (color,glyph) pairs jointly unique (7 colors × 7 glyphs = 49 combos).
function wfComputeLaneStyles(lanes) {
  var map = new Map(), cPool = WF_LANE_COLORS.hashed, gPool = WF_LANE_GLYPHS.hashed;
  var usedColors = new Set(), usedPairs = new Set();
  var mainStyle = { color: WF_LANE_COLORS.main, glyph: WF_LANE_GLYPHS.main };
  usedPairs.add(mainStyle.color + ':' + mainStyle.glyph);
  for (var i = 0; i < lanes.length; i++) if (_wfIsMainLane(lanes[i])) map.set(lanes[i].key, mainStyle);
  for (var j = 0; j < lanes.length; j++) {
    var l = lanes[j];
    if (_wfIsMainLane(l)) continue;
    var h = _wfFnv1a(l.key || '');
    var cSlot = h % cPool.length;
    for (var k = 0; k < cPool.length && usedColors.has(cSlot); k++) cSlot = (cSlot + 1) % cPool.length;
    usedColors.add(cSlot);
    var ci = cSlot, gi = (h >>> 16) % gPool.length;
    var pair = cPool[ci] + ':' + gPool[gi];
    // ponytail: two-level probe — glyph first, bump color on glyph wrap, covers full 7×7 Cartesian
    var giStart = gi, maxProbes = cPool.length * gPool.length;
    for (var p = 0; p < maxProbes && usedPairs.has(pair); p++) {
      gi = (gi + 1) % gPool.length;
      if (gi === giStart) ci = (ci + 1) % cPool.length;
      pair = cPool[ci] + ':' + gPool[gi];
    }
    usedPairs.add(pair);
    map.set(l.key, { color: cPool[ci], glyph: gPool[gi] });
  }
  return map;
}
// ponytail: backward-compat shim — callers that only need the color Map
function wfComputeLaneColors(lanes) {
  var styles = wfComputeLaneStyles(lanes);
  var map = new Map();
  for (var entry of styles) map.set(entry[0], entry[1].color);
  return map;
}
// INVARIANT: this is the only correct way to test "is this the main/orchestrator
// lane" — never !lane.spawnParent, which is null for every lane (see
// docs/decisions/0007-wf-is-main-lane-not-spawn-parent.md).
function _wfIsMainLane(lane) { return lane && (lane.key === 'main' || lane.name === 'main'); }
function wfLaneColor(lane) {
  if (!lane) return WF_LANE_COLORS.main;
  if (_wfIsMainLane(lane)) return WF_LANE_COLORS.main;
  var s = wfState && wfState.laneStyles && wfState.laneStyles.get(lane.key);
  return (s && s.color) || WF_LANE_COLORS.hashed[_wfFnv1a(lane.key || '') % WF_LANE_COLORS.hashed.length];
}
function wfLaneShape(lane) {
  if (!lane) return WF_LANE_GLYPHS.main;
  if (_wfIsMainLane(lane)) return WF_LANE_GLYPHS.main;
  var s = wfState && wfState.laneStyles && wfState.laneStyles.get(lane.key);
  return (s && s.glyph) || WF_LANE_GLYPHS.hashed[(_wfFnv1a(lane.key || '') >>> 16) % WF_LANE_GLYPHS.hashed.length];
}
// #156: moved to format.js — kept as local aliases so call sites are unchanged.
var wfFmtDur = fmtDur;
var wfFmtMin = fmtMin;
var wfEsc = escapeHtml;

function wfCtxPct(e) {
  var win = e.maxContext || 200000;
  return Math.min(100, (e.ctxUsed || 0) / win * 100);
}

// #156: moved to format.js — kept as a thin wrapper (old signature took the turn, not pct).
function wfCtxZoneColor(t) {
  return ctxZone(wfCtxPct(t)).hex;
}

// v8 event detection against real SSE entry summaries (prev = previous turn in same lane)
function wfDetectEvents(t, prev) {
  var evts = [];
  var u = t.usage || {};
  var inT = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (t.isRetry) evts.push('retry');
  else if (Number(t.status) === 429) evts.push('rate-limit');
  else if ((t.status && !isHttpStatusOk(t.status)) || t.toolFail) evts.push('error');
  if (t.isCompacted) evts.push('compaction');
  if (inT > 1000 && (u.cache_read_input_tokens || 0) / inT < 0.5) evts.push('cache-miss');
  if (wfCtxPct(t) >= 80 && (!prev || wfCtxPct(prev) < 80)) evts.push('ctx80');
  var tc = t.toolCalls || {};
  if (tc.Write || tc.Edit || tc.MultiEdit || tc.NotebookEdit) evts.push('file-write');
  if (t.hasCredential) evts.push('credential');
  return evts;
}

function wfLaneCostMedian(lane) {
  if (lane._costMedian != null) return lane._costMedian;
  var costs = lane.turns.map(function(t) { return t.cost || 0; }).sort(function(a, b) { return a - b; });
  lane._costMedian = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
  return lane._costMedian;
}

// Shared bar span for a turn (matches the tx/tw math in wfRenderLaneSvg)
function _wfBarSpan(t) {
  var W = colTurns.clientWidth || 600;
  var chartW = W - WF_LABEL_W - 12;
  var tRange = wfState.viewT1 - wfState.viewT0 || 1;
  var ts = Number(t.receivedAt) || 0;
  var tend = ts + (parseFloat(t.elapsed) || 0) * 1000;
  var x0 = Math.max(WF_LABEL_W, WF_LABEL_W + ((ts - wfState.viewT0) / tRange) * chartW);
  var x1 = Math.max(x0 + WF_MIN_TURN_PX, WF_LABEL_W + ((tend - wfState.viewT0) / tRange) * chartW);
  return { x0: x0, x1: x1 };
}

// ── Lane Inference ────────────────────────────────────────────────────────
// Agent keys whose turns belong to the main lane — model switches within the
// main conversation stay in main (the dashed model-switch line marks them)
var WF_MAIN_AGENT_KEYS = { 'orchestrator': 1, 'sdk-agent': 1, 'default': 1 };
// agentKey values that don't reliably mean "not main" — both are catch-all
// defaults from extractAgentType()'s regex fallback for unrecognized prompts
// (server/system-prompt.js), which could be a genuinely new main-agent
// variant, not necessarily a subagent (codex review round 3).
// INVARIANT: every agentKey-based main/subagent classification site in this
// file AND entry-rendering.js must gate on this — see
// docs/decisions/0005-agent-key-unreliable-shared-contract.md
var AGENT_KEY_UNRELIABLE = { unknown: 1, agent: 1 };

function _wfPushToSubLane(laneMap, key, entry) {
  if (!laneMap.has(key)) laneMap.set(key, { name: key, key: key, turns: [], model: entry.model, ctxWindow: entry.maxContext || 0, spawnParent: null, agentKey: entry.agentKey || null, agentLabel: entry.agentLabel || null, convId: entry.convId || null });
  laneMap.get(key).turns.push(entry);
}

// Sub-lane key: one lane per conversation. convId (hash of messages[0], set by
// the server) separates N parallel instances of the same agent type (#117);
// without it, same-key entries collapse into one shared lane (legacy data).
function _wfSubLaneKey(base, entry) {
  return entry.convId ? base + ':' + entry.convId : base;
}

// ── Sequential-interleave tracker (#230) ──────────────────────────────────
// Temporal overlap (ADR 0008) only catches PARALLEL agents. A sequential
// teammate — dispatched while main idles, zero time overlap — leaves two
// wire-level footprints instead:
//   R1: main's convId (messages[0] hash) only moves forward. If runs of
//       conv A resume AFTER foreign-conv runs, the runs in between are
//       excursions (bracketing). A conv change that never returns is a
//       compaction — legal, stays main (trunk-advance). isCompacted is
//       deliberately NOT consulted: real fan-out first-turns get mislabeled
//       isCompacted (big msg+token drop), so gating on it would exempt
//       exactly the target case (session a7fef8a8 evidence).
//   R2: a fork shares main's convId, so R1 is blind to it — but its turns
//       continue a frontier already split out of main (by overlap or R1):
//       same conv, msgCount within [tail, tail+2], starting at/after the
//       tail ends. A dip with NO such frontier is a rewind/edit and stays
//       in main (session 7e1d9272's 540→493 must not split).
// One tracker implementation serves BOTH entry-rendering.js and this file
// (each holds an instance, fed the same per-turn signals), so the two
// files cannot disagree — the ADR 0005 shape, like AGENT_KEY_UNRELIABLE.
// INVARIANT: sequential-interleave classification must go through this
// tracker in both files, and it never consults isCompacted — see
// docs/decisions/0009-sequential-interleave-conv-bracketing.md
function wfCreateSeqTracker() {
  // list: main-candidate turns kept sorted by (receivedAt, id) — entries
  // arrive in COMPLETION order (a nested turn can finish before the longer
  // turn that started first), so run structure must derive from start
  // order, never arrival order: a foreign-conv turn arriving first would
  // otherwise become the trunk and no bracket would ever close (codex P2,
  // round 1).
  // tails: Map(convId → [ { msg, end }, ... ]) — APPEND-ONLY tail points,
  // one per split turn of that conv. Per-conv so no shared FIFO can evict
  // a still-active conv's evidence (codex P2, round 3); append-only so a
  // historical branch point survives later splits that "continue" it —
  // merging erased the fork point another concurrent track's sequential
  // continuation still needed (439-session re-audit regression,
  // 2026-07-11: jumpreturn residue 3→8). No cap: memory is O(split turns)
  // per session — trivial.
  return { list: [], tails: new Map() };
}

// R2 frontier time-to-live: a dip only stitches onto a frontier whose
// track ended within this window. Measurement basis (439-session audit,
// 2026-07-11, owner-approved): real stitch gaps p50=22s, p90=3min, every
// verified-good stitch ≤2min; all 6 sampled >10min fits were edit/rewind
// shapes, not fork continuations. 15min keeps ~30× headroom over the real
// distribution while structurally closing hour-scale rewind collisions
// with stale branch points (codex P2, round 4).
var WF_SEQ_FRONTIER_TTL_MS = 15 * 60 * 1000;

// Best-fit continuation frontier: msg within [f.msg, f.msg+2], the
// frontier ends at/before this turn starts AND within the TTL window;
// among fits, the latest-ending one (mirrors the parallel-lane best-fit).
// Retired points stay in the Map — eligibility is decided at lookup.
function _wfSeqBestFrontier(frontiers, msg, ts) {
  var best = null;
  for (var i = 0; i < frontiers.length; i++) {
    var f = frontiers[i];
    if (f.msg > 0 && f.msg <= msg && msg <= f.msg + 2 && f.end <= ts &&
        ts - f.end <= WF_SEQ_FRONTIER_TTL_MS &&
        (!best || f.end > best.end)) best = f;
  }
  return best;
}

// Evidence feed: a turn already split out of main (agent-keyed lane,
// overlap overflow, or a closed R1 bracket). Its (msg, end) becomes an
// append-only tail point for its conv — R2 stitches later same-conv dips
// onto the best-fitting point. NEVER merged: a fork can branch several
// concurrent tracks from the same historical msgCount, and folding a
// "continuation" split into an earlier point erases the branch point that
// another track's sequential continuation still needs. Only an R2 stitch
// advances a point — the dip consumed it, so its old value has no further
// consumer.
function wfSeqFeedSplit(tracker, turn) {
  if (!tracker || !turn.convId || !(turn.msgCount > 0)) return;
  var ts = Number(turn.receivedAt) || 0;
  var frontiers = tracker.tails.get(turn.convId);
  if (!frontiers) tracker.tails.set(turn.convId, frontiers = []);
  frontiers.push({ msg: turn.msgCount, end: ts + (parseFloat(turn.elapsed) || 0) * 1000 });
}

// Main-candidate feed. Returns { place: 'main'|'excursion', closed }.
// 'excursion' = R2 stitch — route to a parallel lane now. closed = an R1
// bracket just closed: those turns were provisionally main and the caller
// must retro-move them out.
function wfSeqFeedMain(tracker, turn) {
  var res = { place: 'main', closed: null };
  if (!tracker) return res;
  var conv = turn.convId, msg = turn.msgCount || 0;
  var ts = Number(turn.receivedAt) || 0;
  if (!conv || !ts) return res; // inert: never a boundary, never moved
  // Sorted insertion point by (receivedAt, id): deterministic under the
  // arrival-order ≠ start-order inversions of nested turns (codex P2).
  var list = tracker.list;
  var lo = 0, hi = list.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    var mts = Number(list[mid].receivedAt) || 0;
    if (mts < ts || (mts === ts && String(list[mid].id) <= String(turn.id))) lo = mid + 1;
    else hi = mid;
  }
  // R2 first: a dip that stitches onto a split-out frontier is NOT a trunk
  // return — it must not join the list or close a bracket. prevSame is the
  // chronologically previous same-conv turn (scan back from the insertion
  // point), never the last-ARRIVED one.
  var prevSame = null;
  for (var i = lo - 1; i >= 0 && !prevSame; i--) {
    if (list[i].convId === conv) prevSame = list[i];
  }
  if (prevSame && msg > 0 && msg < (prevSame.msgCount || 0)) {
    var frontiers = tracker.tails.get(conv);
    var fit = frontiers ? _wfSeqBestFrontier(frontiers, msg, ts) : null;
    if (fit) {
      fit.msg = msg; // frontier advances with the stitched turn
      fit.end = ts + (parseFloat(turn.elapsed) || 0) * 1000;
      res.place = 'excursion';
      return res;
    }
  }
  // Inserted before existing turns ⇒ chronological truth was reordered:
  // already-closed excursions may need overturning (the trunk itself can
  // change), but closed turns have left this list — no incremental step
  // can reopen them. The live caller uses this flag to fall back to a
  // full batch rebuild (codex P2, round 5).
  res.reordered = lo < list.length;
  list.splice(lo, 0, turn);
  res.closed = _wfSeqCloseBrackets(tracker);
  return res;
}

// Rebuild convId runs from the (receivedAt, id)-sorted candidate list and
// re-run the trunk walk. Any run bracketed by a reappearance of an earlier
// conv is an excursion; leftover pending runs mean that trunk conv never
// returned — trunk advances (compaction) and they stay main. Because runs
// derive from the sorted list (never arrival order) and the walk reruns on
// every feed, the live path converges to the batch pass regardless of the
// order entries complete in.
function _wfSeqCloseBrackets(tracker) {
  var list = tracker.list;
  if (list.length < 3) return null;
  var runs = [];
  for (var li = 0; li < list.length; li++) {
    var last = runs[runs.length - 1];
    if (last && last.conv === list[li].convId) last.turns.push(list[li]);
    else runs.push({ conv: list[li].convId, turns: [list[li]] });
  }
  if (runs.length < 3) return null;
  var excursed = new Set();
  var work = runs;
  while (work.length) {
    var trunk = work[0].conv;
    var pending = [];
    for (var i = 1; i < work.length; i++) {
      if (work[i].conv === trunk) {
        for (var p = 0; p < pending.length; p++) excursed.add(pending[p]);
        pending = [];
      } else pending.push(work[i]);
    }
    work = pending;
  }
  if (!excursed.size) return null;
  var turns = [];
  excursed.forEach(function(r) {
    for (var e = 0; e < r.turns.length; e++) {
      turns.push(r.turns[e]);
      // INVARIANT: a closed-bracket excursion must immediately become an
      // R2 frontier — dropping this feed makes later same-conv sequential
      // continuations silently fall back into main — see
      // docs/decisions/0009-sequential-interleave-conv-bracketing.md
      wfSeqFeedSplit(tracker, r.turns[e]);
    }
  });
  var turnSet = new Set(turns);
  tracker.list = list.filter(function(t) { return !turnSet.has(t); });
  turns.sort(function(a, b) { return (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0); });
  return turns;
}

function wfInferLanes(entries, childEntries, seqTracker) {
  if (!entries.length && !childEntries.length) return [];
  if (!seqTracker) seqTracker = wfCreateSeqTracker();

  var laneMap = new Map();
  var mainLane = { name: 'main', key: 'main', turns: [], model: null, ctxWindow: 0, spawnParent: null };
  laneMap.set('main', mainLane);
  var orchCtx = 0;

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var sub = false;

    // INVARIANT: gate on AGENT_KEY_UNRELIABLE — see docs/decisions/0005-agent-key-unreliable-shared-contract.md
    if (e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]) {
      // Agent-identity classification (server-detected, authoritative):
      // main-agent keys → main lane regardless of model or isSubagent flag
      if (!WF_MAIN_AGENT_KEYS[e.agentKey]) {
        _wfPushToSubLane(laneMap, _wfSubLaneKey('agent-' + e.agentKey, e), e);
        sub = true;
      }
    } else {
      // Fallback heuristics for entries without agent identity (old data,
      // requests without a system prompt)
      var subKey = _wfSubLaneKey('subagent-' + wfShortModel(e.model), e);
      if (e.isSubagent || (mainLane.model && e.model !== mainLane.model)) {
        _wfPushToSubLane(laneMap, subKey, e);
        sub = true;
      } else if (!e.isCompacted && orchCtx > 20 && wfCtxPct(e) < orchCtx * 0.5 && wfCtxPct(e) < 25) {
        _wfPushToSubLane(laneMap, subKey, e);
        sub = true;
      }
    }

    if (!sub) {
      mainLane.turns.push(e);
      if (!mainLane.model) mainLane.model = e.model;
      mainLane.ctxWindow = e.maxContext || mainLane.ctxWindow;
      var p = wfCtxPct(e);
      if (p > orchCtx * 0.8) orchCtx = Math.max(orchCtx, p);
    }
  }

  // Post-pass (#221/#222): main must stay a serial chain — two turns whose
  // time ranges overlap cannot be the same serial conversation, so the
  // later-starting one is a parallel agent. Typically a fork, which inherits
  // the parent's prompt and therefore carries the SAME authoritative
  // 'orchestrator' agentKey — agentKey is authoritative about prompt
  // content, NOT about instance identity, so it must never exempt a turn
  // from this physical-overlap check (the Batch 11 merged-but-broken bug).
  // INVARIANT: overlap overrides agentKey for lane placement — see
  // docs/decisions/0008-temporal-overlap-overrides-agent-key.md
  // Sort by receivedAt so the earliest-starting turn anchors main (codex R1:
  // entries arrive in completion order which may differ from start order).
  // Overlap predicate matches entry-rendering.js (ADR 0005 alignment): a
  // turn is parallel iff its start falls strictly inside the previous main
  // turn's (start, end) — equal starts count as sequential.
  mainLane.turns.sort(function(a, b) { return (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0); });

  // Post-pass 2 (#230): sequential interleave, interleaved with the overlap
  // sweep to a fixpoint. Overlap only proves PARALLEL agents; a sequential
  // teammate/fork leaves only main's convId run structure (R1) or a
  // split-out frontier's msgCount continuation (R2) as its footprint. Each
  // round: sweep the candidates into a serial chain (ADR 0008), then feed
  // the tracker the same chronological stream the live path sees — split
  // turns as frontier evidence, serial turns as main candidates. When the
  // seq pass excurses a turn, the sweep re-runs WITHOUT it, so a main turn
  // that only overlapped an excursion is re-admitted — keeping the batch
  // rebuild equal to the live path (which never saw the excursion in main).
  // Terminates: each extra round removes ≥1 excursed turn from candidates.
  // INVARIANT: the sweep runs before the seq pass in every round, and the
  // seq pass never consults isCompacted — see
  // docs/decisions/0009-sequential-interleave-conv-bracketing.md
  var fixedEvidence = [];
  laneMap.forEach(function(lane, lk) {
    if (lk === 'main') return;
    for (var si = 0; si < lane.turns.length; si++) fixedEvidence.push(lane.turns[si]);
  });
  var candidates = mainLane.turns;
  var exiled = [];
  for (;;) {
    var serialTurns = [], overflowTurns = [];
    for (var oi = 0; oi < candidates.length; oi++) {
      var cur = candidates[oi];
      var curStart = Number(cur.receivedAt) || 0;
      var last = serialTurns[serialTurns.length - 1];
      var lastStart = last ? (Number(last.receivedAt) || 0) : 0;
      var lastEnd = last ? lastStart + (parseFloat(last.elapsed) || 0) * 1000 : 0;
      if (curStart > lastStart && curStart < lastEnd) overflowTurns.push(cur);
      else serialTurns.push(cur);
    }
    var roundTracker = wfCreateSeqTracker();
    var seqStream = [];
    for (var fe = 0; fe < fixedEvidence.length; fe++) seqStream.push({ t: fixedEvidence[fe], split: true });
    for (var xe = 0; xe < exiled.length; xe++) seqStream.push({ t: exiled[xe], split: true });
    for (var oe = 0; oe < overflowTurns.length; oe++) seqStream.push({ t: overflowTurns[oe], split: true });
    for (var se = 0; se < serialTurns.length; se++) seqStream.push({ t: serialTurns[se], split: false });
    seqStream.sort(function(a, b) { return (Number(a.t.receivedAt) || 0) - (Number(b.t.receivedAt) || 0); });
    var excursed = [];
    for (var qi = 0; qi < seqStream.length; qi++) {
      if (seqStream[qi].split) { wfSeqFeedSplit(roundTracker, seqStream[qi].t); continue; }
      var verdict = wfSeqFeedMain(roundTracker, seqStream[qi].t);
      if (verdict.place === 'excursion') excursed.push(seqStream[qi].t);
      if (verdict.closed) for (var vc = 0; vc < verdict.closed.length; vc++) excursed.push(verdict.closed[vc]);
    }
    if (!excursed.length) {
      mainLane.turns = serialTurns;
      exiled = exiled.concat(overflowTurns);
      break;
    }
    exiled = exiled.concat(excursed);
    var exSet = new Set(excursed);
    candidates = serialTurns.filter(function(t) { return !exSet.has(t); }).concat(overflowTurns);
    candidates.sort(function(a, b) { return (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0); });
  }

  // Excursion/parallel turns go to numbered parallel lanes, best-fit: among
  // lanes of the same base key (model+convId — forks share both), pick the
  // one whose chain ends latest but still before this turn's start. Serial
  // turns of the same fork tend to reconstruct as one lane; the numbered
  // lanes bound out at the session's true max concurrency. One family map
  // for overlap overflow AND seq excursions, so a stitched dip lands in the
  // same lane as its overlap-split siblings.
  var pFamilies = new Map(); // baseKey → [{ key, lastEnd }]
  exiled.sort(function(a, b) { return (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0); });
  for (var ex = 0; ex < exiled.length; ex++) {
    var oTurn = exiled[ex];
    var oStart = Number(oTurn.receivedAt) || 0;
    var oEnd = oStart + (parseFloat(oTurn.elapsed) || 0) * 1000;
    var baseKey = _wfSubLaneKey('parallel-' + wfShortModel(oTurn.model), oTurn);
    var fam = pFamilies.get(baseKey);
    if (!fam) { fam = []; pFamilies.set(baseKey, fam); }
    var best = null;
    for (var pi = 0; pi < fam.length; pi++) {
      if (fam[pi].lastEnd <= oStart && (!best || fam[pi].lastEnd > best.lastEnd)) best = fam[pi];
    }
    if (!best) {
      best = { key: fam.length ? baseKey + '#' + (fam.length + 1) : baseKey, lastEnd: 0 };
      fam.push(best);
    }
    best.lastEnd = Math.max(best.lastEnd, oEnd);
    _wfPushToSubLane(laneMap, best.key, oTurn);
  }

  // Hand the converged classification to the live path: replay the final
  // stream into the caller's tracker so wfAddEntry continues from exactly
  // the batch state (R1 brackets spanning the build boundary still close).
  // INVARIANT: this replay must survive any refactor — removing it paints
  // the first frame correctly and corrupts every live update after it — see
  // docs/decisions/0009-sequential-interleave-conv-bracketing.md
  var finalStream = [];
  for (var fv = 0; fv < fixedEvidence.length; fv++) finalStream.push({ t: fixedEvidence[fv], split: true });
  for (var fx = 0; fx < exiled.length; fx++) finalStream.push({ t: exiled[fx], split: true });
  for (var fm = 0; fm < mainLane.turns.length; fm++) finalStream.push({ t: mainLane.turns[fm], split: false });
  finalStream.sort(function(a, b) { return (Number(a.t.receivedAt) || 0) - (Number(b.t.receivedAt) || 0); });
  for (var ff = 0; ff < finalStream.length; ff++) {
    if (finalStream[ff].split) wfSeqFeedSplit(seqTracker, finalStream[ff].t);
    else wfSeqFeedMain(seqTracker, finalStream[ff].t);
  }

  // Child session entries → their own lanes
  if (childEntries.length) {
    var childBySid = new Map();
    for (var ci = 0; ci < childEntries.length; ci++) {
      var ce = childEntries[ci];
      var sid = ce.sessionId;
      if (!childBySid.has(sid)) childBySid.set(sid, []);
      childBySid.get(sid).push(ce);
    }
    childBySid.forEach(function(turns, sid) {
      var label = sid.slice(0, 8);
      var m = turns[0]?.model;
      if (m) label = wfShortModel(m) + ' ' + label;
      laneMap.set('child-' + sid, { name: label, key: 'child-' + sid, turns: turns, model: m, ctxWindow: turns[0]?.maxContext || 0, spawnParent: null, childSessionId: sid });
    });
  }

  // Build sorted array: main first, then by first turn time
  var result = [mainLane];
  laneMap.forEach(function(lane, k) {
    if (k !== 'main' && lane.turns.length) result.push(lane);
  });
  result.sort(function(a, b) {
    if (a.name === 'main') return -1;
    if (b.name === 'main') return 1;
    var aT = a.turns.length ? a.turns[0].receivedAt : Infinity;
    var bT = b.turns.length ? b.turns[0].receivedAt : Infinity;
    return aT - bT;
  });

  // Dominant model + agent identity per lane
  for (var li = 0; li < result.length; li++) {
    var lane = result[li];
    if (!lane.turns.length) continue;
    var mc = {}, ac = {};
    for (var ti = 0; ti < lane.turns.length; ti++) {
      var tm = lane.turns[ti].model;
      mc[tm] = (mc[tm] || 0) + 1;
      var ak = lane.turns[ti].agentKey;
      if (ak) {
        if (!ac[ak]) ac[ak] = { n: 0, label: lane.turns[ti].agentLabel || ak };
        ac[ak].n++;
      }
    }
    lane.model = Object.entries(mc).sort(function(a, b) { return b[1] - a[1]; })[0][0];
    lane.ctxWindow = lane.turns[0].maxContext || lane.ctxWindow;
    var topA = Object.entries(ac).sort(function(a, b) { return b[1].n - a[1].n; })[0];
    if (topA) { lane.agentKey = topA[0]; lane.agentLabel = topA[1].label; }
  }

  return result;
}

// ── Build State ───────────────────────────────────────────────────────────
function wfBuildState(sessionId) {
  if (!sessionId) return null;

  var entries = [];
  var childEntries = [];
  var childSids = new Set();
  if (typeof sessionsMap !== 'undefined') {
    sessionsMap.forEach(function(sess, sid) {
      if (sess.parentSessionId === sessionId) childSids.add(sid);
    });
  }
  for (var i = 0; i < allEntries.length; i++) {
    var e = allEntries[i];
    if (e.sessionId === sessionId) entries.push(e);
    else if (childSids.has(e.sessionId)) childEntries.push(e);
  }

  if (!entries.length && !childEntries.length) return null;

  var allTurns = entries.concat(childEntries);
  var tMin = Infinity, tMax = -Infinity;
  for (var k = 0; k < allTurns.length; k++) {
    var t = allTurns[k];
    var ts = Number(t.receivedAt) || 0;
    if (ts && ts < tMin) tMin = ts;
    var end = ts + (parseFloat(t.elapsed) || 0) * 1000;
    if (end > tMax) tMax = end;
  }
  if (tMin === Infinity) { tMin = 0; if (tMax === -Infinity) tMax = 1; }

  // #230: the tracker built during the batch pass carries over to the live
  // path (wfAddEntry) so R1 brackets spanning the build boundary still close.
  var seqTracker = wfCreateSeqTracker();
  var lanes = wfInferLanes(entries, childEntries, seqTracker);

  // E1: O(1) turn lookup — avoids repeated O(lanes×turns) scans in hot paths
  var turnIndex = new Map();
  for (var li = 0; li < lanes.length; li++)
    for (var ti = 0; ti < lanes[li].turns.length; ti++)
      turnIndex.set(lanes[li].turns[ti].id, { turn: lanes[li].turns[ti], laneIdx: li });

  return {
    lanes: lanes,
    sessionId: sessionId,
    childSids: childSids,
    turnIndex: turnIndex,
    _seqTracker: seqTracker,
    tMin: tMin, tMax: tMax,
    viewT0: tMin, viewT1: tMax,
    selectedLane: lanes[0] || null,
    selectedTurnId: null,
    selectedSection: 'timeline',
    laneFocusMode: false,
    laneHeightManual: false,
  };
}

// tail-follow slop, aligned with wfIsZoomed's 100ms so a following-but-unzoomed
// view is never misclassified as zoomed (closes the old ~900ms band).
const WF_FOLLOW_SLOP = 100;

// If the view was tracking the old tail, keep the newest turn in view. Slide a
// fixed-span window (tail -f) rather than growing it, so recent bars keep their
// width instead of compressing to the min-pixel floor. Degenerate fit-all
// (span >= full range) just keeps viewT1 pinned to the tail.
function _wfFollowTail(oldTMax) {
  if (wfState.viewT1 < oldTMax - WF_FOLLOW_SLOP) return; // user scrolled back → leave it
  var span = wfState.viewT1 - wfState.viewT0;
  if (span < wfState.tMax - wfState.tMin) {
    wfState.viewT1 = wfState.tMax;
    wfState.viewT0 = Math.max(wfState.tMin, wfState.tMax - span);
  } else {
    wfState.viewT1 = wfState.tMax;
  }
}

// ── Incremental Update ────────────────────────────────────────────────────
// Caller contract: `entry` must already be pushed into allEntries before
// this call — the reordered-arrival path (_wfSeqRebuild) recomputes the
// whole state from allEntries and would otherwise drop the entry
// (entry-rendering.js pushes at its allEntries.push site, then calls here).
function wfAddEntry(entry) {
  if (!wfState) return { lanesChanged: false };
  var prevCount = wfState.lanes.length;

  var ts = Number(entry.receivedAt) || 0;
  var end = ts + (parseFloat(entry.elapsed) || 0) * 1000;
  var oldTMax = wfState.tMax;
  if (ts && ts < wfState.tMin) wfState.tMin = ts;
  if (end > wfState.tMax) wfState.tMax = end;

  // childSids is snapshotted at build time; a child session that spawns while
  // the view is already live isn't in it yet. Refresh from the live sessionsMap
  // so late-arriving child turns still route to a child lane, not main.
  if (wfState.childSids && wfState.sessionId && !wfState.childSids.has(entry.sessionId) &&
      typeof sessionsMap !== 'undefined' && sessionsMap.get) {
    var sess = sessionsMap.get(entry.sessionId);
    if (sess && sess.parentSessionId === wfState.sessionId) wfState.childSids.add(entry.sessionId);
  }

  // Child-session turns get their own child-<sid> lane, mirroring wfInferLanes.
  // Match/create by childSessionId (not .name — child .name is a display label).
  if (wfState.childSids && wfState.childSids.has(entry.sessionId)) {
    var csid = entry.sessionId;
    var clane = wfState.lanes.find(function(l) { return l.childSessionId === csid; });
    if (!clane) {
      var clabel = csid.slice(0, 8);
      if (entry.model) clabel = wfShortModel(entry.model) + ' ' + clabel;
      clane = { name: clabel, key: 'child-' + csid, turns: [], model: entry.model, ctxWindow: entry.maxContext || 0, spawnParent: null, childSessionId: csid };
      wfState.lanes.push(clane);
    }
    clane.turns.push(entry);
    clane._costMedian = null;
    if (wfState.turnIndex) wfState.turnIndex.set(entry.id, { turn: entry, laneIdx: wfState.lanes.indexOf(clane) });
    _wfFollowTail(oldTMax);
    return { lanesChanged: wfState.lanes.length !== prevCount };
  }

  var needsSub, key;
  // INVARIANT: gate on AGENT_KEY_UNRELIABLE — see docs/decisions/0005-agent-key-unreliable-shared-contract.md
  if (entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]) {
    needsSub = !WF_MAIN_AGENT_KEYS[entry.agentKey];
    key = _wfSubLaneKey('agent-' + entry.agentKey, entry);
  } else {
    var mainModel = wfState.lanes[0]?.model;
    needsSub = entry.isSubagent || (mainModel && entry.model !== mainModel);
    key = _wfSubLaneKey('subagent-' + wfShortModel(entry.model), entry);
  }
  if (!needsSub) {
    // Temporal overlap check (#221/#222): if this entry starts strictly
    // inside a recent main-lane turn's time range, it must be a parallel
    // agent (typically a fork sharing the parent's session_id AND its
    // authoritative 'orchestrator' agentKey) — split it to a parallel lane,
    // mirroring the wfInferLanes post-pass. agentKey never exempts a turn
    // from this check: it's authoritative about prompt content, not about
    // instance identity.
    // INVARIANT: overlap overrides agentKey for lane placement — see
    // docs/decisions/0008-temporal-overlap-overrides-agent-key.md
    // Predicate matches entry-rendering.js (ADR 0005): strictly inside
    // (start, end) — an entry that STARTED BEFORE the main turn (late
    // arrival, completion order ≠ start order) stays in main; the batch
    // rebuild's sorted sweep is the authoritative resolver for that case.
    var mainTurns = wfState.lanes[0]?.turns || [];
    for (var mi = mainTurns.length - 1; mi >= 0 && mi >= mainTurns.length - 5; mi--) {
      var mt = mainTurns[mi];
      var mtStart = Number(mt.receivedAt) || 0;
      var mtEnd = mtStart + (parseFloat(mt.elapsed) || 0) * 1000;
      if (mtStart > 0 && ts > mtStart && ts < mtEnd) {
        needsSub = true;
        key = _wfSubLaneKey('parallel-' + wfShortModel(entry.model), entry);
        break;
      }
    }
  }
  // #230 sequential interleave: after agentKey and overlap both said "main",
  // ask the tracker. R2 dips route to a parallel lane immediately; R1
  // foreign-conv turns stay provisionally in main until the trunk conv
  // returns, at which point _wfSeqRetroMove relocates the closed bracket.
  // INVARIANT: same tracker semantics as wfInferLanes' post-pass and
  // entry-rendering.js — see docs/decisions/0009-sequential-interleave-conv-bracketing.md
  var seqVerdict = null;
  if (wfState._seqTracker) {
    if (needsSub) {
      wfSeqFeedSplit(wfState._seqTracker, entry);
    } else {
      seqVerdict = wfSeqFeedMain(wfState._seqTracker, entry);
      // codex P2 round 5: an earlier-starting turn arriving late can
      // invalidate ALREADY-CLOSED excursions — the chronological truth can
      // reorder the trunk itself (B0-A-B-A where B was already retro-moved
      // on the A-B-A prefix). Closed turns left the tracker list, so no
      // incremental step can reopen them: rebuild the whole state from
      // allEntries (the batch pass is the authority). Bounded: fires only
      // on inserted-before-tail arrivals (overlap inversion) — occasional
      // even in fork-heavy sessions.
      // INVARIANT: reordered convergence is two-sided — entry-rendering.js
      // must run _seqRecomputeSession (flips AND unflips) on the same flag,
      // or the two files diverge (the ADR 0005 round-4 shape) — see
      // docs/decisions/0009-sequential-interleave-conv-bracketing.md
      if (seqVerdict.reordered) return _wfSeqRebuild(oldTMax);
      if (seqVerdict.place === 'excursion') {
        needsSub = true;
        key = _wfSubLaneKey('parallel-' + wfShortModel(entry.model), entry);
      }
    }
  }
  if (needsSub) {
    var lane;
    if (key.indexOf('parallel-') === 0) {
      // Best-fit among the numbered parallel lanes of this base key (forks
      // share model+convId, so the key alone can't separate instances):
      // reuse the lane whose chain ends latest but at/before this start;
      // none fits → new numbered lane. Mirrors the wfInferLanes post-pass.
      var famLanes = wfState.lanes.filter(function(l) {
        return l.key === key || l.key.indexOf(key + '#') === 0;
      });
      var bestEnd = -1;
      for (var fi = 0; fi < famLanes.length; fi++) {
        var lt = famLanes[fi].turns[famLanes[fi].turns.length - 1];
        var ltEnd = lt ? (Number(lt.receivedAt) || 0) + (parseFloat(lt.elapsed) || 0) * 1000 : 0;
        if (ltEnd <= ts && ltEnd > bestEnd) { lane = famLanes[fi]; bestEnd = ltEnd; }
      }
      if (!lane && famLanes.length) key = key + '#' + (famLanes.length + 1);
    }
    if (!lane) lane = wfState.lanes.find(function(l) { return l.key === key; });
    if (!lane) {
      lane = { name: key, key: key, turns: [], model: entry.model, ctxWindow: entry.maxContext || 0, spawnParent: null, agentKey: entry.agentKey || null, agentLabel: entry.agentLabel || null, convId: entry.convId || null };
      wfState.lanes.push(lane);
    }
    lane.turns.push(entry);
    lane._costMedian = null;
    if (!lane.agentKey && entry.agentKey) { lane.agentKey = entry.agentKey; lane.agentLabel = entry.agentLabel; }
    if (wfState.turnIndex) wfState.turnIndex.set(entry.id, { turn: entry, laneIdx: wfState.lanes.indexOf(lane) });
  } else if (wfState.lanes[0]) {
    wfState.lanes[0].turns.push(entry);
    wfState.lanes[0]._costMedian = null;
    if (wfState.turnIndex) wfState.turnIndex.set(entry.id, { turn: entry, laneIdx: 0 });
  }

  // #230 R1: the trunk conv just returned — turns of the closed bracket were
  // provisionally drawn in main and must relocate to parallel lanes.
  if (seqVerdict && seqVerdict.closed) _wfSeqRetroMove(seqVerdict.closed);

  _wfFollowTail(oldTMax);
  return { lanesChanged: wfState.lanes.length !== prevCount };
}

// Full-state rebuild for the live path (#230 codex P2 round 5): a
// late-arriving turn that starts earlier than already-processed turns can
// overturn closed excursions, so recompute everything from allEntries via
// wfBuildState (the entry is already in allEntries — entry-rendering pushes
// before calling wfAddEntry) and migrate the user's view state onto the
// fresh wfState. entry-rendering converges on the same signal via
// _seqRecomputeSession (round 6).
// GUARD: the migration list below (view window, selection, focus, manual
// lane height) must evolve together with wfBuildState's returned fields —
// a new user-facing wfState field that isn't migrated here silently resets
// on every reordered arrival.
function _wfSeqRebuild(oldTMax) {
  var old = wfState;
  var fresh = wfBuildState(old.sessionId);
  if (!fresh) return { lanesChanged: false };
  fresh.viewT0 = old.viewT0;
  fresh.viewT1 = old.viewT1;
  fresh.selectedTurnId = old.selectedTurnId;
  fresh.selectedSection = old.selectedSection;
  fresh.laneFocusMode = old.laneFocusMode;
  fresh.laneHeightManual = old.laneHeightManual;
  if (old.selectedLane) {
    fresh.selectedLane = fresh.lanes.find(function(l) { return l.key === old.selectedLane.key; }) || fresh.lanes[0];
  }
  wfState = fresh;
  _wfFollowTail(oldTMax);
  return { lanesChanged: true };
}

// Retro-move a closed R1 bracket (#230) out of the live main lane, using the
// same best-fit-by-family placement as the batch pass (latest-ending lane of
// key/key#N that still ends at/before the turn's start — keeps every lane
// serial, preserving the ADR 0008 no-intra-lane-overlap invariant).
function _wfSeqRetroMove(closedTurns) {
  if (!wfState.lanes[0] || !closedTurns.length) return;
  var closedSet = new Set(closedTurns);
  wfState.lanes[0].turns = wfState.lanes[0].turns.filter(function(t) { return !closedSet.has(t); });
  wfState.lanes[0]._costMedian = null;
  for (var i = 0; i < closedTurns.length; i++) {
    var t = closedTurns[i];
    var ts = Number(t.receivedAt) || 0;
    var key = _wfSubLaneKey('parallel-' + wfShortModel(t.model), t);
    var famLanes = wfState.lanes.filter(function(l) {
      return l.key === key || l.key.indexOf(key + '#') === 0;
    });
    var lane = null, bestEnd = -1;
    for (var fi = 0; fi < famLanes.length; fi++) {
      var lt = famLanes[fi].turns[famLanes[fi].turns.length - 1];
      var ltEnd = lt ? (Number(lt.receivedAt) || 0) + (parseFloat(lt.elapsed) || 0) * 1000 : 0;
      if (ltEnd <= ts && ltEnd > bestEnd) { lane = famLanes[fi]; bestEnd = ltEnd; }
    }
    if (!lane) {
      if (famLanes.length) key = key + '#' + (famLanes.length + 1);
      lane = { name: key, key: key, turns: [], model: t.model, ctxWindow: t.maxContext || 0, spawnParent: null, agentKey: t.agentKey || null, agentLabel: t.agentLabel || null, convId: t.convId || null };
      wfState.lanes.push(lane);
    }
    lane.turns.push(t);
    lane._costMedian = null;
    if (wfState.turnIndex) wfState.turnIndex.set(t.id, { turn: t, laneIdx: wfState.lanes.indexOf(lane) });
  }
}

// ── Lane Summary ──────────────────────────────────────────────────────────
function wfLaneSummary(lane) {
  var turns = lane.turns;
  if (!turns.length) return { peakCtx: 0, avgCache: 0, totalCost: 0, turnCount: 0, duration: 0, totalIn: 0, totalOut: 0 };
  var peakCtx = 0, totalCacheR = 0, totalCacheAll = 0, totalCost = 0, totalIn = 0, totalOut = 0;
  for (var i = 0; i < turns.length; i++) {
    var t = turns[i];
    var pct = wfCtxPct(t);
    if (pct > peakCtx) peakCtx = pct;
    var cr = (t.usage?.cache_read_input_tokens || 0);
    var cc = (t.usage?.cache_creation_input_tokens || 0);
    totalCacheR += cr; totalCacheAll += cr + cc;
    totalCost += (t.cost || 0);
    totalIn += (t.usage?.input_tokens || 0) + cr + cc;
    totalOut += (t.usage?.output_tokens || 0);
  }
  var dur = turns[turns.length - 1].receivedAt + (parseFloat(turns[turns.length - 1].elapsed) || 0) * 1000 - turns[0].receivedAt;
  return { peakCtx: peakCtx, avgCache: totalCacheAll > 0 ? (totalCacheR / totalCacheAll * 100) : 0, totalCost: totalCost, turnCount: turns.length, duration: dur, totalIn: totalIn, totalOut: totalOut };
}

// ── Lane Height Helpers ───────────────────────────────────────────────────
function _wfLaneHeight(laneIdx) {
  if (!wfState || laneIdx >= wfState.lanes.length) return WF_LANE_H;
  return wfState.selectedLane?.key === wfState.lanes[laneIdx].key ? WF_LANE_H_SEL : WF_LANE_H;
}
// INVARIANT: must match what _wfRenderSvgContent actually draws in
// laneFocusMode — see docs/decisions/0006-lane-focus-geometry-consistency.md
function _wfTotalLanesHeight() {
  if (!wfState) return 0;
  // Focus mode: only main (index 0) + the selected lane (if not main) take
  // height — matches what _wfRenderSvgContent actually draws, so the
  // container doesn't reserve empty space for lanes that are hidden.
  if (wfState.laneFocusMode) {
    var focusLi = _wfFocusLaneIdx();
    return _wfLaneHeight(0) + (focusLi > 0 ? _wfLaneHeight(focusLi) : 0);
  }
  var h = 0;
  for (var i = 0; i < wfState.lanes.length; i++) h += _wfLaneHeight(i);
  return h;
}

// ── SVG: Single Lane (v8 ctx-split) ───────────────────────────────────────
// Structure per lane: 44px ctx% bars (cache read/write/input split, 40/80
// threshold lines) → 8px cost track (gray, orange outlier) → event tracks
// (collapsed: Faults+Safety merged 8px / expanded: 4×8px with labels).
function wfDotSvg(shape, color, x, y, tidx) {
  var a = ' class="wf-e" data-i="' + tidx + '"';
  if (shape === 'square') return '<rect' + a + ' x="' + x.toFixed(1) + '" y="' + (y + 2) + '" width="4" height="4" fill="' + color + '"/>';
  if (shape === 'triangle') return '<path' + a + ' d="M' + (x + 2).toFixed(1) + ' ' + (y + 2) + ' L' + (x + 4.5).toFixed(1) + ' ' + (y + 6) + ' L' + (x - 0.5).toFixed(1) + ' ' + (y + 6) + ' Z" fill="' + color + '"/>';
  return '<circle' + a + ' cx="' + (x + 2).toFixed(1) + '" cy="' + (y + 4) + '" r="2" fill="' + color + '"/>';
}

// convIds present in the main lane — computed once per render pass and
// passed down (rendering budget: never rescan lanes[0].turns per lane).
function _wfMainConvSet(lanes) {
  var s = new Set();
  var main = lanes && lanes[0];
  if (main && main.turns) {
    for (var i = 0; i < main.turns.length; i++) {
      if (main.turns[i].convId) s.add(main.turns[i].convId);
    }
  }
  return s;
}

// Display name for a lane. Parallel-lane instances (ADR 0008/0009) share
// agentLabel AND often convId, so they'd all read as the same
// "Orchestrator 5212" — semantically wrong too: one session has one
// orchestrator. Split by conversation identity (owner decision, PR #232
// acceptance; refined 2026-07-11 #230 visual review):
//   convId ∈ main's conv set  → "Fork <conv> #k"     (same-conversation
//     twin: overlap-split fork, R2-stitched continuation)
//   convId ∉ main's conv set  → "Teammate <conv> #k" (independent
//     conversation: agent-team teammate, workflow fan-out — R1 excursion)
function _wfLaneDispName(lane, laneIdx, mainConvs) {
  if (lane.childSessionId) return (lane.agentLabel || wfShortModel(lane.model)) + ' ' + lane.childSessionId.slice(0, 8);
  if (laneIdx === 0) return lane.name;
  var laneOrd = /#(\d+)$/.exec(lane.key || '');
  if ((lane.key || '').indexOf('parallel-') === 0) {
    var kin = lane.convId && mainConvs && mainConvs.has(lane.convId) ? 'Fork' : 'Teammate';
    return kin + (lane.convId ? ' ' + lane.convId.slice(0, 4) : '') + ' #' + (laneOrd ? laneOrd[1] : '1');
  }
  return (lane.agentLabel || lane.name) + (lane.convId ? ' ' + lane.convId.slice(0, 4) : '');
}

function wfRenderLaneSvg(lane, laneIdx, W, xFn, mainConvs) {
  var isSel = wfState.selectedLane?.key === lane.key;
  var laneH = isSel ? WF_LANE_H_SEL : WF_LANE_H;
  var boxH = laneH - WF_LANE_GAP;
  var costY = WF_BAR_H, evY = WF_BAR_H + WF_COST_TRACK_H;
  var svg = '';

  // Selection indicator
  if (isSel) {
    svg += '<rect x="0" y="0" width="3" height="' + boxH + '" fill="var(--accent)" rx="1"/>';
    svg += '<rect x="0" y="0" width="' + W + '" height="' + boxH + '" fill="var(--accent)" opacity="0.04"/>';
  }

  // Lane background (clickable)
  svg += '<rect x="0" y="0" width="' + W + '" height="' + boxH + '" fill="transparent" class="wf-lane-bg" data-lane="' + laneIdx + '" style="cursor:pointer"/>';

  // Label block: agent name / model·ctx window / sysprompt version chips
  var prefix = isSel ? '▶ ' : '';
  var ctxK = Math.round((lane.ctxWindow || 0) / 1000);
  var dispName = _wfLaneDispName(lane, laneIdx, mainConvs);
  var fullTitle = wfEsc(lane.name + ' · ' + (lane.agentLabel || '?') + ' · ' + (lane.model || '?') + ' · ' + ctxK + 'K');
  svg += '<text x="8" y="12" fill="var(--text)" style="font-size:11px;font-family:' + WF_MONO + '"><title>' + fullTitle + '</title>' + wfEsc(prefix + dispName) + '</text>';
  svg += wfGlyphSvg(wfLaneShape(lane), 14, 23, 6, wfLaneColor(lane));
  svg += '<text x="20" y="26" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + '"><tspan fill="' + wfLaneColor(lane) + '">' + wfEsc(wfShortModel(lane.model)) + '</tspan>' + wfEsc(' · ' + ctxK + 'K') + '</text>';
  // sysprompt versions: distinct coreHash in first-seen order; chip click = jump
  // to the turn where that version first appeared; ↗ opens the System Prompt page
  // Hashes go into innerHTML data attributes — accept hex only (index.ndjson
  // lines are local data, but escapeHtml doesn't cover quotes, so validate)
  var vHashes = [], vSeen = {};
  for (var vh = 0; vh < lane.turns.length; vh++) {
    var vhash = lane.turns[vh].coreHash;
    if (vhash && /^[0-9a-f]{4,64}$/i.test(vhash) && !vSeen[vhash]) { vSeen[vhash] = 1; vHashes.push(vhash); }
  }
  if (vHashes.length) {
    var chipY = 40, vx = 8, chW = 6.02; // 10px mono char width
    svg += '<text x="' + vx + '" y="' + chipY + '" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + '">sys</text>';
    vx += 4 * chW;
    // Width-budgeted chips: stop before x=196 so +n and ↗ stay inside the gutter
    var vShownN = 0;
    for (var vc = 0; vc < vHashes.length; vc++) {
      var vinfo = _wfVerMap && _wfVerMap[vHashes[vc]];
      var vlabel = vinfo && vinfo.version ? 'v' + vinfo.version : vHashes[vc].slice(0, 5);
      if (vc > 0 && vx + vlabel.length * chW > 196) break;
      svg += '<text class="wf-sysver" data-lane="' + laneIdx + '" data-hash="' + vHashes[vc] + '" x="' + vx.toFixed(1) + '" y="' + chipY + '" fill="var(--accent)" style="font-size:10px;font-family:' + WF_MONO + ';cursor:pointer"><title>' + wfEsc('跳到 ' + vlabel + ' 第一個 turn') + '</title>' + wfEsc(vlabel) + '</text>';
      vx += (vlabel.length + 1) * chW;
      vShownN++;
    }
    if (vHashes.length > vShownN) {
      var moreTxt = '+' + (vHashes.length - vShownN);
      svg += '<text x="' + vx.toFixed(1) + '" y="' + chipY + '" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + '"><title>' + wfEsc(vHashes.length + ' versions total') + '</title>' + moreTxt + '</text>';
      vx += (moreTxt.length + 1) * chW;
    }
    var safeAgent = /^[a-z0-9_-]{1,64}$/i.test(lane.agentKey || '') ? lane.agentKey : '';
    svg += '<text class="wf-sysver-link" data-agent="' + safeAgent + '" data-hash="' + vHashes[vHashes.length - 1] + '" x="' + vx.toFixed(1) + '" y="' + chipY + '" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + ';cursor:pointer"><title>open in System Prompt</title>↗</text>';
  }

  // Track backgrounds (subtle separation from bar area)
  svg += '<rect x="' + WF_LABEL_W + '" y="' + costY + '" width="' + (W - WF_LABEL_W) + '" height="' + WF_COST_TRACK_H + '" fill="var(--surface)" opacity="0.5"/>';
  svg += '<rect x="' + WF_LABEL_W + '" y="' + evY + '" width="' + (W - WF_LABEL_W) + '" height="' + (boxH - evY) + '" fill="var(--surface)" opacity="0.3"/>';

  // Zone threshold lines: 40% gray dashed (reference) + 80% red dashed (warning)
  var y40 = WF_BAR_H * 0.6 + 0.5, y80 = WF_BAR_H * 0.2 + 0.5;
  svg += '<line x1="' + WF_LABEL_W + '" x2="' + (W - 18) + '" y1="' + y40 + '" y2="' + y40 + '" stroke="#8b949e" stroke-opacity="0.35" stroke-dasharray="3 3" shape-rendering="crispEdges"/>';
  svg += '<line x1="' + WF_LABEL_W + '" x2="' + (W - 18) + '" y1="' + y80 + '" y2="' + y80 + '" stroke="#f85149" stroke-opacity="0.40" stroke-dasharray="3 3" shape-rendering="crispEdges"/>';
  svg += '<text x="' + (W - 4) + '" y="' + (y40 + 3) + '" text-anchor="end" fill="#8b949e" opacity="0.7" style="font-size:9px;font-family:' + WF_MONO + '">40</text>';
  svg += '<text x="' + (W - 4) + '" y="' + (y80 + 3) + '" text-anchor="end" fill="#f85149" opacity="0.7" style="font-size:9px;font-family:' + WF_MONO + '">80</text>';

  // Cross-lane vertical lines on main lane: model switch (gray dashed) + subagent spawn (purple)
  if (laneIdx === 0) {
    for (var vi = 1; vi < lane.turns.length; vi++) {
      if (lane.turns[vi].model && lane.turns[vi - 1].model && lane.turns[vi].model !== lane.turns[vi - 1].model) {
        var vts = Number(lane.turns[vi].receivedAt) || 0;
        if (vts < wfState.viewT0 || vts > wfState.viewT1) continue;
        var vlx = Math.max(WF_LABEL_W, xFn(vts));
        svg += '<line x1="' + vlx.toFixed(1) + '" x2="' + vlx.toFixed(1) + '" y1="0" y2="' + WF_BAR_H + '" stroke="#8b949e" stroke-opacity="0.4" stroke-dasharray="3 2"/>';
      }
    }
    for (var sli = 1; sli < wfState.lanes.length; sli++) {
      var firstT = wfState.lanes[sli].turns[0];
      if (!firstT) continue;
      var sts2 = Number(firstT.receivedAt) || 0;
      if (sts2 < wfState.viewT0 || sts2 > wfState.viewT1) continue;
      var slx = Math.max(WF_LABEL_W, xFn(sts2));
      svg += '<line x1="' + slx.toFixed(1) + '" x2="' + slx.toFixed(1) + '" y1="0" y2="' + WF_BAR_H + '" stroke="#bc8cff" stroke-opacity="0.45"/>';
    }
  }

  // ctx% bars: height = ctx window %, stacked cache read (bottom) / cache write / input (top)
  var events = [];
  for (var i = 0; i < lane.turns.length; i++) {
    var t = lane.turns[i];
    events.push(wfDetectEvents(t, i > 0 ? lane.turns[i - 1] : null));
    var ts = Number(t.receivedAt) || 0;
    var dur = (parseFloat(t.elapsed) || 0) * 1000;
    var tend = ts + dur;
    if (tend < wfState.viewT0 || ts > wfState.viewT1) continue;
    var tx = Math.max(WF_LABEL_W, xFn(ts));
    var tw = Math.max(WF_MIN_TURN_PX, xFn(tend) - tx);
    var h = Math.max(2, Math.round(wfCtxPct(t) / 100 * WF_BAR_H));
    var u = t.usage || {};
    var cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
    var inT = (u.input_tokens || 0) + cr + cc;
    var crH = inT > 0 ? Math.round(h * cr / inT) : 0;
    var cwH = inT > 0 ? Math.round(h * cc / inT) : 0;
    if (cc > 0 && cwH < 1) cwH = 1;
    var riH = Math.max(0, h - crH - cwH);
    svg += '<g class="wf-b" data-i="' + i + '" data-turn-id="' + t.id + '">';
    if (riH > 0) svg += '<rect x="' + tx.toFixed(1) + '" y="' + (WF_BAR_H - h) + '" width="' + tw.toFixed(1) + '" height="' + riH + '" fill="' + WF_V8_INPUT + '"/>';
    if (cwH > 0) svg += '<rect x="' + tx.toFixed(1) + '" y="' + (WF_BAR_H - crH - cwH) + '" width="' + tw.toFixed(1) + '" height="' + cwH + '" fill="' + WF_V8_CACHE_WRITE + '"/>';
    if (crH > 0) svg += '<rect x="' + tx.toFixed(1) + '" y="' + (WF_BAR_H - crH) + '" width="' + tw.toFixed(1) + '" height="' + crH + '" fill="' + WF_V8_CACHE_READ + '"/>';
    svg += '</g>';
  }

  // Cost track: mini bars ∝ $, orange when >3× lane median
  var maxC = 0;
  for (var mi = 0; mi < lane.turns.length; mi++) if ((lane.turns[mi].cost || 0) > maxC) maxC = lane.turns[mi].cost;
  var median = wfLaneCostMedian(lane);
  if (maxC > 0) {
    for (var ci = 0; ci < lane.turns.length; ci++) {
      var ct = lane.turns[ci];
      var cts = Number(ct.receivedAt) || 0;
      var cend = cts + (parseFloat(ct.elapsed) || 0) * 1000;
      if (cend < wfState.viewT0 || cts > wfState.viewT1) continue;
      var cx = Math.max(WF_LABEL_W, xFn(cts));
      var cw2 = Math.max(WF_MIN_TURN_PX, xFn(cend) - cx);
      var ch = Math.max(1, Math.round((ct.cost || 0) / maxC * (WF_COST_TRACK_H - 1)));
      var isOutlier = median > 0 && (ct.cost || 0) > median * 3;
      svg += '<rect class="wf-c" data-i="' + ci + '" x="' + cx.toFixed(1) + '" y="' + (costY + WF_COST_TRACK_H - 1 - ch) + '" width="' + cw2.toFixed(1) + '" height="' + ch + '" fill="' + (isOutlier ? WF_V8_COST_OUTLIER : WF_V8_COST) + '"/>';
    }
  }

  // Event tracks: expanded = 4 labeled tracks; collapsed = Faults + Safety only
  for (var ei = 0; ei < lane.turns.length; ei++) {
    var et = lane.turns[ei];
    var ets = Number(et.receivedAt) || 0;
    if (ets < wfState.viewT0 || ets > wfState.viewT1) continue;
    var ex = Math.max(WF_LABEL_W, xFn(ets));
    var evs = events[ei];
    var perTrackN = [0, 0, 0, 0];
    for (var vj = 0; vj < evs.length; vj++) {
      var info = WF_EV_INFO[evs[vj]];
      if (!info) continue;
      if (!isSel && info.ti !== 0 && info.ti !== 3) continue; // collapsed: Faults + Safety only
      var trackY = isSel ? evY + info.ti * WF_EV_H : evY;
      svg += wfDotSvg(info.shape, info.color, ex + perTrackN[isSel ? info.ti : 0] * 5, trackY, ei);
      perTrackN[isSel ? info.ti : 0]++;
    }
  }
  if (isSel) {
    for (var li2 = 0; li2 < WF_TRACKS.length; li2++) {
      svg += '<text x="' + (WF_LABEL_W - 6) + '" y="' + (evY + li2 * WF_EV_H + 7) + '" text-anchor="end" fill="' + WF_TRACKS[li2].color + '" opacity="0.8" style="font-size:9px;font-family:' + WF_MONO + '">' + WF_TRACKS[li2].label + '</text>';
    }
  }

  return svg;
}

// ── SVG: Full Timeline ────────────────────────────────────────────────────
function wfRenderTimeline() {
  if (!wfState || !wfState.lanes.length) return;

  // #144/#149: (re)assign identity (color+glyph) over the current live lane set
  // each render, so concurrent lanes stay distinct as lanes appear/leave.
  wfState.laneStyles = wfComputeLaneStyles(wfState.lanes);

  var existing = document.getElementById('wf-timeline');
  if (existing) existing.remove();

  var container = document.createElement('div');
  container.id = 'wf-timeline';

  // Overview bar: label (240px) + minimap canvas (flex)
  var overviewDiv = document.createElement('div');
  overviewDiv.id = 'wf-overview';
  var overviewLabel = document.createElement('div');
  overviewLabel.id = 'wf-overview-label';
  overviewLabel.innerHTML = _wfOverviewLabelHtml();
  overviewDiv.appendChild(overviewLabel);
  var canvas = document.createElement('canvas');
  canvas.id = 'wf-minimap-canvas';
  overviewDiv.appendChild(canvas);
  container.appendChild(overviewDiv);

  // Lanes section (contains sticky main SVG + scrollable sub-lanes)
  var lanesSection = document.createElement('div');
  lanesSection.id = 'wf-lanes-section';
  var mainSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mainSvg.id = 'wf-main-svg';
  lanesSection.appendChild(mainSvg);
  var subScroll = document.createElement('div');
  subScroll.id = 'wf-sub-scroll';
  var subSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  subSvg.id = 'wf-sub-svg';
  subScroll.appendChild(subSvg);
  lanesSection.appendChild(subScroll);
  container.appendChild(lanesSection);

  // Resize handle (between timeline and detail)
  var resizeHandle = document.createElement('div');
  resizeHandle.id = 'wf-resize';
  container.appendChild(resizeHandle);

  // Detail area: Agent Card (240px) | Steps Panel (flex)
  var detailArea = document.createElement('div');
  detailArea.id = 'wf-detail-area';
  var agentPanel = document.createElement('div');
  agentPanel.id = 'wf-agent-card-panel';
  detailArea.appendChild(agentPanel);
  var stepsPanel = document.createElement('div');
  stepsPanel.id = 'wf-steps-panel';
  stepsPanel.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden';
  var stepsContent = document.createElement('div');
  stepsContent.id = 'wf-steps-content';
  stepsContent.style.cssText = 'flex:1;overflow-y:auto';
  stepsPanel.appendChild(stepsContent);
  detailArea.appendChild(stepsPanel);
  container.appendChild(detailArea);

  colTurns.appendChild(container);
  _wfLoadVersions();

  // P1: content-driven height (selected lane is taller)
  var contentH = WF_PAD + WF_AXIS_H + _wfTotalLanesHeight() + WF_PAD;
  var maxH = window.innerHeight * 0.45;
  lanesSection.style.maxHeight = Math.min(contentH, maxH) + 'px';

  _wfRenderSvgContent(mainSvg, subSvg, canvas);
  wfSetupInteractions(mainSvg, subSvg);
  wfInitResize(lanesSection, resizeHandle);
  resizeHandle.classList.toggle('wf-resize-expand', !!wfState.laneFocusMode);
  wfRenderAgentCard(wfState.selectedLane);
  // ponytail: charts now inline in selected lane SVG, no separate header
  wfRenderCurrentSection();
}

function _wfRenderSvgContent(mainSvg, subSvg, canvas) {
  var lanes = wfState.lanes;
  var W = colTurns.clientWidth || 600;
  var chartW = W - WF_LABEL_W - 12;
  var tRange = wfState.viewT1 - wfState.viewT0 || 1;
  var xFn = function(t) { return WF_LABEL_W + ((t - wfState.viewT0) / tRange) * chartW; };

  // Main SVG: time axis + main lane (height depends on selection)
  var mainLaneH = _wfLaneHeight(0);
  var mainH = WF_PAD + WF_AXIS_H + mainLaneH;
  mainSvg.setAttribute('width', W);
  mainSvg.setAttribute('height', mainH);
  mainSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + mainH);

  var ms = '';
  // v8 bar legend in the axis row's empty label zone (x 0..240 has no ticks)
  var legendY = WF_PAD + 12;
  [[WF_V8_CACHE_READ, 'read', 8], [WF_V8_CACHE_WRITE, 'write', 66], [WF_V8_INPUT, 'input', 132]].forEach(function(lg) {
    ms += '<rect x="' + lg[2] + '" y="' + (legendY - 8) + '" width="8" height="8" rx="1" fill="' + lg[0] + '"/>';
    ms += '<text x="' + (lg[2] + 12) + '" y="' + legendY + '" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + '">' + lg[1] + '</text>';
  });
  var nTicks = Math.max(2, Math.min(12, Math.ceil(tRange / 1000 / 5)));
  var tickStep = tRange / nTicks;
  for (var i = 0; i <= nTicks; i++) {
    var tt = wfState.viewT0 + i * tickStep;
    ms += '<text x="' + xFn(tt) + '" y="' + (WF_PAD + 12) + '" text-anchor="middle" fill="var(--dim)" style="font-size:10px;font-family:' + WF_MONO + '">' + wfFmtMin(tt, wfState.tMin) + '</text>';
  }
  // ponytail: zoom badge on time axis when zoomed
  var isZoomed = wfIsZoomed();
  if (isZoomed) {
    var fullRange = wfState.tMax - wfState.tMin;
    ms += '<text x="' + (W - 6) + '" y="' + (WF_PAD + 12) + '" text-anchor="end" fill="var(--accent)" style="font-size:10px;font-family:' + WF_MONO + ';cursor:pointer" ondblclick="wfState.viewT0=wfState.tMin;wfState.viewT1=wfState.tMax;wfDeferRender()">' + wfFmtDur(tRange) + ' / ' + wfFmtDur(fullRange) + ' ⟲</text>';
  }
  // Cross-lane dim recedes every lane except the focused (selected) one, so a
  // plain lane-select dims the others just like a locked turn does.
  var focusLi = _wfFocusLaneIdx();
  var laneCls = function(li) { return 'wf-lane' + (focusLi >= 0 && focusLi !== li ? ' dim' : ''); };

  // Main conv set for lane naming — once per render pass, so it can't go
  // stale when new turns arrive (every render recomputes) and never rescans
  // main's turns inside the per-lane loop (rendering budget).
  var mainConvs = _wfMainConvSet(lanes);

  var mainLaneY = WF_PAD + WF_AXIS_H;
  ms += '<g class="' + laneCls(0) + '" data-lane="0" transform="translate(0,' + mainLaneY + ')">' + wfRenderLaneSvg(lanes[0], 0, W, xFn, mainConvs) + '</g>';
  mainSvg.innerHTML = ms;

  // Sub SVG: remaining lanes (dynamic height per lane). Lane-focus mode
  // (collapse toggle) narrows this to just the selected lane (or none, if
  // main is selected) so a session with many subagents can't overflow the
  // fixed-height overview area.
  // INVARIANT: this is ground truth for lane geometry — _wfTotalLanesHeight
  // and _wfLaneIdxAtY must match it — see
  // docs/decisions/0006-lane-focus-geometry-consistency.md
  var subIndices;
  if (wfState.laneFocusMode) {
    subIndices = focusLi > 0 ? [focusLi] : [];
  } else {
    subIndices = lanes.slice(1).map(function(_, i) { return i + 1; });
  }
  if (subIndices.length) {
    var subTotalH = 0;
    for (var sh = 0; sh < subIndices.length; sh++) subTotalH += _wfLaneHeight(subIndices[sh]);
    var subH = WF_PAD + subTotalH + WF_PAD;
    subSvg.setAttribute('width', W);
    subSvg.setAttribute('height', subH);
    subSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + subH);
    var ss = '';
    var subY = WF_PAD;
    for (var si = 0; si < subIndices.length; si++) {
      var li = subIndices[si];
      ss += '<g class="' + laneCls(li) + '" data-lane="' + li + '" transform="translate(0,' + subY + ')">' + wfRenderLaneSvg(lanes[li], li, W, xFn, mainConvs) + '</g>';
      subY += _wfLaneHeight(li);
    }
    subSvg.innerHTML = ss;
    subSvg.parentElement.style.display = '';
  } else {
    subSvg.innerHTML = '';
    subSvg.parentElement.style.display = 'none';
  }

  // innerHTML replaced → hover spotlight DOM state is gone; re-apply lock visuals
  _wfHover = { lane: -1, tidx: -1 };
  _wfApplyLockVisuals();

  // Overview bar + charts + step highlights (synced with viewport)
  wfRenderOverview(canvas);
  // ponytail: charts now inline in selected lane SVG, no separate header
  var stepsEl = document.getElementById('wf-steps-content');
  if (stepsEl) _wfSyncStepsHighlight(stepsEl);
}

// ── Lane focus mode ────────────────────────────────────────────────────────
// Collapse toggle for sessions with many subagent lanes (heuristic finding:
// #wf-lanes-section clips lanes off the bottom with no scroll affordance).
// Focused mode narrows the sub-lane area to just the selected lane; main
// stays visible (pinned/cheap) so orchestrator context is never lost.
// Two rows: zoom/focus-toggle controls stay together (row 1, unchanged
// position), the lane pager gets its own row (row 2, right-aligned) instead
// of sharing row 1's 4px gap with the toggle button — nine-gate review found
// that adjacency put a functionally-opposite control (toggle exits focus
// entirely) right next to "next lane," the same misclick shape this whole
// redesign exists to avoid. Row 2 renders empty/collapsed outside focus mode.
// Row 1 (zoom) and row 2 (mode) both always render, so #wf-overview-label's
// height never changes when focus mode toggles — only the pager fades in on
// row 2's right side, filling space that's otherwise just empty. Keeps the
// zoom buttons' and toggle button's positions stable regardless of state.
function _wfOverviewLabelHtml() {
  var focusLi = _wfFocusLaneIdx();
  var row1 = '<div class="wf-ol-row">' +
    '<span>Overview</span>' +
    '<button onclick="wfZoomBy(0.5)">+</button>' +
    '<button onclick="wfZoomBy(2)">−</button>' +
    '<button onclick="wfState.viewT0=wfState.tMin;wfState.viewT1=wfState.tMax;wfDeferRender()">⟲</button>' +
    '</div>';
  var pagerHtml = wfState.laneFocusMode
    ? '<button onclick="wfCycleLane(-1)" title="Previous agent">▲</button>' +
      '<span class="wf-lane-pos">' + (focusLi + 1) + '/' + wfState.lanes.length + '</span>' +
      '<button onclick="wfCycleLane(1)" title="Next agent">▼</button>'
    : '';
  var row2 = '<div class="wf-ol-row wf-ol-row-mode">' +
    '<button onclick="wfToggleLaneFocus()" title="' + (wfState.laneFocusMode ? 'Show all agents' : 'Focus selected agent') +
      '" class="' + (wfState.laneFocusMode ? 'active' : '') + '">' + (wfState.laneFocusMode ? '▤' : '▥') + '</button>' +
    pagerHtml +
    '</div>';
  return row1 + row2;
}

function _wfRefreshLaneFocusUI() {
  var overviewLabel = document.getElementById('wf-overview-label');
  if (overviewLabel) overviewLabel.innerHTML = _wfOverviewLabelHtml();
  // Respect a manual drag-resize (wfInitResize) — don't silently overwrite
  // it on the next toggle/cycle/click, or the resize handle would appear
  // broken (ux-heuristic-analysis: drags that don't stick read as a bug).
  var lanesSection = document.getElementById('wf-lanes-section');
  if (lanesSection && !(wfState && wfState.laneHeightManual)) {
    var contentH = WF_PAD + WF_AXIS_H + _wfTotalLanesHeight() + WF_PAD;
    var maxH = window.innerHeight * 0.45;
    lanesSection.style.maxHeight = Math.min(contentH, maxH) + 'px';
  }
  var resizeHandle = document.getElementById('wf-resize');
  if (resizeHandle) resizeHandle.classList.toggle('wf-resize-expand', !!(wfState && wfState.laneFocusMode));
  wfDeferRender();
}

function wfToggleLaneFocus() {
  if (!wfState) return;
  wfState.laneFocusMode = !wfState.laneFocusMode;
  _wfRefreshLaneFocusUI();
}

// Shared by the ▲/▼ buttons and the Tab/Shift+Tab keyboard shortcut.
function wfCycleLane(dir) {
  if (!wfState || !wfState.lanes.length) return;
  var lanes = wfState.lanes;
  var curLi = lanes.indexOf(wfState.selectedLane);
  var nextLi = (curLi + dir + lanes.length) % lanes.length;
  wfState.selectedLane = lanes[nextLi];
  wfState.selectedTurnId = null;
  _wfRefreshLaneFocusUI();
  wfRenderAgentCard(lanes[nextLi]);
  wfRenderCurrentSection();
}

// ── v8 spotlight / lock visuals ───────────────────────────────────────────
var _wfHover = { lane: -1, tidx: -1 };

function _wfLaneG(li) {
  return document.querySelector('#wf-timeline g.wf-lane[data-lane="' + li + '"]');
}

// Single source of truth for "is the timeline zoomed in from the full range?"
// (100ms slop absorbs float drift). Replaces 5 inline duplicates.
function wfIsZoomed() {
  return wfState.viewT0 > wfState.tMin + 100 || wfState.viewT1 < wfState.tMax - 100;
}

// Focused lane index = the selected lane. Cross-lane dim keys off this (not the
// locked turn) so selecting any lane — the default main or a clicked subagent —
// consistently recedes the others.
function _wfFocusLaneIdx() {
  if (!wfState || !wfState.selectedLane) return -1;
  return wfState.lanes.indexOf(wfState.selectedLane);
}

function _wfLockInfo() {
  if (!wfState || !wfState.selectedTurnId || !wfState.turnIndex) return null;
  var hit = wfState.turnIndex.get(wfState.selectedTurnId);
  if (!hit) return null;
  var lane = wfState.lanes[hit.laneIdx];
  var tidx = lane.turns.indexOf(hit.turn);
  if (tidx < 0) return null;
  return { li: hit.laneIdx, tidx: tidx, lane: lane };
}

// Spotlight: bars 1..N bright (context accumulates), cost/events only N.
// Position marking (hover edge + locked turn) is carried by the bar highlight
// boundary and the #wf-cursor band — no per-lane guide line.
function _wfApplySpotlight(laneG, lane, tidx) {
  laneG.classList.add('wf-spot');
  laneG.classList.remove('dim'); // active lane is never dimmed (prototype: full undim, not :hover 0.7)
  laneG.querySelectorAll('.wf-b').forEach(function(el) {
    el.classList.toggle('hl', parseInt(el.getAttribute('data-i')) <= tidx);
  });
  laneG.querySelectorAll('.wf-c, .wf-e').forEach(function(el) {
    el.classList.toggle('hl', parseInt(el.getAttribute('data-i')) === tidx);
  });
}

function _wfClearSpotlight(laneG) {
  laneG.classList.remove('wf-spot');
  laneG.querySelectorAll('.hl').forEach(function(el) { el.classList.remove('hl'); });
  // Restore cross-lane dim for non-focused lanes when the hover ends
  var focusLi = _wfFocusLaneIdx();
  var li = parseInt(laneG.getAttribute('data-lane'));
  laneG.classList.toggle('dim', focusLi >= 0 && focusLi !== li);
}

// Locked turn keeps a persistent spotlight across hovers and re-renders
function _wfApplyLockVisuals() {
  var lock = _wfLockInfo();
  if (!lock) return;
  var g = _wfLaneG(lock.li);
  if (g) _wfApplySpotlight(g, lock.lane, lock.tidx);
}

// INVARIANT: must match what _wfRenderSvgContent actually draws in
// laneFocusMode — see docs/decisions/0006-lane-focus-geometry-consistency.md
function _wfLaneIdxAtY(svgEl, my) {
  if (!wfState) return -1;
  if (svgEl.id === 'wf-main-svg') return my >= WF_PAD + WF_AXIS_H ? 0 : -1;
  if (wfState.laneFocusMode) {
    // Focus mode: sub SVG draws only the focused lane (see _wfRenderSvgContent) —
    // walking 1..lanes.length would hit-test against a layout that isn't rendered.
    var focusLi = _wfFocusLaneIdx();
    return (focusLi > 0 && my >= WF_PAD) ? focusLi : -1;
  }
  var accY = WF_PAD;
  for (var i = 1; i < wfState.lanes.length; i++) {
    var lh = _wfLaneHeight(i);
    if (my >= accY && my < accY + lh) return i;
    accY += lh;
  }
  return -1;
}

// #126: bars span x0..x1 (width ∝ duration) — distance is 0 inside the bar,
// else distance to the nearer edge. Start-x-only distance made clicks/hovers
// inside long bars (>40px from the left edge) read as empty space.
function _wfNearestTurn(lane, mx) {
  var best = -1, bestD = Infinity;
  for (var i = 0; i < lane.turns.length; i++) {
    var s = _wfBarSpan(lane.turns[i]);
    var d = mx < s.x0 ? s.x0 - mx : (mx > s.x1 ? mx - s.x1 : 0);
    // <= : on overlap (d=0 for several bars) prefer the later turn, matching
    // SVG paint order — later bars draw on top, so pick what the user sees
    if (d <= bestD) { bestD = d; best = i; }
  }
  return { idx: best, dist: bestD };
}

function _wfHoverClear() {
  if (_wfHover.lane < 0) return;
  var g = _wfLaneG(_wfHover.lane);
  var lock = _wfLockInfo();
  if (g && (!lock || lock.li !== _wfHover.lane)) _wfClearSpotlight(g);
  _wfHover = { lane: -1, tidx: -1 };
  _wfApplyLockVisuals(); // snap back: locked lane reclaims its spotlight
}

// Returns {lane, turn} under cursor (nearest by x within the hovered lane), or null
function _wfHoverMove(svgEl, e) {
  if (!wfState) return null;
  var r = svgEl.getBoundingClientRect();
  var mx = e.clientX - r.left, my = e.clientY - r.top;
  if (mx < WF_LABEL_W) { _wfHoverClear(); return null; }
  var li = _wfLaneIdxAtY(svgEl, my);
  if (li < 0 || !wfState.lanes[li] || !wfState.lanes[li].turns.length) { _wfHoverClear(); return null; }
  var lane = wfState.lanes[li];
  var near = _wfNearestTurn(lane, mx);
  if (near.idx < 0) { _wfHoverClear(); return null; }
  if (_wfHover.lane !== li || _wfHover.tidx !== near.idx) {
    if (_wfHover.lane >= 0 && _wfHover.lane !== li) {
      var prevG = _wfLaneG(_wfHover.lane);
      var lock0 = _wfLockInfo();
      if (prevG && (!lock0 || lock0.li !== _wfHover.lane)) _wfClearSpotlight(prevG);
      else _wfApplyLockVisuals(); // prev hover lane is the locked lane: snap its hl back to the lock
    }
    _wfHover = { lane: li, tidx: near.idx };
    var g = _wfLaneG(li);
    if (g) _wfApplySpotlight(g, lane, near.idx);
  }
  return { lane: lane, turn: lane.turns[near.idx], li: li, tidx: near.idx };
}

// ── Deferred re-render (rAF throttled) ────────────────────────────────────
function wfDeferRender() {
  if (_wfPendingRender) return;
  _wfPendingRender = requestAnimationFrame(function() {
    _wfPendingRender = 0;
    var mainSvg = document.getElementById('wf-main-svg');
    var subSvg = document.getElementById('wf-sub-svg');
    var canvas = document.getElementById('wf-minimap-canvas');
    if (mainSvg && subSvg && canvas) {
      _wfRenderSvgContent(mainSvg, subSvg, canvas);
      _wfUpdateCursor(wfState ? wfState.selectedTurnId : null);
    }
  });
}

// ── Overview Bar (Canvas) ─────────────────────────────────────────────────
// Multi-agent legibility: canvas grows with lane count so 4-6 lanes get
// ~6px bars instead of 2-3px slivers. Capped at 48px (#114) — beyond ~10
// lanes bars shrink toward 1px; per-lane analysis is the swimlane's job.
function wfOverviewHeight(laneCount) {
  return Math.min(48, Math.max(28, laneCount * 7 + 6));
}

// slot = px per lane; when tight (<3px) the 1px gap compresses away so
// every lane stays inside the canvas instead of clipping the last rows
function wfOverviewBarGeom(MH, laneCount) {
  var slot = (MH - 4) / laneCount;
  var barH = Math.max(1, Math.min(8, slot - 1));
  return { barH: barH, laneStep: Math.min(slot, barH + 1) };
}

function wfRenderOverview(canvas) {
  if (!wfState || !canvas) return;
  canvas.style.height = wfOverviewHeight(wfState.lanes.length) + 'px';
  var MW = canvas.clientWidth, MH = canvas.clientHeight;
  if (!MW || !MH) return;
  canvas.width = MW * 2; canvas.height = MH * 2;
  var ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  var totalRange = wfState.tMax - wfState.tMin || 1;
  var x = function(t) { return ((t - wfState.tMin) / totalRange) * MW; };

  // ponytail: canvas can't resolve CSS vars; cache computed values (invalidated on theme change)
  var c = _wfGetCssColors();
  var surfaceColor = c.surface, dimColor = c.dim, accentColor = c.accent, bgColor = c.bg;

  ctx.fillStyle = surfaceColor;
  ctx.fillRect(0, 0, MW, MH);

  var lanes = wfState.lanes;
  var geom = wfOverviewBarGeom(MH, lanes.length);
  var barH = geom.barH, laneStep = geom.laneStep;
  var startY = Math.max(1, (MH - lanes.length * laneStep) / 2);

  for (var li = 0; li < lanes.length; li++) {
    var ly = startY + li * laneStep;
    var isSel = wfState.selectedLane?.key === lanes[li].key;
    for (var ti = 0; ti < lanes[li].turns.length; ti++) {
      var t = lanes[li].turns[ti];
      var ts = Number(t.receivedAt) || 0;
      var dur = (parseFloat(t.elapsed) || 0) * 1000;
      ctx.fillStyle = ctxZone(wfCtxPct(t)).hex;
      // 0.5 alpha sank into the dark bg (lesson: low-luminance signals drown)
      ctx.globalAlpha = isSel ? 0.9 : 0.65;
      ctx.fillRect(x(ts), ly, Math.max(1, (dur / totalRange) * MW), barH);
    }
  }
  ctx.globalAlpha = 1;

  // Scale labels
  ctx.font = '10px SF Mono,Menlo,monospace';
  ctx.fillStyle = dimColor;
  ctx.globalAlpha = 0.7;
  ctx.fillText('0', 2, MH - 2);
  var endLabel = wfFmtDur(totalRange);
  ctx.fillText(endLabel, MW - ctx.measureText(endLabel).width - 2, MH - 2);
  ctx.globalAlpha = 1;

  // Viewport rect when zoomed
  var isZoomed = wfIsZoomed();
  if (isZoomed) {
    var vx = x(wfState.viewT0), vw = Math.max(2, x(wfState.viewT1) - vx);
    // ponytail: no dimming overlay — viewport border alone signals the range
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx + 0.5, 0.5, vw, MH - 1);
    // Duration badge
    var vpLabel = wfFmtDur(wfState.viewT1 - wfState.viewT0);
    ctx.font = '10px SF Mono,Menlo,monospace';
    var lw = ctx.measureText(vpLabel).width;
    var lx = vx + vw - lw - 1, lly = MH - 10;
    ctx.fillStyle = accentColor; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.roundRect(lx - 3, lly - 1, lw + 6, 11, 2); ctx.fill();
    ctx.fillStyle = bgColor; ctx.globalAlpha = 1;
    ctx.fillText(vpLabel, lx, lly + 8);
    ctx.globalAlpha = 1;
  }

  // Selected turn cursor on overview
  _wfDrawOverviewCursor(canvas);

  // Minimap interactions
  _wfSetupMinimapInteractions(canvas, MW, MH, totalRange, x, isZoomed);
}

function _wfSetupMinimapInteractions(canvas, MW, MH, totalRange, x, isZoomed) {
  var EDGE_PX = 6;
  canvas.style.cursor = isZoomed ? 'grab' : 'crosshair';

  canvas.onmousemove = isZoomed ? function(e) {
    var rect = canvas.getBoundingClientRect();
    var vx = x(wfState.viewT0), vw = x(wfState.viewT1) - vx;
    var mx = (e.clientX - rect.left) / rect.width * MW;
    if (Math.abs(mx - vx) < EDGE_PX || Math.abs(mx - (vx + vw)) < EDGE_PX) canvas.style.cursor = 'col-resize';
    else if (mx > vx && mx < vx + vw) canvas.style.cursor = 'grab';
    else canvas.style.cursor = 'crosshair';
  } : null;

  canvas.onmousedown = function(e) {
    e.stopPropagation();
    var rect = canvas.getBoundingClientRect();
    var pxToTime = function(cx) { return wfState.tMin + ((cx - rect.left) / rect.width) * totalRange; };
    var clickTime = pxToTime(e.clientX);
    var zoomedNow = wfIsZoomed();

    if (zoomedNow) {
      var vx = x(wfState.viewT0), vw = x(wfState.viewT1) - vx;
      var mx = (e.clientX - rect.left) / rect.width * MW;
      var onLeft = Math.abs(mx - vx) < EDGE_PX;
      var onRight = Math.abs(mx - (vx + vw)) < EDGE_PX;

      if (onLeft || onRight) {
        var onMove = function(ev) {
          var t = Math.max(wfState.tMin, Math.min(wfState.tMax, pxToTime(ev.clientX)));
          if (onLeft) wfState.viewT0 = Math.min(t, wfState.viewT1 - 2000);
          else wfState.viewT1 = Math.max(t, wfState.viewT0 + 2000);
          wfDeferRender();
        };
        var onUp = function() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return;
      }
      if (mx > vx && mx < vx + vw) {
        var span = wfState.viewT1 - wfState.viewT0, mmStartX = e.clientX, mmStartT0 = wfState.viewT0;
        var onMoveP = function(ev) {
          var dt = ((ev.clientX - mmStartX) / rect.width) * totalRange;
          var t0 = mmStartT0 + dt, t1 = mmStartT0 + dt + span;
          if (t0 < wfState.tMin) { t0 = wfState.tMin; t1 = wfState.tMin + span; }
          if (t1 > wfState.tMax) { t1 = wfState.tMax; t0 = wfState.tMax - span; }
          wfState.viewT0 = t0; wfState.viewT1 = t1;
          wfDeferRender();
        };
        var onUpP = function() { window.removeEventListener('mousemove', onMoveP); window.removeEventListener('mouseup', onUpP); };
        window.addEventListener('mousemove', onMoveP);
        window.addEventListener('mouseup', onUpP);
        return;
      }
    }

    // Brush-to-zoom
    var brushStart = clickTime, brushEnd = clickTime;
    var onMoveB = function(ev) {
      brushEnd = Math.max(wfState.tMin, Math.min(wfState.tMax, pxToTime(ev.clientX)));
    };
    var onUpB = function() {
      window.removeEventListener('mousemove', onMoveB);
      window.removeEventListener('mouseup', onUpB);
      var t0 = Math.min(brushStart, brushEnd), t1 = Math.max(brushStart, brushEnd);
      if (t1 - t0 >= 2000) { wfState.viewT0 = t0; wfState.viewT1 = t1; wfDeferRender(); return; }
      // ponytail: small brush = click → hit-test nearest turn
      var bestD = Infinity, bestTid = null, bestLane = null;
      for (var li = 0; li < wfState.lanes.length; li++) {
        var lane = wfState.lanes[li];
        for (var ti = 0; ti < lane.turns.length; ti++) {
          var tt = Number(lane.turns[ti].receivedAt);
          var d = Math.abs(tt - clickTime);
          if (d < bestD) { bestD = d; bestTid = lane.turns[ti].id; bestLane = lane; }
        }
      }
      if (bestTid && bestD < totalRange * 0.02) {
        wfState.selectedLane = bestLane;
        wfState.selectedTurnId = bestTid;
        wfDeferRender();
        wfRenderAgentCard(bestLane);
        for (var si = 0; si < allEntries.length; si++) {
          if (allEntries[si].id === bestTid) { selectTurn(si); break; }
        }
      } else { wfDeferRender(); }
    };
    window.addEventListener('mousemove', onMoveB);
    window.addEventListener('mouseup', onUpB);
  };
}

// ── Zoom ──────────────────────────────────────────────────────────────────
function wfZoomBy(factor) {
  if (!wfState) return;
  var mid = (wfState.viewT0 + wfState.viewT1) / 2;
  var span = wfState.viewT1 - wfState.viewT0;
  var ns = span * factor;
  var full = wfState.tMax - wfState.tMin;
  if (ns >= full * 1.1) { wfState.viewT0 = wfState.tMin; wfState.viewT1 = wfState.tMax; }
  else if (ns < 2000) return;
  else { wfState.viewT0 = Math.max(wfState.tMin, mid - ns / 2); wfState.viewT1 = Math.min(wfState.tMax, mid + ns / 2); }
  wfDeferRender();
}

// ── SVG Interactions ──────────────────────────────────────────────────────
function wfSetupInteractions(mainSvg, subSvg) {
  function attach(svgEl) {
    var chartW = (colTurns.clientWidth || 600) - WF_LABEL_W - 12;

    svgEl.onmousedown = function(e) {
      var r = svgEl.getBoundingClientRect(), mx = e.clientX - r.left;

      // Version chip → lock the turn where that sysprompt version first appeared
      var chipEl = e.target.closest ? e.target.closest('.wf-sysver') : null;
      if (chipEl) {
        var cLane = wfState.lanes[parseInt(chipEl.getAttribute('data-lane'))];
        var cHash = chipEl.getAttribute('data-hash');
        if (cLane) {
          for (var cti = 0; cti < cLane.turns.length; cti++) {
            if (cLane.turns[cti].coreHash !== cHash) continue;
            wfState.selectedLane = cLane;
            wfState.selectedTurnId = cLane.turns[cti].id;
            wfDeferRender();
            wfRenderAgentCard(cLane);
            for (var cak = 0; cak < allEntries.length; cak++) {
              if (allEntries[cak].id === wfState.selectedTurnId) { selectTurn(cak); break; }
            }
            break;
          }
        }
        return;
      }
      // ↗ → System Prompt page; state handoff via spPendingDeepLink because
      // switchTab's syncUrlFromState rebuilds the URL and drops foreign params
      var linkEl = e.target.closest ? e.target.closest('.wf-sysver-link') : null;
      if (linkEl) {
        spPendingDeepLink = { agent: linkEl.getAttribute('data-agent') || null, hash: linkEl.getAttribute('data-hash') || null };
        switchTab('sysprompt');
        return;
      }

      // Click in label area — compute lane index from Y coordinate
      if (mx < WF_LABEL_W) {
        var my = e.clientY - r.top;
        var li = -1;
        if (svgEl.id === 'wf-main-svg') {
          // Main SVG: one lane at y = WF_PAD + WF_AXIS_H
          if (my >= WF_PAD + WF_AXIS_H) li = 0;
        } else if (wfState.laneFocusMode) {
          // Focus mode: sub SVG draws only the focused lane (see _wfRenderSvgContent) —
          // walking 1..lanes.length would hit-test against a layout that isn't rendered.
          // INVARIANT: see docs/decisions/0006-lane-focus-geometry-consistency.md
          var focusLiClick = _wfFocusLaneIdx();
          if (focusLiClick > 0 && my >= WF_PAD) li = focusLiClick;
        } else {
          // Sub SVG: lanes have variable height, walk to find index
          var accY = WF_PAD;
          for (var si2 = 1; si2 < wfState.lanes.length; si2++) {
            var lh = _wfLaneHeight(si2);
            if (my >= accY && my < accY + lh) { li = si2; break; }
            accY += lh;
          }
        }
        if (li >= 0 && li < wfState.lanes.length) {
          wfState.selectedLane = wfState.lanes[li];
          wfState.selectedTurnId = null;
          _wfRefreshLaneFocusUI();
          wfRenderAgentCard(wfState.lanes[li]);
          wfRenderCurrentSection();
        }
        return;
      }

      // Drag to pan
      var startX = e.clientX, startT0 = wfState.viewT0, startT1 = wfState.viewT1;
      var moved = false, startTime = Date.now();
      var onMove = function(ev) {
        var dx = ev.clientX - startX;
        if (Math.abs(dx) > 5) moved = true; // ponytail: was 3px, too low for HiDPI/touchpad
        var span = startT1 - startT0, dt = -(dx / chartW) * span;
        var t0 = startT0 + dt, t1 = startT1 + dt;
        if (t0 < wfState.tMin) { t0 = wfState.tMin; t1 = wfState.tMin + span; }
        if (t1 > wfState.tMax) { t1 = wfState.tMax; t0 = wfState.tMax - span; }
        wfState.viewT0 = t0; wfState.viewT1 = t1;
        wfDeferRender();
      };
      var onUp = function(ev) {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moved && (Date.now() - startTime) > 200) return; // ponytail: fast tap = always click
        // v8: click chart = lock/unlock nearest turn in that lane
        var r2 = svgEl.getBoundingClientRect();
        var mx2 = ev.clientX - r2.left, my2 = ev.clientY - r2.top;
        var li = _wfLaneIdxAtY(svgEl, my2);
        if (li < 0 || !wfState.lanes[li]) return;
        var lane = wfState.lanes[li];
        var near = lane.turns.length ? _wfNearestTurn(lane, mx2) : { idx: -1, dist: Infinity };
        if (near.idx >= 0 && near.dist < 40) {
          var tid = lane.turns[near.idx].id;
          if (wfState.selectedTurnId === tid) {
            wfState.selectedTurnId = null; // click same turn = unlock
            wfDeferRender();
            return;
          }
          wfState.selectedLane = lane; // lock: auto-expand lane
          wfState.selectedTurnId = tid;
          wfDeferRender();
          wfRenderAgentCard(lane);
          // Bridge to existing detail rendering
          for (var k = 0; k < allEntries.length; k++) {
            if (allEntries[k].id === tid) { selectTurn(k); break; }
          }
        } else {
          // Empty chart area: select lane without locking a turn
          wfState.selectedLane = lane;
          wfState.selectedTurnId = null;
          wfDeferRender();
          wfRenderAgentCard(lane);
          wfRenderCurrentSection();
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    // v8 hover: full-lane spotlight (bars 1..N accumulate) + guide + tooltip
    svgEl.onmousemove = function(e) {
      var hmx = e.clientX - svgEl.getBoundingClientRect().left;
      var hit = _wfHoverMove(svgEl, e);
      if (hit) {
        _wfShowTooltip(e, hit.turn, hit.lane);
        svgEl.style.cursor = 'pointer';
      } else {
        _wfHideTooltip();
        svgEl.style.cursor = hmx >= WF_LABEL_W ? 'grab' : 'pointer';
      }
    };
    svgEl.onmouseleave = function() { _wfHideTooltip(); _wfHoverClear(); };

    // Double-click reset zoom
    svgEl.ondblclick = function() {
      wfState.viewT0 = wfState.tMin;
      wfState.viewT1 = wfState.tMax;
      wfDeferRender();
    };

    // Ctrl+wheel zoom, horizontal scroll pan
    svgEl.onwheel = function(e) {
      var r = svgEl.getBoundingClientRect(), mx = e.clientX - r.left;
      if (mx < WF_LABEL_W) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var cursor = wfState.viewT0 + ((mx - WF_LABEL_W) / chartW) * (wfState.viewT1 - wfState.viewT0);
        var factor = e.deltaY > 0 ? 1.3 : 0.7;
        var span = wfState.viewT1 - wfState.viewT0;
        var ratio = (cursor - wfState.viewT0) / span;
        var ns = span * factor;
        var full = wfState.tMax - wfState.tMin;
        if (ns >= full * 1.1) { wfState.viewT0 = wfState.tMin; wfState.viewT1 = wfState.tMax; }
        else if (ns < 2000) return;
        else { wfState.viewT0 = Math.max(wfState.tMin, cursor - ns * ratio); wfState.viewT1 = Math.min(wfState.tMax, cursor + ns * (1 - ratio)); }
        wfDeferRender();
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        var span2 = wfState.viewT1 - wfState.viewT0;
        var dt = (e.deltaX / chartW) * span2;
        var t0 = wfState.viewT0 + dt, t1 = wfState.viewT1 + dt;
        if (t0 < wfState.tMin) { t0 = wfState.tMin; t1 = t0 + span2; }
        if (t1 > wfState.tMax) { t1 = wfState.tMax; t0 = t1 - span2; }
        wfState.viewT0 = t0; wfState.viewT1 = t1;
        wfDeferRender();
      }
    };
  }
  attach(mainSvg);
  attach(subSvg);
}

// ── Tooltip ───────────────────────────────────────────────────────────────
function _wfFmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function _wfShowTooltip(e, t, lane) {
  if (!_wfTooltipEl) {
    _wfTooltipEl = document.createElement('div');
    _wfTooltipEl.className = 'wf-tooltip';
    document.body.appendChild(_wfTooltipEl);
  }
  var u = t.usage || {};
  var cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
  var inT = (u.input_tokens || 0) + cr + cc;
  var pct = wfCtxPct(t);
  var cz = ctxZone(pct);
  var zone = cz.zone;
  var zoneCls = 'wf-tt-' + (zone === 'safe' ? 'good' : zone);
  var median = lane ? wfLaneCostMedian(lane) : 0;
  var outlier = median > 0 && (t.cost || 0) > median * 3 ? ' <span class="wf-tt-outlier">⚡outlier</span>' : '';
  var tools = t.toolCalls ? Object.entries(t.toolCalls).map(function(kv) { return kv[0] + (kv[1] > 1 ? '×' + kv[1] : ''); }).join(', ') : '';
  // Locked lane, hovering a different turn → remind where the lock is
  var lock = _wfLockInfo();
  var lockLbl = (lock && lane && lock.lane === lane && lock.lane.turns[lock.tidx] !== t)
    ? ' <span class="wf-tt-lock">🔒#' + wfEsc(String(lock.lane.turns[lock.tidx].displayNum || lock.tidx + 1)) + '</span>' : '';
  var row = function(l, v) { return '<div class="r"><span class="l">' + l + '</span><span class="v">' + v + '</span></div>'; };
  _wfTooltipEl.innerHTML =
    row('#' + wfEsc(String(t.displayNum || '?')), wfEsc(wfShortModel(t.model)) + lockLbl)
    + row('Context', '<span class="' + zoneCls + '">' + pct.toFixed(1) + '%</span> (' + zone + ')')
    + row('Cache', _wfFmtTok(cr) + ' read / ' + _wfFmtTok(cc) + ' write')
    + row('Cost', '$' + (t.cost || 0).toFixed(4) + outlier)
    + row('Duration', wfFmtDur((parseFloat(t.elapsed) || 0) * 1000))
    + row('Tokens', _wfFmtTok(inT) + ' in / ' + _wfFmtTok(u.output_tokens || 0) + ' out')
    + (tools ? row('Tools', wfEsc(tools)) : '');
  _wfTooltipEl.style.display = 'block';
  var tx = e.clientX + 12, ty = e.clientY + 12;
  if (tx + _wfTooltipEl.offsetWidth > window.innerWidth) tx = e.clientX - _wfTooltipEl.offsetWidth - 12;
  if (ty + _wfTooltipEl.offsetHeight > window.innerHeight) ty = e.clientY - _wfTooltipEl.offsetHeight - 12;
  _wfTooltipEl.style.left = tx + 'px';
  _wfTooltipEl.style.top = ty + 'px';
}
function _wfHideTooltip() {
  if (_wfTooltipEl) _wfTooltipEl.style.display = 'none';
}

// ── Resize Handle ─────────────────────────────────────────────────────────
function wfInitResize(subScroll, handle) {
  handle.onmousedown = function(e) {
    // Lane-focus mode drives the height from content, not the user — there's
    // nothing to drag (see wf-resize-expand in style.css). A plain click still
    // fires below and exits focus mode instead.
    if (wfState && wfState.laneFocusMode) return;
    e.preventDefault();
    var startY = e.clientY;
    var startH = subScroll.offsetHeight;
    // Once the user drags, stop auto-computing maxHeight on lane-select
    // (_wfRefreshLaneFocusUI) — otherwise the next toggle/cycle/click
    // silently overwrites their resize with no feedback (ux-heuristic-analysis).
    if (wfState) wfState.laneHeightManual = true;
    var onMove = function(ev) {
      var delta = ev.clientY - startY;
      var newH = Math.max(60, startH + delta);
      subScroll.style.maxHeight = newH + 'px';
    };
    var onUp = function() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  handle.onclick = function() {
    if (wfState && wfState.laneFocusMode) wfToggleLaneFocus();
  };
}

// ── Highlight Turn (without full re-render) ───────────────────────────────
// Render a turn's detail into the steps panel without locking it in the
// swimlane (used by lane selection: last turn = full conversation range).
// selectTurn feeds back into wfHighlightTurn, so suppress that echo.
var _wfSuppressHighlight = false;
function _wfShowTurnDetail(turn) {
  if (!turn) return;
  for (var i = 0; i < allEntries.length; i++) {
    if (allEntries[i].id === turn.id) {
      _wfSuppressHighlight = true;
      try { selectTurn(i); } finally { _wfSuppressHighlight = false; }
      return;
    }
  }
}

function wfHighlightTurn(turnId) {
  if (!wfState) return;
  if (_wfSuppressHighlight) return;
  wfState.selectedTurnId = turnId;
  // Update lane selection based on turn
  if (turnId) {
    for (var i = 0; i < wfState.lanes.length; i++) {
      for (var j = 0; j < wfState.lanes[i].turns.length; j++) {
        if (wfState.lanes[i].turns[j].id === turnId) {
          wfState.selectedLane = wfState.lanes[i];
          break;
        }
      }
    }
  }
  wfDeferRender();
  _wfUpdateCursor(turnId);
}

// ── Cursor line — syncs overview + swimlane + step list position ─────────
function _wfFindTurn(turnId) {
  if (!turnId || !wfState) return null;
  var hit = wfState.turnIndex && wfState.turnIndex.get(turnId);
  return hit ? hit.turn : null;
}

function _wfUpdateCursor(turnId) {
  var cursor = document.getElementById('wf-cursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'wf-cursor';
    var lanes = document.getElementById('wf-lanes-section');
    if (lanes) lanes.appendChild(cursor);
    else return;
  }
  var t = _wfFindTurn(turnId);
  var ts = t ? Number(t.receivedAt) : 0;
  if (!ts || ts < wfState.viewT0 || ts > wfState.viewT1) { cursor.style.display = 'none'; return; }
  var endTs = ts + (parseFloat(t.elapsed) || 0) * 1000;
  var W = (document.getElementById('wf-main-svg') || {}).clientWidth || 600;
  var chartW = W - WF_LABEL_W - 12, tRange = wfState.viewT1 - wfState.viewT0 || 1;
  var px = WF_LABEL_W + ((ts - wfState.viewT0) / tRange) * chartW;
  var px2 = endTs > ts ? WF_LABEL_W + ((Math.min(endTs, wfState.viewT1) - wfState.viewT0) / tRange) * chartW : px;
  cursor.style.display = '';
  cursor.style.left = px.toFixed(1) + 'px';
  cursor.style.width = Math.max(px2 - px, 3) + 'px';
}

function _wfDrawOverviewCursor(canvas) {
  if (!canvas || !wfState || !wfState.selectedTurnId) return;
  var t = _wfFindTurn(wfState.selectedTurnId);
  if (!t) return;
  var ts = Number(t.receivedAt);
  var endTs = ts + (parseFloat(t.elapsed) || 0) * 1000;
  var MW = canvas.clientWidth, MH = canvas.clientHeight, totalRange = wfState.tMax - wfState.tMin || 1;
  var px1 = ((ts - wfState.tMin) / totalRange) * MW;
  var px2 = endTs > ts ? ((endTs - wfState.tMin) / totalRange) * MW : px1;
  var w = Math.max(px2 - px1, 3); // ponytail: min 3px so short turns stay visible
  if (px1 + w > MW) px1 = MW - w; // clamp: keep rect inside canvas
  var ctx2 = canvas.getContext('2d');
  var c = _wfGetCssColors();
  ctx2.fillStyle = c.accent;
  ctx2.globalAlpha = 0.35;
  ctx2.fillRect(px1, 0, w, MH);
  // P15: 1px bright indicator line at selected turn's start position
  ctx2.globalAlpha = 0.9;
  ctx2.fillRect(Math.round(px1), 0, 1, MH);
  ctx2.globalAlpha = 1;
}

// ── Agent Card ────────────────────────────────────────────────────────────
// Session-wide rollup fields (inputTokens/outputTokens/compactCount/cacheBreaks/
// idleMs/toolFailTurns/toolCallTurns) live on the sessionsMap session object,
// accumulated per-entry in entry-rendering.js addEntry(). Only meaningful for the
// orchestrator lane — a single lane has no view of "other lanes" so these are session,
// not lane, aggregates. See docs/designs/follow-live-turn-subagent.md "Overview Panel (L3)".
// No main/subagent cost split here — isAnthropicSubagent() in store.js can't
// tell them apart when the subagent request carries the parent's session_id
// (current Claude Code behavior), so the split would silently misattribute
// subagent spend as main. Tracked separately; add back once that's fixed.
function _wfFmtSessTok(n) {
  n = n || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}
function _wfFmtSessDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '-';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  if (ms < 86400000) return (ms / 3600000).toFixed(1) + 'h';
  return (ms / 86400000).toFixed(1) + 'd';
}
// Parse an entry-id timestamp ("2026-03-08T17-47-13-000") to epoch ms.
// Same 4-line parse as formatRelativeTime in miller-columns.js — not reused
// directly since that helper returns a formatted string, not raw ms.
function _wfParseIdMs(id) {
  if (!id || id.length < 19) return null;
  var ts = new Date(id.slice(0, 10) + 'T' + id.slice(11, 19).replace(/-/g, ':')).getTime();
  return isFinite(ts) ? ts : null;
}

function wfRenderAgentCard(lane) {
    var agentPanel = document.getElementById('wf-agent-card-panel');
  if (!lane || !agentPanel) return;
  var summary = wfLaneSummary(lane);
  var color = wfLaneColor(lane);

  // Orchestrator lane only: session-wide rollup (see comment above wfRenderAgentCard).
  // INVARIANT: _wfIsMainLane, not !lane.spawnParent — see
  // docs/decisions/0007-wf-is-main-lane-not-spawn-parent.md
  var isOrchestrator = _wfIsMainLane(lane);
  var sess = (isOrchestrator && wfState && typeof sessionsMap !== 'undefined')
    ? sessionsMap.get(wfState.sessionId) : null;

  // Session-wide on the main lane (matches Context/Cache/Tokens below — a lane
  // has no view of "the other lanes," so main's tool rollup must read sess.toolCalls,
  // not just this lane's own turns, or counts like a 473-call Agent/Task tool
  // total would be undercounted to whatever subset the orchestrator itself called).
  var toolTotals = (isOrchestrator && sess && sess.toolCalls) ? sess.toolCalls : {};
  if (!isOrchestrator || !sess || !sess.toolCalls) {
    for (var i = 0; i < lane.turns.length; i++) {
      var tc = lane.turns[i].toolCalls || {};
      for (var k in tc) toolTotals[k] = (toolTotals[k] || 0) + tc[k];
    }
  }
  var topTools = Object.entries(toolTotals).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 6);

  var html = '<div class="wf-agent-card" style="border-left:2px solid ' + color + '">';
  html += '<div class="wf-ac-name">' + wfGlyphHtml(wfLaneShape(lane), 10, color) + ' ' + wfEsc(lane.name) + ' <span class="wf-ac-model" style="background:' + color + '22;color:' + color + '">' + wfEsc(wfShortModel(lane.model)) + '</span></div>';
  // INVARIANT: main/subagent label must use _wfIsMainLane, not lane.spawnParent
  // — see docs/decisions/0007-wf-is-main-lane-not-spawn-parent.md
  html += '<div class="wf-ac-meta">' + summary.turnCount + ' turns · ' + wfFmtDur(summary.duration) + ' · ' + (isOrchestrator ? 'orchestrator' : 'subagent') + '</div>';

  html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Context</div>';
  html += '<div class="wf-ac-row"><span>Peak</span><span class="wf-ac-val">' + summary.peakCtx.toFixed(1) + '%</span></div>';
  html += '<div class="wf-ac-row"><span>Window</span><span class="wf-ac-val">' + Math.round((lane.ctxWindow || 0) / 1000) + 'K</span></div>';
  if (sess) html += '<div class="wf-ac-row"><span>Compacts</span><span class="wf-ac-val">' + (sess.compactCount || 0) + '</span></div>';
  html += '</div>';

  html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Cache</div>';
  html += '<div class="wf-ac-row"><span>Hit rate</span><span class="wf-ac-val">' + summary.avgCache.toFixed(1) + '%</span></div>';
  if (sess) html += '<div class="wf-ac-row"><span>Breaks</span><span class="wf-ac-val">' + (sess.cacheBreaks || 0) + '</span></div>';
  html += '</div>';

  html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Cost</div>';
  html += '<div class="wf-ac-row"><span>Total</span><span class="wf-ac-val">$' + summary.totalCost.toFixed(4) + '</span></div>';
  html += '</div>';

  if (sess && (sess.inputTokens || sess.outputTokens)) {
    var inTok = sess.inputTokens || 0, outTok = sess.outputTokens || 0;
    var ioRatio = outTok > 0 ? (inTok / outTok).toFixed(1) + ':1' : '-';
    html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Tokens</div>';
    html += '<div class="wf-ac-row"><span>Input</span><span class="wf-ac-val">' + _wfFmtSessTok(inTok) + '</span></div>';
    html += '<div class="wf-ac-row"><span>Output</span><span class="wf-ac-val">' + _wfFmtSessTok(outTok) + '</span></div>';
    html += '<div class="wf-ac-row"><span>I/O ratio</span><span class="wf-ac-val">' + ioRatio + '</span></div>';
    html += '</div>';
  }

  // Turns/intervene dropped — design doc's own data-availability table marks
  // it "Complex — may defer" (no signal yet for user-turn vs auto-approved).
  // Retries is available (sess.retryCount, tracked in entry-rendering.js).
  if (sess && sess.retryCount) {
    html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Autonomy</div>';
    html += '<div class="wf-ac-row"><span>Retries</span><span class="wf-ac-val">' + sess.retryCount + '</span></div>';
    html += '</div>';
  }

  if (topTools.length) {
    html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Tools</div>';
    for (var ti = 0; ti < topTools.length; ti++) {
      html += '<div class="wf-ac-row"><span class="wf-ac-tool">' + wfEsc(topTools[ti][0]) + '</span><span class="wf-ac-tool-count">' + topTools[ti][1] + '</span></div>';
    }
    if (sess && (sess.toolCallTurns || 0) > 0) {
      // Turn-level, not call-level: a turn with 1 failed call among many still
      // counts as fully failed (toolFail is a turn boolean, not a per-call
      // count — codex review flagged the old "Failure rate" label as implying
      // more precision than this data actually has).
      var failRate = (sess.toolFailTurns || 0) / sess.toolCallTurns * 100;
      html += '<div class="wf-ac-row"><span title="Turns with 1+ failed tool result, not individual call failures">Turn failure rate</span><span class="wf-ac-val">' + failRate.toFixed(1) + '%</span></div>';
    }
    html += '</div>';
  }

  if (sess) {
    var startMs = _wfParseIdMs(sess.firstId);
    var durationMs = (startMs != null && sess.lastReceivedAt) ? (sess.lastReceivedAt - startMs) : null;
    var activeMs = durationMs != null ? Math.max(0, durationMs - (sess.idleMs || 0)) : null;
    html += '<div class="wf-ac-section"><div class="wf-ac-section-title">Time</div>';
    html += '<div class="wf-ac-row"><span>Started</span><span class="wf-ac-val">' + (sess.firstId ? wfEsc(formatEntryDate(sess.firstId)) : '-') + '</span></div>';
    html += '<div class="wf-ac-row"><span>Duration</span><span class="wf-ac-val">' + _wfFmtSessDur(durationMs) + '</span></div>';
    html += '<div class="wf-ac-row"><span>Active</span><span class="wf-ac-val">' + _wfFmtSessDur(activeMs) + '</span></div>';
    html += '</div>';
  }

  // Section navigation (reuses v1.9.2 sections column concept)
  var secs = [
    { name: 'timeline', label: 'Timeline', badge: lane.turns.length + ' turns' },
    { name: 'system', label: 'System' },
    { name: 'core-tools', label: 'Core' },
    { name: 'mcp-tools', label: 'MCP' },
    { name: 'skills', label: 'Skills' },
    { name: 'cost-efficiency', label: 'Cost Efficiency' },
    { name: 'raw-req', label: 'Request' },
    { name: 'raw-res', label: 'Events' },
  ];
  var curSec = wfState.selectedSection || 'timeline';
  html += '<div class="wf-ac-nav">';
  for (var si = 0; si < secs.length; si++) {
    var s = secs[si];
    var sel = curSec === s.name ? ' wf-ac-nav-active' : '';
    html += '<span class="wf-ac-nav-item' + sel + '" data-section="' + s.name + '" onclick="wfSelectSection(\'' + s.name + '\')">' + wfEsc(s.label);
    if (s.badge) html += ' <span class="wf-ac-nav-badge">' + wfEsc(s.badge) + '</span>';
    html += '</span>';
  }
  html += '</div>';

  html += '</div>';
  agentPanel.innerHTML = html;
}

// ── Lane-level summary (no turn selected) ────────────────────────────────
function _wfRenderLaneSummary(lane, section) {
  var el = document.getElementById('wf-steps-content');
  if (!el) return;
  var s = wfLaneSummary(lane);
  var html = '<div style="padding:16px">';
  html += '<div style="font-size:13px;color:var(--dim);margin-bottom:12px">' + wfEsc(lane.name) + ' · ' + s.turnCount + ' turns · ' + wfFmtDur(s.duration) + '</div>';

  if (section === 'cost-efficiency') {
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += '<tr style="color:var(--dim)"><th style="text-align:left;padding:4px 8px">#</th><th style="text-align:left;padding:4px 8px">Model</th><th style="text-align:right;padding:4px 8px">Cost</th><th style="text-align:right;padding:4px 8px">Tokens</th><th style="text-align:right;padding:4px 8px">Cache</th></tr>';
    for (var i = 0; i < lane.turns.length; i++) {
      var t = lane.turns[i], u = t.usage || {}, inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      var allTok = inTok + (u.output_tokens || 0), cache = u.cache_read_input_tokens || 0;
      var pct = inTok > 0 ? (cache / inTok * 100).toFixed(0) + '%' : '-';
      html += '<tr style="cursor:pointer;border-top:1px solid var(--border)" onclick="wfLockTurn(\'' + t.id + '\');wfSelectSection(\'cost-efficiency\')">';
      html += '<td style="padding:4px 8px;color:var(--dim)">' + (i + 1) + '</td>';
      html += '<td style="padding:4px 8px">' + wfEsc(wfShortModel(t.model)) + '</td>';
      html += '<td style="padding:4px 8px;text-align:right">$' + (t.cost || 0).toFixed(4) + '</td>';
      html += '<td style="padding:4px 8px;text-align:right">' + (allTok / 1000).toFixed(1) + 'K</td>';
      html += '<td style="padding:4px 8px;text-align:right">' + pct + '</td></tr>';
    }
    html += '<tr style="border-top:2px solid var(--border);font-weight:bold"><td colspan="2" style="padding:4px 8px">Total</td>';
    html += '<td style="padding:4px 8px;text-align:right">$' + s.totalCost.toFixed(4) + '</td>';
    html += '<td style="padding:4px 8px;text-align:right">' + ((s.totalIn + s.totalOut) / 1000).toFixed(1) + 'K</td>';
    html += '<td style="padding:4px 8px;text-align:right">' + s.avgCache.toFixed(0) + '%</td></tr></table>';
  } else {
    html += '<div style="color:var(--dim);font-size:12px">Click a turn bar to see ' + wfEsc(section) + ' detail</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// Lock a turn AND its lane atomically, deriving the lane from turnIndex
// (the collision-free laneIdx) so the A==B invariant — expanded lane ==
// locked-turn lane — holds structurally for every caller. Bridges to
// selectTurn (detail pane) and refreshes swimlane visuals via wfDeferRender.
function wfLockTurn(turnId) {
  if (!wfState || !turnId) return;
  var hit = wfState.turnIndex && wfState.turnIndex.get(turnId);
  if (!hit) return; // unknown turn → no phantom lock (leave selection untouched)
  wfState.selectedTurnId = turnId;
  wfState.selectedLane = wfState.lanes[hit.laneIdx];
  _wfRefreshLaneFocusUI();
  for (var k = 0; k < allEntries.length; k++) {
    if (allEntries[k].id === turnId) { selectTurn(k); break; }
  }
}

// ── Section Navigation ───────────────────────────────────────────────────
function wfSelectSection(name) {
  if (!wfState) return;
  wfState.selectedSection = name;
  selectedSection = name;
  // Update nav highlight
  var panel = document.getElementById('wf-agent-card-panel');
  if (panel) {
    panel.querySelectorAll('.wf-ac-nav-item').forEach(function(el) {
      el.classList.toggle('wf-ac-nav-active', el.getAttribute('data-section') === name);
    });
  }
  var lane = wfState.selectedLane;
  if (!lane || !lane.turns.length) return;
  // No turn selected: timeline = last turn's detail (full range), no lock
  if (!wfState.selectedTurnId) {
    if (name === 'timeline') { _wfShowTurnDetail(lane.turns[lane.turns.length - 1]); return; }
    _wfRenderLaneSummary(lane, name); return;
  }
  for (var i = 0; i < allEntries.length; i++) {
    if (allEntries[i].id === wfState.selectedTurnId) { selectTurn(i); break; }
  }
}

// Render current section into #wf-steps-content (selectTurn → renderDetailCol redirect)
function wfRenderCurrentSection() {
  if (!wfState) return;
  var lane = wfState.selectedLane;
  if (!lane || !lane.turns.length) return;
  var sec = wfState.selectedSection || 'timeline';
  selectedSection = sec;
  if (!wfState.selectedTurnId) {
    // Timeline with no lock = last turn's detail (its request holds the whole
    // conversation = full range) without lock visuals; other sections keep summary
    if (sec === 'timeline') { _wfShowTurnDetail(lane.turns[lane.turns.length - 1]); return; }
    _wfRenderLaneSummary(lane, sec); return;
  }
  for (var i = 0; i < allEntries.length; i++) {
    if (allEntries[i].id === wfState.selectedTurnId) { selectTurn(i); break; }
  }
}

// ── Steps Panel (flat turn list — kept for reference but no longer the default) ──
var WF_IDLE_THRESHOLD = 300000;
function wfRenderSteps(scrollToId) {
  var el = document.getElementById('wf-steps-content');
  if (!el || !wfState) return;
  var lane = wfState.selectedLane;
  if (!lane || !lane.turns.length) { el.innerHTML = '<div style="padding:12px;color:var(--dim)">Select a lane</div>'; return; }

  var turns = lane.turns;
  var color = wfLaneColor(lane);
  var html = '<div class="wf-steps-header" style="padding:4px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--dim)">TIMELINE · <span style="color:' + color + '">' + wfGlyphHtml(wfLaneShape(lane), 10, color) + ' ' + wfEsc(lane.name) + '</span> · ' + turns.length + ' turns</div>';

  for (var idx = 0; idx < turns.length; idx++) {
    var t = turns[idx];
    // Idle separator
    if (idx > 0) {
      var prevEnd = Number(turns[idx - 1].receivedAt) + (parseFloat(turns[idx - 1].elapsed) || 0) * 1000;
      var idle = Number(t.receivedAt) - prevEnd;
      if (idle > WF_IDLE_THRESHOLD) {
        html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 8px;color:var(--yellow);font-size:10px"><span style="flex:1;border-top:1px dashed var(--yellow);opacity:0.3"></span>⏸ ' + wfFmtDur(idle) + '<span style="flex:1;border-top:1px dashed var(--yellow);opacity:0.3"></span></div>';
      }
    }
    var isSel = wfState.selectedTurnId === t.id;
    var tools = Object.entries(t.toolCalls || {});
    var mc = wfModelColor(t.model);
    var pct = wfCtxPct(t);
    var u = t.usage || {};
    var cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
    var cacheRate = (cr + cc) > 0 ? cr / (cr + cc) * 100 : 0;
    var pctLabelColor = cacheRate >= 50 ? 'var(--dim)' : 'var(--yellow)';
    var dur = (parseFloat(t.elapsed) || 0) * 1000;

    html += '<div class="wf-step-row' + (isSel ? ' wf-step-selected' : '') + '" data-tid="' + t.id + '" style="display:grid;grid-template-columns:28px minmax(0,1fr) 50px 50px;align-items:start;padding:3px 8px;cursor:pointer;font-size:11px;border-left:3px solid ' + (isSel ? 'var(--accent)' : 'transparent') + ';background:' + (isSel ? 'var(--surface-active)' : 'transparent') + '">';
    html += '<span style="color:var(--dim);font-size:10px">#' + (t.displayNum || idx + 1) + '</span>';
    html += '<span>';
    if (!tools.length) {
      html += '<span style="color:var(--dim)">🧠 thinking' + (dur > 5000 ? ' ' + wfFmtDur(dur) : '') + '</span>';
    } else {
      for (var ti = 0; ti < Math.min(tools.length, 4); ti++) {
        var bracket = tools.length > 1 ? (ti === 0 ? '┌' : ti === Math.min(tools.length, 4) - 1 ? '└' : '│') : '';
        html += '<span style="display:block"><span style="color:var(--border);margin-right:2px">' + bracket + '</span><span style="color:var(--green)">' + wfEsc(tools[ti][0]) + '</span>' + (tools[ti][1] > 1 ? '<span style="color:var(--dim)">×' + tools[ti][1] + '</span>' : '') + '</span>';
      }
      if (tools.length > 4) html += '<span style="color:var(--dim)">+' + (tools.length - 4) + ' more</span>';
    }
    html += '</span>';
    html += '<span style="text-align:right;color:' + pctLabelColor + '">' + pct.toFixed(1) + '%</span>';
    html += '<span style="text-align:right;color:var(--dim)">' + wfFmtDur(dur) + '</span>';
    html += '</div>';
  }

  el.innerHTML = html;

  // Click handler on step rows
  el.querySelectorAll('.wf-step-row').forEach(function(row) {
    row.onclick = function() {
      var tid = row.getAttribute('data-tid');
      wfLockTurn(tid);
      wfRenderSteps(tid);
    };
  });

  // Scroll to selected turn
  if (scrollToId) {
    var selRow = el.querySelector('.wf-step-row[data-tid="' + scrollToId + '"]');
    if (selRow) selRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Highlight turns visible in zoomed viewport
  _wfSyncStepsHighlight(el);
}

function _wfSyncStepsHighlight(container) {
  if (!wfState) return;
  var isZoomed = wfIsZoomed();
  container.querySelectorAll('.wf-step-row').forEach(function(row) {
    var tid = row.getAttribute('data-tid');
    var inView = false;
    if (isZoomed) {
      var hit = wfState.turnIndex && wfState.turnIndex.get(tid);
      if (hit) {
        var ts = Number(hit.turn.receivedAt);
        inView = ts >= wfState.viewT0 && ts <= wfState.viewT1;
      }
    }
    row.style.opacity = isZoomed && !inView ? '0.4' : '1';
  });
}

// ── Keyboard Handler (dispatched from keyboard-nav.js) ────────────────────
function wfKeyHandler(key, e) {
  if (!wfState || !wfState.selectedLane) return false;
  var lane = wfState.selectedLane;

  // j/k: next/prev turn within selected lane (arrows use normal turn-list nav)
  if (key === 'j' || key === 'k') {
    if (!lane.turns.length) return false;
    var curIdx = -1;
    if (wfState.selectedTurnId) {
      for (var i = 0; i < lane.turns.length; i++) {
        if (lane.turns[i].id === wfState.selectedTurnId) { curIdx = i; break; }
      }
    }
    var next = key === 'j' ? curIdx + 1 : curIdx - 1;
    next = Math.max(0, Math.min(lane.turns.length - 1, next));
    var turn = lane.turns[next];
    wfState.selectedTurnId = turn.id;
    for (var k2 = 0; k2 < allEntries.length; k2++) {
      if (allEntries[k2].id === turn.id) { selectTurn(k2); break; }
    }
    return true;
  }

  // Tab / Shift+Tab: cycle lanes (same stepping logic as the ▲/▼ overview buttons)
  if (key === 'Tab') {
    e.preventDefault();
    wfCycleLane(e.shiftKey ? -1 : 1);
    return true;
  }

  // Esc: unlock turn, then zoom reset, then back to main lane
  if (key === 'Escape') {
    if (wfState.selectedTurnId) {
      wfState.selectedTurnId = null;
      wfDeferRender();
      return true;
    }
    var isZoomed = wfIsZoomed();
    if (isZoomed) {
      wfState.viewT0 = wfState.tMin; wfState.viewT1 = wfState.tMax;
      wfDeferRender();
      return true;
    }
    if (lane.name !== 'main') {
      wfState.selectedLane = wfState.lanes[0];
      wfState.selectedTurnId = null;
      _wfRefreshLaneFocusUI();
      wfRenderAgentCard(wfState.lanes[0]);
      return true;
    }
    return false;
  }

  return false;
}

// ── Window Resize ─────────────────────────────────────────────────────────
var _wfResizeTimer = 0;
window.addEventListener('resize', function() {
  if (!wfState) return;
  clearTimeout(_wfResizeTimer);
  _wfCssCache = null;
  _wfResizeTimer = setTimeout(wfDeferRender, 200);
});
