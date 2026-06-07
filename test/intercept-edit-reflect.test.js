'use strict';

// Differential tests for: "an intercept-edited request is reflected in the
// dashboard, with a forensic received-sidecar and an edited badge".
//
// Per the verification doctrine: each check below FAILS on the pre-fix code and
// PASSES on the fixed code (fail-on-old / pass-on-new), and asserts an OBSERVABLE
// result (what loadEntryReqRes — the function the dashboard endpoint serves —
// returns, and what lands on disk), not an implementation detail.
//
//   T-READ   : same-check on the read contract (runs on old + new; old returns
//              no edited/original/editSummary → red).
//   T-WRITE  : the write seam persistEditedRequest persists as-sent _req.json +
//              forensic _req.received.json + sets ctx.edited/editSummary +
//              re-anchors the delta chain (absent on old → red).
//   T-DELTA  : a later delta whose prevId points at an edited turn splices the
//              canonical EDITED messages, never the received sidecar.
//   T-SPLIT  : if the _req.json rewrite fails, the anchor is CLEARED (recorder
//              called with null) so the next turn re-anchors full (no split-brain).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { loadEntryReqRes } = require('../server/restore');
const forward = require('../server/forward');

const ORIG = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'say X' },
];
const EDITED = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'say BANANA' },
];

