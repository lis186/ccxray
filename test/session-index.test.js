'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

describe('session-index', () => {
  let tmpDir, origLogsDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-si-'));
    await fsp.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    // Point LOGS_DIR at our temp dir
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpDir, 'logs'), writable: true, configurable: true });
  });

  afterEach(async () => {
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    // Clear module cache so each test gets fresh state
    delete require.cache[require.resolve('../server/session-index')];
  });

  it('#377 slice 2: unknown session window stays zero and creates no weather signal', () => {
    const si = require('../server/session-index');
    const { assessWeather } = require('../public/weather');
    const turnWithoutFacts = {
      id: 'no-facts',
      maxContext: 0,
      usage: {
        input_tokens: 176000,
        output_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };

    const win = si.sessionWindow('missing-session');
    assert.equal(win, 0);
    const weather = assessWeather([turnWithoutFacts], { sessionWindow: win });
    assert.equal(weather.level, 'sunny');
    assert.equal(weather.stats.ctxPct, 0);
    assert.equal(weather.score, 0);
  });

  it('#377 slice 2: partial store weather uses the session-index 1M fold', async () => {
    const si = require('../server/session-index');
    const store = require('../server/store');
    const savedEntries = store.entries.splice(0);
    const sid = 'partial-1m';
    store.entries.push({
      id: 'surviving-200k-copy',
      sessionId: sid,
      maxContext: 200000,
      usage: {
        input_tokens: 176000,
        output_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    try {
      si.updateFromEntry({
        id: 'trimmed-1m-evidence',
        sessionId: sid,
        maxContext: 200000,
        beta1m: true,
      });

      assert.equal(si.sessionWindow(sid), 1000000);
      const weather = si.get(sid).weather;
      assert.equal(weather.level, 'sunny');
      // #387: +output_tokens(1000) shifts 17.6 → 17.7
      assert.equal(weather.stats.ctxPct, 17.7);
      assert.equal(weather.score, 0);
    } finally {
      store.entries.splice(0, store.entries.length, ...savedEntries);
      await si.flush();
    }
  });

  it('updateFromEntry + flush + load round-trip', async () => {
    const si = require('../server/session-index');
    si.updateFromEntry({
      sessionId: 'abc-123', id: '2026-07-15T09-00-00-000', model: 'claude-opus-4-6',
      cwd: '/home/user/project', cost: { cost: 1.5 }, receivedAt: 1000000,
      provider: 'anthropic', agent: 'claude', title: 'Test session', maxContext: 200000,
    });
    si.updateFromEntry({
      sessionId: 'abc-123', id: '2026-07-15T09-10-00-000', model: 'claude-opus-4-6',
      cwd: '/home/user/project', cost: { cost: 0.5 }, receivedAt: 2000000,
      provider: 'anthropic', agent: 'claude',
    });
    assert.equal(si.size(), 1);
    const all = si.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sid, 'abc-123');
    assert.equal(all[0].count, 2);
    assert.equal(all[0].totalCost, 2.0);
    assert.equal(all[0].firstId, '2026-07-15T09-00-00-000');
    assert.equal(all[0].lastId, '2026-07-15T09-10-00-000');
    assert.equal(all[0].title, 'Test session');

    await si.flush();
    const config = require('../server/config');
    const raw = await fsp.readFile(path.join(config.LOGS_DIR, 'sessions.json'), 'utf8');
    assert.ok(raw.includes('abc-123'));

    // Clear and reload
    delete require.cache[require.resolve('../server/session-index')];
    const si2 = require('../server/session-index');
    const loaded = await si2.loadSessionIndex();
    assert.ok(loaded);
    assert.equal(si2.size(), 1);
    const reloaded = si2.getAll()[0];
    assert.equal(reloaded.count, 2);
    assert.equal(reloaded.totalCost, 2.0);
  });

  it('rebuildFromIndexContent', () => {
    const si = require('../server/session-index');
    const lines = [
      JSON.stringify({ id: '2026-07-10T01-00-00-000', sessionId: 'sess-a', model: 'opus', cwd: '/a', cost: { cost: 1 }, receivedAt: 100 }),
      JSON.stringify({ id: '2026-07-10T02-00-00-000', sessionId: 'sess-a', model: 'opus', cwd: '/a', cost: { cost: 2 }, receivedAt: 200 }),
      JSON.stringify({ id: '2026-07-10T03-00-00-000', sessionId: 'sess-b', model: 'sonnet', cwd: '/b', cost: { cost: 0.5 }, receivedAt: 300 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    assert.equal(si.size(), 2);
    const a = si.getAll().find(s => s.sid === 'sess-a');
    assert.equal(a.count, 2);
    assert.equal(a.totalCost, 3);
    const b = si.getAll().find(s => s.sid === 'sess-b');
    assert.equal(b.count, 1);
  });

  it('#333: rebuild dedups BOTH cost and turn count per responseId', () => {
    const si = require('../server/session-index');
    // 3 duplicate copies of ONE turn (same responseId) + 1 distinct turn — the
    // shared-log shape. Cost counted once per responseId (ADR mandatory) AND the
    // turn count deduped (owner decision 2026-07-23) so the card shows 2 merged
    // turns, not the 4 raw lines. reconcile() dedups its tally the same way.
    const lines = [
      JSON.stringify({ id: 't1a', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 1 }),
      JSON.stringify({ id: 't1b', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 2 }),
      JSON.stringify({ id: 't1c', sessionId: 'sess-x', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 3 }),
      JSON.stringify({ id: 't2', sessionId: 'sess-x', responseId: 'msg_01B', cost: { cost: 0.01 }, receivedAt: 4 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-x');
    assert.ok(Math.abs(s.totalCost - 0.06) < 1e-9, `cost once per responseId: expected 0.06, got ${s.totalCost}`);
    assert.equal(s.count, 2, 'count deduped per responseId: 2 merged turns, not 4 raw lines');
  });

  it('#333: cost dedup keeps the MAX per responseId (poor copy logged first)', () => {
    const si = require('../server/session-index');
    // A partial copy (output 0, cost ~0) logged before the complete copy must not
    // pin the session total to the cheap value (codex round-3 M3).
    const lines = [
      JSON.stringify({ id: 'p1', sessionId: 'sess-z', responseId: 'msg_01A', cost: { cost: 0.001 }, receivedAt: 1 }),
      JSON.stringify({ id: 'p2', sessionId: 'sess-z', responseId: 'msg_01A', cost: { cost: 0.01 }, receivedAt: 2 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-z');
    assert.ok(Math.abs(s.totalCost - 0.01) < 1e-9, `expected max 0.01, got ${s.totalCost}`);
  });

  it('#333: a line without responseId still counts its cost (legacy/exempt)', () => {
    const si = require('../server/session-index');
    const lines = [
      JSON.stringify({ id: 'l1', sessionId: 'sess-y', cost: { cost: 0.1 }, receivedAt: 1 }),
      JSON.stringify({ id: 'l2', sessionId: 'sess-y', cost: { cost: 0.2 }, receivedAt: 2 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const s = si.getAll().find(x => x.sid === 'sess-y');
    assert.ok(Math.abs(s.totalCost - 0.3) < 1e-9, 'no responseId ⇒ no dedup, both cost counted');
    assert.equal(s.count, 2, 'no responseId ⇒ no dedup key ⇒ every line counts');
  });

  it('#333: seedDedupState prevents cross-restart double COUNT and double COST', async () => {
    // Full cross-restart flow. Prior process: a proxy logged one turn
    // (msg_01A, cost 0.30) → count 1, cost 0.30, flushed to sessions.json.
    let si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's', id: 'proxy1', responseId: 'msg_01A', cost: { cost: 0.30 }, receivedAt: 1, maxContext: 200000 });
    assert.equal(si.getAll()[0].count, 1);
    await si.flush();

    // Restart: fresh module (empty _countedRids/_costByRid). Fast-load reads
    // count/cost straight from sessions.json — the path that used to re-inflate.
    delete require.cache[require.resolve('../server/session-index')];
    si = require('../server/session-index');
    assert.ok(await si.loadSessionIndex());
    assert.equal(si.getAll()[0].count, 1, 'reloaded merged count');
    assert.ok(Math.abs(si.getAll()[0].totalCost - 0.30) < 1e-9, 'reloaded cost');

    // Importer seeds dedup state from the proxy line still in the index, THEN
    // imports the SAME turn from the transcript (different id, same responseId).
    const indexContent = JSON.stringify({ id: 'proxy1', sessionId: 's', responseId: 'msg_01A', cost: { cost: 0.30 }, receivedAt: 1 });
    si.seedDedupState(indexContent);
    si.updateFromEntry({ sessionId: 's', id: 'import1', responseId: 'msg_01A', cost: { cost: 0.30 }, receivedAt: 2 });
    assert.equal(si.getAll()[0].count, 1, 'imported duplicate adds no COUNT — no cross-restart double count');
    assert.ok(Math.abs(si.getAll()[0].totalCost - 0.30) < 1e-9, 'imported duplicate adds no COST');

    // A genuinely new turn (different responseId) increments both.
    si.updateFromEntry({ sessionId: 's', id: 'import2', responseId: 'msg_01B', cost: { cost: 0.05 }, receivedAt: 3 });
    assert.equal(si.getAll()[0].count, 2, 'a new turn still counts');
    assert.ok(Math.abs(si.getAll()[0].totalCost - 0.35) < 1e-9, 'a new turn still adds cost');
  });

  it('loadSessionIndex returns false when file missing', async () => {
    const si = require('../server/session-index');
    const loaded = await si.loadSessionIndex();
    assert.equal(loaded, false);
  });

  it('setTitle updates existing session', async () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 's1', id: 't1', model: 'x', receivedAt: 1 });
    si.setTitle('s1', 'My Title');
    assert.equal(si.getAll()[0].title, 'My Title');
  });

  it('multiple sessions', () => {
    const si = require('../server/session-index');
    for (let i = 0; i < 5; i++) {
      si.updateFromEntry({ sessionId: `s-${i}`, id: `2026-07-${10+i}T00-00-00-000`, model: 'opus', receivedAt: i * 1000 });
    }
    assert.equal(si.size(), 5);
  });

  it('reconcile detects session-count drift and rebuilds', async () => {
    const si = require('../server/session-index');
    // Seed sessions.json with 2 sessions
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    si.updateFromEntry({ sessionId: 'sb', id: 't2', model: 'x', cost: { cost: 2 }, receivedAt: 2 });
    await si.flush();
    assert.equal(si.size(), 2);

    // index.ndjson has 3 sessions
    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sb', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
      JSON.stringify({ id: 't3', sessionId: 'sc', model: 'x', cost: { cost: 3 }, receivedAt: 3 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.ok(drifted, 'should detect session-count drift');
    assert.equal(si.size(), 3, 'should rebuild with 3 sessions');
  });

  it('reconcile detects entry-count drift and rebuilds', async () => {
    const si = require('../server/session-index');
    // Seed with 1 session / 1 entry
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    await si.flush();
    assert.equal(si.getAll()[0].count, 1);

    // index.ndjson has same 1 session but 2 entries
    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sa', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.ok(drifted, 'should detect entry-count drift');
    assert.equal(si.getAll()[0].count, 2, 'should rebuild with correct count');
  });

  it('reconcile passes when counts match', () => {
    const si = require('../server/session-index');
    si.updateFromEntry({ sessionId: 'sa', id: 't1', model: 'x', cost: { cost: 1 }, receivedAt: 1 });
    si.updateFromEntry({ sessionId: 'sb', id: 't2', model: 'x', cost: { cost: 2 }, receivedAt: 2 });

    const indexContent = [
      JSON.stringify({ id: 't1', sessionId: 'sa', model: 'x', cost: { cost: 1 }, receivedAt: 1 }),
      JSON.stringify({ id: 't2', sessionId: 'sb', model: 'x', cost: { cost: 2 }, receivedAt: 2 }),
    ].join('\n');

    const drifted = si.reconcile(indexContent);
    assert.equal(drifted, false, 'should not detect drift');
    assert.equal(si.size(), 2, 'should keep existing sessions');
  });

  it('#333: reconcile does not thrash on a duplicate-heavy shared log', () => {
    const si = require('../server/session-index');
    // 3 copies of msg_01A + 1 msg_01B ⇒ merged count 2. index.ndjson holds the
    // same 4 raw lines. reconcile must dedup its tally by responseId to match the
    // merged s.count — a raw-line tally (4) vs merged count (2) would rebuild on
    // EVERY reconcile (the perpetual-drift trap the paired dedup exists to avoid).
    const lines = [
      JSON.stringify({ id: 't1a', sessionId: 'sx', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 1 }),
      JSON.stringify({ id: 't1b', sessionId: 'sx', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 2 }),
      JSON.stringify({ id: 't1c', sessionId: 'sx', responseId: 'msg_01A', cost: { cost: 0.05 }, receivedAt: 3 }),
      JSON.stringify({ id: 't2', sessionId: 'sx', responseId: 'msg_01B', cost: { cost: 0.01 }, receivedAt: 4 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    assert.equal(si.getAll()[0].count, 2, 'merged count after rebuild');
    const drifted = si.reconcile(lines);
    assert.equal(drifted, false, 'merged count must reconcile against its own raw log without false drift');
    assert.equal(si.getAll()[0].count, 2, 'count unchanged — no thrash rebuild');
  });

  it('#333: cross-session dup credits COUNT+COST to the first-seen session (known limitation)', () => {
    const si = require('../server/session-index');
    // KNOWN LIMITATION (ADR 0012, codex review 2026-07-23): when the SAME
    // responseId appears under two different sessionIds — e.g. a proxy copy
    // logged 'direct-api' and the importer's copy carrying the real session
    // (#329 path) — dedup credits the FIRST-seen session, matching the
    // pre-existing _costByRid behavior. The read-time merge (store._identityScore)
    // instead renders the turn under the higher-identity session, so the two
    // cards disagree with their Turns columns. reconcile compares only global
    // totals, so it neither detects nor heals this. This test PINS that behavior
    // (not an endorsement) so nobody assumes cross-session cards stay consistent.
    const lines = [
      JSON.stringify({ id: 'p1', sessionId: 'direct-api', sessionInferred: true, responseId: 'msg_01X', cost: { cost: 0.20 }, receivedAt: 1 }),
      JSON.stringify({ id: 'i1', sessionId: 's-real', sessionInferred: false, responseId: 'msg_01X', cost: { cost: 0.20 }, receivedAt: 2 }),
    ].join('\n');
    si.rebuildFromIndexContent(lines);
    const first = si.getAll().find(s => s.sid === 'direct-api');
    const real = si.getAll().find(s => s.sid === 's-real');
    assert.equal(first.count, 1, 'first-seen session keeps the count');
    assert.equal(real.count, 0, 'later cross-session copy is suppressed (credited to first-seen, not moved)');
    assert.ok(Math.abs(first.totalCost - 0.20) < 1e-9, 'cost also credited to first-seen session');
    assert.ok(Math.abs((real.totalCost || 0)) < 1e-9, 'cross-session copy adds no cost to its own session');
  });

  // #385: weather assessment must receive deduped metas (ADR 0012 invariant)
  it('#385: duplicate metas by responseId do not inflate weather signals', () => {
    const si = require('../server/session-index');
    // 10 logical turns: 9 end_turn turns + 1 toolFail turn duplicated 5×.
    // Old code: 14 raw entries — the 5 dups are consecutive tool_use+toolFail at the
    //           end, forming a 5-turn window with errorRate=1.0 → error_cluster fires.
    // New code: 10 deduped entries — only 1 tool_use turn → no 5-turn window has ≥3
    //           tool_use turns → error_cluster cannot fire.
    const metas = [];
    for (let i = 0; i < 9; i++) {
      metas.push({
        id: `t${i}`, sessionId: 'weather-dup', responseId: `rid_${i}`,
        model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolFail: false,
        cost: { cost: 0.01 }, receivedAt: (i + 1) * 1000, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    // The toolFail turn — duplicated 5× (same responseId, chained proxy shape)
    for (let k = 0; k < 5; k++) {
      metas.push({
        id: `t9_dup${k}`, sessionId: 'weather-dup', responseId: 'rid_fail',
        model: 'claude-sonnet-4-6', stopReason: 'tool_use', toolFail: true,
        cost: { cost: 0.01 }, receivedAt: 10000 + k, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    si.rebuildFromMetas(metas);
    const s = si.get('weather-dup');
    assert.ok(s, 'session exists');
    assert.ok(s.weather, 'weather computed');
    // error_cluster must NOT fire — only 1 tool_use turn in 10 deduped entries,
    // no 5-turn window has ≥3 tool_use turns (sigErrorCluster threshold).
    const ecFactor = s.weather.factors.find(f => f.type === 'error_cluster');
    assert.equal(ecFactor, undefined, 'error_cluster must not fire on deduped metas');
  });

  it('#385 Guard 1: legacy metas without responseId pass through to weather', () => {
    const si = require('../server/session-index');
    // 5 distinct legacy lines (no responseId) — all must count in weather.
    // sigErrorCluster checks: 5-turn window has 5 tool_use, 5 errors → errorRate=1.0.
    // If the dedup wrongly dropped legacy lines, errorRate would be lower or the
    // window wouldn't have ≥3 tool_use turns.
    const metas = [];
    for (let i = 0; i < 5; i++) {
      metas.push({
        id: `legacy${i}`, sessionId: 'weather-legacy',
        model: 'claude-sonnet-4-6', stopReason: 'tool_use', toolFail: true,
        cost: { cost: 0.01 }, receivedAt: (i + 1) * 1000, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    si.rebuildFromMetas(metas);
    const s = si.get('weather-legacy');
    assert.ok(s.weather, 'weather computed');
    // error_cluster must fire with errorRate=1.0 — proves all 5 lines counted
    const ecFactor = s.weather.factors.find(f => f.type === 'error_cluster');
    assert.ok(ecFactor, 'error_cluster fires — proves all 5 legacy lines reached weather');
    assert.equal(ecFactor.detail.errorRate, 1.0, 'all 5 turns are errors (no dedup applied)');
    assert.equal(s.count, 5, 'count also 5 (no responseId = no dedup)');
  });

  it('#385 Guard 2: cost/count unchanged by weather dedup', () => {
    const si = require('../server/session-index');
    // Same fixture as the main #385 test — cost/count must be identical pre/post fix
    const metas = [];
    for (let i = 0; i < 9; i++) {
      metas.push({
        id: `t${i}`, sessionId: 'guard2', responseId: `rid_${i}`,
        cost: { cost: 0.01 }, receivedAt: (i + 1) * 1000, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    for (let k = 0; k < 5; k++) {
      metas.push({
        id: `t9_dup${k}`, sessionId: 'guard2', responseId: 'rid_fail',
        cost: { cost: 0.01 }, receivedAt: 10000 + k, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    si.rebuildFromMetas(metas);
    const s = si.get('guard2');
    // 10 unique responseIds ⇒ count=10, cost=0.10 (already correct pre-fix)
    assert.equal(s.count, 10, 'count deduped by responseId: 10 logical turns');
    assert.ok(Math.abs(s.totalCost - 0.10) < 1e-9, `cost deduped: expected 0.10, got ${s.totalCost}`);
  });

  it('#385 Guard 3: clean fixture (all unique responseIds) produces identical weather', () => {
    const si = require('../server/session-index');
    const { assessWeather } = require('../public/weather');
    // 10 clean turns — no duplicates. Dedup is an identity transform.
    const metas = [];
    for (let i = 0; i < 10; i++) {
      metas.push({
        id: `c${i}`, sessionId: 'clean', responseId: `uniq_${i}`,
        model: 'claude-sonnet-4-6', stopReason: 'tool_use', toolFail: i === 5,
        cost: { cost: 0.01 }, receivedAt: (i + 1) * 1000, maxContext: 200000,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    // Compute expected weather directly from the metas (no dedup effect)
    const expected = assessWeather(metas);
    si.rebuildFromMetas(metas);
    const s = si.get('clean');
    assert.ok(s.weather, 'weather computed');
    assert.equal(s.weather.level, expected.level, 'level matches direct assessment');
    assert.equal(s.weather.score, expected.score, 'score matches direct assessment');
    assert.equal(s.weather.stats.errTurns, expected.stats.errTurns, 'errTurns matches');
    assert.equal(s.weather.stats.errRate, expected.stats.errRate, 'errRate matches');
  });

  // ── #381: agentKey-based subagent gate must exclude subagent turns from window fold ──
  // Old code uses `!entry.isSubagent` → a turn with agentKey='task-agent' (known subagent)
  // but isSubagent=false would enter the fold and inflate the window.
  // New code uses isMainTurnByAgentKey → checks WF_MAIN_AGENT_KEYS → 'task-agent' is not
  // in the map → excluded from fold regardless of isSubagent flag.
  it('#381 fail-on-old: subagent agentKey with isSubagent=false must not inflate session window', () => {
    const si = require('../server/session-index');
    const sid = 'test-381-gate';

    // A main turn establishes the session at 200K
    si.updateFromEntry({
      id: '2026-07-31T10-00-00-000', ts: '10:00:00',
      sessionId: sid, receivedAt: 1000, elapsed: '2.0',
      agentKey: 'orchestrator', isSubagent: false,
      maxContext: 200000,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { cost: 0.01 },
    });
    assert.equal(si.sessionWindow(sid), 200000, 'window starts at 200K');

    // A subagent turn: agentKey='task-agent' (NOT in WF_MAIN_AGENT_KEYS),
    // isSubagent=false (server heuristic missed it), beta1m=true, maxContext=1M
    // Old code: !isSubagent → true → enters fold → window inflates to 1M (WRONG)
    // New code: isMainTurnByAgentKey → 'task-agent' not in MAIN_KEYS → excluded (CORRECT)
    si.updateFromEntry({
      id: '2026-07-31T10-01-00-000', ts: '10:01:00',
      sessionId: sid, receivedAt: 2000, elapsed: '3.0',
      agentKey: 'task-agent', isSubagent: false,
      maxContext: 1000000, beta1m: true,
      usage: { input_tokens: 500000, output_tokens: 200 },
      cost: { cost: 0.05 },
    });

    // The subagent's 1M evidence must NOT enter the session window fold
    assert.equal(si.sessionWindow(sid), 200000,
      'subagent agentKey turn must not inflate session window — old code would give 1000000');
  });
});
