const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessWeather } = require('../public/weather.js');

// Helper to create a minimal turn object
function turn(overrides = {}) {
  return {
    usage: { input_tokens: 10000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    maxContext: 200000,
    stopReason: 'end_turn',
    isCompacted: false,
    toolFail: false,
    ...overrides
  };
}

// ctx% fixtures (maxContext = 200000)
const CTX10 = { input_tokens: 15000, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };  // 10%
const CTX50 = { input_tokens: 80000, output_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // 50%
const CTX90 = { input_tokens: 150000, output_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };// 90%

// n consecutive tool_use turns, first `failCount` of them failing
function toolRun(n, failCount) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(turn({ stopReason: 'tool_use', toolFail: i < failCount }));
  return arr;
}

describe('assessWeather', () => {
  it('1. empty turns → clear', () => {
    for (const empty of [[], null, undefined]) {
      const r = assessWeather(empty);
      assert.equal(r.level, 'clear');
      assert.equal(r.weather, '☀️');
      assert.deepEqual(r.factors, []);
    }
  });

  it('2. clear — low ctx, no events → clear', () => {
    const r = assessWeather([turn({ usage: CTX10 }), turn({ usage: CTX10 })]);
    assert.equal(r.level, 'clear');
    assert.equal(r.weather, '☀️');
    assert.deepEqual(r.factors, []);
  });

  it('3. ctx_warn — ctxPct between 40-80% → fair', () => {
    const r = assessWeather([turn({ usage: CTX50 })]);
    assert.equal(r.level, 'fair');
    assert.equal(r.weather, '🌤️');
    assert.deepEqual(r.factors, ['ctx_warn']);
  });

  it('4. ctx_danger — ctxPct > 80% → cloudy', () => {
    const r = assessWeather([turn({ usage: CTX90 })]);
    assert.equal(r.level, 'cloudy');
    assert.equal(r.weather, '⛅');
    assert.deepEqual(r.factors, ['ctx_danger']);
  });

  it('5. single compaction → cloudy (level 2)', () => {
    const r = assessWeather([turn({ isCompacted: true }), turn({ usage: CTX10 })]);
    assert.equal(r.level, 'cloudy');
    assert.deepEqual(r.factors, ['compaction']);
  });

  it('6. multi compaction (2+) → rainy (level 3)', () => {
    const r = assessWeather([turn({ isCompacted: true }), turn({ isCompacted: true }), turn({ usage: CTX10 })]);
    assert.equal(r.level, 'rainy');
    assert.equal(r.weather, '🌧️');
    assert.deepEqual(r.factors, ['compaction_multi']);
  });

  it('7. truncation (max_tokens + output >= 16000) → bumps level by 1', () => {
    const r = assessWeather([turn({
      stopReason: 'max_tokens',
      usage: { input_tokens: 10000, output_tokens: 16000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    })]);
    assert.equal(r.level, 'fair');
    assert.deepEqual(r.factors, ['truncation']);
  });

  it('8. truncation with low output (< 16000) → no effect', () => {
    const r = assessWeather([turn({
      stopReason: 'max_tokens',
      usage: { input_tokens: 10000, output_tokens: 10000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    })]);
    assert.equal(r.level, 'clear');
    assert.deepEqual(r.factors, []);
  });

  it('9. stuck — 10+ consecutive tool_use with >25% error → rainy', () => {
    const r = assessWeather(toolRun(10, 3)); // 3/10 = 30% > 25%
    assert.equal(r.level, 'rainy');
    assert.deepEqual(r.factors, ['stuck']);
  });

  it('10. stuck resets — streak broken by non-tool_use → no stuck', () => {
    // run A: 9 tool_use (4 fail), break, run B: 5 tool_use (0 fail).
    // max consecutive streak = 9 (< 10) → stuck never fires.
    const turns = [...toolRun(9, 4), turn({ stopReason: 'end_turn' }), ...toolRun(5, 0)];
    const r = assessWeather(turns);
    assert.ok(!r.factors.includes('stuck'));
    // 4 fails / 14 tool turns = 28.5% > 15%, not stuck → elevated fires instead
    assert.equal(r.level, 'fair');
    assert.deepEqual(r.factors, ['tool_error_elevated']);
  });

  it('11. tool_error_elevated — >15% error, 5+ tool turns, not stuck → bumps level by 1', () => {
    const r = assessWeather(toolRun(5, 1)); // 1/5 = 20% > 15%, streak 5 < 10
    assert.equal(r.level, 'fair');
    assert.deepEqual(r.factors, ['tool_error_elevated']);
  });

  it('12. tool_error_below_threshold — <15% → no effect', () => {
    const r = assessWeather(toolRun(10, 1)); // 1/10 = 10%, not stuck, not elevated
    assert.equal(r.level, 'clear');
    assert.deepEqual(r.factors, []);
  });

  it('13. combined: ctx_warn + compaction + truncation → cumulative', () => {
    const turns = [
      turn({ isCompacted: true }),
      turn({
        stopReason: 'max_tokens',
        usage: { input_tokens: 10000, output_tokens: 16000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }),
      turn({ usage: CTX50 }) // last turn drives ctx → ctx_warn
    ];
    const r = assessWeather(turns);
    // ctx_warn(1) → compaction(2) → truncation(min(2+1,4)=3)
    assert.equal(r.level, 'rainy');
    assert.deepEqual(r.factors, ['ctx_warn', 'compaction', 'truncation']);
  });

  it('14. combined: compaction_multi + stuck → max level (rainy, not additive)', () => {
    const turns = [turn({ isCompacted: true }), turn({ isCompacted: true }), ...toolRun(10, 3)];
    const r = assessWeather(turns);
    // both contribute level 3 via Math.max → stays rainy, does not stack to stormy
    assert.equal(r.level, 'rainy');
    assert.deepEqual(r.factors, ['compaction_multi', 'stuck']);
  });

  it('15. level capped at 4 (stormy) — multiple degradations do not exceed stormy', () => {
    const turns = [
      turn({ isCompacted: true }),
      turn({ isCompacted: true }),
      turn({
        stopReason: 'max_tokens',
        usage: { input_tokens: 10000, output_tokens: 16000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }),
      ...toolRun(10, 3),        // stuck
      turn({ usage: CTX90 })    // last turn → ctx_danger
    ];
    const r = assessWeather(turns);
    // ctx_danger(2) → compaction_multi(3) → truncation(min(3+1,4)=4) → stuck(max(4,3)=4)
    assert.equal(r.level, 'stormy');
    assert.equal(r.weather, '⛈️');
    assert.deepEqual(r.factors, ['ctx_danger', 'compaction_multi', 'truncation', 'stuck']);
  });

  it('16. compaction scar permanence — early compaction, rest clear → still cloudy', () => {
    const turns = [turn({ isCompacted: true }), turn({ usage: CTX10 }), turn({ usage: CTX10 }), turn({ usage: CTX10 })];
    const r = assessWeather(turns);
    assert.equal(r.level, 'cloudy');
    assert.deepEqual(r.factors, ['compaction']);
  });
});
