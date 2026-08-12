// Session weather score — pure function, no imports.
// Reads dashboard entry objects directly (entry.usage.*, entry.maxContext, etc.).

var MODEL_BASELINES = {
  'claude-opus-4-6': 15200,
  'claude-opus-4-8': 34000,
  'claude-fable-5': 23800,
  'claude-sonnet-5': 12900,
  'claude-sonnet-4-6': 11900,
  'claude-haiku-4-5': 11100,
};
var BASELINE_FALLBACK = 20000;

var LEVELS = [
  { ceil: 0.35, level: 'sunny',  emoji: '☀️' },
  { ceil: 0.55, level: 'fair',   emoji: '🌤️' },
  { ceil: 0.75, level: 'cloudy', emoji: '⛅' },
  { ceil: 0.95, level: 'rainy',  emoji: '🌧️' },
  { ceil: Infinity, level: 'stormy', emoji: '⛈️' },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  var k = (sorted.length - 1) * p;
  var lo = Math.floor(k), hi = Math.ceil(k);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function _wDurMs(entry) {
  var e = entry.elapsed;
  if (e == null || e === '?' || e === '') return null;
  var ms = (typeof e === 'number' ? e : parseFloat(e)) * 1000;
  return isFinite(ms) ? ms : null;
}

// ponytail: ctxFloor=0.4 — below 40% no signal, ramps to 1.0 at 100%. Lost in the Middle (Liu 2023): quality degrades well before max context.
var CTX_FLOOR = 0.4;

// #377: derive the window from the turns we were given — mirrors _wfLaneWindow
// (workflow-timeline.js:196) and sessionCtxWindow (miller-columns.js:13) so the
// weather denominator matches what the rest of the dashboard shows.
function _foldWindow(turns) {
  var win = 0, has1m = false;
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].beta1m === true) has1m = true;
    if ((turns[i].maxContext || 0) > win) win = turns[i].maxContext;
  }
  return has1m ? 1000000 : win;
}

function sigCtxPressure(turns, opts) {
  if (!turns.length) return { severity: 0, detail: {} };
  var last = turns[turns.length - 1];
  var u = last.usage || {};
  var mx = (opts && opts.sessionWindow) || _foldWindow(turns);
  if (!mx || mx < 1000) return { severity: 0, detail: { ctxPct: 0, turnIndex: turns.length - 1, entryId: last && last.id || null } };
  // #387: match computeCtxUsed semantics (format.js:15-21) — four-term sum
  var used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  var pct = used / mx;
  var sev = clamp01((pct - CTX_FLOOR) / (1 - CTX_FLOOR));
  return { severity: sev, detail: { ctxPct: Math.round(pct * 1000) / 10, turnIndex: turns.length - 1, entryId: last && last.id || null } };
}

function sigCompaction(turns) {
  var count = 0;
  for (var i = 0; i < turns.length; i++) { if (turns[i].isCompacted) count++; }
  var sev = count === 0 ? 0 : count === 1 ? 0.4 : 0.6;
  return { severity: sev, detail: { compactionCount: count } };
}

function sigTruncation(turns) {
  for (var i = 0; i < turns.length; i++) {
    var u = turns[i].usage || {};
    if (turns[i].stopReason === 'max_tokens' && (u.output_tokens || 0) >= 16000) {
      return { severity: 0.5, detail: { turnIndex: i, entryId: turns[i] && turns[i].id || null } };
    }
  }
  return { severity: 0, detail: {} };
}

function _openAIToolEvidence(turns) {
  var pending = Object.create(null);
  var results = [];
  for (var i = 0; i < turns.length; i++) {
    var returned = Array.isArray(turns[i].turnToolResults) ? turns[i].turnToolResults : [];
    for (var r = 0; r < returned.length; r++) {
      var result = returned[r];
      var call = result && pending[result.callId];
      if (!call || result.eligible !== true || call.tool !== 'Bash') continue;
      results.push({
        callId: result.callId,
        toolFail: result.toolFail,
        turnIndex: call.turnIndex,
        entryId: call.entryId,
      });
      delete pending[result.callId];
    }
    var calls = turns[i].turnToolCallIds;
    if (!calls || typeof calls !== 'object' || Array.isArray(calls)) continue;
    for (var callId in calls) {
      pending[callId] = { tool: calls[callId], turnIndex: i, entryId: turns[i].id || null };
    }
  }
  return results;
}

