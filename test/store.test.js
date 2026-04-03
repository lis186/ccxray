'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('store', () => {
  describe('sessionCosts', () => {
    it('exports a sessionCosts Map', () => {
      const store = require('../server/store');
      assert.ok(store.sessionCosts instanceof Map, 'sessionCosts should be a Map');
    });

    it('accumulates cost across multiple turns', () => {
      const store = require('../server/store');
      store.sessionCosts.clear();
      const sid = 'test-session-1';
      // Simulate 3 turns
      for (let i = 0; i < 3; i++) {
        store.sessionCosts.set(sid, (store.sessionCosts.get(sid) || 0) + 0.01);
      }
      assert.ok(Math.abs(store.sessionCosts.get(sid) - 0.03) < 1e-10);
    });
  });

  describe('entry memory release', () => {
    it('releases req/res memory after nulling (requires --expose-gc)', async () => {
      if (typeof global.gc !== 'function') {
        // Skip if gc not exposed — this test must be run with: node --expose-gc --test
        return;
      }
      const store = require('../server/store');
      const startLen = store.entries.length;

      // Allocate large unique arrays on V8 heap (each ~1MB+)
      for (let i = 0; i < 20; i++) {
        store.entries.push({
          id: `mem-test-${i}`,
          req: { messages: new Array(50_000).fill(null).map((_, j) => ({ role: 'user', i, j })) },
          res: new Array(25_000).fill(null).map((_, j) => ({ type: 'delta', i, j })),
          _loaded: true,
        });
      }

      global.gc();
      const heapWithData = process.memoryUsage().heapUsed;

      for (let i = startLen; i < startLen + 20; i++) {
        store.entries[i].req = null;
        store.entries[i].res = null;
        store.entries[i]._loaded = false;
      }

      global.gc();
      const heapAfterRelease = process.memoryUsage().heapUsed;
      const freedBytes = heapWithData - heapAfterRelease;
      assert.ok(
        freedBytes >= 15 * 1024 * 1024,
        `expected at least 15MB freed, got ${(freedBytes / (1024 * 1024)).toFixed(2)}MB`
      );

      // Clean up
      store.entries.splice(startLen, 20);
    });
  });
});
