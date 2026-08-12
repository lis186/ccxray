'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../server/store');

test('configDir is extracted, cached per session, and retained on later turns', () => {
  const systemSession = '504-config-system';
  const contextSession = '504-config-context';
  const emptySession = '504-config-empty';
  const otherSession = '504-config-other';
  for (const sid of [systemSession, contextSession, emptySession, otherSession]) {
    delete store.sessionMeta[sid];
  }

  try {
    const first = store.cacheConfigDir(systemSession, {
      system: [{ text: "Contents of /Users/test/.claude-work/CLAUDE.md (user's private global instructions for all projects):" }],
    });
    assert.equal(first, '/Users/test/.claude-work');
    assert.equal(store.cacheConfigDir(systemSession, { messages: [] }), '/Users/test/.claude-work');

    const contextManaged = store.cacheConfigDir(contextSession, {
      context_management: {},
      messages: [{ content: [
        { type: 'text', text: "Contents of /home/test/.claude-team/CLAUDE.md (user's private global instructions for all projects):" },
      ] }],
    });
    assert.equal(contextManaged, '/home/test/.claude-team');

    assert.equal(store.cacheConfigDir(emptySession, { system: [{ text: 'No marker here.' }] }), null);
    assert.equal(store.cacheConfigDir(otherSession, { messages: [] }), null);
    assert.equal(store.sessionMeta[systemSession].configDir, '/Users/test/.claude-work');
    assert.ok(!('configDir' in store.sessionMeta[otherSession]), 'different sessions must not share configDir');
    assert.equal(store.cacheConfigDir(null, { system: [] }), null);
  } finally {
    for (const sid of [systemSession, contextSession, emptySession, otherSession]) {
      delete store.sessionMeta[sid];
    }
  }
});
