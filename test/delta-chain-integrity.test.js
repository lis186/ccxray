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
const { loadEntryReqRes, pruneLogs, findChainChildren, sweepOrphanedPruneTmpFiles, fsyncDir } = require('../server/restore');
const { reconstructReq } = require('../server/rebuild-index');
const {
  resolveChainMessages, spliceDelta, classifyReqHead, deltaAncestorTooOld, shouldForceFullRecord,
  ChainReadError, writerRetentionDays, _resetWriterRetentionCache,
} = require('../server/delta-helpers');

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

  describe('lazy load hardening', () => {
    it('does not hang on an in-memory prevId cycle; returns incomplete', async () => {
      await writeReq('cyc-a', rec({ prevId: 'cyc-b', msgOffset: 1, messages: D1 }));
      await writeReq('cyc-b', rec({ prevId: 'cyc-a', msgOffset: 1, messages: D2 }));
      const a = inMemory('cyc-a');
      inMemory('cyc-b');
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('loadEntryReqRes hung on a cycle')), 3000));
      await Promise.race([loadEntryReqRes(a), timeout]);
      assert.ok(a.req.incomplete, 'a cycle surfaces as an incomplete chain');
    });

    it('marks incomplete when the delta offset leaves a gap past the parent', async () => {
      await writeReq('gap-0', rec({ messages: ANCHOR })); // covers absolute 0..2
      await writeReq('gap-1', rec({ prevId: 'gap-0', msgOffset: 10, messages: D1 }));
      const entry = coldEntry('gap-1');
      await loadEntryReqRes(entry);
      assert.deepEqual(entry.req.messages, D1, 'non-contiguous parent history is not spliced');
      assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'gap-0', msgOffset: 10 });
    });

    it('marks incomplete for a corrupt (negative / non-integer) msgOffset', async () => {
      await writeReq('bad-0', rec({ messages: ANCHOR }));
      await writeReq('bad-1', rec({ prevId: 'bad-0', msgOffset: -2, messages: D1 }));
      await writeReq('bad-2', rec({ prevId: 'bad-0', msgOffset: '3', messages: D1 }));
      for (const id of ['bad-1', 'bad-2']) {
        const entry = coldEntry(id);
        await loadEntryReqRes(entry);
        assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'bad-0', msgOffset: null }, id + ': alignment is unknown, not 0');
        assert.deepEqual(entry.req.messages, D1, id);
      }
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

    it('spliceDelta rejects an offset beyond parent coverage, below its base, or corrupt', () => {
      const parent = { messages: [msg('user', 'x'), msg('assistant', 'y')], base: 3, missing: null };
      const own = [msg('user', 'z')];
      const gap = spliceDelta(parent, { prevId: 'p', msgOffset: 9, messages: own });
      assert.deepEqual(gap, { messages: own, base: 9, missing: { prevId: 'p', msgOffset: 9 } });
      const below = spliceDelta(parent, { prevId: 'p', msgOffset: 1, messages: own });
      assert.equal(below.base, 1);
      assert.ok(below.missing);
      for (const bad of [-1, 1.5, '3', NaN]) {
        const st = spliceDelta(parent, { prevId: 'p', msgOffset: bad, messages: own });
        assert.deepEqual(st.messages, own);
        assert.ok(st.missing, String(bad));
      }
      // exactly adjacent is contiguous and stays complete
      const ok = spliceDelta({ messages: [msg('user', 'x')], base: 0, missing: null }, { prevId: 'p', msgOffset: 1, messages: own });
      assert.equal(ok.missing, null);
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

    // Option C: a kept child whose chain is ALREADY truncated is rewritten as a
    // full record of what is resolvable + a persisted marker, so the ancestor can go.
    async function seedIncompleteChild(childId) {
      // OLD_A (anchor) is gone; OLD_B is a delta on it; the child is a delta on OLD_B.
      await writeReq(OLD_B, rec({ prevId: OLD_A, msgOffset: 3, messages: D1 }));
      await writeRes(OLD_B);
      await writeReq(childId, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      await writeRes(childId);
    }

    it('rewrites an already-incomplete child as a full record with a persisted marker, then deletes the ancestor', async () => {
      const child = todayId(2);
      await seedIncompleteChild(child);
      writeIndex([OLD_B, child]);

      const before = coldEntry(child);
      await loadEntryReqRes(before);
      assert.deepEqual(before.req.incomplete, { reason: 'missing-ancestor', prevId: OLD_A, msgOffset: 3 });
      const preMessages = JSON.stringify(before.req.messages);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(OLD_B), false, 'ancestor deleted');
      assert.equal(exists(OLD_B, '_res.json'), false);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'));
      assert.ok(!('prevId' in onDisk) && !('msgOffset' in onDisk));
      assert.equal(JSON.stringify(onDisk.messages), preMessages, 'exactly the resolvable messages');
      assert.deepEqual(onDisk.incomplete, { reason: 'missing-ancestor', prevId: OLD_A, msgOffset: 3, persisted: true });

      // The marker survives the rewrite: lazy load surfaces it like a live one.
      const after = coldEntry(child);
      await loadEntryReqRes(after);
      assert.equal(JSON.stringify(after.req.messages), preMessages);
      assert.equal(after.req.incomplete.reason, 'missing-ancestor');
      assert.equal(after.req.incomplete.msgOffset, 3);
      assert.equal(after.req.incomplete.prevId, OLD_A);
      assert.deepEqual(fs.readdirSync(tmpDir).filter(f => f.includes('.reanchor-')), []);
    });

    it('a delta chained onto a persisted-incomplete record stays aligned and marked', async () => {
      const child = todayId(3);
      await seedIncompleteChild(child);
      writeIndex([OLD_B, child]);
      await pruneLogs({ retentionDays: 14 });

      // child now holds absolute messages 3..6; a later turn appends one at offset 7.
      const next = todayId(4);
      await writeReq(next, rec({ prevId: child, msgOffset: 7, messages: [msg('user', 'h')] }));
      const entry = coldEntry(next);
      await loadEntryReqRes(entry);
      assert.deepEqual(entry.req.messages, [...D1, ...D2, msg('user', 'h')]);
      assert.equal(entry.req.incomplete.msgOffset, 3);
      assert.equal(entry.req.incomplete.prevId, OLD_A);
    });

    it('rebuild-index treats a persisted-incomplete record as unrecoverable', async () => {
      const child = todayId(5);
      await seedIncompleteChild(child);
      writeIndex([OLD_B, child]);
      await pruneLogs({ retentionDays: 14 });
      assert.equal(await reconstructReq(child, storage, new Map()), null);
    });

    it('cascades: Z(missing) <- Q <- P (old) <- C (kept) collapses into one persisted-incomplete record', async () => {
      const Q = '2020-01-01T00-00-00-000', P = '2020-01-01T00-00-01-000';
      await writeReq(Q, rec({ prevId: 'missing-Z', msgOffset: 3, messages: D1 }));
      await writeReq(P, rec({ prevId: Q, msgOffset: 5, messages: D2 }));
      const child = todayId(6);
      await writeReq(child, rec({ prevId: P, msgOffset: 7, messages: [msg('user', 'h')] }));
      writeIndex([Q, P, child]);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(P), false);
      assert.equal(exists(Q), false);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'));
      assert.deepEqual(onDisk.messages, [...D1, ...D2, msg('user', 'h')]);
      assert.deepEqual(onDisk.incomplete, { reason: 'missing-ancestor', prevId: 'missing-Z', msgOffset: 3, persisted: true });
    });

    it('keeps the ancestor and logs why when the source changes during the re-anchor (CAS)', async () => {
      const child = todayId(7);
      await seedIncompleteChild(child);
      writeIndex([OLD_B, child]);
      const childPath = path.join(tmpDir, child + '_req.json');
      const origRead = storage.read;
      let mutated = false;
      storage.read = async function (id, suffix) {
        const r = await origRead.call(this, id, suffix);
        if (id === OLD_B && !mutated) { mutated = true; fs.appendFileSync(childPath, ' '); } // a concurrent writer
        return r;
      };
      const errors = [];
      const origErr = console.error;
      console.error = (...a) => { errors.push(a.join(' ')); };
      try { await pruneLogs({ retentionDays: 14 }); } finally { console.error = origErr; storage.read = origRead; }

      assert.equal(exists(OLD_B), true, 'ancestor kept');
      assert.equal(exists(OLD_B, '_res.json'), true);
      assert.ok(JSON.parse(fs.readFileSync(childPath, 'utf8')).prevId, 'child still a delta');
      assert.ok(errors.some(l => l.includes(OLD_B) && l.includes(child) && /source changed/.test(l)), errors.join('\n'));
      assert.deepEqual(fs.readdirSync(tmpDir).filter(f => f.includes('.reanchor-')), []);
    });

    it('re-anchors a kept child whose id sorts BEFORE its ancestor (clock rollback)', async () => {
      await seedChain();
      const rolledBack = '2019-12-31T23-59-59-000'; // protected via memory, lexically older than OLD_A
      await writeReq(rolledBack, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      await writeRes(rolledBack);
      inMemory(rolledBack);
      writeIndex([OLD_A, OLD_B, rolledBack]);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(OLD_B), false);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, rolledBack + '_req.json'), 'utf8'));
      assert.deepEqual(onDisk.messages, [...ANCHOR, ...D1, ...D2]);
      assert.ok(!('prevId' in onDisk));
    });

    it('re-anchors every sibling of one expired ancestor (fork)', async () => {
      await seedChain();
      const kids = [todayId(20), todayId(21)];
      await writeReq(kids[0], rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      await writeReq(kids[1], rec({ prevId: OLD_B, msgOffset: 5, messages: [msg('user', 'other branch')] }));
      writeIndex([OLD_A, OLD_B, ...kids]);

      await pruneLogs({ retentionDays: 14 });

      assert.equal(exists(OLD_B), false);
      const m0 = JSON.parse(fs.readFileSync(path.join(tmpDir, kids[0] + '_req.json'), 'utf8')).messages;
      const m1 = JSON.parse(fs.readFileSync(path.join(tmpDir, kids[1] + '_req.json'), 'utf8')).messages;
      assert.deepEqual(m0, [...ANCHOR, ...D1, ...D2]);
      assert.deepEqual(m1, [...ANCHOR, ...D1, msg('user', 'other branch')]);
    });

    it('deletes NO expired log when a candidate cannot be classified; logs once', async () => {
      await seedChain();
      const child = todayId(22);
      await writeReq(child, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      fs.mkdirSync(path.join(tmpDir, todayId(23) + '_req.json')); // unreadable candidate (EISDIR)
      writeIndex([OLD_A, OLD_B, child]);

      const errors = [];
      const origErr = console.error;
      console.error = (...a) => { errors.push(a.join(' ')); };
      try { await pruneLogs({ retentionDays: 14 }); } finally { console.error = origErr; }

      for (const id of [OLD_A, OLD_B]) {
        assert.equal(exists(id), true, id + ' kept');
        assert.equal(exists(id, '_res.json'), true, id + ' _res kept');
      }
      assert.equal(errors.filter(l => /could not classify/.test(l)).length, 1, errors.join('\n'));
      assert.ok(JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8')).prevId, 'child untouched');
    });

    it('fsyncs the rewritten file, then the directory, before any ancestor is deleted', async () => {
      await seedChain();
      const child = todayId(24);
      await writeReq(child, rec({ prevId: OLD_B, msgOffset: 5, messages: D2 }));
      writeIndex([OLD_A, OLD_B, child]);
      const events = [];
      const realFsync = fs.fsyncSync, realRename = fs.renameSync, realOpen = fs.openSync;
      const dirFds = new Set();
      fs.openSync = function (p, ...rest) { const fd = realOpen.call(this, p, ...rest); if (p === tmpDir) dirFds.add(fd); return fd; };
      fs.fsyncSync = function (fd) { events.push(dirFds.has(fd) ? 'fsync-dir' : 'fsync-file'); return realFsync.call(this, fd); };
      fs.renameSync = function (a, b) { events.push('rename'); return realRename.call(this, a, b); };
      const origDelete = storage.deleteFile;
      storage.deleteFile = async function (f) { events.push('delete'); return origDelete.call(this, f); };
      try { await pruneLogs({ retentionDays: 14 }); } finally {
        fs.fsyncSync = realFsync; fs.renameSync = realRename; fs.openSync = realOpen; storage.deleteFile = origDelete;
      }
      const firstDelete = events.indexOf('delete');
      assert.ok(firstDelete > 0);
      const before = events.slice(0, firstDelete);
      assert.deepEqual(before.slice(0, 3), ['fsync-file', 'rename', 'fsync-dir']);
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

  describe('writer rule: no new delta onto an ancestor prune could reach', () => {
    const NOW = new Date('2026-11-20T12:00:00+08:00');
    const idDaysAgo = (n) => new Date(NOW.getTime() - n * 86400000 - 3600000).toISOString().slice(0, 10) + 'T10-00-00-000';

    it('forces a full record once the previous record is older than floor(retention/2) days', () => {
      assert.equal(deltaAncestorTooOld(idDaysAgo(0), 14, NOW), false);
      assert.equal(deltaAncestorTooOld(idDaysAgo(6), 14, NOW), false);
      assert.equal(deltaAncestorTooOld(idDaysAgo(8), 14, NOW), true);
      assert.equal(deltaAncestorTooOld(idDaysAgo(2), 4, NOW), false);
      assert.equal(deltaAncestorTooOld(idDaysAgo(3), 4, NOW), true);
    });

    it('uses a 1-day minimum window, and never forces when retention is off', () => {
      assert.equal(deltaAncestorTooOld(idDaysAgo(0), 1, NOW), false);
      assert.equal(deltaAncestorTooOld(idDaysAgo(2), 1, NOW), true);
      for (const off of [0, -1, NaN, undefined]) assert.equal(deltaAncestorTooOld(idDaysAgo(300), off, NOW), false, String(off));
    });

    it('shouldForceFullRecord keeps its other triggers and adds the age rule', () => {
      const fresh = { id: idDaysAgo(0), deltaCount: 1 };
      assert.equal(shouldForceFullRecord(undefined, { retentionDays: 14, now: NOW }), true);
      assert.equal(shouldForceFullRecord(fresh, { retentionDays: 14, now: NOW }), false);
      assert.equal(shouldForceFullRecord(fresh, { snapshotN: 1, retentionDays: 14, now: NOW }), true);
      assert.equal(shouldForceFullRecord({ id: idDaysAgo(10), deltaCount: 1 }, { retentionDays: 14, now: NOW }), true);
      assert.equal(shouldForceFullRecord({ id: idDaysAgo(10), deltaCount: 1 }, { retentionDays: 0, now: NOW }), false);
    });

    it('server/index.js routes the writer decision through shouldForceFullRecord', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
      assert.match(src, /shouldForceFullRecord\(prev,\s*\{[^}]*retentionDays:\s*writerRetentionDays\(config\.LOG_RETENTION_DAYS\)/);
    });
  });

  describe('findChainChildren (head-only scan)', () => {
    const ANC = '2020-01-01T00-00-00-000';
    const scan = (ids, doomed = [ANC]) => findChainChildren(ids.map(i => i + '_req.json'), new Set(doomed));

    it('finds deltas by head and never reads a full record in full', async () => {
      const reads = [];
      const origRead = storage.read;
      storage.read = async function (id, suffix) { reads.push(id); return origRead.call(this, id, suffix); };
      try {
        const delta = todayId(10), full = todayId(11);
        await writeReq(delta, rec({ prevId: ANC, msgOffset: 3, messages: D1 }));
        await writeReq(full, rec({ messages: ANCHOR }));
        const { children, failed } = await scan([delta, full]);
        assert.equal(failed, null);
        assert.deepEqual(children.map(k => k.id), [delta]);
        assert.deepEqual(reads, [delta], 'the full record was classified from its head alone');
      } finally { storage.read = origRead; }
    });

    it('falls back to a full read when extra params push the keys past the head window', async () => {
      const delta = todayId(12);
      await writeReq(delta, rec({ pad: 'x'.repeat(20000), prevId: ANC, msgOffset: 3, messages: D1 }));
      assert.deepEqual((await scan([delta])).children.map(k => k.id), [delta]);
    });

    it('is not fooled by a NESTED messages/prevId key in an extra param', async () => {
      const delta = todayId(13), full = todayId(14);
      // nested "messages" ahead of the real prevId must not make the delta look full
      await writeReq(delta, rec({ extra: { messages: [], prevId: 'nested' }, prevId: ANC, msgOffset: 3, messages: D1 }));
      // a nested prevId inside a message must not make the full record look like a delta
      await writeReq(full, rec({ messages: [{ role: 'user', content: '"prevId":"x"', prevId: ANC }] }));
      const { children } = await scan([delta, full]);
      assert.deepEqual(children.map(k => k.id), [delta]);
    });

    it('ignores deltas whose chain head is not doomed', async () => {
      const keepHead = todayId(15);
      await writeReq(keepHead, rec({ prevId: 'someone-else', msgOffset: 3, messages: D1 }));
      assert.deepEqual((await scan([keepHead])).children, []);
    });

    it('does NOT trust id order: a child whose id sorts BEFORE its ancestor is still found (clock rollback)', async () => {
      const rolledBack = '2019-12-31T23-59-59-000'; // lexically older than ANC
      await writeReq(rolledBack, rec({ prevId: ANC, msgOffset: 3, messages: D1 }));
      assert.deepEqual((await scan([rolledBack])).children.map(k => k.id), [rolledBack]);
    });

    it('reports failure on an unreadable candidate, but not on a vanished or empty one', async () => {
      const dirAsFile = todayId(16);
      fs.mkdirSync(path.join(tmpDir, dirAsFile + '_req.json')); // read fails with EISDIR, not ENOENT
      assert.match((await scan([dirAsFile])).failed, new RegExp(dirAsFile));

      const empty = todayId(17);
      fs.writeFileSync(path.join(tmpDir, empty + '_req.json'), '');
      assert.equal((await scan([empty, 'vanished-id'])).failed, null);

      const truncated = todayId(18);
      fs.writeFileSync(path.join(tmpDir, truncated + '_req.json'), '{"mod');
      assert.match((await scan([truncated])).failed, new RegExp(truncated));
    });
  });

  describe('classifyReqHead', () => {
    it('counts only depth-1 keys', () => {
      assert.equal(classifyReqHead('{"a":{"messages":1,"prevId":2},"prevId":"p","msgOffset":3,"messages":[]}'), 'delta');
      assert.equal(classifyReqHead('{"model":"m","messages":[{"prevId":"x"}]}'), 'full');
      assert.equal(classifyReqHead('{"s":"say \\"prevId\\": hi","messages":[]}'), 'full');
      assert.equal(classifyReqHead('{"model":"messages","prevId":"p"'), 'delta');
    });
    it('is unknown when neither depth-1 key is in the head', () => {
      assert.equal(classifyReqHead(''), 'unknown');
      assert.equal(classifyReqHead('{"pad":"xxxx'), 'unknown');
      assert.equal(classifyReqHead('{"a":["prevId","messages"],'), 'unknown');
    });
  });

  describe('re-anchor tmp sweep', () => {
    const tmpName = (id, hex) => `${id}_req.json.reanchor-12345-${hex}.tmp`;

    it('removes a stale reanchor tmp, keeps a fresh one and unrelated files', () => {
      const stale = tmpName('2020-01-01T00-00-00-000', 'a'.repeat(16));
      const fresh = tmpName('2020-01-01T00-00-01-000', 'b'.repeat(16));
      for (const f of [stale, fresh, '2020-01-01T00-00-02-000_req.json', 'index.ndjson']) {
        fs.writeFileSync(path.join(tmpDir, f), '{}');
      }
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(path.join(tmpDir, stale), old, old);

      sweepOrphanedPruneTmpFiles(tmpDir);

      assert.equal(fs.existsSync(path.join(tmpDir, stale)), false, 'stale tmp removed');
      assert.equal(fs.existsSync(path.join(tmpDir, fresh)), true, 'in-flight tmp not raced');
      assert.equal(fs.existsSync(path.join(tmpDir, '2020-01-01T00-00-02-000_req.json')), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'index.ndjson')), true);
    });
  });

  describe('round 3: strict prune, retention, rebuild, corrupt alignment', () => {
    const A = '2020-01-01T00-00-00-000', B = '2020-01-01T00-00-01-000';
    // A (anchor) <- B (delta) <- C (kept delta, today)
    async function seedABC(cId) {
      await writeReq(A, rec({ messages: ANCHOR }));
      await writeReq(B, rec({ prevId: A, msgOffset: 3, messages: D1 }));
      await writeReq(cId, rec({ prevId: B, msgOffset: 5, messages: D2 }));
      for (const id of [A, B, cId]) await writeRes(id);
      writeIndex([A, B, cId]);
    }
    const quietErrors = async (fn) => {
      const errors = [];
      const orig = console.error;
      console.error = (...a) => { errors.push(a.join(' ')); };
      try { await fn(); } finally { console.error = orig; }
      return errors;
    };
    const readJson = (id) => JSON.parse(fs.readFileSync(path.join(tmpDir, id + '_req.json'), 'utf8'));

    it('strict resolver: ENOENT is a missing link, everything else throws ChainReadError', async () => {
      await writeReq('s-0', rec({ prevId: 'absent', msgOffset: 3, messages: D1 }));
      const st = await resolveChainMessages(storage, 's-0', { strict: true });
      assert.deepEqual(st.missing, { prevId: 'absent', msgOffset: 3 });

      fs.writeFileSync(path.join(tmpDir, 's-bad_req.json'), '{"mod');
      await writeReq('s-1', rec({ prevId: 's-bad', msgOffset: 3, messages: D1 }));
      await assert.rejects(resolveChainMessages(storage, 's-1', { strict: true }), ChainReadError);
      // lazy-load (non-strict) keeps treating it as incomplete
      assert.ok((await resolveChainMessages(storage, 's-1')).missing);

      await writeReq('s-c1', rec({ prevId: 's-c2', msgOffset: 1, messages: D1 }));
      await writeReq('s-c2', rec({ prevId: 's-c1', msgOffset: 1, messages: D2 }));
      await assert.rejects(resolveChainMessages(storage, 's-c2', { strict: true }), ChainReadError);
    });

    it('a corrupt ancestor aborts the prune: no persisted-incomplete child, no ancestor deleted', async () => {
      const child = todayId(30);
      await seedABC(child);
      fs.writeFileSync(path.join(tmpDir, B + '_req.json'), '{"model":"m","prevId":"' + A); // truncated mid-write
      const before = fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8');
      const errors = await quietErrors(() => pruneLogs({ retentionDays: 14 }));
      assert.equal(exists(A), true);
      assert.equal(exists(B), true);
      assert.equal(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'), before, 'child not rewritten');
      assert.equal(errors.filter(l => /keeping all expired logs/.test(l)).length, 1, errors.join('\n'));
    });

    it('a transient read error (EIO) on an ancestor aborts the prune instead of persisting a truncation', async () => {
      const child = todayId(31);
      await seedABC(child);
      const origRead = storage.read;
      storage.read = async function (id, suffix) {
        if (id === B && suffix === '_req.json') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return origRead.call(this, id, suffix);
      };
      let errors;
      try { errors = await quietErrors(() => pruneLogs({ retentionDays: 14 })); } finally { storage.read = origRead; }
      assert.equal(exists(A) && exists(B), true);
      assert.ok(!('incomplete' in readJson(child)), 'no truncation persisted');
      assert.ok(errors.some(l => /EIO/.test(l)), errors.join('\n'));
    });

    it('a failure re-reading the retained ancestor aborts the prune (does not delete its own ancestor)', async () => {
      const child = todayId(32);
      await seedABC(child);
      const childPath = path.join(tmpDir, child + '_req.json');
      const origRead = storage.read;
      let bReads = 0;
      storage.read = async function (id, suffix) {
        if (id === B && suffix === '_req.json') {
          bReads++;
          if (bReads === 1) fs.appendFileSync(childPath, ' ');                 // C's re-anchor fails (CAS) -> B retained
          else throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); // then the follow-up read of B fails
        }
        return origRead.call(this, id, suffix);
      };
      let errors;
      try { errors = await quietErrors(() => pruneLogs({ retentionDays: 14 })); } finally { storage.read = origRead; }
      assert.ok(bReads >= 2, 'the follow-up read happened');
      assert.equal(exists(B), true, 'retained ancestor stays');
      assert.equal(exists(A), true, 'its own ancestor is NOT deleted while it still references it');
      assert.ok(errors.some(l => /re-read kept ancestor/.test(l)), errors.join('\n'));
    });

    it('a directory-fsync failure (EIO) keeps the ancestor; unsupported codes are swallowed', async () => {
      const child = todayId(33);
      await seedABC(child);
      const realFsync = fs.fsyncSync, realOpen = fs.openSync;
      const dirFds = new Set();
      fs.openSync = function (p, ...rest) { const fd = realOpen.call(this, p, ...rest); if (p === tmpDir) dirFds.add(fd); return fd; };
      fs.fsyncSync = function (fd) {
        if (dirFds.has(fd)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return realFsync.call(this, fd);
      };
      let errors;
      try { errors = await quietErrors(() => pruneLogs({ retentionDays: 14 })); } finally { fs.fsyncSync = realFsync; fs.openSync = realOpen; }
      assert.equal(exists(B), true, 'ancestor kept: the replacement was not durable');
      assert.ok(errors.some(l => /could not re-anchor/.test(l) && /EIO/.test(l)), errors.join('\n'));

      for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']) {
        fs.fsyncSync = () => { throw Object.assign(new Error(code), { code }); };
        try { fsyncDir(tmpDir); } finally { fs.fsyncSync = realFsync; }
      }
      fs.fsyncSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
      try { assert.throws(() => fsyncDir(tmpDir), /EACCES/); } finally { fs.fsyncSync = realFsync; }
    });

    it('writerRetentionDays: the shorter enrolled retention wins; other states fall back to config', () => {
      _resetWriterRetentionCache();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-inj-774-'));
      fs.mkdirSync(path.join(home, 'logs'));
      const opts = (readEnrollment) => ({ home, logsDir: path.join(home, 'logs'), readEnrollment });
      const enrolled = (days) => () => ({ state: 'enrolled', retentionDays: days });
      try {
        assert.equal(writerRetentionDays(14, opts(enrolled(4))), 4);
        assert.equal(writerRetentionDays(14, opts(enrolled(30))), 14, 'longer enrollment does not raise it');
        assert.equal(writerRetentionDays(0, opts(enrolled(4))), 4, 'enrolled prune still applies when env retention is off');
        for (const e of [null, { state: 'removed', retentionDays: 2 }, { state: 'invalid' }, { state: 'enrolled', retentionDays: 0 }]) {
          assert.equal(writerRetentionDays(14, opts(() => e)), 14);
        }
        assert.equal(writerRetentionDays(14, opts(() => { throw new Error('boom'); })), 14);
      } finally { _resetWriterRetentionCache(); fs.rmSync(home, { recursive: true, force: true }); }
    });

    it('writerRetentionDays follows the enrollment file: a change applies to the very next call (no stale cache)', () => {
      _resetWriterRetentionCache();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-cache-774-'));
      const logsDir = path.join(home, 'logs');
      fs.mkdirSync(logsDir);
      const file = path.join(home, 'export-enrollment.json');
      const write = (days, mtimeSec) => {
        fs.writeFileSync(file, JSON.stringify({ state: 'enrolled', enrolledAt: '2026-01-01T00:00:00Z', retentionDays: days }));
        fs.utimesSync(file, mtimeSec, mtimeSec);
      };
      try {
        assert.equal(writerRetentionDays(14, { home, logsDir }), 14, 'no enrollment yet');
        write(10, 1_700_000_000);
        assert.equal(writerRetentionDays(14, { home, logsDir }), 10);
        write(1, 1_700_000_100);                                  // enrollment shortened mid-run
        assert.equal(writerRetentionDays(14, { home, logsDir }), 1, 'the new value is used immediately');
        write(9, 1_700_000_200);                                  // same size, different mtime
        assert.equal(writerRetentionDays(14, { home, logsDir }), 9);
        fs.unlinkSync(file);
        assert.equal(writerRetentionDays(14, { home, logsDir }), 14, 'removing the file returns to config');
      } finally { _resetWriterRetentionCache(); fs.rmSync(home, { recursive: true, force: true }); }
    });

    it('a logs root that is not <home>/logs gets the 1-day window (another home may prune it)', () => {
      _resetWriterRetentionCache();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shared-root-774-'));
      const own = path.join(home, 'logs');
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-other-root-774-'));
      fs.mkdirSync(own);
      try {
        assert.equal(writerRetentionDays(14, { home, logsDir: own }), 14, 'own logs dir: config applies');
        assert.equal(writerRetentionDays(14, { home, logsDir: other }), 2, 'explicit LOGS_DIR: 1-day window (retention 2)');
        assert.equal(writerRetentionDays(0, { home, logsDir: other }), 2, 'even with retention off');
        assert.equal(writerRetentionDays(1, { home, logsDir: other }), 1, 'a shorter config stays shorter');
        const NOW = new Date('2026-11-20T12:00:00+08:00');
        const twoDaysOld = new Date(NOW.getTime() - 2 * 86400000).toISOString().slice(0, 10) + 'T10-00-00-000';
        assert.equal(shouldForceFullRecord({ id: twoDaysOld, deltaCount: 1 }, { retentionDays: 14, now: NOW }), false);
        assert.equal(shouldForceFullRecord({ id: twoDaysOld, deltaCount: 1 }, { retentionDays: writerRetentionDays(14, { home, logsDir: other }), now: NOW }), true);
      } finally { _resetWriterRetentionCache(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
    });

    it('with a real enrollment file shorter than config, the writer forces full where config alone would not', () => {
      _resetWriterRetentionCache();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enroll-774-'));
      try {
        fs.mkdirSync(path.join(home, 'logs'));
        fs.writeFileSync(path.join(home, 'export-enrollment.json'), JSON.stringify({ state: 'enrolled', enrolledAt: '2026-01-01T00:00:00Z', retentionDays: 4 }));
        const NOW = new Date('2026-11-20T12:00:00+08:00');
        const prevId = new Date(NOW.getTime() - 5 * 86400000).toISOString().slice(0, 10) + 'T10-00-00-000'; // 5 days old
        assert.equal(shouldForceFullRecord({ id: prevId, deltaCount: 1 }, { retentionDays: 14, now: NOW }), false, 'config alone: window is 7 days');
        const effective = writerRetentionDays(14, { home, logsDir: path.join(home, 'logs') });
        assert.equal(effective, 4);
        assert.equal(shouldForceFullRecord({ id: prevId, deltaCount: 1 }, { retentionDays: effective, now: NOW }), true, 'enrolled 4d: window is 2 days');
      } finally { _resetWriterRetentionCache(); fs.rmSync(home, { recursive: true, force: true }); }
    });

    it('rebuild-index rejects a leaf whose own offset leaves a gap or is corrupt', async () => {
      await writeReq('rb-0', rec({ messages: ANCHOR }));
      await writeReq('rb-ok', rec({ prevId: 'rb-0', msgOffset: 3, messages: D1 }));
      await writeReq('rb-gap', rec({ prevId: 'rb-0', msgOffset: 10, messages: D1 }));
      await writeReq('rb-bad', rec({ prevId: 'rb-0', msgOffset: -1, messages: D1 }));
      assert.equal((await reconstructReq('rb-ok', storage, new Map())).parsedBody.messages.length, 5, 'control: contiguous leaf rebuilds');
      assert.equal(await reconstructReq('rb-gap', storage, new Map()), null);
      assert.equal(await reconstructReq('rb-bad', storage, new Map()), null);
    });

    it('corrupt alignment is persisted as unknown (msgOffset null) and descendants do not build on it', async () => {
      const child = todayId(34), next = todayId(35);
      await writeReq(A, rec({ messages: ANCHOR }));
      await writeReq(child, rec({ prevId: A, msgOffset: '3', messages: D1 })); // corrupt offset
      await writeReq(next, rec({ prevId: child, msgOffset: 5, messages: D2 }));
      writeIndex([A, child, next]);
      await quietErrors(() => pruneLogs({ retentionDays: 14 }));

      assert.equal(exists(A), false, 'ancestor deleted once the unknown alignment is persisted');
      const onDisk = readJson(child);
      assert.deepEqual(onDisk.incomplete, { reason: 'missing-ancestor', prevId: A, msgOffset: null, persisted: true });
      const c = coldEntry(child);
      await loadEntryReqRes(c);
      assert.equal(c.req.incomplete.msgOffset, null);
      assert.deepEqual(c.req.messages, D1);

      // next is valid (offset 5) but its parent has no known alignment: only its own
      // messages are trusted and the count comes from ITS offset, not a fabricated base.
      const d = coldEntry(next);
      await loadEntryReqRes(d);
      assert.deepEqual(d.req.messages, D2);
      assert.deepEqual(d.req.incomplete, { reason: 'missing-ancestor', prevId: child, msgOffset: 5 });
    });
  });

  describe('round 4: malformed deltas and deletion order', () => {
    const A = '2020-01-01T00-00-00-000', B = '2020-01-01T00-00-01-000';
    const quiet = async (fn) => {
      const errors = [];
      const orig = console.error;
      console.error = (...a) => { errors.push(a.join(' ')); };
      try { await fn(); } finally { console.error = orig; }
      return errors;
    };

    it('a record naming an ancestor is a delta whatever its offset says (JSON round-trip of NaN is null)', async () => {
      const roundTripped = JSON.parse(JSON.stringify(rec({ prevId: 'mal-0', msgOffset: NaN, messages: D1 })));
      assert.equal(roundTripped.msgOffset, null);
      await writeReq('mal-0', rec({ messages: ANCHOR }));
      await writeReq('mal-1', roundTripped);
      const entry = coldEntry('mal-1');
      await loadEntryReqRes(entry);
      assert.deepEqual(entry.req.messages, D1);
      assert.deepEqual(entry.req.incomplete, { reason: 'missing-ancestor', prevId: 'mal-0', msgOffset: null }, 'not presented as complete');
      assert.equal(await reconstructReq('mal-1', storage, new Map()), null, 'rebuild-index rejects it');
    });

    it('prune treats a null-offset record as a child of its prevId and re-anchors it as unknown alignment', async () => {
      const child = todayId(40);
      await writeReq(A, rec({ messages: ANCHOR }));
      await writeReq(child, JSON.parse(JSON.stringify(rec({ prevId: A, msgOffset: NaN, messages: D1 }))));
      writeIndex([A, child]);
      await quiet(() => pruneLogs({ retentionDays: 14 }));
      assert.equal(exists(A), false);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, child + '_req.json'), 'utf8'));
      assert.ok(!('prevId' in onDisk) && !('msgOffset' in onDisk));
      assert.deepEqual(onDisk.incomplete, { reason: 'missing-ancestor', prevId: A, msgOffset: null, persisted: true });
    });

    // A (anchor) <- B (delta), both expired; C (today) is a kept delta on B.
    async function seedChain(cId) {
      await writeReq(A, rec({ messages: ANCHOR }));
      await writeReq(B, rec({ prevId: A, msgOffset: 3, messages: D1 }));
      await writeReq(cId, rec({ prevId: B, msgOffset: 5, messages: D2 }));
      for (const id of [A, B, cId]) await writeRes(id);
      writeIndex([A, B, cId]);
    }

    it('deletes descendants before ancestors', async () => {
      const child = todayId(41);
      await seedChain(child);
      const order = [];
      const origDelete = storage.deleteFile;
      storage.deleteFile = async function (f) { order.push(f); return origDelete.call(this, f); };
      try { await pruneLogs({ retentionDays: 14 }); } finally { storage.deleteFile = origDelete; }
      assert.ok(order.indexOf(B + '_req.json') >= 0 && order.indexOf(A + '_req.json') >= 0);
      assert.ok(order.indexOf(B + '_req.json') < order.indexOf(A + '_req.json'), order.join(', '));
    });

    it('keeps the ancestors when a descendant cannot be deleted', async () => {
      const child = todayId(42);
      await seedChain(child);
      const origDelete = storage.deleteFile;
      storage.deleteFile = async function (f) {
        if (f === B + '_req.json') throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
        return origDelete.call(this, f);
      };
      let errors;
      try { errors = await quiet(() => pruneLogs({ retentionDays: 14 })); } finally { storage.deleteFile = origDelete; }
      assert.equal(exists(B), true, 'the file that could not be deleted stays');
      assert.equal(exists(A), true, 'so its ancestor is NOT deleted this prune');
      assert.equal(exists(A, '_res.json'), true);
      assert.ok(errors.some(l => /could not delete/.test(l) && l.includes(B)), errors.join('\n'));
      // the next prune (failure gone) finishes the job
      await pruneLogs({ retentionDays: 14 });
      assert.equal(exists(A) || exists(B), false);
    });
  });
});