// #509: did this session issue a Bash call on a turn that was CAPABLE of recording
// the result? `turnToolCallIds` is the #486/#475 paired-pipeline marker: its presence
// means the response-side writer ran and listed the turn's calls, so a Bash call in
// it with no matching result is a genuine measurement gap rather than an old log.
//
// Two scoping decisions, both load-bearing:
//  - Bash only, because _openAIToolEvidence pairs Bash and nothing else. A session
//    whose only tools were Read/Grep can never produce evidence, so escalating it
//    would make ❔ the default state and devalue the marker (ADR 0017's habituation
//    argument, applied per display).
//  - `turnToolCallIds` only — NOT the cumulative `toolCalls`, and not `turnToolCalls`
//    (#427, which predates the results pipeline). A legacy turn carries no capability
//    signal and must contribute nothing, exactly as ADR 0017 has legacy entries
//    contribute nothing to the aggregate confidence fold. Marking every pre-#486
//    Bash session ❔ would be the retired corpus-age gate wearing a per-session mask.
function _issuedCapableBashCall(turns) {
  for (var i = 0; i < turns.length; i++) {
    var ids = turns[i].turnToolCallIds;
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) continue;
    for (var callId in ids) {
      if (ids[callId] === 'Bash') return true;
    }
  }
  return false;
}

// Did this session issue a Bash call by ANY available signal? Reporting/denominator
// helper — the escalation above deliberately uses the narrower capability test.
// INVARIANT(ADR 0018): a per-turn map that is present but EMPTY (`{}`) means the
// response was parsed and made zero calls, so it must suppress the cumulative
// fallback; only a fully absent per-turn map falls back to request-derived
// `toolCalls`. The per-tool max-vs-sum distinction ADR 0018 draws for counts is moot
// here — this is a presence test. See docs/decisions/0018-turn-tool-calls-null-vs-empty.md
function sessionIssuedBashCall(turns) {
  if (!turns || !turns.length) return false;
  var isMap = function(v) { return v && typeof v === 'object' && !Array.isArray(v); };
  for (var i = 0; i < turns.length; i++) {
    var t = turns[i], perTurnPresent = false;
    if (isMap(t.turnToolCallIds)) {
      perTurnPresent = true;
      for (var callId in t.turnToolCallIds) if (t.turnToolCallIds[callId] === 'Bash') return true;
    }
    if (isMap(t.turnToolCalls)) {
      perTurnPresent = true;
      if (t.turnToolCalls.Bash) return true;
    }
    if (perTurnPresent) continue; // parsed response, zero calls — no fallback
    if (isMap(t.toolCalls) && t.toolCalls.Bash) return true;
  }
  return false;
}

function sigToolFailure(toolEvidence, issuedCapableBash) {
  var known = 0, firstFailure = null;
  for (var i = 0; i < toolEvidence.length; i++) {
    if (toolEvidence[i].toolFail === true || toolEvidence[i].toolFail === false) known++;
    if (toolEvidence[i].toolFail === true && firstFailure === null) firstFailure = toolEvidence[i];
  }
  if (firstFailure !== null) {
    return { severity: null, availability: 'failure', detail: { turnIndex: firstFailure.turnIndex, entryId: firstFailure.entryId, known: known, eligible: toolEvidence.length } };
  }
  if (toolEvidence.length > known) {
    return { severity: null, availability: 'unavailable', detail: { known: known, eligible: toolEvidence.length } };
  }
  if (toolEvidence.length > 0) {
    return { severity: 0, availability: 'clear', detail: { known: known, eligible: toolEvidence.length } };
  }
  // #509: no evidence at all. Distinguish "nothing to measure" (sunny is honest)
  // from "a Bash call ran and its outcome was never recorded" (must not read as
  // healthy). Kept as its own availability value rather than folded into
  // 'unavailable' so the two diagnoses stay separable — 'unavailable' means results
  // arrived and could not be decoded (the Codex decoder gap, #506), 'unmeasured'
  // means no result arrived at all.
  return { severity: 0, availability: issuedCapableBash ? 'unmeasured' : 'no_data', detail: { known: known, eligible: toolEvidence.length } };
}

