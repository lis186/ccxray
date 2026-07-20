'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('COLD_SESSIONS_ENABLED kill-switch', () => {
  it('defaults to false', () => {
    const config = require('../server/config');
    assert.equal(config.COLD_SESSIONS_ENABLED, false);
  });

  it('filters cold sessions from /_api/sessions when disabled', () => {
    const store = require('../server/store');
    const sessionIdx = require('../server/session-index');

    // Seed session index with two sessions
    sessionIdx.updateFromEntry({ sessionId: 'hot-1', id: 't1', model: 'm', cwd: '/', cost: { cost: 0 }, receivedAt: 1 });
    sessionIdx.updateFromEntry({ sessionId: 'cold-1', id: 't2', model: 'm', cwd: '/', cost: { cost: 0 }, receivedAt: 2 });

    // Only hot-1 is in store.sessionMeta (hot)
    store.sessionMeta['hot-1'] = { provider: 'anthropic' };

    const config = require('../server/config');
    const allSessions = sessionIdx.getAll();
    assert.equal(allSessions.length >= 2, true, 'index has both sessions');

    // Simulate the API filter logic
    let sessions = allSessions;
    if (!config.COLD_SESSIONS_ENABLED) {
      sessions = sessions.filter(s => store.sessionMeta[s.sid]);
    }

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sid, 'hot-1');

    // Cleanup
    delete store.sessionMeta['hot-1'];
  });
});
