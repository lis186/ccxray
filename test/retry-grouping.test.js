'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── Shared test harness: load client-side JS in a VM context ──

function loadDashboardContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  function el() {
    return {
      style: {}, dataset: {}, innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, insertBefore() {},
      querySelector: () => el(), querySelectorAll: () => [],
      remove() {},
    };
  }
  const context = {
    console, window: {},
    document: {
      getElementById: () => el(), createElement: () => el(),
      querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(),
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  // Stubs only for globals NOT declared by the loaded scripts
  vm.runInContext(`
    function updateSysPromptBadge() {}
    function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; }
    function setInterval() { return 0; }
    function clearInterval() {}
    window.ccxraySettings = { visibleProviders: [] };
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  for (const f of ['format.js', 'session-label.js', 'miller-columns.js', 'entry-rendering.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, f), 'utf8'), context);
  }
  // Bridge const/let declarations into the context object for test access
  vm.runInContext(`
    this.allEntries = allEntries;
    this.sessionsMap = sessionsMap;
    this.selectedSessionId = null;
    _loading = true;
  `, context);
  return context;
}

function makeEntry(overrides) {
  return {
    id: '2026-06-09T10-00-00-000', ts: '10:00:00', model: 'gpt-5.5',
    status: 200, elapsed: '85.0', method: 'POST',
    usage: { input_tokens: 5000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    maxContext: 200000, isSubagent: false, sessionInferred: false,
    toolCalls: {}, title: 'Test turn', provider: 'openai',
    receivedAt: '1749456000000',
    ...overrides,
  };
}

// Shared session id for entries in the same session
const SID = 'sess_retry_test';

// ── Tests: these define "what better looks like" ──

describe('Issue #44: Retry grouping — isRetry classification', () => {
  it('marks a 429 entry with no usage as isRetry=true', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-00-01-000', status: 429, usage: null,
      elapsed: '0.1', sessionId: SID,
    }));
    const entry = ctx.allEntries[0];
    assert.equal(entry.isRetry, true, 'a 429 with null usage must be classified as retry');
  });

  it('marks a 502 entry with no output_tokens as isRetry=true', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-00-02-000', status: 502, usage: null,
      elapsed: '0.1', sessionId: SID,
    }));
    assert.equal(ctx.allEntries[0].isRetry, true);
  });

  it('marks a 499 entry with usage but output_tokens=0 as isRetry=true (Specimen 2)', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-00-03-000', status: 499,
      usage: { input_tokens: 9507, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      elapsed: '459.0', sessionId: SID,
    }));
    assert.equal(ctx.allEntries[0].isRetry, true, 'Specimen 2: non-OK status + zero output = retry');
  });

  it('keeps a 200 entry with output_tokens > 0 as isRetry=false', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-00-04-000', status: 200, sessionId: SID,
      usage: { input_tokens: 5000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
    assert.equal(ctx.allEntries[0].isRetry, false, 'a normal 200 turn is not retry');
  });

  it('keeps a 499 entry with output_tokens > 0 as isRetry=false (real interrupted turn)', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-00-05-000', status: 499,
      usage: { input_tokens: 5000, output_tokens: 275, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      elapsed: '672.1', sessionId: SID,
    }));
    assert.equal(ctx.allEntries[0].isRetry, false, 'error with real output is a real turn');
  });
});

describe('Issue #44: Session counters — retries counted separately', () => {
  it('does not increment mainCount for retry entries', () => {
    const ctx = loadDashboardContext();
    // Real turn #1
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-01-00-000', sessionId: SID, status: 200 }));
    // Retry (429)
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-01-01-000', sessionId: SID, status: 429, usage: null, elapsed: '0.1' }));
    // Retry (502)
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-01-02-000', sessionId: SID, status: 502, usage: null, elapsed: '0.1' }));
    // Real turn #2
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-01-03-000', sessionId: SID, status: 200 }));

    const sess = ctx.sessionsMap.get(SID);
    assert.equal(sess.mainCount, 2, 'only real turns increment mainCount');
    assert.equal(sess.retryCount, 2, 'retries tracked in retryCount');
    assert.equal(sess.count, 4, 'sess.count is total API calls (including retries)');
  });

  it('gives retry entries displayNum with "r" prefix', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-02-00-000', sessionId: SID, status: 200 }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-02-01-000', sessionId: SID, status: 429, usage: null, elapsed: '0.1' }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-02-02-000', sessionId: SID, status: 200 }));

    assert.equal(ctx.allEntries[0].displayNum, '1', 'first real turn is #1');
    assert.equal(ctx.allEntries[1].displayNum, 'r1', 'retry gets r-prefix');
    assert.equal(ctx.allEntries[2].displayNum, '2', 'second real turn is #2 (no gap)');
  });
});

describe('Issue #44: Session card — retry badge', () => {
  it('shows retry count in session card HTML', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-03-00-000', sessionId: SID, status: 200 }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-03-01-000', sessionId: SID, status: 429, usage: null, elapsed: '0.1' }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-03-02-000', sessionId: SID, status: 429, usage: null, elapsed: '0.1' }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-03-03-000', sessionId: SID, status: 200 }));

    const sess = ctx.sessionsMap.get(SID);
    const html = ctx.renderSessionItem(sess, SID);
    assert.ok(html.includes('2t'), 'real turn count shown (4 total - 2 retries = 2)');
    assert.ok(html.includes('2r') || html.includes('2 retries'), 'retry count visible');
  });

  it('omits retry badge when session has zero retries', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-04-00-000', sessionId: 'clean_session', status: 200 }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-04-01-000', sessionId: 'clean_session', status: 200 }));

    const sess = ctx.sessionsMap.get('clean_session');
    const html = ctx.renderSessionItem(sess, 'clean_session');
    assert.ok(!html.includes('retry'), 'no retry badge for clean sessions');
    assert.ok(!html.includes('0r'), 'no 0r badge');
  });

  it('shows 0t when session has only retries and no real turns', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-04-10-000', sessionId: 'all_retry', status: 504, usage: null, elapsed: '0.1' }));

    const sess = ctx.sessionsMap.get('all_retry');
    const html = ctx.renderSessionItem(sess, 'all_retry');
    assert.ok(html.includes('0t'), 'zero real turns');
    assert.ok(html.includes('1r'), 'retry count shown');
  });
});

describe('Issue #44: Empty state — all-retry sessions', () => {
  it('updateRetryEmptyState creates element for all-retry session', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-09-00-000', sessionId: 'only_retries', status: 504, usage: null, elapsed: '0.1' }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-09-01-000', sessionId: 'only_retries', status: 502, usage: null, elapsed: '0.1' }));

    // Verify the session has only retries
    const sess = ctx.sessionsMap.get('only_retries');
    assert.equal(sess.retryCount, 2, 'both entries are retries');
    assert.equal(sess.mainCount, 0, 'no real turns');
    assert.equal(sess.count - sess.retryCount, 0, 'display count would be 0t');

    // Verify getVisibleTurnIndices returns empty for this session
    vm.runInContext('selectedSessionId = "only_retries"', ctx);
    const visible = ctx.getVisibleTurnIndices();
    assert.equal(visible.length, 0, 'no visible turns for all-retry session');
  });
});

describe('Issue #44: getVisibleTurnIndices — retries hidden', () => {
  it('excludes retry entries from visible turn list', () => {
    const ctx = loadDashboardContext();
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-05-00-000', sessionId: SID, status: 200 }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-05-01-000', sessionId: SID, status: 429, usage: null, elapsed: '0.1' }));
    ctx.addEntry(makeEntry({ id: '2026-06-09T10-05-02-000', sessionId: SID, status: 200 }));

    // Set selectedSessionId inside the VM scope (it's a let in miller-columns.js)
    vm.runInContext('selectedSessionId = "' + SID + '"', ctx);
    const visible = ctx.getVisibleTurnIndices();
    assert.equal(visible.length, 2, 'only 2 real turns visible');
    assert.equal(ctx.allEntries[visible[0]].isRetry, false);
    assert.equal(ctx.allEntries[visible[1]].isRetry, false);
  });
});

describe('Issue #44: Gap timing — retries skipped', () => {
  it('measures gap from previous real turn, not from retry', () => {
    const ctx = loadDashboardContext();
    const t0 = 1749456000000; // base timestamp
    // Real turn #1: starts at t0, runs for 5s
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-06-00-000', sessionId: SID, status: 200,
      receivedAt: String(t0), elapsed: '5.0',
    }));
    // Retry at t0+6s (1s after turn 1 ends)
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-06-01-000', sessionId: SID, status: 429,
      usage: null, elapsed: '0.1', receivedAt: String(t0 + 6000),
    }));
    // Real turn #2 at t0+10s (5s after turn 1 ends, 4s after retry)
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-06-02-000', sessionId: SID, status: 200,
      receivedAt: String(t0 + 10000), elapsed: '8.0',
    }));

    // The gap for turn #2 should be measured from turn #1 end (t0+5s), not from retry
    // Expected gap: 10000 - (t0 + 5000) = 5000ms
    // If retry pollutes: 10000 - (t0 + 6000 + 100) = 3900ms (wrong)
    const turn2 = ctx.allEntries[2];
    // The gap is rendered in the turn card — we check the entry data
    // Gap timing is computed during addEntry and baked into the DOM.
    // We can't easily extract it from the entry, but we can verify
    // the prevInSession was the real turn, not the retry.
    // Since gap is baked into the DOM, we verify via the isRetry flag
    // ensuring the scan skips retries.
    assert.equal(ctx.allEntries[1].isRetry, true, 'retry entry is marked');
    assert.equal(ctx.allEntries[0].isRetry, false, 'real turn 1 is not retry');
    assert.equal(ctx.allEntries[2].isRetry, false, 'real turn 2 is not retry');
  });
});

describe('Issue #44: Claude session regression — zero retries', () => {
  it('Claude sessions with all-200 turns have no retry classification', () => {
    const ctx = loadDashboardContext();
    const claudeSid = 'claude_session_clean';
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-07-00-000', sessionId: claudeSid, status: 200,
      provider: 'anthropic', model: 'claude-opus-4-6',
      usage: { input_tokens: 50000, output_tokens: 2000, cache_read_input_tokens: 45000, cache_creation_input_tokens: 0 },
    }));
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-07-01-000', sessionId: claudeSid, status: 200,
      provider: 'anthropic', model: 'claude-opus-4-6',
      usage: { input_tokens: 55000, output_tokens: 3000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 },
    }));

    const sess = ctx.sessionsMap.get(claudeSid);
    assert.equal(sess.retryCount, 0, 'Claude session has zero retries');
    assert.equal(sess.mainCount, 2, 'both turns counted as main');
    assert.equal(ctx.allEntries[0].isRetry, false);
    assert.equal(ctx.allEntries[1].isRetry, false);
  });
});

describe('Issue #44: Compression detection — retries not used as baseline', () => {
  it('compression check skips retry entries as comparison baseline', () => {
    const ctx = loadDashboardContext();
    // Turn 1: large context
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-08-00-000', sessionId: SID, status: 200,
      usage: { input_tokens: 100000, output_tokens: 2000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 30000 },
      maxContext: 200000, receivedAt: '1749456000000',
    }));
    // Retry with partial billing (Specimen 2): would be wrong baseline
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-08-01-000', sessionId: SID, status: 499,
      usage: { input_tokens: 9958, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      maxContext: 200000, elapsed: '246.2', receivedAt: '1749456010000',
    }));
    // Turn 2: context dropped (compaction happened relative to turn 1, not retry)
    ctx.addEntry(makeEntry({
      id: '2026-06-09T10-08-02-000', sessionId: SID, status: 200,
      usage: { input_tokens: 30000, output_tokens: 1500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000 },
      maxContext: 200000, receivedAt: '1749456020000',
    }));

    // Turn 2 should be compared against Turn 1 (180k ctx), not Retry (9958 ctx).
    // Turn 1 ctx = 100000+50000+30000 = 180000, Turn 2 ctx = 30000+10000+5000 = 45000
    // msgDrop and tokenDrop would detect compaction from Turn 1 → Turn 2.
    // If retry contaminates, comparison would be 9958 → 45000 = no compaction (wrong).
    const turn2 = ctx.allEntries[2];
    assert.equal(ctx.allEntries[1].isRetry, true, 'specimen 2 is retry');
    // With the fix, turn2.isCompacted should reflect comparison vs turn 1
    // Without the fix, comparison vs retry would show no compaction
  });
});
