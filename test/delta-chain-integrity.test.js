'use strict';

// #774: delta chains must not silently truncate. Covers the shared disk resolver
// (server/delta-helpers.js), the lazy-load fallback + req.incomplete marker
// (server/restore.js loadEntryReqRes), and the prune re-anchor (pruneLogs).
// Hermetic: temp CCXRAY_HOME + temp logs dir, synthetic messages only.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-delta-chain-home-'));
process.env.CCXRAY_HOME = TEST_HOME;
after(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { loadEntryReqRes, pruneLogs } = require('../server/restore');
const { resolveChainMessages, spliceDelta } = require('../server/delta-helpers');

const msg = (role, text) => ({ role, content: text });
const ANCHOR = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')];
const D1 = [msg('assistant', 'd'), msg('user', 'e')];
const D2 = [msg('assistant', 'f'), msg('user', 'g')];

describe('#774 delta chain integrity', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-delta-chain-' + process.pid);
  let storage, origStorage, origRetention;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
    origStorage = config.storage;
    origRetention = config.LOG_RETENTION_DAYS;
    config.storage = storage;
    config.LOG_RETENTION_DAYS = 14;
  });

  after(() => {
    config.storage = origStorage;
    config.LOG_RETENTION_DAYS = origRetention;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });
    store.entries.length = 0;
  });

  const rec = (extra) => ({ model: 'm', max_tokens: 100, ...extra });
  const writeReq = (id, body) => storage.write(id, '_req.json', JSON.stringify(body));
  const writeRes = (id) => storage.write(id, '_res.json', '[]');
  // A cold entry: exactly what loadColdEntry builds — not in store.entries.
  const coldEntry = (id) => ({ id, req: null, res: null, _loaded: false });
  const inMemory = (id) => { const e = coldEntry(id); store.entries.push(e); return e; };
  const exists = (id, suffix = '_req.json') => fs.existsSync(path.join(tmpDir, id + suffix));
  const todayId = (n) => new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '-' + String(n).padStart(3, '0');
  const writeIndex = (ids) => fs.writeFileSync(
    path.join(tmpDir, 'index.ndjson'),
    ids.map(id => JSON.stringify({ id, sessionId: 's1', cwd: '/tmp/p' })).join('\n') + '\n');

  describe('lazy load', () => {
    it('reconstructs a delta whose ancestor is on disk but not in memory (cold path)', async () => {
      await writeReq('anchor-1', rec({ messages: ANCHOR }));
      await writeReq('delta-2', rec({ prevId: 'anchor-1', msgOffset: 3, messages: D1 }));
      await writeReq('delta-3', rec({ prevId: 'delta-2', msgOffset: 5, messages: D2 }));
      await writeRes('delta-3');

      const entry = coldEntry('delta-3');
      await loadEntryReqRes(entry);

      assert.deepEqual(entry.req.messages, [...ANCHOR, ...D1, ...D2]);
      assert.equal(entry.req.incomplete, undefined);
    });

    it('marks req.incomplete when the ancestor file is gone', async () => {
      await writeReq('delta-orphan', rec({ prevId: 'pruned-anchor', msgOffset: 5, messages: D1 }));
      const entry = coldEntry('delta-orphan');
      await loadEntryReqRes(entry);

      assert.deepEqual(entry.req.messages, D1);
      assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'pruned-anchor', msgOffset: 5 });
      assert.ok(!('prevId' in entry.req));
      assert.ok(!('msgOffset' in entry.req));
    });

    it('reports the BROKEN link, not the child, when the gap is deeper in the chain', async () => {
      // delta-1 (offset 3) lost its anchor; delta-2 (offset 5) chains to delta-1.
      await writeReq('delta-1', rec({ prevId: 'gone', msgOffset: 3, messages: D1 }));
      await writeReq('delta-2', rec({ prevId: 'delta-1', msgOffset: 5, messages: D2 }));

      const entry = coldEntry('delta-2');
      await loadEntryReqRes(entry);

      // absolute messages 3..8 survive; the first 3 are unavailable.
      assert.deepEqual(entry.req.messages, [...D1, ...D2]);
      assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'gone', msgOffset: 3 });
    });

    it('propagates incompleteness through an in-memory ancestor', async () => {
      await writeReq('delta-1', rec({ prevId: 'gone', msgOffset: 3, messages: D1 }));
      await writeReq('delta-2', rec({ prevId: 'delta-1', msgOffset: 5, messages: D2 }));
      inMemory('delta-1');
      const entry = inMemory('delta-2');
      await loadEntryReqRes(entry);

      assert.deepEqual(entry.req.messages, [...D1, ...D2]);
      assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'gone', msgOffset: 3 });
    });

    it('a complete chain through memory carries no marker', async () => {
      await writeReq('anchor-1', rec({ messages: ANCHOR }));
      await writeReq('delta-2', rec({ prevId: 'anchor-1', msgOffset: 3, messages: D1 }));
      inMemory('anchor-1');
      const entry = inMemory('delta-2');
      await loadEntryReqRes(entry);
      assert.deepEqual(entry.req.messages, [...ANCHOR, ...D1]);
      assert.equal(entry.req.incomplete, undefined);
    });
  });

  describe('resolveChainMessages', () => {
    it('returns null when the id itself is unreadable', async () => {
      assert.equal(await resolveChainMessages(storage, 'nope'), null);
    });

    it('treats a prevId cycle as a broken link instead of looping', async () => {
      await writeReq('c-1', rec({ prevId: 'c-2', msgOffset: 1, messages: D1 }));
      await writeReq('c-2', rec({ prevId: 'c-1', msgOffset: 1, messages: D2 }));
      const st = await resolveChainMessages(storage, 'c-2');
      assert.ok(st.missing, 'cycle must surface as an incomplete chain');
    });

    it('treats a chain deeper than maxDepth as broken', async () => {
      await writeReq('d-0', rec({ messages: ANCHOR }));
      await writeReq('d-1', rec({ prevId: 'd-0', msgOffset: 3, messages: D1 }));
      await writeReq('d-2', rec({ prevId: 'd-1', msgOffset: 5, messages: D2 }));
      const ok = await resolveChainMessages(storage, 'd-2');
      assert.equal(ok.missing, null);
      const shallow = await resolveChainMessages(storage, 'd-2', { maxDepth: 2 });
      assert.ok(shallow.missing);
    });

    it('memoizes through the cache without changing results', async () => {
      await writeReq('m-0', rec({ messages: ANCHOR }));
      await writeReq('m-1', rec({ prevId: 'm-0', msgOffset: 3, messages: D1 }));
      const cache = new Map();
      const a = await resolveChainMessages(storage, 'm-1', { cache });
      assert.ok(cache.has('m-0') && cache.has('m-1'));
      fs.unlinkSync(path.join(tmpDir, 'm-0_req.json')); // cache must answer without disk
      const b = await resolveChainMessages(storage, 'm-1', { cache });
      assert.deepEqual(b, a);
    });

    it('spliceDelta places messages by absolute offset', () => {
      const parent = { messages: [msg('user', 'x'), msg('assistant', 'y')], base: 3, missing: { prevId: 'p', msgOffset: 3 } };
      const st = spliceDelta(parent, { prevId: 'q', msgOffset: 5, messages: [msg('user', 'z')] });
      assert.deepEqual(st.messages.map(m => m.content), ['x', 'y', 'z']);
      assert.equal(st.base, 3);
      assert.deepEqual(st.missing, { prevId: 'p', msgOffset: 3 });
    });
  });

  describe('prune re-anchor', () => {
    const OLD_A = '2020-01-01T00-00-00-000';
    const OLD_B = '2020-01-01T00-00-01-000';

    async function seedChain() {
      await writeReq(OLD_A, rec({ messages: ANCHOR, sysHash: null }));
      await writeReq(OLD_B, rec({ prevId: OLD_A, msgOffset: 3, messages: D1 }));
      for (const id of [OLD_A, OLD_B]) await writeRes(id);
    }

    it('rewrites a kept delta to FULL, byte-equal to the pre-prune reconstruction, then deletes the ancestor', async () => {
      await seedChain();
      const child = todayId(1);
      await writeReq(child, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      await writeRes(child);
      writeIndex([OLD_A, OLD_B, child]);

      const before = coldEntry(child);
      await loadEntryReqRes(before);
      const preMessages = JSON.stringify(before.req.messages);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(OLD_A), false, 'ancestor anchor deleted');
      assert.equal(exists(OLD_B), false, 'ancestor delta deleted');
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'));
      assert.ok(!('prevId' in onDisk) && !('msgOffset' in onDisk), 'child is a full record');
      assert.equal(JSON.stringify(onDisk.messages), preMessages);
      assert.equal(onDisk.model, 'm');

      const after = coldEntry(child);
      await loadEntryReqRes(after);
      assert.equal(JSON.stringify(after.req.messages), preMessages);
      assert.equal(after.req.incomplete, undefined);
      assert.deepEqual(fs.readdirSync(tmpDir).filter(f => f.includes('.reanchor-')), [], 'no tmp left behind');
    });

    it('re-anchors an in-memory (protected) old child as well', async () => {
      await seedChain();
      const child = '2020-01-02T00-00-00-000';
      await writeReq(child, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      await writeRes(child);
      inMemory(child);
      writeIndex([OLD_A, OLD_B, child]);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(OLD_B), false);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'));
      assert.deepEqual(onDisk.messages, [...ANCHOR, ...D1, ...D2]);
      assert.ok(!('prevId' in onDisk));
    });

    it('keeps the ancestor and logs why when the re-anchor cannot be verified', async () => {
      // OLD_B's own anchor is already gone → the child's chain is incomplete → nothing to verify against.
      await writeReq(OLD_B, rec({ prevId: OLD_A, msgOffset: 3, messages: D1 }));
      await writeRes(OLD_B);
      const child = todayId(2);
      const childBody = rec({ prevId: OLD_B, msgOffset: 5, messages: D2 });
      await writeReq(child, childBody);
      writeIndex([OLD_B, child]);

      const errors = [];
      const origErr = console.error;
      console.error = (...a) => { errors.push(a.join(' ')); };
      try { await pruneLogs({ retentionDays: 14 }); } finally { console.error = origErr; }

      assert.equal(exists(OLD_B), true, 'ancestor kept');
      assert.equal(exists(OLD_B, '_res.json'), true, 'ancestor _res kept with it');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8')), childBody, 'child untouched');
      assert.ok(errors.some(l => l.includes(OLD_B) && l.includes(child) && /incomplete/.test(l)), errors.join('\n'));
    });

    it('cascades: a kept ancestor whose own head is doomed is handled the same way', async () => {
      // Z (missing) ← Q ← P (both old, unprotected) ← C (kept). C can't be verified → P kept → P can't → Q kept.
      const Q = '2020-01-01T00-00-00-000', P = '2020-01-01T00-00-01-000';
      await writeReq(Q, rec({ prevId: 'missing-Z', msgOffset: 3, messages: D1 }));
      await writeReq(P, rec({ prevId: Q, msgOffset: 5, messages: D2 }));
      const child = todayId(3);
      await writeReq(child, rec({ prevId: P, msgOffset: 7, messages: [msg('user', 'h')] }));
      writeIndex([Q, P, child]);

      const origErr = console.error;
      console.error = () => {};
      try { await pruneLogs({ retentionDays: 14 }); } finally { console.error = origErr; }

      assert.equal(exists(P), true);
      assert.equal(exists(Q), true);
    });

    it('leaves an unreferenced old record alone to be pruned as before', async () => {
      await writeReq(OLD_A, rec({ messages: ANCHOR }));
      await writeRes(OLD_A);
      const keep = todayId(5);
      await writeReq(keep, rec({ messages: ANCHOR })); // full, no chain
      writeIndex([OLD_A, keep]);
      await pruneLogs({ retentionDays: 14 });
      assert.equal(exists(OLD_A), false);
      assert.equal(exists(keep), true);
    });
  });
});
