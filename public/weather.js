// Session weather score — single-scalar health indicator
// Design: docs/solutions/session-weather.md

function assessWeather(turns) {
  if (!turns || !turns.length) return { weather: '☀️', level: 'clear', factors: [] };

  let level = 0;
  const factors = [];

  // 1. context zone (base) — last turn's ctxPct
  const last = turns[turns.length - 1];
  const u = last.usage || {};
  const ctxUsed = (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0) + (u.output_tokens || 0);
  const ctxPct = Math.min(100, ctxUsed / (last.maxContext || 200000) * 100);
  if (ctxPct > 80)       { level = Math.max(level, 2); factors.push('ctx_danger'); }
  else if (ctxPct >= 40)  { level = Math.max(level, 1); factors.push('ctx_warn'); }

  // 2. compaction scar (permanent, cumulative)
  const compactions = turns.filter(t => t.isCompacted).length;
  if (compactions >= 2)      { level = Math.max(level, 3); factors.push('compaction_multi'); }
  else if (compactions >= 1) { level = Math.max(level, 2); factors.push('compaction'); }

  // 3. truncation: stopReason=max_tokens AND output_tokens>=16000
  const truncations = turns.filter(
    t => t.stopReason === 'max_tokens' && (t.usage?.output_tokens ?? 0) >= 16000
  ).length;
  if (truncations > 0) { level = Math.min(level + 1, 4); factors.push('truncation'); }

  // 4. stuck detector: >=10 consecutive tool_use with >25% error rate
  let streak = 0, errors = 0, maxStuck = 0;
  for (const t of turns) {
    if (t.stopReason === 'tool_use') {
      streak++;
      if (t.toolFail) errors++;
      if (streak >= 10 && errors / streak > 0.25) maxStuck = Math.max(maxStuck, streak);
    } else { streak = 0; errors = 0; }
  }
  if (maxStuck >= 10) { level = Math.max(level, 3); factors.push('stuck'); }

  // 5. elevated tool error rate (non-stuck, threshold 15%)
  const toolTurns = turns.filter(t => t.stopReason === 'tool_use');
  if (toolTurns.length >= 5) {
    const rate = toolTurns.filter(t => t.toolFail).length / toolTurns.length;
    if (rate > 0.15 && maxStuck < 10) {
      level = Math.min(level + 1, 4);
      factors.push('tool_error_elevated');
    }
  }

  const ICONS = ['☀️', '🌤️', '⛅', '🌧️', '⛈️'];
  const KEYS  = ['clear', 'fair', 'cloudy', 'rainy', 'stormy'];
  const i = Math.min(level, 4);
  return { weather: ICONS[i], level: KEYS[i], factors };
}

if (typeof module !== 'undefined') module.exports = { assessWeather };