function sigStuck(turns, toolEvidence) {
  var pairedStreak = 0, pairedMax = 0, pairedStart = 0, pairedEnd = 0;
  var pairedEvidenceCount = 0;
  var pairedStartId = null, pairedEndId = null, currentStart = 0, currentStartId = null;
  for (var p = 0; p < toolEvidence.length; p++) {
    if (toolEvidence[p].toolFail === true) {
      pairedEvidenceCount++;
      if (pairedStreak === 0) {
        currentStart = toolEvidence[p].turnIndex;
        currentStartId = toolEvidence[p].entryId;
      }
      pairedStreak++;
      if (pairedStreak > pairedMax) {
        pairedMax = pairedStreak;
        pairedStart = currentStart;
        pairedEnd = toolEvidence[p].turnIndex;
        pairedStartId = currentStartId;
        pairedEndId = toolEvidence[p].entryId;
      }
    } else if (toolEvidence[p].toolFail === false) {
      pairedEvidenceCount++;
      pairedStreak = 0;
    }
  }
  // RETIRED(#516): severity permanently 0. Six independent sources (CUSUM simulation,
  // ISA-18.2 rationalization, Hawkes analysis, circuit-breaker scoping review, Fable,
  // Codex) confirmed: (a) max observed streak in entire corpus = 3 vs threshold 10,
  // (b) any Bash success resets the counter so the canonical stuck loop (npm test fails
  // → read → edit → npm test fails) never exceeds streak 1 — the bug is scoping not
  // threshold, (c) failure rate has no predictive relationship with any proxy outcome.
  // Detail computed but has no live consumer (severity 0 → never enters factors →
  // _FACTOR_FMT.stuck deleted). Kept only so the function signature stays stable for
  // callers that destructure the result; the detail object is write-only.
  return { severity: 0, detail: { maxStreak: pairedMax, turnStart: pairedStart, turnEnd: pairedEnd, entryIdStart: pairedStartId, entryIdEnd: pairedEndId } };
}

function sigLatencyDrift(turns) {
  var recent = [];
  for (var i = turns.length - 1; i >= 0 && recent.length < 10; i--) {
    var ms = _wDurMs(turns[i]);
    if (ms != null) recent.push({ ms: ms, model: turns[i].model });
  }
  if (recent.length < 5) return { severity: 0, detail: {} };
  var model = recent[0].model || '';
  var baseline = MODEL_BASELINES[model] || BASELINE_FALLBACK;
  var vals = recent.map(function(r) { return r.ms; }).sort(function(a, b) { return a - b; });
  var p75 = percentile(vals, 0.75);
  var ratio = p75 / baseline;
  // ponytail: K=0.5 — 2x baseline reaches severity 0.5, 3x reaches 1.0. Gentler than K=2 which saturated on normal sessions.
  return { severity: clamp01((ratio - 1) * 0.5), detail: { p75: Math.round(p75), baseline: baseline, ratio: Math.round(ratio * 100) / 100 } };
}

function sigErrorCluster(turns, toolEvidence) {
  var pairedMaxRate = 0, pairedBestStart = 0, pairedBestEnd = 0;
  var pairedStartId = null, pairedEndId = null, pairedEvidenceCount = 0;
  for (var e = 0; e < toolEvidence.length; e++) {
    if (toolEvidence[e].toolFail === true || toolEvidence[e].toolFail === false) pairedEvidenceCount++;
  }
  for (var p = 0; p <= toolEvidence.length - 5; p++) {
    var pairedKnown = 0, pairedErrors = 0;
    for (var q = p; q < p + 5; q++) {
      if (toolEvidence[q].toolFail === true) { pairedKnown++; pairedErrors++; }
      else if (toolEvidence[q].toolFail === false) pairedKnown++;
    }
    if (pairedKnown < 3) continue;
    var pairedRate = pairedErrors / pairedKnown;
    if (pairedRate > pairedMaxRate) {
      pairedMaxRate = pairedRate;
      pairedBestStart = toolEvidence[p].turnIndex;
      pairedBestEnd = toolEvidence[p + 4].turnIndex;
      pairedStartId = toolEvidence[p].entryId;
      pairedEndId = toolEvidence[p + 4].entryId;
    }
  }
  // RETIRED(#516): severity permanently 0. CUSUM simulation proved the max-over-
  // overlapping-windows null drifts with session length — under pure 6% noise a
  // 1,000-turn healthy session's expected 5-window max rate is 53.8%, P(≥0.4) = 100%.
  // This signal measured session length, not failure. Detail computed but has no
  // live consumer (_FACTOR_FMT.error_cluster deleted); write-only.
  return { severity: 0, detail: { windowStart: pairedBestStart, windowEnd: pairedBestEnd, errorRate: Math.round(pairedMaxRate * 100) / 100, entryIdStart: pairedStartId, entryIdEnd: pairedEndId } };
}

