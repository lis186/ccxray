'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const hub = require('../server/hub');
const { createLocalStorage } = require('../server/storage/local');
const { rebuildIndex, reconstructReq, tsFromId, nearestPrecedingSession } = require('../server/rebuild-index');

// rebuildIndex takes an injectable storage + log sink, so we drive it against a
// tmp local-storage dir without touching the user's ~/.ccxray. Hub-liveness is
// stubbed off (no live hub during tests).
describe('rebuild-index', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-rebuild-' + process.pid);
  let storage;
  let realReadHubLock;
  const logs = [];
  const log = (m) => logs.push(m);

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
    realReadHubLock = hub.readHubLock;
    hub.readHubLock = () => null; // no live hub
  });

  after(() => {
    hub.readHubLock = realReadHubLock;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logs.length = 0;
    // wipe the logs dir + shared dir between cases
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
    for (const sid of Object.keys(store.sessionMeta)) delete store.sessionMeta[sid];
  });

  // ── helpers to seed a synthetic logs dir ──
  const SYS_HASH = 'abc123';
  const SYSTEM = [
    { type: 'text', text: 'You are Claude.' },
    { type: 'text', text: 'Env\nPrimary working directory: /home/me/proj\nmore' },
  ];
  function writeShared() {
    fs.writeFileSync(path.join(tmpDir, 'shared', `sys_${SYS_HASH}.json`), JSON.stringify(SYSTEM));
  }
  function writeReq(id, body) {
    fs.writeFileSync(path.join(tmpDir, `${id}_req.json`), JSON.stringify(body));
  }
  function writeRes(id, events) {
    fs.writeFileSync(path.join(tmpDir, `${id}_res.json`), JSON.stringify(events));
  }
  function writeIndexLine(obj) {
    fs.appendFileSync(path.join(tmpDir, 'index.ndjson'), JSON.stringify(obj) + '\n');
  }
  // A minimal Anthropic SSE event stream with usage + stop_reason.
  function sseEvents() {
    return [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ];
  }
  function readIndexIds() {
    const c = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('#333: add-only backfills responseId onto legacy lines whose _res survives', async () => {
    // Legacy line WITH a surviving _res.json (carries a message id) → enriched.
    const idA = '2026-07-01T10-00-00-000';
    writeIndexLine({ id: idA, ts: '10:00:00', sessionId: 's', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200 });
    writeRes(idA, [{ type: 'message_start', message: { id: 'msg_01LEGACY', usage: { input_tokens: 1, output_tokens: 1 } } }]);
    // Legacy line whose _res was pruned (none on disk) → left untouched.
    const idB = '2026-07-01T11-00-00-000';
    writeIndexLine({ id: idB, ts: '11:00:00', sessionId: 's', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200 });
    // OpenAI line → exempt (skip the read entirely, never enriched).
    const idC = '2026-07-01T12-00-00-000';
    writeIndexLine({ id: idC, ts: '12:00:00', sessionId: 's', provider: 'openai', model: 'gpt-5', isSSE: true, status: 200 });
    writeRes(idC, [{ type: 'message_start', message: { id: 'msg_01NOPE' } }]);

    const res = await rebuildIndex({ apply: true, storage, log });
    assert.equal(res.enriched, 1, 'exactly one line enriched (anthropic + surviving res)');
    const lines = readIndexIds();
    assert.equal(lines.find(l => l.id === idA).responseId, 'msg_01LEGACY', 'surviving-res line gains the key');
    assert.ok(!('responseId' in lines.find(l => l.id === idB)), 'pruned-res line untouched');
    assert.ok(!('responseId' in lines.find(l => l.id === idC)), 'openai line exempt');
  });

  it('tsFromId / nearestPrecedingSession pure helpers', () => {
    assert.equal(tsFromId('2026-05-01T11-47-17-808'), '11:47:17');
    const tl = [{ id: 'a', sid: 'S1' }, { id: 'm', sid: 'S2' }];
    assert.equal(nearestPrecedingSession(tl, 'z'), 'S2');
    assert.equal(nearestPrecedingSession(tl, 'b'), 'S1');
    assert.equal(nearestPrecedingSession(tl, 'a'), null); // strictly before
  });

  it('reconstructReq splices a delta chain and returns null on a broken chain', async () => {
    writeShared();
    writeReq('2026-06-01T00-00-01-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      metadata: { session_id: 'S1' },
    });
    writeReq('2026-06-01T00-00-02-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T00-00-01-000', msgOffset: 2,
      messages: [{ role: 'user', content: 'c' }],
      metadata: { session_id: 'S1' },
    });
    // broken: prevId points at a file that does not exist
    writeReq('2026-06-01T00-00-03-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: 'gone', msgOffset: 5, messages: [{ role: 'user', content: 'x' }],
      metadata: { session_id: 'S1' },
    });

    const cache = new Map();
    const ok = await reconstructReq('2026-06-01T00-00-02-000', storage, cache);
    assert.equal(ok.provider, 'anthropic');
    assert.equal(ok.parsedBody.messages.length, 3); // 2 spliced + 1 delta
    assert.equal(ok.parsedBody.metadata.session_id, 'S1');

    const broken = await reconstructReq('2026-06-01T00-00-03-000', storage, new Map());
    assert.equal(broken, null);
  });

  it('dry run reports orphans and does NOT touch the index', async () => {
    writeShared();
    writeIndexLine({ id: '2026-06-01T00-00-00-000', sessionId: 'S1', sessionInferred: false, cwd: '/home/me/proj' });
    writeReq('2026-06-01T00-00-05-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'hi there' }], metadata: { session_id: 'S1' },
    });
    const before = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');

    const r = await rebuildIndex({ apply: false, storage, log });
    assert.equal(r.applied, false);
    assert.equal(r.recovered, 1);
    const after = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    assert.equal(after, before, 'dry run must be byte-for-byte no-op');
  });

  it('apply: canonical projection, merge-only, cwd + title + session, skips broken chains', async () => {
    writeShared();
    // A pruned-source line: present in index, no _req.json on disk. Must survive.
    writeIndexLine({ id: '2026-06-01T00-00-00-000', sessionId: 'S1', sessionInferred: false, cwd: '/home/me/proj', msgCount: 9 });

    // Anchor (explicit session, has _res with usage/stop_reason)
    writeReq('2026-06-01T01-00-00-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'first question' }], metadata: { session_id: 'S1' },
    });
    writeRes('2026-06-01T01-00-00-000', sseEvents());

    // Delta off the anchor
    writeReq('2026-06-01T01-00-01-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T01-00-00-000', msgOffset: 1,
      messages: [{ role: 'assistant', content: 'answer' }, { role: 'user', content: 'second question' }],
      metadata: { session_id: 'S1' },
    });

    // Subagent turn: no session_id, no cwd in system → inferred. Runs after the
    // anchor, so it must attribute to S1 and inherit S1's cwd.
    writeReq('2026-06-01T01-00-02-000', {
      model: 'claude-x', max_tokens: 100,
      system: [{ type: 'text', text: 'You are a subagent.' }],
      messages: [{ role: 'user', content: 'subagent task' }],
    });

    // Broken-chain delta: ancestor pruned → must be skipped, never emitted.
    writeReq('2026-06-01T01-00-03-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: 'pruned-ancestor', msgOffset: 3, messages: [{ role: 'user', content: 'orphan delta' }],
      metadata: { session_id: 'S1' },
    });

    const r = await rebuildIndex({ apply: true, storage, log });
    assert.equal(r.applied, true);
    assert.equal(r.recovered, 3, 'anchor + delta + subagent');
    assert.equal(r.unrecoverable, 1, 'broken-chain delta');

    const byId = new Map(readIndexIds().map(o => [o.id, o]));
    // pruned-source line preserved untouched
    assert.equal(byId.get('2026-06-01T00-00-00-000').msgCount, 9);
    // broken-chain delta absent
    assert.equal(byId.has('2026-06-01T01-00-03-000'), false);

    const anchor = byId.get('2026-06-01T01-00-00-000');
    assert.equal(anchor.sessionId, 'S1');
    assert.equal(anchor.sessionInferred, false);
    assert.equal(anchor.cwd, '/home/me/proj', 'cwd recovered from rehydrated system');
    assert.equal(anchor.sysHash, SYS_HASH, 'sysHash preserved from stripped req');
    assert.equal(anchor.agentKey, 'agent', 'agent identity recomputed from rehydrated system');
    assert.equal(anchor.stopReason, 'end_turn', 'stopReason from message_delta');
    assert.ok(anchor.usage && anchor.usage.input_tokens === 100, 'usage from _res via canonical projection');
    assert.equal(anchor.title, 'first question', 'title recovered from last user text');

    const delta = byId.get('2026-06-01T01-00-01-000');
    assert.equal(delta.msgCount, 3, 'full spliced messages');

    const sub = byId.get('2026-06-01T01-00-02-000');
    assert.equal(sub.isSubagent, true);
    assert.equal(sub.sessionInferred, true);
    assert.equal(sub.sessionId, 'S1', 'attributed to the session active just before it');
    assert.equal(sub.cwd, '/home/me/proj', 'cwd backfilled from attributed session');

    // every recovered line uses only canonical INDEX_FIELDS
    const { INDEX_FIELDS } = require('../server/entry');
    for (const o of [anchor, delta, sub]) {
      for (const k of Object.keys(o)) assert.ok(INDEX_FIELDS.includes(k), `unexpected field ${k}`);
    }
  });

  it('apply is idempotent — a second run recovers nothing and leaves the index unchanged', async () => {
    writeShared();
    writeReq('2026-06-01T02-00-00-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'q' }], metadata: { session_id: 'S2' },
    });
    await rebuildIndex({ apply: true, storage, log });
    const after1 = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    const r2 = await rebuildIndex({ apply: true, storage, log });
    assert.equal(r2.recovered, 0);
    const after2 = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    assert.equal(after2, after1, 'second apply is a no-op');
  });

  it('skips non-Anthropic records (OpenAI body + WS transport-only), never emits a bogus line', async () => {
    writeShared();
    // OpenAI/Codex turn (raw `input` body) — must be skipped, not rebuilt as Anthropic.
    writeReq('2026-06-01T03-00-00-000', {
      model: 'gpt-5.5', input: [{ role: 'user', content: 'hi' }], provider: 'openai',
    });
    // WS transport-only record (no payload) — must be skipped.
    writeReq('2026-06-01T03-00-01-000', {
      transport: 'websocket', capture: 'transport-only', headers: { sessionId: 'codex-x' }, metadata: null,
    });
    // A real Anthropic turn alongside them — must be recovered.
    writeReq('2026-06-01T03-00-02-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'real one' }], metadata: { session_id: 'S3' },
    });

    const r = await rebuildIndex({ apply: true, storage, log });
    assert.equal(r.recovered, 1, 'only the Anthropic turn');
    assert.equal(r.unrecoverable, 2, 'OpenAI + WS transport-only skipped');
    const byId = new Map(readIndexIds().map(o => [o.id, o]));
    assert.equal(byId.has('2026-06-01T03-00-00-000'), false, 'OpenAI not emitted');
    assert.equal(byId.has('2026-06-01T03-00-01-000'), false, 'WS transport-only not emitted');
    assert.equal(byId.get('2026-06-01T03-00-02-000').provider, 'anthropic');
  });

  it('recovered lines are written in id order (older orphan sorts before newer existing line)', async () => {
    writeShared();
    // Existing index has a NEWER line; we recover an OLDER orphan → it must sort first.
    writeIndexLine({ id: '2026-06-01T05-00-00-000', sessionId: 'S4', sessionInferred: false, cwd: '/p' });
    writeReq('2026-06-01T04-00-00-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'older' }], metadata: { session_id: 'S4' },
    });
    await rebuildIndex({ apply: true, storage, log });
    const ids = readIndexIds().map(o => o.id);
    assert.deepEqual(ids, ['2026-06-01T04-00-00-000', '2026-06-01T05-00-00-000'], 'sorted by id');
  });

  it('recovers a very old turn (>14 days) — rebuild has no age filter', async () => {
    writeShared();
    // A turn from 2024 — well beyond LOG_RETENTION_DAYS. As long as its
    // _req/_res files survive on disk (e.g. star-protected from prune),
    // rebuild-index must recover it. This locks the guarantee that rebuild
    // scans ALL surviving files regardless of age.
    const oldId = '2024-01-15T10-30-00-000';
    writeReq(oldId, {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'ancient question' }],
      metadata: { session_id: 'S-old' },
    });
    writeRes(oldId, sseEvents());

    const r = await rebuildIndex({ apply: true, storage, log });
    assert.equal(r.recovered, 1);
    const byId = new Map(readIndexIds().map(o => [o.id, o]));
    const old = byId.get(oldId);
    assert.ok(old, 'old turn must be recovered');
    assert.equal(old.sessionId, 'S-old');
    assert.equal(old.title, 'ancient question');
    assert.equal(old.stopReason, 'end_turn');
  });

  it('cache is bounded: 2-session × 3-turn chains evict ancestors after use (OOM fix #82)', async () => {
    writeShared();
    // Session A: 3-turn delta chain (anchor → delta1 → delta2)
    writeReq('2026-06-01T06-00-00-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'A0' }], metadata: { session_id: 'SA' },
    });
    writeRes('2026-06-01T06-00-00-000', sseEvents());
    writeReq('2026-06-01T06-00-01-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T06-00-00-000', msgOffset: 1,
      messages: [{ role: 'assistant', content: 'a1' }, { role: 'user', content: 'A1' }],
      metadata: { session_id: 'SA' },
    });
    writeRes('2026-06-01T06-00-01-000', sseEvents());
    writeReq('2026-06-01T06-00-02-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T06-00-01-000', msgOffset: 3,
      messages: [{ role: 'assistant', content: 'a2' }, { role: 'user', content: 'A2' }],
      metadata: { session_id: 'SA' },
    });
    writeRes('2026-06-01T06-00-02-000', sseEvents());

    // Session B: 3-turn delta chain (anchor → delta1 → delta2)
    writeReq('2026-06-01T07-00-00-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'B0' }], metadata: { session_id: 'SB' },
    });
    writeRes('2026-06-01T07-00-00-000', sseEvents());
    writeReq('2026-06-01T07-00-01-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T07-00-00-000', msgOffset: 1,
      messages: [{ role: 'assistant', content: 'b1' }, { role: 'user', content: 'B1' }],
      metadata: { session_id: 'SB' },
    });
    writeRes('2026-06-01T07-00-01-000', sseEvents());
    writeReq('2026-06-01T07-00-02-000', {
      model: 'claude-x', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-06-01T07-00-01-000', msgOffset: 3,
      messages: [{ role: 'assistant', content: 'b2' }, { role: 'user', content: 'B2' }],
      metadata: { session_id: 'SB' },
    });
    writeRes('2026-06-01T07-00-02-000', sseEvents());

    const r = await rebuildIndex({ apply: true, storage, log });
    assert.equal(r.recovered, 6);

    // Correctness: all delta chains spliced correctly
    const byId = new Map(readIndexIds().map(o => [o.id, o]));
    assert.equal(byId.get('2026-06-01T06-00-02-000').msgCount, 5, 'SA chain: 1+2+2');
    assert.equal(byId.get('2026-06-01T07-00-02-000').msgCount, 5, 'SB chain: 1+2+2');

    // OOM proxy: after eviction, cache should be empty — every entry was either
    // projected (and deleted if no downstream refs) or consumed as an ancestor
    // (and deleted when last child finished). Old code: cache.size === 6.
    assert.equal(r.cacheFinalSize, 0, 'cache fully evicted after rebuild (OOM fix #82)');
  });

  it('refuses to run while a live hub holds the index', async () => {
    hub.readHubLock = () => ({ pid: process.pid, port: 5577 }); // our own pid is alive
    try {
      const r = await rebuildIndex({ apply: true, storage, log });
      assert.equal(r.refused, true);
    } finally {
      hub.readHubLock = () => null;
    }
  });
});
