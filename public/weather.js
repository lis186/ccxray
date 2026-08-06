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

function sigStuck(turns) {
  var streak = 0, maxStreak = 0, maxStreakEnd = 0;
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].stopReason === 'tool_use' && turns[i].toolFail) {
      streak++;
      if (streak > maxStreak) { maxStreak = streak; maxStreakEnd = i; }
    } else {
      streak = 0;
    }
  }
  var startIdx = maxStreak > 0 ? maxStreakEnd - maxStreak + 1 : 0;
  return { severity: maxStreak >= 10 ? 0.9 : 0, detail: { maxStreak: maxStreak, turnStart: startIdx, turnEnd: maxStreakEnd, entryIdStart: turns[startIdx] && turns[startIdx].id || null, entryIdEnd: turns[maxStreakEnd] && turns[maxStreakEnd].id || null } };
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

function sigErrorCluster(turns) {
  var maxRate = 0, bestStart = 0, bestEnd = 0;
  for (var i = 0; i <= turns.length - 5; i++) {
    var toolUse = 0, errors = 0;
    for (var j = i; j < i + 5; j++) {
      if (turns[j].stopReason === 'tool_use') {
        toolUse++;
        if (turns[j].toolFail) errors++;
      }
    }
    if (toolUse < 3) continue;
    var rate = errors / toolUse;
    if (rate > maxRate) { maxRate = rate; bestStart = i; bestEnd = i + 4; }
  }
  // ponytail: denom=2.0 — window needs 100% error rate to reach severity 0.5. Exp2: 0.6 flagged 247/346 sessions.
  var sev = clamp01(maxRate / 2.0);
  return { severity: sev, detail: { windowStart: bestStart, windowEnd: bestEnd, errorRate: Math.round(maxRate * 100) / 100, entryIdStart: turns[bestStart] && turns[bestStart].id || null, entryIdEnd: turns[bestEnd] && turns[bestEnd].id || null } };
}

// ponytail: sustained low cache hit rate — cost/perf signal, not functionality. Skips first 3 turns (cold start). Expert consensus: 50% threshold (break-even), 0.5 cap.
function sigCacheHealth(turns) {
  var rates = [];
  for (var i = Math.max(3, turns.length - 10); i < turns.length; i++) {
    var u = turns[i].usage || {};
    if (u.cache_read_input_tokens == null && u.cache_creation_input_tokens == null) continue;
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
function sigErrorCumulative(turns) {
  var toolTurns = 0, errTurns = 0, firstErrId = null;
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].stopReason === 'tool_use') {
      toolTurns++;
      if (turns[i].toolFail) { errTurns++; if (!firstErrId) firstErrId = turns[i].id || null; }
    }
  }
  if (toolTurns < 10) return { severity: 0, detail: {} };
  var rate = errTurns / toolTurns;
  // ponytail: 20% cumulative error rate = severity 0.5, 40% = 1.0. Requires ≥10 tool turns to avoid noise.
  var sev = clamp01(rate / 0.4);
  return { severity: sev, detail: { errTurns: errTurns, toolTurns: toolTurns, rate: Math.round(rate * 100) / 100, firstErrId: firstErrId } };
}

