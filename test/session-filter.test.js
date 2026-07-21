const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const RECENT_MS = 24 * 60 * 60 * 1000;

// Mirrors public/miller-columns.js getStatusClass (post-fix with sessionsMap fallback)
function makeGetStatusClass(sessionStatusMap, sessionsMap) {
  return function getStatusClass(sid) {
    const s = sessionStatusMap.get(sid);
    if (s) {
      if (s.active) return 'sdot-stream';
      if (s.lastSeenAt && Date.now() - s.lastSeenAt < RECENT_MS) return 'sdot-idle';
      return 'sdot-off';
    }
    const sess = sessionsMap.get(sid);
    if (sess && sess.lastReceivedAt && Date.now() - sess.lastReceivedAt < RECENT_MS) return 'sdot-idle';
    return 'sdot-off';
  };
}

describe('getStatusClass — session filter fallback', () => {
  it('restored session with recent lastReceivedAt should not be sdot-off', () => {
    const sessionStatusMap = new Map();
    const sessionsMap = new Map();
    sessionsMap.set('sess-1', { lastReceivedAt: Date.now() - 3600_000 }); // 1h ago

    const getStatusClass = makeGetStatusClass(sessionStatusMap, sessionsMap);
    assert.notEqual(getStatusClass('sess-1'), 'sdot-off',
      'restored session within 24h should not be sdot-off');
  });

  it('restored session older than 24h returns sdot-off', () => {
    const sessionStatusMap = new Map();
    const sessionsMap = new Map();
    sessionsMap.set('sess-1', { lastReceivedAt: Date.now() - 25 * 60 * 60 * 1000 });

    const getStatusClass = makeGetStatusClass(sessionStatusMap, sessionsMap);
    assert.equal(getStatusClass('sess-1'), 'sdot-off');
  });

  it('active session via sessionStatusMap returns sdot-stream', () => {
    const sessionStatusMap = new Map();
    sessionStatusMap.set('sess-1', { active: true, lastSeenAt: Date.now() });

    const getStatusClass = makeGetStatusClass(sessionStatusMap, new Map());
    assert.equal(getStatusClass('sess-1'), 'sdot-stream');
  });

  it('recently-idle session via sessionStatusMap returns sdot-idle', () => {
    const sessionStatusMap = new Map();
    sessionStatusMap.set('sess-1', { active: false, lastSeenAt: Date.now() - 60_000 });

    const getStatusClass = makeGetStatusClass(sessionStatusMap, new Map());
    assert.equal(getStatusClass('sess-1'), 'sdot-idle');
  });

  it('unknown session returns sdot-off', () => {
    const getStatusClass = makeGetStatusClass(new Map(), new Map());
    assert.equal(getStatusClass('nonexistent'), 'sdot-off');
  });
});
