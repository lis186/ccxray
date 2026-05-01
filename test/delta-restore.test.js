'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { loadEntryReqRes } = require('../server/restore');

// loadEntryReqRes uses config.storage and store.entries as singletons.
// Swap config.storage to a tmp dir for the duration of these tests, and
// reset store.entries between cases so chains don't leak.

describe('loadEntryReqRes — delta chain reconstruction', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-delta-restore-' + Date.now());
  let realStorage;

  before(async () => {
    realStorage = config.storage;
    const tmpStorage = createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.entries.length = 0;
  });

  // Helper: write an entry's _req.json and register it in store.entries
  async function writeEntry(id, reqBody, resBody = []) {
    await config.storage.write(id, '_req.json', JSON.stringify(reqBody));
    await config.storage.write(id, '_res.json', JSON.stringify(resBody));
    store.entries.push({ id, req: null, res: null, _loaded: false });
  }

  it('reconstructs full messages from a single delta hop', async () => {
    const anchorMsgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const deltaNew = [{ role: 'assistant', content: 'd' }, { role: 'user', content: 'e' }];

    await writeEntry('anchor-001', { model: 'm', max_tokens: 100, messages: anchorMsgs });
    await writeEntry('delta-002', {
      model: 'm', max_tokens: 100,
      prevId: 'anchor-001', msgOffset: 3,
      messages: deltaNew,
    });

    const entry = store.entries.find(e => e.id === 'delta-002');
    await loadEntryReqRes(entry);

    assert.deepEqual(entry.req.messages, [...anchorMsgs, ...deltaNew]);
    assert.ok(!('prevId' in entry.req));
    assert.ok(!('msgOffset' in entry.req));
  });

  it('reconstructs through a multi-hop chain (anchor → delta → delta)', async () => {
    const anchorMsgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    const delta1New = [{ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }];
    const delta2New = [{ role: 'user', content: 'e' }];

    await writeEntry('anchor-001', { model: 'm', max_tokens: 100, messages: anchorMsgs });
    await writeEntry('delta-002', { model: 'm', max_tokens: 100, prevId: 'anchor-001', msgOffset: 2, messages: delta1New });
    await writeEntry('delta-003', { model: 'm', max_tokens: 100, prevId: 'delta-002', msgOffset: 4, messages: delta2New });

    const entry = store.entries.find(e => e.id === 'delta-003');
    await loadEntryReqRes(entry);

    assert.deepEqual(entry.req.messages, [...anchorMsgs, ...delta1New, ...delta2New]);
  });

  it('degrades gracefully when prevId entry was pruned', async () => {
    const deltaNew = [{ role: 'user', content: 'orphan' }];
    await writeEntry('delta-orphan', {
      model: 'm', max_tokens: 100,
      prevId: 'pruned-anchor', msgOffset: 5,
      messages: deltaNew,
    });
    // Note: 'pruned-anchor' is NOT in store.entries

    const entry = store.entries.find(e => e.id === 'delta-orphan');
    await loadEntryReqRes(entry);

    // restore.js falls back to "delta portion only" when prev is missing
    assert.deepEqual(entry.req.messages, deltaNew);
  });

  it('caches result via _loaded flag (idempotent)', async () => {
    const msgs = [{ role: 'user', content: 'cached' }];
    await writeEntry('e-cache', { model: 'm', max_tokens: 100, messages: msgs });

    const entry = store.entries.find(e => e.id === 'e-cache');
    await loadEntryReqRes(entry);
    assert.equal(entry._loaded, true);
    assert.deepEqual(entry.req.messages, msgs);

    // Mutate underlying file — second call should NOT re-read it
    await config.storage.write('e-cache', '_req.json', JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'changed' }] }));
    await loadEntryReqRes(entry);
    assert.deepEqual(entry.req.messages, msgs); // still cached
  });

  it('handles concurrent loads of the same entry without double-reading', async () => {
    const anchorMsgs = [{ role: 'user', content: 'shared' }];
    const deltaNew = [{ role: 'assistant', content: 'reply' }];
    await writeEntry('anchor-c', { model: 'm', max_tokens: 100, messages: anchorMsgs });
    await writeEntry('delta-c', { model: 'm', max_tokens: 100, prevId: 'anchor-c', msgOffset: 1, messages: deltaNew });

    const entry = store.entries.find(e => e.id === 'delta-c');
    // Fire two loads concurrently; the second must reuse the first's promise
    const [r1, r2] = await Promise.all([loadEntryReqRes(entry), loadEntryReqRes(entry)]);
    assert.equal(r1, r2); // both await the same promise (or both undefined)
    assert.deepEqual(entry.req.messages, [...anchorMsgs, ...deltaNew]);
  });

  it('preserves model and max_tokens from delta header (not from prev)', async () => {
    await writeEntry('anchor-model', { model: 'old-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    await writeEntry('delta-model', {
      model: 'new-model', max_tokens: 4000,
      prevId: 'anchor-model', msgOffset: 1,
      messages: [{ role: 'assistant', content: 'hi back' }],
    });

    const entry = store.entries.find(e => e.id === 'delta-model');
    await loadEntryReqRes(entry);

    assert.equal(entry.req.model, 'new-model');
    assert.equal(entry.req.max_tokens, 4000);
  });

  it('handles empty-delta (messages=[]) — full match retry shape', async () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    await writeEntry('anchor-empty', { model: 'm', max_tokens: 100, messages: msgs });
    await writeEntry('delta-empty', {
      model: 'm', max_tokens: 100,
      prevId: 'anchor-empty', msgOffset: 2,
      messages: [],
    });

    const entry = store.entries.find(e => e.id === 'delta-empty');
    await loadEntryReqRes(entry);
    // Reconstruction: prev[0..2] + [] = full prev messages
    assert.deepEqual(entry.req.messages, msgs);
  });
});
