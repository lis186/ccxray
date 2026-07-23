'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalStorage } = require('../server/storage/local');

// ── loadEntryReqRes (content-addressed) ─────────────────────────────

describe('loadEntryReqRes', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-restore-test-' + Date.now());
  let storage;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reconstructs full req from stripped _req.json + shared files', async () => {
    const sys = [{ type: 'text', text: 'system prompt' }];
    const tools = [{ name: 'bash', description: 'run bash' }];
    const messages = [{ role: 'user', content: 'hello' }];
    const sysHash = 'aaa111';
    const toolsHash = 'bbb222';

    await storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(sys));
    await storage.writeSharedIfAbsent(`tools_${toolsHash}.json`, JSON.stringify(tools));
    await storage.write('2026-04-02T08-00-00-000', '_req.json',
      JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 1000, messages, sysHash, toolsHash }));
    await storage.write('2026-04-02T08-00-00-000', '_res.json',
      JSON.stringify([{ type: 'message_start' }]));

    // Import loadEntryReqRes after setting up the storage (it uses config.storage internally)
    // We test the reconstruction logic via the storage primitives
    const stripped = JSON.parse(await storage.read('2026-04-02T08-00-00-000', '_req.json'));
    const loadedSys = JSON.parse(await storage.readShared(`sys_${stripped.sysHash}.json`));
    const loadedTools = JSON.parse(await storage.readShared(`tools_${stripped.toolsHash}.json`));
    const fullReq = { ...stripped, system: loadedSys, tools: loadedTools };
    delete fullReq.sysHash;
    delete fullReq.toolsHash;

    assert.deepEqual(fullReq.system, sys);
    assert.deepEqual(fullReq.tools, tools);
    assert.deepEqual(fullReq.messages, messages);
    assert.equal(fullReq.model, 'claude-opus-4-6');
    assert.ok(!('sysHash' in fullReq));
    assert.ok(!('toolsHash' in fullReq));
  });

  it('handles null sysHash and toolsHash gracefully', async () => {
    await storage.write('2026-04-02T09-00-00-000', '_req.json',
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 100, messages: [], sysHash: null, toolsHash: null }));

    const stripped = JSON.parse(await storage.read('2026-04-02T09-00-00-000', '_req.json'));
    const sys = stripped.sysHash ? JSON.parse(await storage.readShared(`sys_${stripped.sysHash}.json`)) : null;
    const tools = stripped.toolsHash ? JSON.parse(await storage.readShared(`tools_${stripped.toolsHash}.json`)) : null;

    assert.equal(sys, null);
    assert.equal(tools, null);
  });

  it('res stored as minified JSON parses correctly', async () => {
    const events = [{ type: 'message_start', message: { id: 'x' } }, { type: 'message_stop' }];
    await storage.write('2026-04-02T10-00-00-000', '_res.json', JSON.stringify(events));
    const raw = await storage.read('2026-04-02T10-00-00-000', '_res.json');
    // Should not have newlines/spaces (minified)
    assert.ok(!raw.includes('\n'));
    assert.deepEqual(JSON.parse(raw), events);
  });
});

// ── restoreFromLogs (index.ndjson) ───────────────────────────────────

describe('restoreFromLogs', () => {
  it('returns cleanly when no index.ndjson exists', async () => {
    // loadEntryReqRes with a non-existent entry should set _loaded=true and req/res=null
    const { loadEntryReqRes } = require('../server/restore');
    const entry = { id: 'no-such-file', _loaded: false, req: null, res: null };
    await loadEntryReqRes(entry);
    assert.equal(entry._loaded, true);
    assert.equal(entry.req, null);
    assert.equal(entry.res, null);
  });
});

