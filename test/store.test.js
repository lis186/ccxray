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
      store.markSessionUsage({ sessionId: 'future-sid', isSubagent: false, usage: { input_tokens: 5, output_tokens: 3 } });
      assert.deepEqual(store.computeSessionResume('future-sid', 'future-provider'), { resumable: false, resumeCommand: null });
    });

    it('a present-but-empty provider fails closed (only missing falls back to anthropic)', () => {
      assert.deepEqual(store.computeSessionResume('empty-provider-sid', ''), { resumable: false, resumeCommand: null });
    });

    it('codex session with no usage is not resumable', () => {
      const r = store.computeSessionResume('codex-sid-nousage', 'openai');
      assert.deepEqual(r, { resumable: false, resumeCommand: null });
    });

    it('codex session becomes resumable after a non-subagent turn with output', () => {
      const sid = 'codex-sid-withusage';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5, output_tokens: 3 } });
      const r = store.computeSessionResume(sid, 'openai');
      assert.deepEqual(r, { resumable: true, resumeCommand: `codex resume ${sid}` });
    });

    it('subagent usage alone does not make a codex session resumable', () => {
      const sid = 'codex-sid-subonly';
      store.markSessionUsage({ sessionId: sid, isSubagent: true, usage: { input_tokens: 5, output_tokens: 3 } });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('a turn without usage does not mark the session', () => {
      const sid = 'codex-sid-nousagefield';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: null });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('legacy usage without an output_tokens field fails closed', () => {
      const sid = 'codex-sid-legacy-no-output-field';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5 } });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('a billed zero-output turn does not mark the session (hung WS / cross-session retry)', () => {
      const sid = 'codex-sid-zero-output';
      // Specimen from issue #44: status 499 after 45m, input billed, no output,
      // no rollout file on disk — `codex resume` would fail.
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 9953, output_tokens: 0 } });
      assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
    });

    it('hasUsage is monotonic — a later usage-less turn keeps resumability', () => {
      const sid = 'codex-sid-monotonic';
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5, output_tokens: 3 } });
      store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: null });
      assert.equal(store.computeSessionResume(sid, 'openai').resumable, true);
    });

    it('sentinel sessions are never resumable regardless of provider', () => {
      for (const sid of ['direct-api', 'codex-raw', 'grok-raw', 'unknown']) {
        store.markSessionUsage({ sessionId: sid, isSubagent: false, usage: { input_tokens: 5, output_tokens: 3 } });
        assert.deepEqual(store.computeSessionResume(sid, 'openai'), { resumable: false, resumeCommand: null });
        assert.deepEqual(store.computeSessionResume(sid, 'anthropic'), { resumable: false, resumeCommand: null });
      }
    });

    it('empty/missing session id is not resumable', () => {
      assert.deepEqual(store.computeSessionResume(null, 'anthropic'), { resumable: false, resumeCommand: null });
      assert.deepEqual(store.computeSessionResume('', 'openai'), { resumable: false, resumeCommand: null });
    });
  });

  // Shared test helpers — used by detectSession and linkParentSession tests
  function resetSessionState(store) {
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

  // #221: newer Claude Code builds stamp subagent requests with the parent's
  // session_id, so the old "no cwd AND no session_id" heuristic under-detects.
  describe('isAnthropicSubagent', () => {
    function withAgentType(b1, b2, extra) {
      return Object.assign({ system: [{ text: 'billing' }, { text: b1 }, { text: b2 }] }, extra || {});
    }

    it('old path: no cwd, no session_id → subagent', () => {
      const store = require('../server/store');
      assert.equal(store.isAnthropicSubagent({}), true);
    });

    it('new path: no cwd, has session_id, agentKey general-purpose → subagent', () => {
      const store = require('../server/store');
      const req = withAgentType(
        'You are Claude Code',
        'You are an agent for Claude Code, tasked with completing a task.',
        { metadata: { session_id: 'child-sid' } }
      );
      assert.equal(store.isAnthropicSubagent(req), true);
    });

    it('main orchestrator: has cwd and session_id → not a subagent', () => {
      const store = require('../server/store');
      const req = {
        system: [{ text: 'Primary working directory: /home/user/project' }],
        metadata: { session_id: 'parent-sid' },
      };
      assert.equal(store.isAnthropicSubagent(req), false);
    });

    it('fork (orchestrator key, no cwd, has session_id) → not a subagent (fork detection is #222)', () => {
      const store = require('../server/store');
      const req = withAgentType(
        'You are Claude Code',
        'You are an interactive agent for coding tasks.',
        { metadata: { session_id: 'parent-sid' } }
      );
      assert.equal(store.isAnthropicSubagent(req), false);
    });
  });

  describe('detectSession – subagent attribution', () => {
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

    it('orphan does not stick to a stale currentSessionId (falls back to direct-api)', () => {
      // currentSessionId had no time bound: an orphan arriving hours after the
      // last session activity was silently attributed to that dead session —
      // across projects if the user had switched. Stale fallback must go to
      // the direct-api sentinel instead.
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('dead-0a1b', 3));
      Object.assign(store.sessionMeta['dead-0a1b'], { cwd: '/old', lastSeenAt: Date.now() - 3600000 });
      store.activeRequests['dead-0a1b'] = 0;

      const r = store.detectSession({ messages: [{ role: 'user', content: 'task' }] });
      assert.equal(r.sessionId, 'direct-api');
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

  describe('linkParentSession – cross-session subagent linkage', () => {
    it('links subagent session to inflight parent', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: Date.now(), bannerPrinted: true };

      // New session with own session_id, no cwd, 1 message — looks like a subagent
      const childBody = { metadata: { session_id: 'child-bbb' }, messages: [{ role: 'user', content: 'research' }] };
      store.detectSession(childBody);
      store.sessionMeta['child-bbb'] = store.sessionMeta['child-bbb'] || {};
      store.sessionMeta['child-bbb'].lastSeenAt = Date.now();

      const parent = store.linkParentSession('child-bbb', childBody, false);
      assert.equal(parent, 'parent-aaa');
      assert.equal(store.sessionMeta['child-bbb'].parentSessionId, 'parent-aaa');
    });

    it('links when isSubagentHint is true (Codex header)', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: Date.now(), bannerPrinted: true };

      // Even with cwd and tools, isSubagentHint=true forces the linkage
      const childBody = mainReq('child-ccc', 5);
      store.detectSession(childBody);
      store.sessionMeta['child-ccc'] = store.sessionMeta['child-ccc'] || {};
      store.sessionMeta['child-ccc'].lastSeenAt = Date.now();

      const parent = store.linkParentSession('child-ccc', childBody, true);
      assert.equal(parent, 'parent-aaa');
    });

    it('does not link when session has cwd and many messages', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: Date.now(), bannerPrinted: true };

      // Normal session with cwd and 5 messages — not a subagent
      const normalBody = mainReq('normal-ddd', 5);
      store.detectSession(normalBody);
      store.sessionMeta['normal-ddd'] = store.sessionMeta['normal-ddd'] || {};
      store.sessionMeta['normal-ddd'].lastSeenAt = Date.now();

      const parent = store.linkParentSession('normal-ddd', normalBody, false);
      assert.equal(parent, null);
      assert.equal(store.sessionMeta['normal-ddd'].parentSessionId, undefined);
    });

    it('never re-parents an established top-level session (meta.cwd set)', () => {
      // Real incident (d1997e5f → 3e419704): a long-running project session's own
      // subagent kickoffs carry the SAME session_id with no cwd and 1 message.
      // After a hub restart wiped parentSessionId, one such kickoff re-qualified
      // the whole session for linking and inferParentSession picked another
      // project's inflight session. A session that has ever shown a cwd is
      // top-level — it must never be re-parented.
      const store = require('../server/store');
      resetSessionState(store);

      // Another project's session, currently inflight
      store.detectSession(mainReq('bbb2-feed', 3));
      store.activeRequests['bbb2-feed'] = 1;
      Object.assign(store.sessionMeta['bbb2-feed'], { cwd: '/proj-b', lastSeenAt: Date.now() });

      // Established session: cwd known (e.g. restored from index after hub restart)
      store.sessionMeta['aaa1-feed'] = { cwd: '/proj-a', lastSeenAt: Date.now() - 10000, bannerPrinted: true };

      // Its own subagent kickoff: same session_id, no cwd, 1 message
      const kick = { metadata: { session_id: 'aaa1-feed' }, messages: [{ role: 'user', content: 'task' }] };
      const parent = store.linkParentSession('aaa1-feed', kick, undefined);
      assert.equal(parent, null);
      assert.equal(store.sessionMeta['aaa1-feed'].parentSessionId, undefined);
    });

    it('does not link when no parent session is active', () => {
      const store = require('../server/store');
      resetSessionState(store);

      // No active sessions
      const childBody = { metadata: { session_id: 'orphan-eee' }, messages: [{ role: 'user', content: 'hi' }] };
      store.detectSession(childBody);
      store.sessionMeta['orphan-eee'] = store.sessionMeta['orphan-eee'] || {};
      store.sessionMeta['orphan-eee'].lastSeenAt = Date.now();

      const parent = store.linkParentSession('orphan-eee', childBody, false);
      assert.equal(parent, null);
    });

    it('links even when child session meta exists (but no activeRequests/lastSeenAt yet)', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: Date.now(), bannerPrinted: true };

      // detectSession creates sessionMeta for child but does NOT set lastSeenAt or activeRequests
      const childBody = { metadata: { session_id: 'child-ggg' }, messages: [{ role: 'user', content: 'hi' }] };
      store.detectSession(childBody);
      // Production: linkParentSession runs BEFORE activeRequests increment
      const parent = store.linkParentSession('child-ggg', childBody, false);
      assert.equal(parent, 'parent-aaa');
    });

    it('self-links when child is strictly more recent than parent (documents ordering requirement)', () => {
      const store = require('../server/store');
      resetSessionState(store);

      const now = Date.now();
      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: now, bannerPrinted: true };

      const childBody = { metadata: { session_id: 'child-hhh' }, messages: [{ role: 'user', content: 'hi' }] };
      store.detectSession(childBody);
      // WRONG ordering: active tracking before linkParentSession.
      // Child is strictly newer → inferParentSession returns child → self-link → guard drops.
      store.activeRequests['child-hhh'] = 1;
      store.sessionMeta['child-hhh'].lastSeenAt = now + 1;
      const parent = store.linkParentSession('child-hhh', childBody, false);
      assert.equal(parent, null, 'self-link dropped — production avoids this by calling linkParentSession before activeRequests increment');
    });

    it('does not re-link if parentSessionId already set', () => {
      const store = require('../server/store');
      resetSessionState(store);

      store.detectSession(mainReq('parent-aaa', 3));
      store.activeRequests['parent-aaa'] = 1;
      store.sessionMeta['parent-aaa'] = { cwd: '/home', lastSeenAt: Date.now(), bannerPrinted: true };

      store.detectSession(mainReq('parent-bbb', 3));
      store.activeRequests['parent-bbb'] = 1;
      store.sessionMeta['parent-bbb'] = { cwd: '/other', lastSeenAt: Date.now(), bannerPrinted: true };

      const childBody = { metadata: { session_id: 'child-fff' }, messages: [{ role: 'user', content: 'hi' }] };
      store.detectSession(childBody);
      store.sessionMeta['child-fff'] = store.sessionMeta['child-fff'] || {};
      store.sessionMeta['child-fff'].lastSeenAt = Date.now();
      store.sessionMeta['child-fff'].parentSessionId = 'parent-aaa';

      // Second call should not override
      const parent = store.linkParentSession('child-fff', childBody, false);
      assert.equal(parent, 'parent-aaa');
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

  // #223: session attribution edge cases
  describe('inferParentSession — 30s window (#223)', () => {
    it('finds session with lastSeenAt within 30s', () => {
      const store = require('../server/store');
      resetSessionState(store);
      store.sessionMeta['parent-1'] = { cwd: '/proj', lastSeenAt: Date.now() - 10000 };
      store.activeRequests['parent-1'] = 1;
      assert.equal(store.inferParentSession(), 'parent-1');
    });

    it('does NOT find session with lastSeenAt older than 30s', () => {
      const store = require('../server/store');
      resetSessionState(store);
      store.sessionMeta['stale-1'] = { cwd: '/proj', lastSeenAt: Date.now() - 40000 };
      store.activeRequests['stale-1'] = 1;
      assert.equal(store.inferParentSession(), null);
    });

    it('streaming refresh keeps session within window (simulated)', () => {
      const store = require('../server/store');
      resetSessionState(store);
      // Session started 40s ago but streaming refreshed lastSeenAt 5s ago
      store.sessionMeta['streaming-1'] = { cwd: '/proj', lastSeenAt: Date.now() - 5000 };
      store.activeRequests['streaming-1'] = 1;
      assert.equal(store.inferParentSession(), 'streaming-1');
    });
  });

  describe('linkParentSession — cwd ordering (#223)', () => {
    it('links subagent when meta.cwd is NOT yet set (reorder fix)', () => {
      const store = require('../server/store');
      resetSessionState(store);
      // Parent session is inflight
      store.sessionMeta['parent-2'] = { cwd: '/proj', lastSeenAt: Date.now() };
      store.activeRequests['parent-2'] = 1;
      // Child session — no cwd on meta yet (linkParentSession runs before cwd assignment)
      store.sessionMeta['child-2'] = {};
      const result = store.linkParentSession('child-2', { messages: [{ role: 'user', content: 'go' }] });
      assert.equal(result, 'parent-2');
    });

    it('does NOT re-parent a session that already has cwd', () => {
      const store = require('../server/store');
      resetSessionState(store);
      store.sessionMeta['parent-3'] = { cwd: '/proj', lastSeenAt: Date.now() };
      store.activeRequests['parent-3'] = 1;
      // Established session with cwd already set
      store.sessionMeta['established-3'] = { cwd: '/other-proj' };
      const result = store.linkParentSession('established-3', { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(result, null);
    });
  });
});