function assessWeather(turns, opts) {
  if (!turns || !turns.length) {
    return { level: 'sunny', emoji: LEVELS[0].emoji, score: 0, factors: [], stats: { ctxPct: 0, errRate: 0, errTurns: 0, latencyRatio: null, compactions: 0 }, tooltip: 'Operating normally' };
  }

  var signals = [
    { type: 'ctx_pressure', result: sigCtxPressure(turns, opts) },
    { type: 'compaction_scar', result: sigCompaction(turns) },
    { type: 'truncation', result: sigTruncation(turns) },
    { type: 'stuck', result: sigStuck(turns) },
    { type: 'latency_drift', result: sigLatencyDrift(turns) },
    { type: 'error_cluster', result: sigErrorCluster(turns) },
    { type: 'error_cumulative', result: sigErrorCumulative(turns) },
    { type: 'cache_health', result: sigCacheHealth(turns) },
  ];

  var sevs = signals.map(function(s) { return s.result.severity; }).sort(function(a, b) { return b - a; });
  var score = sevs[0] + 0.3 * (sevs[1] || 0);

  var pick = LEVELS[LEVELS.length - 1];
  for (var i = 0; i < LEVELS.length; i++) {
    if (score < LEVELS[i].ceil) { pick = LEVELS[i]; break; }
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
    latencyRatio: _sigMap.latency_drift.detail.ratio || null,
    compactions: _sigMap.compaction_scar.detail.compactionCount || 0,
    cacheHitRate: _sigMap.cache_health.detail.medianHitRate != null ? _sigMap.cache_health.detail.medianHitRate : null,
  };

  var tooltip = _buildTooltip(pick.level, factors, stats);
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
  stuck: function(d) { return 'stuck ' + (d.maxStreak || 0) + ' failures (' + _rangeLink(d.turnStart || 0, d.turnEnd || 0, d.entryIdStart, d.entryIdEnd) + ')'; },
  latency_drift: function(d) { return 'latency ' + (d.ratio || '?') + 'x baseline'; },
  error_cluster: function(d) { return 'error burst ' + Math.round((d.errorRate || 0) * 100) + '% (' + _rangeLink(d.windowStart || 0, d.windowEnd || 0, d.entryIdStart, d.entryIdEnd) + ')'; },
  error_cumulative: function(d) { var label = d.errTurns + '/' + d.toolTurns + ' tool errors (' + Math.round((d.rate || 0) * 100) + '%)'; return d.firstErrId ? _turnLink(label, d.firstErrId) : label; },
  cache_health: function(d) { return 'cache hit ' + (d.medianHitRate || 0) + '% (last ' + (d.recentTurns || '?') + ' turns)'; },
};

var _LEVEL_SUMMARY = {
  sunny: 'Operating normally',
  fair: 'Minor signals, no action needed',
  cloudy: 'Quality starting to degrade',
  rainy: 'Significantly degraded, take action',
  stormy: 'Critically degraded, act now',
};

var _ACTION_TABLE = {
  stuck: function(d) { return 'Check ' + _rangeLink(d.turnStart || 0, d.turnEnd || 0, d.entryIdStart, d.entryIdEnd) + ' — usually permissions or paths'; },
  error_cluster: function(d) { return 'Check ' + _rangeLink(d.windowStart || 0, d.windowEnd || 0, d.entryIdStart, d.entryIdEnd); },
  // Returns null when there is no turn to link to: an unlinked "Check tool
  // errors" line is the same non-falsifiable advice this table was pruned of
  // (#336) — it says to look without saying where. Only reachable when a turn
  // carries no `id`; stored entries always do, so this is a contract guard
  // rather than a live path.
  error_cumulative: function(d) { return d.firstErrId ? 'Check ' + _turnLink('first error', d.firstErrId) + ' — common: permissions, paths, settings' : null; },
};

function _buildTooltip(level, factors, stats) {
  var lines = [_LEVEL_SUMMARY[level] || ''];
  if (level === 'sunny' || level === 'fair') {
    // Show key stats to prove WHY it's healthy
    if (stats) {
      var parts = [];
      parts.push('context ' + (stats.ctxPct || 0) + '%');
      parts.push(stats.errTurns ? stats.errTurns + ' errors' : '0 errors');
      if (stats.cacheHitRate != null) parts.push('cache ' + stats.cacheHitRate + '%');
      if (stats.latencyRatio != null) parts.push('latency ' + stats.latencyRatio + 'x');
      if (stats.compactions) parts.push('compacted ×' + stats.compactions);
      lines.push(parts.join(' · '));
    }
    return lines.join('\n');
  }
  if (factors.length) {
    lines.push(factors.map(function(f) {
      var fmt = _FACTOR_FMT[f.type];
      return fmt ? fmt(f.detail) : f.type;
    }).join(' · '));
  }
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

if (typeof module !== 'undefined') module.exports = { assessWeather };