// ponytail: sustained low cache hit rate — cost/perf signal, not functionality. Skips first 3 turns (cold start). Expert consensus: 50% threshold (break-even), 0.5 cap.
function sigCacheHealth(turns) {
  var rates = [];
  for (var i = Math.max(3, turns.length - 10); i < turns.length; i++) {
    if (turns[i].provider && turns[i].provider !== 'anthropic') continue;
    var u = turns[i].usage || {};
    var inT = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (inT < 1000) continue;
    rates.push((u.cache_read_input_tokens || 0) / inT);
  }
  if (rates.length < 3) return { severity: 0, detail: {} };
  rates.sort(function(a, b) { return a - b; });
  var median = percentile(rates, 0.5);
  // ponytail: 50%→0, 0%→0.5. Aligns with workflow-timeline cache-miss event (<50%) and Anthropic break-even economics (1.4 reads/write).
  var sev = median >= 0.5 ? 0 : clamp01((0.5 - median) * 1.0);
  return { severity: sev, detail: { medianHitRate: Math.round(median * 100), recentTurns: rates.length } };
}

// ponytail: catches chronic tool errors spread across long sessions that error_cluster misses (exp9: ~30 false negatives).
function sigErrorCumulative(turns, toolEvidence) {
  var pairedKnown = 0, pairedErrors = 0, pairedFirstErrId = null;
  for (var p = 0; p < toolEvidence.length; p++) {
    if (toolEvidence[p].toolFail === true) {
      pairedKnown++;
      pairedErrors++;
      if (!pairedFirstErrId) pairedFirstErrId = toolEvidence[p].entryId || null;
    } else if (toolEvidence[p].toolFail === false) {
      pairedKnown++;
    }
  }
  var pairedRate = pairedKnown ? pairedErrors / pairedKnown : 0;
  // RETIRED(#516): severity permanently 0. Falsified empirically: failure rate has
  // no positive predictive relationship with truncation, compaction, or cost outliers
  // (the only relationship is negative and explained by session length). Present in
  // 94% of measurable sessions, failing ISA-18.2's "Abnormal" criterion — a condition
  // in the majority IS the normal operating state. Detail preserved: errTurns/toolTurns
  // feed stats.errRate and the tooltip's tool-error line.
  return { severity: 0, detail: { errTurns: pairedErrors, toolTurns: pairedKnown, rate: Math.round(pairedRate * 100) / 100, firstErrId: pairedFirstErrId } };
}

