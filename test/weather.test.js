'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessWeather } = require('../public/weather');
const { extractOpenAIToolCallIds, extractOpenAITurnToolResults } = require('../server/helpers');

function makeTurn(overrides) {
  var base = {
    model: 'claude-opus-4-6',
    elapsed: '12',
    stopReason: 'end_turn',
    usage: {
      output_tokens: 800,
      input_tokens: 2000,
      cache_read_input_tokens: 28000,
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

function makeOpenAITurn(overrides) {
  return makeTurn(Object.assign({
    provider: 'openai',
    stopReason: 'completed',
    toolFail: false,
    turnToolFail: undefined,
    turnToolCallIds: {},
    turnToolResults: [],
  }, overrides));
}

describe('assessWeather', function() {

  it('#475 real Codex WS call and result fixtures produce known failed weather evidence', function() {
    var fixtureDir = path.join(__dirname, 'fixtures', 'wire-parsers', 'openai');
    var request = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'real-codex-ws-tool-output.json'), 'utf8'));
    var events = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'real-codex-ws-tool-call-events.json'), 'utf8'));
    var result = assessWeather([
      makeOpenAITurn({ id: 'real-call', turnToolCallIds: extractOpenAIToolCallIds(events) }),
      makeOpenAITurn({
        id: 'real-result',
        turnToolResults: extractOpenAITurnToolResults(request.input, { client: request.metadata.client }),
      }),
    ]);

    assert.notEqual(result.level, 'sunny');
    assert.notEqual(result.stats.toolSignal, 'no_data');
    assert.equal(result.stats.toolKnownRate, 100);
  });

  it('#475 failure followed by a terminal response still raises a warning (fail-on-old)', function() {
    var turns = [
      makeOpenAITurn({ id: 'call-a', turnToolCallIds: { call_a: 'Bash' } }),
      makeOpenAITurn({ id: 'interleaved-unrelated-entry' }),
      makeOpenAITurn({
        id: 'terminal',
        turnToolResults: [{ callId: 'call_a', eligible: true, toolFail: true }],
      }),
    ];
    var r = assessWeather(turns);
    assert.notEqual(r.level, 'sunny');
    assert.ok(hasFactor(r, 'tool_failure'), 'paired failure should be visible');
  });

  it('#475 failure is attributed to call A when the model switches to successful call B (fail-on-old)', function() {
    var turns = [
      makeOpenAITurn({ id: 'issued-a', turnToolCallIds: { call_a: 'Bash' } }),
      makeOpenAITurn({
        id: 'issued-b',
        turnToolCallIds: { call_b: 'Bash' },
        turnToolResults: [{ callId: 'call_a', eligible: true, toolFail: true }],
      }),
      makeOpenAITurn({
        id: 'finished',
        turnToolResults: [{ callId: 'call_b', eligible: true, toolFail: false }],
      }),
    ];
    var r = assessWeather(turns);
    var failure = r.factors.find(function(f) { return f.type === 'tool_failure'; });
    assert.ok(failure, 'A failure should remain visible');
    assert.equal(failure.detail.entryId, 'issued-a', 'failure belongs to the response that issued A');
    assert.ok(!hasFactor(r, 'stuck'), 'switching to a successful tool is not a failure streak');
  });

  it('#475 unmatched Object.prototype call IDs are not accepted as tool evidence', function() {
    var r = assessWeather([
      makeOpenAITurn({
        id: 'unmatched-results',
        turnToolResults: [
          { callId: '__proto__', eligible: true, toolFail: true },
          { callId: 'toString', eligible: true, toolFail: true },
        ],
      }),
    ]);

    assert.equal(r.stats.toolSignal, 'no_data');
    assert.equal(r.stats.toolKnownRate, null);
    assert.ok(!hasFactor(r, 'tool_failure'));
  });

  it('#475 ten call_id-paired failures across entries are stormy (fail-on-old)', function() {
    var turns = [makeOpenAITurn({ id: 'issued-0', turnToolCallIds: { call_0: 'Bash' } })];
    for (var i = 0; i < 10; i++) {
      var nextCalls = {};
      if (i < 9) nextCalls['call_' + (i + 1)] = 'Bash';
      turns.push(makeOpenAITurn({
        id: 'result-' + i,
        turnToolCallIds: nextCalls,
        turnToolResults: [{ callId: 'call_' + i, eligible: true, toolFail: true }],
      }));
    }
    var r = assessWeather(turns);
    assert.equal(r.level, 'stormy');
    var stuck = r.factors.find(function(f) { return f.type === 'stuck'; });
    assert.ok(stuck, 'paired failures should feed the stuck signal');
    assert.equal(stuck.detail.maxStreak, 10);
  });

  it('#475 unknown process results are neutral in failure streaks while known success breaks them (fail-on-old)', function() {
    function assessSequence(middleResult) {
      var calls = {};
      var results = [];
      for (var i = 0; i < 13; i++) {
        calls['call_' + i] = 'Bash';
        results.push({ callId: 'call_' + i, eligible: true, toolFail: i === 6 ? middleResult : true });
      }
      return assessWeather([
        makeOpenAITurn({ id: 'issued', turnToolCallIds: calls }),
        makeOpenAITurn({ id: 'returned', turnToolResults: results }),
      ]);
    }

    var unknown = assessSequence(undefined);
    var knownSuccess = assessSequence(false);
    var unknownStuck = unknown.factors.find(function(f) { return f.type === 'stuck'; });

    assert.equal(unknown.level, 'stormy');
    assert.ok(unknownStuck, 'an undecodable result must not erase the surrounding failure streak');
    assert.equal(unknownStuck.detail.maxStreak, 12);
    assert.ok(!hasFactor(knownSuccess, 'stuck'), 'a confirmed success must break the failure streak');
  });

  it('#475 all unknown eligible results make the tool signal unavailable, not sunny or stormy (fail-on-old)', function() {
    var turns = [
      makeOpenAITurn({ id: 'issued-unknown', turnToolCallIds: { call_unknown: 'Bash' } }),
      makeOpenAITurn({
        id: 'returned-unknown',
        turnToolResults: [{ callId: 'call_unknown', eligible: true, toolFail: undefined }],
      }),
    ];
    var r = assessWeather(turns);
    assert.equal(r.level, 'unavailable');
    assert.notEqual(r.level, 'sunny');
    assert.notEqual(r.level, 'stormy');
    assert.equal(r.score, 0, 'unavailable is not a numeric severity');
    assert.match(r.tooltip, /signal unavailable/i);
  });

  it('#475 undefined, false, and true remain three distinct tool signal states (fail-on-old)', function() {
    function assess(toolFail) {
      return assessWeather([
        makeOpenAITurn({ id: 'issued', turnToolCallIds: { call_x: 'Bash' } }),
        makeOpenAITurn({
          id: 'returned',
          turnToolResults: [{ callId: 'call_x', eligible: true, toolFail: toolFail }],
        }),
      ]);
    }
    var unknown = assess(undefined);
    var clear = assess(false);
    var failed = assess(true);
    assert.deepEqual(
      [unknown.stats.toolSignal, clear.stats.toolSignal, failed.stats.toolSignal],
      ['unavailable', 'clear', 'failure'],
    );
    assert.deepEqual([unknown.level, clear.level, failed.level], ['unavailable', 'sunny', 'fair']);
  });

  it('#475 partial unknown evidence remains visibly unavailable', function() {
    var result = assessWeather([
      makeOpenAITurn({ id: 'known-call', turnToolCallIds: { call_known: 'Bash' } }),
      makeOpenAITurn({
        id: 'known-result',
        turnToolResults: [{ callId: 'call_known', eligible: true, toolFail: false }],
      }),
      makeOpenAITurn({ id: 'unknown-call', turnToolCallIds: { call_unknown: 'Bash' } }),
      makeOpenAITurn({
        id: 'unknown-result',
        turnToolResults: [{ callId: 'call_unknown', eligible: true, toolFail: undefined }],
      }),
    ]);

    assert.equal(result.level, 'unavailable');
    assert.equal(result.stats.toolSignal, 'unavailable');
    assert.equal(result.stats.toolKnownRate, 50);
    assert.match(result.tooltip, /1 of 2 eligible tool results could be decoded/);
  });

  it('#475 unavailable tooltip uses the decoded count when the displayed known rate rounds to zero', function() {
    var calls = {};
    var results = [];
    for (var i = 0; i < 201; i++) {
      calls['call_' + i] = 'Bash';
      results.push({ callId: 'call_' + i, eligible: true, toolFail: i === 0 ? false : undefined });
    }
    var r = assessWeather([
      makeOpenAITurn({ id: 'issued', turnToolCallIds: calls }),
      makeOpenAITurn({ id: 'returned', turnToolResults: results }),
    ]);

    assert.equal(r.level, 'unavailable');
    assert.equal(r.stats.toolKnownRate, 0);
    assert.match(r.tooltip, /1 of 201 eligible tool results could be decoded/);
    assert.doesNotMatch(r.tooltip, /no eligible tool result could be decoded/);
  });

  it('#475 unavailable tooltip cannot describe 199 of 200 decoded results as only 100% (fail-on-old)', function() {
    var calls = {};
    var results = [];
    for (var i = 0; i < 200; i++) {
      calls['call_' + i] = 'Bash';
      results.push({ callId: 'call_' + i, eligible: true, toolFail: i < 199 ? false : undefined });
    }
    var r = assessWeather([
      makeOpenAITurn({ id: 'issued', turnToolCallIds: calls }),
      makeOpenAITurn({ id: 'returned', turnToolResults: results }),
    ]);

    assert.equal(r.level, 'unavailable');
    assert.equal(r.stats.toolKnownRate, 100);
    assert.match(r.tooltip, /199 of 200 eligible tool results could be decoded/);
    assert.doesNotMatch(r.tooltip, /only 100%/);
  });

  it('#475 weather tool-failure decisions use explicit three-value comparisons', function() {
    var source = fs.readFileSync(path.join(__dirname, '..', 'public', 'weather.js'), 'utf8');
    var decisionLines = source.split('\n').filter(function(line) {
      return /\b(?:if|else if|while)\b/.test(line) && /toolFail/.test(line);
    });
    assert.ok(decisionLines.length > 0, 'guard must inspect real decision lines');
    decisionLines.forEach(function(line) {
      assert.match(line, /toolFail\s*===\s*(?:true|false)/, line.trim());
    });
  });

  it('#475 failure-rate excludes unknown and known-rate excludes ineligible Read results', function() {
    var turns = [];
    for (var i = 0; i < 100; i++) {
      var id = 'call_' + i;
      var tool = i < 10 ? 'Bash' : 'Read';
      var toolFail = i < 2 ? true : i < 10 ? false : undefined;
      var eligible = i < 100;
      turns.push(makeOpenAITurn({ id: 'issued-' + i, turnToolCallIds: { [id]: tool } }));
      turns.push(makeOpenAITurn({
        id: 'returned-' + i,
        turnToolResults: [{ callId: id, eligible: eligible, toolFail: toolFail }],
      }));
    }
    var r = assessWeather(turns);
    var cumulative = r.factors.find(function(f) { return f.type === 'error_cumulative'; });
    assert.ok(cumulative, '10 known Bash results satisfy the cumulative denominator');
    assert.equal(cumulative.detail.toolTurns, 10, 'Read and unknown results are not failure-rate denominator members');
    assert.equal(cumulative.detail.errTurns, 2);
    assert.equal(cumulative.detail.rate, 0.2);
    assert.equal(r.stats.toolKnownRate, 100, 'Read results are ineligible, not unknown eligible results');
  });

  it('#475 clean non-shell Grok results are excluded from tool-signal eligibility (fail-on-old)', function() {
    var callId = 'call_grok_search';
    var callIds = extractOpenAIToolCallIds([
      { type: 'function_call', name: 'search_documents', call_id: callId },
    ]);
    var results = extractOpenAITurnToolResults([
      { type: 'function_call_output', call_id: callId, output: 'clean search result without an exit footer' },
    ], { client: 'grok' });
    var r = assessWeather([
      makeOpenAITurn({ id: 'issued', turnToolCallIds: callIds }),
      makeOpenAITurn({ id: 'returned', turnToolResults: results }),
    ]);

    assert.deepEqual(callIds, { call_grok_search: 'search_documents' });
    assert.deepEqual(results, [{ callId: callId, eligible: true, toolFail: undefined }]);
    assert.equal(r.level, 'sunny');
    assert.equal(r.stats.toolSignal, 'no_data');
    assert.equal(r.stats.toolKnownRate, null);
    assert.doesNotMatch(r.tooltip, /signal unavailable/i);
  });

  it('#475 Anthropic weather scores remain identical to the origin/main baseline', function() {
    var healthy = repeat(20, function(i) { return { id: 'h' + i, provider: 'anthropic' }; });
    var failing = repeat(12, function(i) {
      return { id: 'f' + i, provider: 'anthropic', stopReason: 'tool_use', toolFail: true };
    });
    var compacted = repeat(20, function(i) {
      return { id: 'm' + i, provider: 'anthropic', isCompacted: i === 5 || i === 10 || i === 15 };
    });
    assert.deepEqual(
      [healthy, failing, compacted].map(function(turns) {
        var r = assessWeather(turns);
        return { level: r.level, score: r.score };
      }),
      [
        { level: 'sunny', score: 0 },
        { level: 'stormy', score: 1.27 },
        { level: 'cloudy', score: 0.6 },
      ],
    );
  });

  it('#475 an inert OpenAI turn must not erase Anthropic tool severity (round-2 regression)', function() {
    var anthropicFailures = repeat(12, function(i) {
      return { id: 'anthropic-' + i, provider: 'anthropic', stopReason: 'tool_use', toolFail: true };
    });
    var openAIFailures = [makeOpenAITurn({ id: 'openai-call-0', turnToolCallIds: { call_0: 'Bash' } })];
    for (var i = 0; i < 12; i++) {
      var nextCalls = {};
      if (i < 11) nextCalls['call_' + (i + 1)] = 'Bash';
      openAIFailures.push(makeOpenAITurn({
        id: 'openai-result-' + i,
        turnToolCallIds: nextCalls,
        turnToolResults: [{ callId: 'call_' + i, eligible: true, toolFail: true }],
      }));
    }

    var anthropic = assessWeather(anthropicFailures);
    var openAI = assessWeather(openAIFailures);
    var mixed = assessWeather(anthropicFailures.concat(makeOpenAITurn({ id: 'openai-no-tool-data' })));
    var openAIUnderThreshold = assessWeather([
      makeOpenAITurn({ id: 'single-call', turnToolCallIds: { single_call: 'Bash' } }),
      makeOpenAITurn({
        id: 'single-result',
        turnToolResults: [{ callId: 'single_call', eligible: true, toolFail: true }],
      }),
    ]);

    assert.deepEqual(
      [anthropic, openAI, mixed].map(function(result) {
        return { level: result.level, score: result.score };
      }),
      [
        { level: 'stormy', score: 1.27 },
        { level: 'stormy', score: 1.27 },
        { level: 'stormy', score: 1.27 },
      ],
    );
    assert.equal(openAIUnderThreshold.stats.errTurns, 1);
    assert.equal(openAIUnderThreshold.stats.errRate, 1);
  });

  // Both providers carry real evidence at DIFFERENT severities — the branch
  // _strongerToolSignal exists for, and the one the round-2 regression broke.
  // Asserting entryIdStart (not score) is what makes this non-vacuous: it names
  // which side's window was selected, so a hard-coded single-provider return fails.
  function mixedErrorClusterDetail(anthropicFailures, openAIFailures) {
    var turns = [];
    for (var a = 0; a < 5; a++) {
      turns.push(makeTurn({
        id: 'anthropic-' + a,
        provider: 'anthropic',
        stopReason: 'tool_use',
        toolFail: a < anthropicFailures,
      }));
    }
    turns.push(makeOpenAITurn({ id: 'openai-0', turnToolCallIds: { call_0: 'Bash' } }));
    for (var o = 0; o < 5; o++) {
      var nextCalls = {};
      if (o < 4) nextCalls['call_' + (o + 1)] = 'Bash';
      turns.push(makeOpenAITurn({
        id: 'openai-' + (o + 1),
        turnToolCallIds: nextCalls,
        turnToolResults: [{ callId: 'call_' + o, eligible: true, toolFail: o < openAIFailures }],
      }));
    }
    var result = assessWeather(turns);
    return result.factors.filter(function(f) { return f.type === 'error_cluster'; })[0].detail;
  }

  it('#475 mixed providers with real evidence on both sides select the more severe window', function() {
    // OpenAI 4/5 errors (sev 0.4) vs Anthropic 1/5 (sev 0.1) → OpenAI window wins
    var openAIWins = mixedErrorClusterDetail(1, 4);
    assert.match(openAIWins.entryIdStart, /^openai-/);
    assert.equal(openAIWins.errorRate, 0.8);

    // Anthropic 4/5 errors (sev 0.4) vs OpenAI 1/5 (sev 0.1) → Anthropic window wins
    var anthropicWins = mixedErrorClusterDetail(4, 1);
    assert.match(anthropicWins.entryIdStart, /^anthropic-/);
    assert.equal(anthropicWins.errorRate, 0.8);
  });

  it('#475 equal-severity provider tie keeps the side with actual tool evidence (fail-on-old)', function() {
    var result = assessWeather([
      makeTurn({ id: 'anthropic-no-tools', provider: 'anthropic', toolCount: 0 }),
      makeOpenAITurn({ id: 'openai-call', turnToolCallIds: { call_failed: 'Bash' } }),
      makeOpenAITurn({
        id: 'openai-result',
        turnToolResults: [{ callId: 'call_failed', eligible: true, toolFail: true }],
      }),
    ]);

    assert.ok(hasFactor(result, 'tool_failure'));
    assert.equal(result.stats.errTurns, 1);
    assert.equal(result.stats.errRate, 1);
    assert.match(result.tooltip, /1 errors/);
    assert.doesNotMatch(result.tooltip, /0 errors/);
  });

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

  it('#336 tooltip — only evidence-linked top factors have action lines (fail-on-old)', function() {
    var ctxTurns = repeat(30);
    ctxTurns[ctxTurns.length - 1] = makeTurn({
      usage: { input_tokens: 140000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000, output_tokens: 800 },
      maxContext: 200000,
    });

    var compactionTurns = repeat(20);
    compactionTurns[5] = makeTurn({ isCompacted: true });
    compactionTurns[10] = makeTurn({ isCompacted: true });
    compactionTurns[15] = makeTurn({ isCompacted: true });

    var truncationTurns = repeat(20);
    truncationTurns[5] = makeTurn({ isCompacted: true });
    truncationTurns[19] = makeTurn({
      stopReason: 'max_tokens',
      usage: { output_tokens: 20000, input_tokens: 20000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 },
    });

    var stuckTurns = repeat(20, function(i) {
      return { id: 's' + i, stopReason: 'tool_use' };
    });
    for (var i = 20; i < 30; i++) {
      stuckTurns.push(makeTurn({ id: 's' + i, stopReason: 'tool_use', toolFail: true }));
    }

    var clusterTurns = repeat(5, function(i) {
      return { id: 'c' + i, stopReason: 'tool_use', toolFail: true, isCompacted: i === 0 };
    });

    var cumulativeTurns = repeat(100, function(i) {
      return { id: 'e' + i, stopReason: 'tool_use', toolFail: i % 4 === 0 };
    });

    // Same shape, no turn ids → firstErrId stays null, so error_cumulative has
    // nothing to link to and must emit NO action line (#336 codex R1 P2).
    var cumulativeNoIdTurns = repeat(100, function(i) {
      return { stopReason: 'tool_use', toolFail: i % 4 === 0 };
    });

    var cases = [
      {
        type: 'ctx_pressure',
        turns: ctxTurns,
        factors: 'context 90.4%',
        action: null,
      },
      {
        type: 'compaction_scar',
        turns: compactionTurns,
        factors: 'compaction ×3 (info lost)',
        action: null,
      },
      {
        type: 'truncation',
        turns: truncationTurns,
        factors: 'output truncated (turn 19) · compaction ×1 (info lost)',
        action: null,
      },
      {
        type: 'latency_drift',
        turns: repeat(10, { elapsed: '33.44' }),
        factors: 'latency 2.2x baseline',
        action: null,
      },
      {
        type: 'stuck',
        turns: stuckTurns,
        factors: 'stuck 10 failures (turn 20-29) · 10/30 tool errors (33%) · error burst 100% (turn 20-24)',
        action: '→ Check turn 20-29 — usually permissions or paths',
      },
      {
        type: 'error_cluster',
        turns: clusterTurns,
        factors: 'error burst 100% (turn 0-4) · compaction ×1 (info lost)',
        action: '→ Check turn 0-4',
      },
      {
        type: 'error_cumulative',
        turns: cumulativeTurns,
        factors: '25/100 tool errors (25%) · error burst 40% (turn 0-4)',
        action: '→ Check first error — common: permissions, paths, settings',
      },
      {
        type: 'error_cumulative',
        turns: cumulativeNoIdTurns,
        factors: '25/100 tool errors (25%) · error burst 40% (turn 0-4)',
        action: null,
      },
    ];

    cases.forEach(function(testCase) {
      var result = assessWeather(testCase.turns);
      var lines = result.tooltip.split('\n');
      assert.equal(result.factors[0].type, testCase.type, testCase.type + ' should be the top factor');
      assert.equal(lines[1], testCase.factors, testCase.type + ' factor formatting should stay unchanged');
      var actionLines = lines.filter(function(line) { return line.indexOf('→ ') === 0; });
      assert.deepEqual(actionLines, testCase.action ? [testCase.action] : [], testCase.type + ' action line');
    });
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

  // ── cache_health signal ──

  it('cache_miss — sustained 0% cache hit → severity 0.5', function() {
    var turns = repeat(15, { usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 800 } });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'cache_health'), 'should detect cache miss');
    var f = r.factors.find(function(f) { return f.type === 'cache_health'; });
    assert.equal(f.severity, 0.5, 'severity at 0% should be 0.5');
    assert.equal(f.detail.medianHitRate, 0);
  });

  it('cache_degraded — 30% hit rate → severity ≈ 0.2', function() {
    // 9600 / 32000 = 30%
    var turns = repeat(15, { usage: { input_tokens: 20400, cache_read_input_tokens: 9600, cache_creation_input_tokens: 2000, output_tokens: 800 } });
    var r = assessWeather(turns);
    assert.ok(hasFactor(r, 'cache_health'));
    var f = r.factors.find(function(f) { return f.type === 'cache_health'; });
    assert.ok(f.severity >= 0.19 && f.severity <= 0.21, 'severity ' + f.severity + ' ≈ 0.2');
  });

  it('cache_healthy — 80% hit rate → no signal', function() {
    // 25600 / 32000 = 80%
    var turns = repeat(15, { usage: { input_tokens: 4400, cache_read_input_tokens: 25600, cache_creation_input_tokens: 2000, output_tokens: 800 } });
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'cache_health'));
  });

  it('cache_cold_start — first 3 turns skipped', function() {
    // 4 turns total, first 3 have 0% cache, turn 4 has 80%
    // max(3, 4-10) = 3 → only turn 3 qualifies → < 3 qualifying → no signal
    var turns = [
      makeTurn({ usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 800 } }),
      makeTurn({ usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 800 } }),
      makeTurn({ usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 800 } }),
      makeTurn({ usage: { input_tokens: 4400, cache_read_input_tokens: 25600, cache_creation_input_tokens: 2000, output_tokens: 800 } }),
    ];
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'cache_health'), 'cold start turns should be skipped');
  });

  it('cache_insufficient — only 2 qualifying turns → no signal', function() {
    var turns = repeat(5);
    // Only turns 3-4 qualify (after skipping first 3), that's 2 turns — below minimum 3
    var r = assessWeather(turns);
    // With 5 turns: max(3, 5-10) = 3 → turns 3,4 → 2 qualifying → no signal
    assert.ok(!hasFactor(r, 'cache_health'));
  });

  it('cache_tiny_turns_skipped — turns with < 1K input tokens ignored', function() {
    var turns = repeat(15, { usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 200, output_tokens: 100 } });
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'cache_health'), 'tiny turns should not trigger cache signal');
  });

  it('cache_codex_exempt — OpenAI/Codex entries are skipped', function() {
    // OpenAI parser normalizes cache_read_input_tokens to 0, so null-check alone doesn't work
    var turns = repeat(15, { provider: 'openai', usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 800 } });
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'cache_health'), 'codex/openai entries should not trigger cache signal');
  });

  it('cache_grok_exempt — xAI/Grok entries are skipped', function() {
    var turns = repeat(15, { provider: 'xai', usage: { input_tokens: 30000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 800 } });
    var r = assessWeather(turns);
    assert.ok(!hasFactor(r, 'cache_health'), 'grok entries should not trigger cache signal');
  });

  it('cache stats shown in sunny tooltip', function() {
    var turns = repeat(10);
    var r = assessWeather(turns);
    assert.ok(r.stats.cacheHitRate != null, 'stats should include cacheHitRate');
    assert.ok(r.tooltip.includes('cache'), 'sunny tooltip should show cache stat');
  });
});
