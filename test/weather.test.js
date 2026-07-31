'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessWeather } = require('../public/weather');

function makeTurn(overrides) {
  var base = {
    model: 'claude-opus-4-6',
    elapsed: '12',
    stopReason: 'end_turn',
    usage: {
      output_tokens: 800,
      input_tokens: 20000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
    },
    maxContext: 200000,
    toolFail: false,
    toolCount: 1,
    isCompacted: false,
  };
  if (!overrides) return base;
  var result = Object.assign({}, base, overrides);
  if (overrides.usage) result.usage = Object.assign({}, base.usage, overrides.usage);
  return result;
}

function repeat(n, overrides) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(makeTurn(typeof overrides === 'function' ? overrides(i) : overrides));
  return out;
}

function hasFactor(result, type) {
  return result.factors.some(function(f) { return f.type === type; });
}

describe('assessWeather', function() {

  it('no_data — empty turns → sunny', function() {
    var r = assessWeather([]);
    assert.equal(r.level, 'sunny');
    assert.equal(r.score, 0);
    assert.equal(r.factors.length, 0);
  });

  it('clear — 20 healthy turns → sunny', function() {
    var turns = repeat(20);
    var r = assessWeather(turns);
    assert.equal(r.level, 'sunny');
    assert.ok(r.score < 0.35, 'score ' + r.score + ' should be < 0.35');
    assert.ok(!hasFactor(r, 'stuck'));
    assert.ok(!hasFactor(r, 'truncation'));
    assert.ok(!hasFactor(r, 'compaction_scar'));
  });

  it('ctx_warn — last turn at 60% context', function() {
    var turns = repeat(19);
    turns.push(makeTurn({ usage: { input_tokens: 100000, cache_read_input_tokens: 15000, cache_creation_input_tokens: 5000, output_tokens: 800 }, maxContext: 200000 }));
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'ctx_pressure'));
    var f = r.factors.find(function(f) { return f.type === 'ctx_pressure'; });
    // ctxFloor=0.4: 60% → (0.6-0.4)/(1-0.4) = 0.333
    assert.ok(f.severity >= 0.32 && f.severity <= 0.35, 'severity ' + f.severity + ' ≈ 0.33');
  });

  it('ctx_danger — last turn at 90% context → rainy+', function() {
    var turns = repeat(19);
    turns.push(makeTurn({ usage: { input_tokens: 140000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000, output_tokens: 800 }, maxContext: 200000 }));
    var r = assessWeather(turns);
    assert.ok(r.score >= 0.75, 'score ' + r.score + ' should be >= 0.75');
    assert.ok(r.level === 'rainy' || r.level === 'stormy', 'level=' + r.level);
  });

  it('ctx_mixed_window — session fold prevents a false context alarm', function() {
    var turns = repeat(19, {
      usage: { input_tokens: 500, cache_read_input_tokens: 20000 },
      maxContext: 1000000,
      beta1m: true,
    });
    turns.push(makeTurn({
      usage: { input_tokens: 1000, cache_read_input_tokens: 175000, cache_creation_input_tokens: 0 },
      maxContext: 200000,
    }));
    var r = assessWeather(turns);
    assert.equal(r.level, 'sunny');
    assert.ok(r.stats.ctxPct < 20, 'ctxPct ' + r.stats.ctxPct + ' should be < 20');
  });

  it('ctx_session_window_override — explicit window takes priority over the fold', function() {
    var turns = repeat(19, {
      usage: { input_tokens: 500, cache_read_input_tokens: 20000 },
      maxContext: 1000000,
      beta1m: true,
    });
    turns.push(makeTurn({
      usage: { input_tokens: 1000, cache_read_input_tokens: 175000, cache_creation_input_tokens: 0 },
      maxContext: 200000,
    }));
    var r = assessWeather(turns, { sessionWindow: 400000 });
    // #387: shift = output_tokens(800) / window(400000) = 0.2pp → 44.0 → 44.2
    assert.ok(Math.abs(r.stats.ctxPct - 44.2) <= 0.2, 'ctxPct ' + r.stats.ctxPct + ' should be ≈ 44.2');
    assert.equal(r.level, 'sunny');
  });

  it('ctx_unknown_window — no observed maxContext produces no signal', function() {
    var turns = repeat(20, {
      usage: { input_tokens: 1000, cache_read_input_tokens: 175000, cache_creation_input_tokens: 0 },
      maxContext: undefined,
    });
    var r = assessWeather(turns);
    assert.equal(r.level, 'sunny');
    assert.equal(r.stats.ctxPct, 0);
    assert.ok(!hasFactor(r, 'ctx_pressure'));
  });

  it('compaction_single — one compaction, otherwise healthy', function() {
    var turns = repeat(20);
    turns[10] = makeTurn({ isCompacted: true });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'compaction_scar'));
    var f = r.factors.find(function(f) { return f.type === 'compaction_scar'; });
    assert.equal(f.severity, 0.4);
  });

  it('compaction_multi — three compactions → severity 0.6', function() {
    var turns = repeat(20);
    turns[5] = makeTurn({ isCompacted: true });
    turns[10] = makeTurn({ isCompacted: true });
    turns[15] = makeTurn({ isCompacted: true });
    var r = assessWeather(turns);
    var f = r.factors.find(function(f) { return f.type === 'compaction_scar'; });
    assert.equal(f.severity, 0.6);
  });

  it('truncation — max_tokens with output_tokens=20000', function() {
    var turns = repeat(19);
    turns.push(makeTurn({ stopReason: 'max_tokens', usage: { output_tokens: 20000, input_tokens: 20000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 } }));
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'truncation'));
    var f = r.factors.find(function(f) { return f.type === 'truncation'; });
    assert.equal(f.severity, 0.5);
  });

  it('truncation ignored when output_tokens < 16000', function() {
    var turns = repeat(19);
    turns.push(makeTurn({ stopReason: 'max_tokens', usage: { output_tokens: 10000, input_tokens: 20000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 } }));
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'truncation'));
  });

  it('stuck — 12 consecutive toolFail turns → stormy', function() {
    var turns = repeat(5);
    for (var i = 0; i < 12; i++) turns.push(makeTurn({ stopReason: 'tool_use', toolFail: true }));
    turns.push(makeTurn());
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'stuck'));
    var f = r.factors.find(function(f) { return f.type === 'stuck'; });
    assert.equal(f.severity, 0.9);
    assert.equal(r.level, 'stormy');
  });

  it('stuck — 9 consecutive errors not enough', function() {
    var turns = repeat(5);
    for (var i = 0; i < 9; i++) turns.push(makeTurn({ stopReason: 'tool_use', toolFail: true }));
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'stuck'));
  });

  it('latency_spike — last 10 turns at 2x baseline', function() {
    var turns = repeat(20, function(i) {
      if (i >= 10) return { elapsed: '30.4' };
      return {};
    });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'latency_drift'));
    var f = r.factors.find(function(f) { return f.type === 'latency_drift'; });
    // K=0.5: 2x baseline → (2-1)*0.5 = 0.5
    assert.ok(f.severity >= 0.45 && f.severity <= 0.55, 'severity ' + f.severity + ' should be ≈ 0.5');
  });

  it('insufficient_latency_data — only 3 turns → latency_drift = 0', function() {
    var turns = repeat(3);
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'latency_drift'));
  });

  it('latency uses fallback baseline for unknown model', function() {
    var turns = repeat(10, { model: 'future-model-99', elapsed: '40' });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'latency_drift'));
    var f = r.factors.find(function(f) { return f.type === 'latency_drift'; });
    assert.ok(f.detail.baseline === 20000);
  });

  it('error_burst — 5 consecutive turns with 4 tool errors among 5 tool_use', function() {
    var turns = repeat(20);
    for (var i = 10; i < 15; i++) {
      turns[i] = makeTurn({ stopReason: 'tool_use', toolFail: i !== 12 });
    }
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'error_cluster'));
    var f = r.factors.find(function(f) { return f.type === 'error_cluster'; });
    assert.ok(f.severity > 0, 'severity should be > 0');
    assert.ok(f.detail.errorRate >= 0.8, 'errorRate ' + f.detail.errorRate + ' should be >= 0.8');
  });

  it('error_cluster requires >= 3 tool_use in window', function() {
    var turns = repeat(10);
    turns[3] = makeTurn({ stopReason: 'tool_use', toolFail: true });
    turns[4] = makeTurn({ stopReason: 'tool_use', toolFail: true });
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'error_cluster') || r.factors.find(function(f) { return f.type === 'error_cluster'; }).severity === 0);
  });

  it('error_cumulative — scattered errors across long session', function() {
    // 100 tool_use turns, 25 with errors = 25% rate, spread out (not clustered)
    var turns = [];
    for (var i = 0; i < 100; i++) {
      turns.push(makeTurn({ stopReason: 'tool_use', toolFail: i % 4 === 0 }));
    }
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'error_cumulative'), 'should detect cumulative errors');
    var f = r.factors.find(function(f) { return f.type === 'error_cumulative'; });
    // 25% rate / 0.4 = 0.625 severity
    assert.ok(f.severity >= 0.6 && f.severity <= 0.65, 'severity ' + f.severity + ' ≈ 0.625');
    assert.equal(f.detail.errTurns, 25);
    assert.equal(f.detail.toolTurns, 100);
  });

  it('error_cumulative — not enough tool turns to trigger', function() {
    var turns = repeat(8, { stopReason: 'tool_use', toolFail: true });
    var r = assessWeather(turns);
    // Only 8 tool turns, minimum is 10
    assert.ok(!hasFactor(r, 'error_cumulative') || r.factors.find(function(f) { return f.type === 'error_cumulative'; }).severity === 0);
  });

  it('compound — ctx 80% + error burst + latency high → stormy', function() {
    var turns = repeat(30, { elapsed: '25' });
    turns[turns.length - 1] = makeTurn({
      usage: { input_tokens: 130000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 10000, output_tokens: 800 },
      maxContext: 200000, elapsed: '25',
    });
    for (var i = 20; i < 25; i++) {
      turns[i] = makeTurn({ stopReason: 'tool_use', toolFail: true, elapsed: '25' });
    }
    var r = assessWeather(turns);
    // With calibrated params (ctxFloor=0.4, errDenom=2.0, latK=0.5), compound is rainy not stormy
    assert.ok(r.score >= 0.75, 'score ' + r.score + ' should be >= 0.75 for rainy+');
    assert.ok(r.level === 'rainy' || r.level === 'stormy', 'level ' + r.level + ' should be rainy or stormy');
    assert.ok(hasFactor(r, 'ctx_pressure'));
    assert.ok(hasFactor(r, 'error_cluster'));
    assert.ok(hasFactor(r, 'latency_drift'));
  });

  it('healthy_despite_errors — 2 scattered errors in 50 turns → sunny/fair', function() {
    var turns = repeat(50);
    turns[15] = makeTurn({ stopReason: 'tool_use', toolFail: true });
    turns[38] = makeTurn({ stopReason: 'tool_use', toolFail: true });
    var r = assessWeather(turns);
    assert.ok(r.level === 'sunny' || r.level === 'fair', 'level=' + r.level);
  });

  it('factors sorted by severity descending', function() {
    var turns = repeat(20);
    turns[10] = makeTurn({ isCompacted: true });
    turns[turns.length - 1] = makeTurn({
      usage: { input_tokens: 140000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000, output_tokens: 800 },
      maxContext: 200000,
    });
    var r = assessWeather(turns);
    for (var i = 1; i < r.factors.length; i++) {
      assert.ok(r.factors[i - 1].severity >= r.factors[i].severity,
        'factors not sorted: ' + r.factors[i - 1].severity + ' < ' + r.factors[i].severity);
    }
  });

  it('score composition = max + 0.3 * second', function() {
    var turns = repeat(20);
    turns[10] = makeTurn({ isCompacted: true });
    turns[turns.length - 1] = makeTurn({
      usage: { input_tokens: 140000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000, output_tokens: 800 },
      maxContext: 200000,
    });
    var r = assessWeather(turns);
    var sevs = r.factors.map(function(f) { return f.severity; }).sort(function(a, b) { return b - a; });
    var expected = sevs[0] + 0.3 * (sevs[1] || 0);
    assert.ok(Math.abs(r.score - expected) < 0.01, 'score ' + r.score + ' != expected ' + expected);
  });

  it('null elapsed turns are skipped for latency', function() {
    var turns = repeat(10, { elapsed: '?' });
    turns.push(makeTurn({ elapsed: '12' }));
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'latency_drift'));
  });

  it('numeric elapsed is handled (seconds as number)', function() {
    var turns = repeat(10, { elapsed: 30.4 });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'latency_drift'));
  });

  it('emoji matches level', function() {
    var map = { sunny: '☀️', fair: '🌤️', cloudy: '⛅', rainy: '🌧️', stormy: '⛈️' };
    var r = assessWeather([]);
    assert.equal(r.emoji, map[r.level]);
    var r2 = assessWeather(repeat(12, { stopReason: 'tool_use', toolFail: true }));
    assert.equal(r2.emoji, map[r2.level]);
  });

  it('tooltip — sunny shows stats proving health', function() {
    var r = assessWeather(repeat(10));
    assert.ok(r.tooltip.includes('Operating normally'), 'has summary');
    assert.ok(r.tooltip.includes('context'), 'has context stat');
    assert.ok(r.tooltip.includes('0 errors'), 'has error stat');
  });

  it('tooltip — fair has factors line', function() {
    var turns = repeat(20);
    turns[turns.length - 1] = makeTurn({
      usage: { input_tokens: 110000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000, output_tokens: 800 },
      maxContext: 200000,
    });
    var r = assessWeather(turns);
    if (r.level === 'fair') {
      assert.ok(r.tooltip.includes('Minor signals'), 'should have fair summary');
      assert.ok(r.tooltip.includes('context'), 'should mention context factor');
      assert.ok(!r.tooltip.includes('→'), 'fair should not have action line');
    }
  });

  it('tooltip — cloudy+ has action line', function() {
    var turns = repeat(30);
    turns[turns.length - 1] = makeTurn({
      usage: { input_tokens: 140000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000, output_tokens: 800 },
      maxContext: 200000,
    });
    var r = assessWeather(turns);
    if (r.level === 'cloudy' || r.level === 'rainy' || r.level === 'stormy') {
      assert.ok(r.tooltip.includes('→'), 'cloudy+ should have action line');
    }
  });

  it('tooltip — stuck has specific action', function() {
    var turns = [];
    for (var i = 0; i < 15; i++) turns.push(makeTurn({ stopReason: 'tool_use', toolFail: true }));
    var r = assessWeather(turns);
    assert.ok(r.tooltip.includes('permissions'), 'stuck action should mention permissions');
  });

  // ── #387: ctx numerator includes output_tokens (match computeCtxUsed) ──

  it('#387 — ctx numerator includes output_tokens (fail-on-old)', function() {
    var turns = repeat(19);
    turns.push(makeTurn({
      usage: { input_tokens: 60000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 20000 },
      maxContext: 200000,
    }));
    var r = assessWeather(turns);
    // Old code: used = 60000+40000+0 = 100000, pct = 50.0
    // New code: used = 60000+40000+0+20000 = 120000, pct = 60.0
    assert.equal(r.stats.ctxPct, 60.0, 'ctxPct should include output_tokens');
  });

  it('#387 — output_tokens=0 produces same result as before (no drift)', function() {
    var turns = repeat(19);
    turns.push(makeTurn({
      usage: { input_tokens: 60000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 0 },
      maxContext: 200000,
    }));
    var r = assessWeather(turns);
    assert.equal(r.stats.ctxPct, 50.0, 'ctxPct unchanged when output_tokens=0');
  });

  it('#387 — output_tokens crosses CTX_FLOOR threshold (fail-on-old)', function() {
    var turns = repeat(19);
    // input-only pct = 79000/200000 = 39.5% (below CTX_FLOOR=0.4)
    // with output: (79000+8000)/200000 = 43.5% (above CTX_FLOOR)
    turns.push(makeTurn({
      usage: { input_tokens: 79000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8000 },
      maxContext: 200000,
    }));
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'ctx_pressure'), 'should detect ctx_pressure when output pushes past floor');
    assert.equal(r.stats.ctxPct, 43.5, 'ctxPct should be 43.5 with output_tokens');
    // Verify other factors are not affected by the ctx numerator change
    var otherFactors = r.factors.filter(function(f) { return f.type !== 'ctx_pressure'; });
    assert.equal(otherFactors.length, 0, 'no other factors should fire on this fixture');
  });
});