describe('intercept edit reflected in dashboard (+ received sidecar + badge)', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-edit-reflect-' + process.pid);
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
    for (const sid of Object.keys(store.sessionMeta)) delete store.sessionMeta[sid];
  });

  function pushEntry(fields) {
    const entry = { req: null, res: null, _loaded: false, ...fields };
    store.entries.push(entry);
    return entry;
  }

  // ── T-READ: the read contract surfaces edited flag + original + summary ──
  it('T-READ: loadEntryReqRes exposes edited flag, original body, and editSummary', async () => {
    const id = 'edited-001';
    // Canonical _req.json is the AS-SENT (edited) body; received sidecar holds original.
    await config.storage.write(id, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: EDITED }));
    await config.storage.write(id, '_req.received.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: ORIG }));
    const summary = ['user[2]: "say X" → "say BANANA"'];
    const entry = pushEntry({ id, edited: true, editSummary: summary });

    await loadEntryReqRes(entry);

    // Canonical content is the edited body (both old and new agree here).
    assert.deepEqual(entry.req.messages, EDITED);
    // The differential part — absent on pre-fix code:
    assert.equal(entry.req.edited, true, 'entry.req.edited must be true for an edited turn');
    assert.ok(entry.req.original, 'entry.req.original must be attached from the received sidecar');
    assert.deepEqual(entry.req.original.messages, ORIG, 'original must hold the pre-edit body');
    assert.deepEqual(entry.req.editSummary, summary, 'editSummary must be surfaced for the badge');
  });

  it('T-READ: a non-edited turn has no edited/original (no sidecar probe regression)', async () => {
    const id = 'plain-001';
    await config.storage.write(id, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: ORIG }));
    const entry = pushEntry({ id }); // no edited flag
    await loadEntryReqRes(entry);
    assert.deepEqual(entry.req.messages, ORIG);
    assert.ok(!entry.req.edited, 'plain turn must not be flagged edited');
    assert.ok(!entry.req.original, 'plain turn must not carry an original');
  });

  // ── T-WRITE: the write seam persists as-sent + received + re-anchors ──
  it('T-WRITE: persistEditedRequest writes as-sent _req.json, received sidecar, sets ctx.edited, re-anchors', async () => {
    const id = 'edited-write-001';
    const sid = 'sess-write-1';
    // Receipt-time write (what index.js does) — the ORIGINAL body.
    await config.storage.write(id, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: ORIG, metadata: { session_id: sid } }));

    const anchorCalls = [];
    forward.setSessionAnchorRecorder((sessionId, anchorId, messages) => anchorCalls.push({ sessionId, anchorId, messages }));

    const ctx = {
      id, reqSessionId: sid,
      parsedBody: { model: 'm', max_tokens: 10, messages: EDITED, metadata: { session_id: sid } },
      originalBody: { model: 'm', max_tokens: 10, messages: ORIG, metadata: { session_id: sid } },
      sysHash: null, toolsHash: null,
    };

    await forward.persistEditedRequest(ctx);

    // _req.json now holds the AS-SENT (edited) body, full format (no delta fields).
    const onDisk = JSON.parse(await config.storage.read(id, '_req.json'));
    assert.deepEqual(onDisk.messages, EDITED, '_req.json must be rewritten to the edited body');
    assert.equal(onDisk.prevId, undefined, 'edited turn must be full format (no prevId)');
    assert.equal(onDisk.msgOffset, undefined, 'edited turn must be full format (no msgOffset)');

    // Forensic received sidecar holds the original.
    const received = JSON.parse(await config.storage.read(id, '_req.received.json'));
    assert.deepEqual(received.messages, ORIG, '_req.received.json must preserve the original body');

    // ctx surfaces edited state for the entry/index.
    assert.equal(ctx.edited, true);
    assert.ok(Array.isArray(ctx.editSummary) && ctx.editSummary.length > 0, 'ctx.editSummary must describe the change');
    assert.ok(ctx.editSummary.some(l => l.includes('say X') && l.includes('say BANANA')));

    // Anchor reset to a CLONE of the edited messages (not by-ref to parsedBody).
    const reset = anchorCalls.find(c => c.sessionId === sid && c.messages != null);
    assert.ok(reset, 'anchor must be reset on success');
    assert.deepEqual(reset.messages, EDITED);
    assert.notEqual(reset.messages, ctx.parsedBody.messages, 'anchor messages must be a clone, not the live parsedBody array');

    // Round-trips through the dashboard read path as edited + original.
    const entry = pushEntry({ id, edited: ctx.edited, editSummary: ctx.editSummary });
    await loadEntryReqRes(entry);
    assert.deepEqual(entry.req.messages, EDITED);
    assert.deepEqual(entry.req.original.messages, ORIG);
  });

  // ── T-DELTA: later delta splices canonical edited, never the received sidecar ──
  it('T-DELTA: a delta whose prevId is an edited turn reconstructs from EDITED canonical, not the sidecar', async () => {
    const anchorId = 'edited-anchor-001';
    await config.storage.write(anchorId, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: EDITED }));
    await config.storage.write(anchorId, '_req.received.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: ORIG }));
    pushEntry({ id: anchorId, edited: true, editSummary: ['user[2]: "say X" → "say BANANA"'] });

    const childId = 'delta-child-001';
    const childNew = [{ role: 'assistant', content: 'BANANA' }, { role: 'user', content: 'again' }];
    await config.storage.write(childId, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, prevId: anchorId, msgOffset: 3, messages: childNew }));
    const child = pushEntry({ id: childId });

    await loadEntryReqRes(child);
    // Spliced prefix must be the EDITED messages from the canonical _req.json,
    // never the original "say X" from the received sidecar.
    assert.deepEqual(child.req.messages, [...EDITED, ...childNew]);
    assert.ok(!JSON.stringify(child.req.messages).includes('say X'), 'must not leak original content via the sidecar');
  });

  // ── T-SPLIT: rewrite failure clears the anchor (no split-brain) ──
  it('T-SPLIT: when the _req.json rewrite fails, the anchor is cleared (recorder called with null)', async () => {
    const id = 'edited-fail-001';
    const sid = 'sess-fail-1';
    await config.storage.write(id, '_req.json', JSON.stringify({ model: 'm', max_tokens: 10, messages: ORIG }));

    const anchorCalls = [];
    forward.setSessionAnchorRecorder((sessionId, anchorId, messages) => anchorCalls.push({ sessionId, messages }));

    // Make the canonical _req.json rewrite fail, leaving disk + anchor inconsistent
    // unless the fix clears the anchor.
    const realWrite = config.storage.write.bind(config.storage);
    config.storage.write = (entryId, suffix, data) =>
      suffix === '_req.json' && entryId === id
        ? Promise.reject(new Error('disk full'))
        : realWrite(entryId, suffix, data);

    try {
      const ctx = {
        id, reqSessionId: sid,
        parsedBody: { model: 'm', max_tokens: 10, messages: EDITED, metadata: { session_id: sid } },
        originalBody: { model: 'm', max_tokens: 10, messages: ORIG },
        sysHash: null, toolsHash: null,
      };
      await forward.persistEditedRequest(ctx).catch(() => {});
    } finally {
      config.storage.write = realWrite;
    }

    const cleared = anchorCalls.find(c => c.sessionId === sid && c.messages == null);
    assert.ok(cleared, 'on rewrite failure the anchor must be cleared (recorder called with null) to force the next turn full');
  });
});