function assessWeather(turns, opts) {
  if (!turns || !turns.length) {
    return { level: 'sunny', emoji: LEVELS[0].emoji, score: 0, factors: [], stats: { ctxPct: 0, errRate: 0, errTurns: 0, toolTurns: 0, latencyRatio: null, compactions: 0, toolKnownRate: null, toolSignal: 'no_data' }, tooltip: 'Operating normally' };
  }

  var openAIToolEvidence = _openAIToolEvidence(turns);
  var signals = [
    { type: 'ctx_pressure', result: sigCtxPressure(turns, opts) },
    { type: 'compaction_scar', result: sigCompaction(turns) },
    { type: 'truncation', result: sigTruncation(turns) },
    { type: 'tool_failure', result: sigToolFailure(openAIToolEvidence, _issuedCapableBashCall(turns)) },
    { type: 'stuck', result: sigStuck(turns, openAIToolEvidence) },
    { type: 'latency_drift', result: sigLatencyDrift(turns) },
    { type: 'error_cluster', result: sigErrorCluster(turns, openAIToolEvidence) },
    { type: 'error_cumulative', result: sigErrorCumulative(turns, openAIToolEvidence) },
    { type: 'cache_health', result: sigCacheHealth(turns) },
  ];

  // Availability is metadata, never a severity input.
  var sevs = signals.map(function(s) { return s.result.severity; }).filter(function(s) { return typeof s === 'number'; }).sort(function(a, b) { return b - a; });
  var score = sevs[0] + 0.3 * (sevs[1] || 0);

  var pick = LEVELS[LEVELS.length - 1];
  for (var i = 0; i < LEVELS.length; i++) {
    if (score < LEVELS[i].ceil) { pick = LEVELS[i]; break; }
  }
  // #509: both no-measurement states escalate a sunny pick to ❔ — 'unavailable'
  // (results arrived, none decodable) and 'unmeasured' (a capable Bash call ran and
  // no result was ever recorded). A session that made no Bash call keeps 'no_data'
  // and stays sunny, which is the correct reading of "nothing to measure".
  if (pick.level === 'sunny' && signals.some(function(s) {
    return s.result.availability === 'unavailable' || s.result.availability === 'unmeasured';
  })) {
    pick = { level: 'unavailable', emoji: '❔' };
  }

  var factors = [];
  for (var k = 0; k < signals.length; k++) {
    if (signals[k].result.severity > 0) {
      factors.push({ type: signals[k].type, severity: signals[k].result.severity, detail: signals[k].result.detail });
    }
  }
  factors.sort(function(a, b) { return b.severity - a.severity; });

  // Key stats for all levels (including sunny — proves WHY it's healthy)
  var _sigMap = {};
  for (var si = 0; si < signals.length; si++) _sigMap[signals[si].type] = signals[si].result;
  var stats = {
    ctxPct: _sigMap.ctx_pressure.detail.ctxPct || 0,
    errRate: _sigMap.error_cumulative.detail.rate || 0,
    errTurns: _sigMap.error_cumulative.detail.errTurns || 0,
    toolTurns: _sigMap.error_cumulative.detail.toolTurns || 0,
    latencyRatio: _sigMap.latency_drift.detail.ratio || null,
    compactions: _sigMap.compaction_scar.detail.compactionCount || 0,
    cacheHitRate: _sigMap.cache_health.detail.medianHitRate != null ? _sigMap.cache_health.detail.medianHitRate : null,
    toolKnownRate: _sigMap.tool_failure.detail.eligible > 0
      ? Math.round(_sigMap.tool_failure.detail.known / _sigMap.tool_failure.detail.eligible * 100)
      : null,
    toolSignal: _sigMap.tool_failure.availability,
  };

  var tooltip = _buildTooltip(pick.level, factors, stats, _sigMap.tool_failure.detail.known, _sigMap.tool_failure.detail.eligible);
  return { level: pick.level, emoji: pick.emoji, score: Math.round(score * 1000) / 1000, factors: factors, stats: stats, tooltip: tooltip };
}

function _turnLink(label, entryId) {
  if (!entryId || typeof document === 'undefined') return label;
  return '<span class="wo-turn-link" onclick="event.stopPropagation();if(typeof wfZoomToTurnRange===\'function\')wfZoomToTurnRange(\'' + entryId + '\')">' + label + '</span>';
}

function _rangeLink(start, end, startId, endId) {
  var label = 'turn ' + start + '-' + end;
  if ((!startId && !endId) || typeof document === 'undefined') return label;
  var sid = startId || endId, eid = endId || startId;
  return '<span class="wo-turn-link" onclick="event.stopPropagation();if(typeof wfZoomToTurnRange===\'function\')wfZoomToTurnRange(\'' + sid + '\',\'' + eid + '\')">' + label + '</span>';
}

var _FACTOR_FMT = {
  ctx_pressure: function(d) { return 'context ' + (d.ctxPct || 0) + '%'; },
  compaction_scar: function(d) { return 'compaction ×' + (d.compactionCount || 1) + ' (info lost)'; },
  truncation: function(d) { return 'output truncated (' + _turnLink('turn ' + (d.turnIndex || '?'), d.entryId) + ')'; },
  tool_failure: function(d) { return 'tool failed (' + _turnLink('turn ' + (d.turnIndex || 0), d.entryId) + ')'; },
  // RETIRED(#516): stuck, error_cluster, error_cumulative removed — severity permanently 0,
  // these formatters were unreachable (factors only admits severity > 0).
  latency_drift: function(d) { return 'latency ' + (d.ratio || '?') + 'x baseline'; },
  cache_health: function(d) { return 'cache hit ' + (d.medianHitRate || 0) + '% (last ' + (d.recentTurns || '?') + ' turns)'; },
};