// Restored entries must re-apply usage-aware context inference, otherwise
// historical index lines that captured maxContext=200000 for Claude 1M-plan
// turns (where no system prompt was sent so the [1m] marker couldn't be
// extracted) keep displaying "636K / 200K (clamped to 100%)" forever.
describe('restoreFromLogs — maxContext re-inference for legacy entries', () => {
  const config = require('../server/config');
  const store = require('../server/store');
  const { restoreFromLogs } = require('../server/restore');
  const tmpDir = path.join(os.tmpdir(), 'ccxray-restore-infer-' + Date.now());
  let realStorage;
  let realRestoreDays;

  before(async () => {
    realStorage = config.storage;
    realRestoreDays = config.RESTORE_DAYS;
    // Bypass the RESTORE_DAYS date-window filter. The synthetic entries below
    // use hardcoded 2026-05-14 ids that become "older than the cutoff" as time
    // passes from when this suite was written, and would otherwise be silently
    // dropped from store.entries — making the suite green at write time and
    // red a few days later.
    config.RESTORE_DAYS = 0;
    const tmpStorage = require('../server/storage/local').createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    config.RESTORE_DAYS = realRestoreDays;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bumps stored maxContext=200000 to 1M when restored usage exceeds it', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T13-27-40-199';
    // Reproduces the real-world bug pattern: bare model, no [1m] marker
    // captured at write time, but usage clearly exceeds 200K.
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '13:27:40', sessionId: 'sess-1',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 632129, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      maxContext: 200000,
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry, 'expected restored entry');
    assert.equal(entry.maxContext, 1_000_000);
  });

  it('keeps stored maxContext=1000000 even when current usage is small (no downgrade)', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T14-00-00-000';
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '14:00:00', sessionId: 'sess-2',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 50000 },
      maxContext: 1_000_000, // originally detected correctly via [1m] in system
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 1_000_000);
  });

  it('re-derives polluted maxContext=1M for non-1M-capable Claude models (#211, fail-on-old)', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T14-30-00-000';
    // A stored 1M on a model outside SUPPORTS_1M cannot encode a legitimate
    // beta-header signal — it can only be pre-clamp LiteLLM pollution (#211)
    // or the usage hatch, which re-inference reproduces. Re-derive instead of
    // keeping the max. (Pre-fix fable-5 pollution is healed by rebuild-index,
    // since fable is 1M-capable and stays trusted here.)
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '14:30:00', sessionId: 'sess-4e68c773',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 172_700 },
      maxContext: 1_000_000, // polluted by LiteLLM max-capability
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 200_000);
  });

  it('heals polluted 1M on a SUPPORTS_1M model via the persisted system prompt (#211, fail-on-old)', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T15-30-00-000';
    // The reported session: claude-fable-5 ran a 200K window (system marker has
    // no [1m]) but pre-clamp code stored maxContext=1M from LiteLLM. fable IS
    // in SUPPORTS_1M, so the model gate alone cannot distinguish pollution
    // from a genuine beta-header 1M — the persisted system prompt can.
    const sysHash = 'aaa1m0';
    await config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify([
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'The exact model ID is claude-fable-5.' },
    ]));
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '15:30:00', sessionId: 'sess-4e68c773',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-fable-5', sysHash,
      usage: { input_tokens: 172_700 },
      maxContext: 1_000_000, // polluted by LiteLLM max-capability
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 200_000);
  });

  it('keeps stored 1M when the persisted system prompt carries the [1m] marker', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T16-00-00-000';
    const sysHash = 'bbb1m1';
    await config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify([
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'The exact model ID is claude-fable-5[1m].' },
    ]));
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '16:00:00', sessionId: 'sess-genuine-1m',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-fable-5', sysHash,
      usage: { input_tokens: 70_500 },
      maxContext: 1_000_000,
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 1_000_000);
  });

  it('a stale marker naming another model is not evidence — no downgrade (fail-on-old)', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T16-30-00-000';
    // Post-switch lag window: entry ran claude-fable-5 on a genuine 1M plan
    // (beta header at capture → stored 1M), but the system marker still names
    // the previous bare sonnet-5 leg. The marker describes another model, so
    // it must not downgrade this entry.
    const sysHash = 'ccc1m2';
    await config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify([
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'The exact model ID is claude-sonnet-5.' },
    ]));
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '16:30:00', sessionId: 'sess-switch-lag',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-fable-5', sysHash,
      usage: { input_tokens: 70_500 },
      maxContext: 1_000_000, // genuine, from the beta header at capture time
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 1_000_000);
  });

  it('a stale [1m] marker from another model keeps stored value conservatively', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T17-00-00-000';
    // Inverse lag case: bare fable-5 entry with polluted stored 1M whose
    // marker still names sonnet-5[1m]. The marker is not about this model, so
    // the entry is unverifiable → keep stored (conservative; heals once the
    // marker catches up on later turns).
    const sysHash = 'ddd1m3';
    await config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify([
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'The exact model ID is claude-sonnet-5[1m].' },
    ]));
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '17:00:00', sessionId: 'sess-switch-lag-2',
      provider: 'anthropic', agent: 'claude',
      model: 'claude-fable-5', sysHash,
      usage: { input_tokens: 50_000 },
      maxContext: 1_000_000,
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, 1_000_000);
  });

  it('leaves OpenAI entries untouched (no Claude bump)', async () => {
    store.entries.length = 0;
    const id = '2026-05-14T15-00-00-000';
    await config.storage.appendIndex(JSON.stringify({
      id, ts: '15:00:00', sessionId: 'sess-3',
      provider: 'openai', agent: 'codex',
      model: 'gpt-5',
      usage: { input_tokens: 500000 }, // exceeds 400K base
      maxContext: null,
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    const entry = store.entries.find(e => e.id === id);
    assert.ok(entry);
    assert.equal(entry.maxContext, null);
  });
});

// ── #333 responseId merge on restore ────────────────────────────────

// A shared ~/.ccxray written by chained proxies holds 2–8 partial copies per
// turn (same upstream responseId, complementary metadata). A non-oversized
// session's copies all enter the store, so restore must fold them into one
// canonical, count cost once, and keep the dropped ids resolvable as aliases.
describe('restoreFromLogs — #333 responseId merge', () => {
  const config = require('../server/config');
  const store = require('../server/store');
  const { restoreFromLogs } = require('../server/restore');
  const tmpDir = path.join(os.tmpdir(), 'ccxray-restore-merge-' + Date.now());
  let realStorage, realRestoreDays;

  before(async () => {
    realStorage = config.storage;
    realRestoreDays = config.RESTORE_DAYS;
    config.RESTORE_DAYS = 0;
    const tmpStorage = require('../server/storage/local').createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    config.RESTORE_DAYS = realRestoreDays;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('folds duplicate copies into one canonical, counts cost once, aliases dropped ids', async () => {
    store.entries.length = 0;
    store.entryIndex.clear();
    store.responseIndex.clear();
    store.sessionCosts.clear();
    const sid = 'sess-dup333';
    const base = { ts: '10:00:00', sessionId: sid, provider: 'anthropic', agent: 'claude',
      model: 'claude-opus-4-7', isSSE: true, status: 200 };
    // Three copies of the SAME logical response (msg_01DUP), metadata split:
    const id1 = '2026-05-14T10-00-00-000';
    const id2 = '2026-05-14T10-00-01-000';
    const id3 = '2026-05-14T10-00-02-000';
    await config.storage.appendIndex(JSON.stringify({ ...base, id: id1, responseId: 'msg_01DUP',
      receivedAt: 1000, agentKey: 'orchestrator', coreHash: 'core9', usage: null, cost: null }) + '\n');
    await config.storage.appendIndex(JSON.stringify({ ...base, id: id2, responseId: 'msg_01DUP',
      receivedAt: 2000, usage: { input_tokens: 1200, output_tokens: 42 }, cost: { cost: 0.05 } }) + '\n');
    await config.storage.appendIndex(JSON.stringify({ ...base, id: id3, responseId: 'msg_01DUP',
      receivedAt: 3000, convId: 'c9', usage: { input_tokens: 1200, output_tokens: 42 }, cost: { cost: 0.05 } }) + '\n');
    // A distinct turn in the same session must remain its own entry.
    await config.storage.appendIndex(JSON.stringify({ ...base, id: '2026-05-14T10-00-03-000',
      responseId: 'msg_01OTHER', receivedAt: 4000, agentKey: 'orchestrator', usage: { input_tokens: 5, output_tokens: 1 }, cost: { cost: 0.01 } }) + '\n');

    await restoreFromLogs();

    const dupRows = store.entries.filter(e => e.responseId === 'msg_01DUP');
    assert.equal(dupRows.length, 1, 'three copies collapse to one row in the store');
    const m = dupRows[0];
    assert.equal(m.id, id1, 'canonical id = earliest copy');
    assert.equal(m.agentKey, 'orchestrator', 'agentKey reconstructed from the copy that had it');
    assert.equal(m.convId, 'c9', 'convId reconstructed from the copy that had it');
    assert.equal(m.usage.output_tokens, 42, 'usage reconstructed from the copy with real tokens');

    // Dropped copy ids resolve to the canonical (delta prevId safety).
    assert.equal(store.getEntryById(id2), m, 'dropped id2 aliases to canonical');
    assert.equal(store.getEntryById(id3), m, 'dropped id3 aliases to canonical');

    // Cost counted once for the merged turn (0.05), plus the distinct turn (0.01).
    assert.ok(Math.abs(store.sessionCosts.get(sid) - 0.06) < 1e-9,
      `expected session cost 0.06, got ${store.sessionCosts.get(sid)}`);

    // The whole session is two rows, not four.
    assert.equal(store.entries.filter(e => e.sessionId === sid).length, 2);
  });
});

// ── codex resume eligibility ────────────────────────────────────────

// Resume-eligibility must survive a restart: it is rebuilt purely from the
// index (no rollout-file probing), so a codex session is resumable iff the
// index holds a non-subagent turn with output_tokens > 0 for it.
describe('restoreFromLogs — codex resume eligibility', () => {
  const config = require('../server/config');
  const store = require('../server/store');
  const { restoreFromLogs } = require('../server/restore');
  const { summarizeEntry } = require('../server/sse-broadcast');
  const tmpDir = path.join(os.tmpdir(), 'ccxray-restore-resume-' + Date.now());
  let realStorage;
  let realRestoreDays;

  before(async () => {
    realStorage = config.storage;
    realRestoreDays = config.RESTORE_DAYS;
    config.RESTORE_DAYS = 0;
    const tmpStorage = require('../server/storage/local').createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    config.RESTORE_DAYS = realRestoreDays;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a codex session with a completed turn is resumable after restore', async () => {
    store.entries.length = 0;
    const sid = 'codex-restore-ok';
    await config.storage.appendIndex(JSON.stringify({
      id: '2026-05-20T10-00-00-000', ts: '10:00:00', sessionId: sid,
      provider: 'openai', agent: 'codex', model: 'gpt-5',
      usage: { input_tokens: 42, output_tokens: 12 }, isSubagent: false,
      isSSE: true, status: 200, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    assert.deepEqual(
      store.computeSessionResume(sid, 'openai'),
      { resumable: true, resumeCommand: `codex resume ${sid}` },
    );
    const summary = summarizeEntry(store.entries.find(e => e.sessionId === sid));
    assert.equal(summary.resumeCommand, `codex resume ${sid}`);
  });

  it('marks usage before serialization: a usage-less entry earlier in the index still reports the final command', async () => {
    store.entries.length = 0;
    const sid = 'codex-restore-late-usage';
    // First indexed entry has no usage; the usage-bearing turn comes later.
    // Without the restore-loop pre-marking, serializing entry 1 first would
    // report resumable:false (summarizeEntry only marks as it goes).
    await config.storage.appendIndex(JSON.stringify({
      id: '2026-05-20T12-00-00-000', ts: '12:00:00', sessionId: sid,
      provider: 'openai', agent: 'codex', model: 'gpt-5',
      usage: null, isSubagent: false,
      isSSE: false, status: 502, receivedAt: 1779000000000,
    }) + '\n');
    await config.storage.appendIndex(JSON.stringify({
      id: '2026-05-20T12-01-00-000', ts: '12:01:00', sessionId: sid,
      provider: 'openai', agent: 'codex', model: 'gpt-5',
      usage: { input_tokens: 7, output_tokens: 2 }, isSubagent: false,
      isSSE: true, status: 200, receivedAt: 1779000060000,
    }) + '\n');

    await restoreFromLogs();
    const first = store.entries.find(e => e.id === '2026-05-20T12-00-00-000');
    assert.equal(summarizeEntry(first).resumeCommand, `codex resume ${sid}`);
  });

  it('a codex session with only a billed zero-output turn is not resumable after restore', async () => {
    store.entries.length = 0;
    const sid = 'codex-restore-zero-output';
    // Issue #44 specimen 2: hung WS turn — input billed, zero output, no
    // rollout file on disk. Restore must not resurrect the resume button.
    await config.storage.appendIndex(JSON.stringify({
      id: '2026-05-20T13-00-00-000', ts: '13:00:00', sessionId: sid,
      provider: 'openai', agent: 'codex', model: 'gpt-5',
      usage: { input_tokens: 9953, output_tokens: 0 }, isSubagent: false,
      isSSE: true, status: 499, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    assert.deepEqual(
      store.computeSessionResume(sid, 'openai'),
      { resumable: false, resumeCommand: null },
    );
    const summary = summarizeEntry(store.entries.find(e => e.sessionId === sid));
    assert.equal(summary.resumeCommand, null);
  });

  it('a codex session with only a 502-style turn (no usage) is not resumable', async () => {
    store.entries.length = 0;
    const sid = 'codex-restore-502';
    await config.storage.appendIndex(JSON.stringify({
      id: '2026-05-20T11-00-00-000', ts: '11:00:00', sessionId: sid,
      provider: 'openai', agent: 'codex', model: 'gpt-5',
      usage: null, isSubagent: false,
      isSSE: false, status: 502, receivedAt: 1779000000000,
    }) + '\n');

    await restoreFromLogs();
    assert.deepEqual(
      store.computeSessionResume(sid, 'openai'),
      { resumable: false, resumeCommand: null },
    );
    const summary = summarizeEntry(store.entries.find(e => e.sessionId === sid));
    assert.equal(summary.resumeCommand, null);
  });
});
