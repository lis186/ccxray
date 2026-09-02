'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = require('../server/store');
const hub = require('../server/hub');
const { createLocalStorage } = require('../server/storage/local');
const { rebuildIndex } = require('../server/rebuild-index');

// #438: `ccxray rebuild-index` backfills the per-turn turnToolFail field onto
// legacy lines from the surviving _req.json (the field derives from the
// request's last user message, unlike turnToolCalls which comes from _res).
// Same injectable-storage isolation pattern as test/rebuild-index.test.js.
describe('#438 turnToolFail backfill in rebuild-index', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-ttf-backfill-' + process.pid);
  let storage;
  let realReadHubLock;
  const logs = [];
  const log = (m) => logs.push(m);

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
    realReadHubLock = hub.readHubLock;
    hub.readHubLock = () => null; // no live hub
    process.env.CCXRAY_SKIP_RECENCY_CHECK = '1';
  });

  after(() => {
    hub.readHubLock = realReadHubLock;
    delete process.env.CCXRAY_SKIP_RECENCY_CHECK;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logs.length = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
    for (const sid of Object.keys(store.sessionMeta)) delete store.sessionMeta[sid];
  });

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
  function sseEvents() {
    return [
      { type: 'message_start', message: { id: 'msg_01ORPHAN', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ];
  }
  function readIndexLines() {
    const c = fs.readFileSync(path.join(tmpDir, 'index.ndjson'), 'utf8');
    return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  const failResult = { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' };
  const okResult = { type: 'tool_result', tool_use_id: 't2', content: 'ok' };

  it('backfills turnToolFail from the last user message; per-turn, not cumulative', async () => {
    // Last user message carries a failing tool_result → true.
    const idFail = '2026-07-01T10-00-00-000';
    writeReq(idFail, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [failResult] },
      ],
      metadata: { session_id: 'S1' },
    });
    writeIndexLine({ id: idFail, ts: '10:00:00', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 3 });

    // Old failure earlier in history, clean LAST user message → false (the
    // #427-class cumulative bug would say true).
    const idClean = '2026-07-01T11-00-00-000';
    writeReq(idClean, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [
        { role: 'user', content: [failResult] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
        { role: 'user', content: [okResult] },
      ],
      metadata: { session_id: 'S1' },
    });
    writeIndexLine({ id: idClean, ts: '11:00:00', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 3 });

    // _req pruned → untouched (key stays absent, honest legacy).
    const idPruned = '2026-07-01T12-00-00-000';
    writeIndexLine({ id: idPruned, ts: '12:00:00', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 1 });

    // Already-populated value → gate skips, never overwritten (add-only).
    const idHave = '2026-07-01T13-00-00-000';
    writeReq(idHave, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: [okResult] }],
      metadata: { session_id: 'S1' },
    });
    writeIndexLine({ id: idHave, ts: '13:00:00', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 1, turnToolFail: true });

    // OpenAI line → exempt even with a _req on disk.
    const idO = '2026-07-01T14-00-00-000';
    writeReq(idO, { model: 'gpt-5', messages: [{ role: 'user', content: [failResult] }] });
    writeIndexLine({ id: idO, ts: '14:00:00', sessionId: 'S1', provider: 'openai', model: 'gpt-5', isSSE: true, status: 200, convId: 'cv', msgCount: 1 });

    const res = await rebuildIndex({ apply: true, storage, log });
    assert.equal(res.refused, false);

    const lines = readIndexLines();
    assert.equal(lines.find(l => l.id === idFail).turnToolFail, true, 'failing last turn → true');
    assert.equal(lines.find(l => l.id === idClean).turnToolFail, false, 'clean last turn → false despite older failure');
    assert.ok(!('turnToolFail' in lines.find(l => l.id === idPruned)), 'pruned-_req line untouched');
    assert.equal(lines.find(l => l.id === idHave).turnToolFail, true, 'existing value not overwritten');
    assert.ok(!('turnToolFail' in lines.find(l => l.id === idO)), 'openai line exempt');
    assert.ok(logs.some(m => /backfilled turnToolFail onto 2 legacy line\(s\) \(#438\)/.test(m)), 'log reports the backfill count');
  });

  it('backfills from a delta _req: the stored tail ends with the turn\'s last user message', async () => {
    const idDelta = '2026-07-02T10-00-01-000';
    writeReq(idDelta, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      prevId: '2026-07-02T10-00-00-000', msgOffset: 2,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [failResult] },
      ],
      metadata: { session_id: 'S1' },
    });
    // No prevId file on disk — the backfill reads the delta tail directly,
    // no chain reconstruction needed.
    writeIndexLine({ id: idDelta, ts: '10:00:01', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 4 });

    const res = await rebuildIndex({ apply: true, storage, log });
    assert.equal(res.refused, false);
    assert.equal(readIndexLines().find(l => l.id === idDelta).turnToolFail, true, 'delta tail carries the failing last user message');
  });

  it('the backfill alone flips hasChanges: index is rewritten with the new key', async () => {
    // No orphans, no other enrichment candidates — only turnToolFail.
    const id = '2026-07-03T10-00-00-000';
    writeReq(id, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: [okResult] }],
      metadata: { session_id: 'S1' },
    });
    writeIndexLine({ id, ts: '10:00:00', sessionId: 'S1', provider: 'anthropic', model: 'claude-opus-4-7', isSSE: true, status: 200, convId: 'cv', msgCount: 1, coreHash: 'x', agentKey: 'k', agentLabel: 'K', isSubagent: false, responseId: 'msg_01X', turnToolCalls: {} });

    const res = await rebuildIndex({ apply: true, storage, log });
    assert.equal(res.refused, false);
    assert.equal(readIndexLines().find(l => l.id === id).turnToolFail, false, 'checked-clean false persisted');
  });

  it('orphan recovery carries turnToolFail via buildEntryFields (no separate wiring)', async () => {
    writeShared();
    // Anchor line so orphan session attribution has a timeline.
    writeIndexLine({ id: '2026-07-04T09-00-00-000', sessionId: 'S1', sessionInferred: false, provider: 'anthropic', cwd: '/home/me/proj', convId: 'cv', msgCount: 1, turnToolFail: false });

    // Orphan with a failing last user message.
    const idOrphanFail = '2026-07-04T10-00-00-000';
    writeReq(idOrphanFail, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [failResult] },
      ],
      metadata: { session_id: 'S1' },
    });
    writeRes(idOrphanFail, sseEvents());

    // Clean orphan → explicit false (checked-clean, not legacy-absent).
    const idOrphanClean = '2026-07-04T11-00-00-000';
    writeReq(idOrphanClean, {
      model: 'claude-opus-4-7', max_tokens: 100, sysHash: SYS_HASH,
      messages: [{ role: 'user', content: 'plain question' }],
      metadata: { session_id: 'S1' },
    });

    const res = await rebuildIndex({ apply: true, storage, log });
    assert.equal(res.refused, false);
    assert.equal(res.recovered, 2);

    const lines = readIndexLines();
    assert.equal(lines.find(l => l.id === idOrphanFail).turnToolFail, true, 'recovered orphan carries true');
    // #486: no tool_result blocks → undefined (no-tools ≠ checked-clean)
    assert.equal(lines.find(l => l.id === idOrphanClean).turnToolFail, undefined, 'recovered no-tool orphan carries undefined');
  });
});
