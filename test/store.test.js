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

  describe('trimEntries eviction', () => {
    it('trims entries to MAX_ENTRIES', () => {
      const store = require('../server/store');
      const startLen = store.entries.length;

      // Push entries beyond limit
      const testLimit = store.MAX_ENTRIES;
      for (let i = 0; i < testLimit + 50; i++) {
        store.entries.push({ id: `trim-test-${i}`, req: null, res: null });
      }
      assert.ok(store.entries.length > testLimit);

      store.trimEntries();
      assert.equal(store.entries.length, testLimit, `Should trim to ${testLimit}`);

      // Oldest entries should be gone, newest kept
      assert.equal(store.entries[store.entries.length - 1].id, `trim-test-${testLimit + 49}`);

      // Clean up
      store.entries.splice(startLen);
    });

    it('does not trim when under limit', () => {
      const store = require('../server/store');
      const startLen = store.entries.length;
      store.entries.push({ id: 'under-limit', req: null, res: null });
      store.trimEntries();
      assert.equal(store.entries.length, startLen + 1);
      store.entries.pop();
    });
  });

  describe('computeSessionResume / markSessionUsage', () => {
    const store = require('../server/store');

    it('claude sessions are always resumable with --resume', () => {
      const r = store.computeSessionResume('claude-sid-aaa', 'anthropic');
      assert.deepEqual(r, { resumable: true, resumeCommand: 'claude --resume claude-sid-aaa' });
    });

    it('entries without a provider fall back to anthropic (always resumable)', () => {
      const r = store.computeSessionResume('legacy-sid', undefined);
      assert.deepEqual(r, { resumable: true, resumeCommand: 'claude --resume legacy-sid' });
    });

    it('an unknown provider fails closed (no resume command)', () => {
      store.markSessionUsage({ sessionId: 'future-sid', isSubagent: false, usage: { input_tokens: 5 } });
      assert.deepEqual(store.computeSessionResume('future-sid', 'future-provider'), { resumable: false, resumeCommand: null });
    });

    it('codex session with no usage is not resumable', () => {
      const r = store.computeSessionResume('codex-sid-nousage', 'openai');
      assert.deepEqual(r, { resumable: false, resumeCommand: null });
    });

    it('codex session becomes resumable after a non-subagent usage turn', () => {
      const sid = 'codex-sid-withusage';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5 } });
      const r = store.computeSessionResume(sid, 'openai');
      assert.deepEqual(r, { resumable: true, resumeCommand: `codex resume ${sid}` });
    });

    it('subagent usage alone does not make a codex session resumable', () => {
      const sid = 'codex-sid-subonly';
      store.markSessionUsage({ sessionId: sid, isSubagent: true, usage: { input_tokens: 5 } });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('a turn without usage does not mark the session', () => {
      const sid = 'codex-sid-nousagefield';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: null });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('hasUsage is monotonic — a later usage-less turn keeps resumability', () => {
      const sid = 'codex-sid-monotonic';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5 } });
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: null });
      assert.equal(store.computeSessionResume(sid, 'openai').resumable, true);
    });

    it('sentinel sessions are never resumable regardless of provider', () => {
      for (const sid of ['direct-api', 'codex-raw', 'unknown']) {
        store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5 } });
        assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
        assert.deepEqual(store.computeSessionResume(sid, 'anthropic'), { resumable: false, resumeCommand: null });
      }
    });

    it('empty/missing session id is not resumable', () => {
      assert.deepEqual(store.computeSessionResume(null, 'anthropic'), { resumable: false, resumeCommand: null });
      assert.deepEqual(store.computeSessionResume('', 'openai'), { resumable: false, resumeCommand: null });
    });
  });

  describe('detectSession – subagent attribution', () => {
    // Fresh store state for each test — we manipulate module-level globals
    // so we need to reset between tests.
    function resetSessionState(store) {
      // Clear mutable session state
      for (const k of Object.keys(store.sessionMeta)) delete store.sessionMeta[k];
      for (const k of Object.keys(store.activeRequests)) delete store.activeRequests[k];
    }

    function mainReq(sessionId, msgCount) {
      return {
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
        system: [{ text: 'Primary working directory: /home/user/project' }],
        messages: new Array(msgCount).fill({ role: 'user', content: 'hi' }),
        tools: new Array(90).fill({ name: 'Read' }),
      };
    }

    function bareSubagentReq() {
      return { messages: [{ role: 'user', content: 'do research' }] };
    }

    it('attributes bare subagent to the only inflight session', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Main agent request establishes session
      const r1 = store.detectSession(mainReq('aaa-111', 3));
      assert.equal(r1.sessionId, 'aaa-111');

      // Simulate inflight (index.js increments after detectSession)
      store.activeRequests['aaa-111'] = 1;
      store.sessionMeta['aaa-111'] = { cwd: '/home', lastSeenAt: Date.now() };

      // Bare subagent should be attributed to aaa-111
      const r2 = store.detectSession(bareSubagentReq());
      assert.equal(r2.sessionId, 'aaa-111');
      assert.equal(r2.isNewSession, false);
    });

    it('attributes subagent to inflight session over idle session in multi-session', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session A: was active but now idle
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() - 5000 };
      store.activeRequests['aaa-111'] = 0;

      // Session B: currently inflight
      store.detectSession(mainReq('bbb-222', 1));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: Date.now() };
      store.activeRequests['bbb-222'] = 1;

      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('does not attribute when no session active within 30s', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session exists but stale (60s ago)
      store.detectSession(mainReq('old-sess', 3));
      store.sessionMeta['old-sess'] = { cwd: '/old', lastSeenAt: Date.now() - 60000 };
      store.activeRequests['old-sess'] = 0;

      const r = store.detectSession(bareSubagentReq());
      // Should NOT create a new session, just reuse current
      assert.equal(r.isNewSession, false);
    });

    it('attributes non-subagent (with tools) to active session instead of creating phantom', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 5));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() };
      store.activeRequests['aaa-111'] = 1;

      // Request with tools → not a bare subagent, but active session exists within 30s.
      // Should be attributed to aaa-111 rather than creating a phantom direct-api session.
      const reqWithTools = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Read' }],
      };
      const r = store.detectSession(reqWithTools);
      assert.equal(r.isNewSession, false);
      assert.equal(r.sessionId, 'aaa-111');
    });

    it('attributes non-subagent with metadata to active session instead of creating phantom', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() };
      store.activeRequests['aaa-111'] = 1;

      // Request with custom metadata → fails isLikelySubagent, but active session exists.
      // Should be attributed to aaa-111 rather than creating a phantom direct-api session.
      const r = store.detectSession({
        metadata: { user_id: 'custom-app-v1' },
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.equal(r.isNewSession, false);
      assert.equal(r.sessionId, 'aaa-111');
    });

    it('never pollutes currentSessionId from subagent path', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('aaa-111', 3));
      // Merge in-place: replacing the object would clobber bookkeeping flags
      // (e.g. bannerPrinted) that detectSession set on this entry.
      Object.assign(store.sessionMeta['aaa-111'], { cwd: '/a', lastSeenAt: Date.now() });
      store.activeRequests['aaa-111'] = 1;

      store.detectSession(bareSubagentReq());
      assert.equal(store.getCurrentSessionId(), 'aaa-111');

      // Next main request should still see aaa-111 as current
      const r = store.detectSession(mainReq('aaa-111', 5));
      assert.equal(r.isNewSession, false);
    });

    it('picks inflight session even when two sessions are recent', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const now = Date.now();
      // Session A: recent but NOT inflight
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: now - 2000 };
      store.activeRequests['aaa-111'] = 0;

      // Session B: recent AND inflight
      store.detectSession(mainReq('bbb-222', 3));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: now - 3000 };
      store.activeRequests['bbb-222'] = 1;

      // Even though A is more recent, B is inflight → B wins
      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('attributes to most-recent when both sessions inflight', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const now = Date.now();
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: now - 5000 };
      store.activeRequests['aaa-111'] = 1;

      store.detectSession(mainReq('bbb-222', 3));
      store.sessionMeta['bbb-222'] = { cwd: '/b', lastSeenAt: now - 1000 };
      store.activeRequests['bbb-222'] = 1;

      // Both inflight → most recent wins
      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'bbb-222');
    });

    it('falls back to idle recent session when nothing is inflight', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // Session completed 10s ago (within 30s window)
      store.detectSession(mainReq('aaa-111', 3));
      store.sessionMeta['aaa-111'] = { cwd: '/a', lastSeenAt: Date.now() - 10000 };
      store.activeRequests['aaa-111'] = 0;

      const r = store.detectSession(bareSubagentReq());
      assert.equal(r.sessionId, 'aaa-111');
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
