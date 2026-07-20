'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('SSE ring buffer', () => {
  let mod;
  beforeEach(() => {
    // Fresh module for each test
    delete require.cache[require.resolve('../server/sse-broadcast')];
    mod = require('../server/sse-broadcast');
  });

  it('getEpoch returns a number', () => {
    assert.equal(typeof mod.getEpoch(), 'number');
    assert.ok(mod.getEpoch() > 0);
  });

  it('getRing starts empty', () => {
    assert.deepEqual(mod.getRing(), []);
  });

  it('broadcast populates ring with monotonic seq', () => {
    const store = require('../server/store');
    // Add a fake SSE client to capture output
    const chunks = [];
    const fakeRes = { write(d) { chunks.push(d); } };
    store.sseClients.push(fakeRes);

    mod.broadcastRaw({ _type: 'test', v: 1 });
    mod.broadcastRaw({ _type: 'test', v: 2 });

    const ring = mod.getRing();
    assert.equal(ring.length, 2);
    assert.ok(ring[1].seq > ring[0].seq);

    // SSE frames should have id: field
    assert.ok(chunks[0].startsWith('id: '));
    assert.ok(chunks[0].includes('data: '));

    // Parse the id
    const idLine = chunks[0].split('\n')[0];
    const [epoch, seq] = idLine.replace('id: ', '').split(':').map(Number);
    assert.equal(epoch, mod.getEpoch());
    assert.equal(seq, ring[0].seq);

    store.sseClients.splice(store.sseClients.indexOf(fakeRes), 1);
  });

  it('ring evicts oldest when full', () => {
    // Use a small ring size for testing — env var is read at require time,
    // so we test eviction behavior by filling the ring
    const ring = mod.getRing();
    const store = require('../server/store');
    const fakeRes = { write() {} };
    store.sseClients.push(fakeRes);

    for (let i = 0; i < 2010; i++) {
      mod.broadcastRaw({ i });
    }
    // Default RING_SIZE=2000
    assert.ok(ring.length <= 2000);
    assert.ok(ring[0].seq > 1); // oldest was evicted

    store.sseClients.splice(store.sseClients.indexOf(fakeRes), 1);
  });
});