var _LEVEL_SUMMARY = {
  unavailable: 'Tool failure signal unavailable',
  sunny: 'Operating normally',
  fair: 'Minor signals, no action needed',
  cloudy: 'Quality starting to degrade',
  rainy: 'Significantly degraded, take action',
  stormy: 'Critically degraded, act now',
};

// RETIRED(#516): _ACTION_TABLE deleted — its only three keys (stuck, error_cluster,
// error_cumulative) all have severity 0, so they never enter factors and the action
// lookup at _buildTooltip:458 never matches. The table was the last remaining
// prescriptive element ("take action", "act now") whose retirement was recommended
// by both adversarial review rounds.
var _ACTION_TABLE = {};

function _buildTooltip(level, factors, stats, toolKnownCount, toolEligibleCount) {
  var lines = [_LEVEL_SUMMARY[level] || ''];
  if (level === 'unavailable') {
    // #509: the ❔ level now covers two distinct gaps — say which one, otherwise the
    // decode message would claim results arrived when none did.
    if (stats && stats.toolSignal === 'unmeasured') lines.push('a Bash call ran but no tool result was recorded');
    else lines.push(toolKnownCount > 0
      ? toolKnownCount + ' of ' + toolEligibleCount + ' eligible tool results could be decoded'
      : 'no eligible tool result could be decoded');
    return lines.join('\n');
  }
  if (level === 'sunny' || level === 'fair') {
    // Show key stats to prove WHY it's healthy
    if (stats) {
      var parts = [];
      parts.push('context ' + (stats.ctxPct || 0) + '%');
      parts.push(stats.toolTurns >= 5 ? (stats.errTurns ? stats.errTurns + ' errors' : '0 errors') : '—');
      if (stats.cacheHitRate != null) parts.push('cache ' + stats.cacheHitRate + '%');
      if (stats.latencyRatio != null) parts.push('latency ' + stats.latencyRatio + 'x');
      if (stats.compactions) parts.push('compacted ×' + stats.compactions);
      if (stats.toolSignal === 'unavailable') parts.push('tool failure signal unavailable');
      else if (stats.toolSignal === 'unmeasured') parts.push('tool result never recorded');
      if (stats.toolKnownRate != null && stats.toolKnownRate < 100) parts.push('tool results ' + stats.toolKnownRate + '% known');
      lines.push(parts.join(' · '));
    }
    return lines.join('\n');
  }
  if (factors.length) {
    var factorLine = factors.map(function(f) {
      var fmt = _FACTOR_FMT[f.type];
      return fmt ? fmt(f.detail) : f.type;
    }).join(' · ');
    if (stats && stats.toolSignal === 'unavailable') factorLine += ' · tool failure signal unavailable';
    else if (stats && stats.toolSignal === 'unmeasured') factorLine += ' · tool result never recorded';
    if (stats && stats.toolKnownRate != null && stats.toolKnownRate < 100) factorLine += ' · tool results ' + stats.toolKnownRate + '% known';
    lines.push(factorLine);
  }
  else if (stats && stats.toolSignal === 'unavailable') lines.push('tool failure signal unavailable');
  else if (stats && stats.toolSignal === 'unmeasured') lines.push('tool result never recorded');
  if (level === 'cloudy' || level === 'rainy' || level === 'stormy') {
    var top = factors[0];
    if (top) {
      // An entry may decline to produce a line (returns null) when it has no
      // evidence to point at — guard the RESULT, not just the entry's presence.
      var act = _ACTION_TABLE[top.type];
      var actLine = act ? act(top.detail) : null;
      if (actLine) lines.push('→ ' + actLine);
    }
  }
  return lines.join('\n');
}

// ── Weather overlay (browser only) ──
// Stays open while cursor is on the trigger OR on the overlay itself.
var _weatherOverlay = null;
var _weatherOverlaySavedTitle = null;
var _weatherOverlayTitleEl = null;
var _weatherHideTimer = null;

function showWeatherOverlay(e, weather) {
  if (typeof document === 'undefined' || !weather) return;
  if (_weatherHideTimer) { clearTimeout(_weatherHideTimer); _weatherHideTimer = null; }
  if (typeof _wfTooltipEl !== 'undefined' && _wfTooltipEl) _wfTooltipEl.style.display = 'none';
  var card = e.target.closest ? e.target.closest('[title]') : null;
  if (card) { _weatherOverlaySavedTitle = card.title; _weatherOverlayTitleEl = card; card.title = ''; }
  if (!_weatherOverlay) {
    _weatherOverlay = document.createElement('div');
    _weatherOverlay.className = 'weather-overlay';
    _weatherOverlay.onmouseenter = function() { if (_weatherHideTimer) { clearTimeout(_weatherHideTimer); _weatherHideTimer = null; } };
    _weatherOverlay.onmouseleave = function() { _dismissWeatherOverlay(); };
    document.body.appendChild(_weatherOverlay);
  }
  var lines = (weather.tooltip || weather.level).split('\n');
  var html = '<div class="wo-header">' + weather.emoji + ' ' + weather.level + '</div>';
  if (lines.length > 1) html += '<div class="wo-factors">' + lines[1].replace(/ · /g, '<br>') + '</div>';
  if (lines.length > 2) html += '<div class="wo-action">' + lines[2] + '</div>';
  _weatherOverlay.innerHTML = html;
  _weatherOverlay.style.display = 'block';
  _weatherOverlay.style.pointerEvents = 'auto';
  var ox = e.clientX + 12, oy = e.clientY + 12;
  if (ox + _weatherOverlay.offsetWidth > window.innerWidth) ox = e.clientX - _weatherOverlay.offsetWidth - 12;
  if (oy + _weatherOverlay.offsetHeight > window.innerHeight) oy = e.clientY - _weatherOverlay.offsetHeight - 12;
  _weatherOverlay.style.left = ox + 'px';
  _weatherOverlay.style.top = oy + 'px';
}

function hideWeatherOverlay() {
  // Delay hide — if cursor moves to the overlay within 150ms, cancel the hide.
  if (_weatherHideTimer) clearTimeout(_weatherHideTimer);
  _weatherHideTimer = setTimeout(_dismissWeatherOverlay, 150);
}

function _dismissWeatherOverlay() {
  if (_weatherHideTimer) { clearTimeout(_weatherHideTimer); _weatherHideTimer = null; }
  if (_weatherOverlay) _weatherOverlay.style.display = 'none';
  if (_weatherOverlayTitleEl && _weatherOverlaySavedTitle != null) { _weatherOverlayTitleEl.title = _weatherOverlaySavedTitle; _weatherOverlayTitleEl = null; _weatherOverlaySavedTitle = null; }
}

// #484: weather display toggle — default OFF until tool-failure signals are trustworthy.
// Computation and persistence keep running; only these render gates are affected.
// localStorage tri-state: 'on' | 'off' | null (null = program default = OFF).
// URL param ?weather=1 (also on/off) overrides for one-shot inspection.
var _WEATHER_STORAGE_KEY = 'ccxray-weather-display';
var _weatherDisplayDefault = false;

// Latch URL override at load time so syncUrlFromState (miller-columns.js:2183)
// cannot silently wash it away on the first navigation.
var _weatherUrlOverride = (function() {
  try {
    if (typeof URLSearchParams === 'undefined' || typeof location === 'undefined') return null;
    var v = new URLSearchParams(location.search).get('weather');
    if (v === '1' || v === 'on') return true;
    if (v === '0' || v === 'off') return false;
  } catch (_) {}
  return null;
})();

function weatherDisplayEnabled() {
  if (_weatherUrlOverride !== null) return _weatherUrlOverride;
  if (typeof localStorage === 'undefined') return _weatherDisplayDefault;
  try {
    var stored = localStorage.getItem(_WEATHER_STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch (_) {}
  return _weatherDisplayDefault;
}

if (typeof module !== 'undefined') module.exports = { assessWeather, weatherDisplayEnabled, sessionIssuedBashCall };
