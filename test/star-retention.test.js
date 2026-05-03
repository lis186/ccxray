'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getProjectName,
  computeRetentionSets,
  isProtectedByStar,
  SENTINEL_SESSIONS,
  SENTINEL_PROJECTS,
} = require('../server/helpers');

describe('star-retention', () => {
  describe('getProjectName', () => {
    it('returns last path segment for normal cwd', () => {
      assert.equal(getProjectName('/Users/x/dev/myapp'), 'myapp');
      assert.equal(getProjectName('/single'), 'single');
      assert.equal(getProjectName('/Users/x/dev/myapp/'), 'myapp');
    });
    it('passes through sentinel labels', () => {
      assert.equal(getProjectName('(quota-check)'), '(quota-check)');
      assert.equal(getProjectName('(unknown)'), '(unknown)');
    });
    it('returns "(unknown)" for null / undefined / non-string', () => {
      assert.equal(getProjectName(null), '(unknown)');
      assert.equal(getProjectName(undefined), '(unknown)');
      assert.equal(getProjectName(42), '(unknown)');
    });
    it('returns "(unknown)" for empty string', () => {
      assert.equal(getProjectName(''), '(unknown)');
    });
  });

  describe('SENTINEL_SESSIONS / SENTINEL_PROJECTS', () => {
    it('exposes expected sentinel ids', () => {
      assert.ok(SENTINEL_SESSIONS.has('direct-api'));
      assert.ok(SENTINEL_PROJECTS.has('(unknown)'));
      assert.ok(SENTINEL_PROJECTS.has('(quota-check)'));
    });
  });

  describe('computeRetentionSets', () => {
    const idx = [
      { id: 't1', sessionId: 's1', cwd: '/x/foo' },
      { id: 't2', sessionId: 's1', cwd: '/x/foo' },
      { id: 't3', sessionId: 's2', cwd: '/x/bar' },
      { id: 'd1', sessionId: 'direct-api', cwd: '(unknown)' },
      { id: 'd2', sessionId: 'direct-api', cwd: '(unknown)' },
      { id: 'q1', sessionId: 'sQ', cwd: '(quota-check)' },
    ];

    it('starring a turn lifts its session into retainedSessions (real session)', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['t1'] });
      assert.ok(sets.retainedSessions.has('s1'));
      assert.equal(sets.retainedSessions.has('s2'), false);
      assert.ok(sets.retainedProjects.has('foo'));
    });

    it('starring a turn in sentinel session does NOT lift the bucket', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['d1'] });
      assert.equal(sets.retainedSessions.has('direct-api'), false);
      assert.ok(sets.starredTurnIds.has('d1'));
      // (unknown) is sentinel project, should not be in retainedProjects either
      assert.equal(sets.retainedProjects.has('(unknown)'), false);
    });

    it('starring a turn under sentinel project does NOT lift the project', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['q1'] });
      assert.equal(sets.retainedProjects.has('(quota-check)'), false);
    });

    it('starredSessions seed retainedSessions; their projects derive', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: ['s2'], turns: [] });
      assert.ok(sets.retainedSessions.has('s2'));
      assert.ok(sets.retainedProjects.has('bar'));
    });

    it('sentinel session in starredSessions is rejected at the source', () => {
      // Defensive: even if 'direct-api' somehow ends up in starredSessions
      // (manual settings edit, pre-API-guard data, etc.), it must NOT enter
      // retainedSessions — otherwise every direct-api turn gets pinned.
      const sets = computeRetentionSets(idx, { projects: [], sessions: ['direct-api', 's2'], turns: [] });
      assert.equal(sets.retainedSessions.has('direct-api'), false);
      assert.ok(sets.retainedSessions.has('s2'));
    });

    it('sentinel project in starredProjects is rejected at the source', () => {
      const sets = computeRetentionSets(idx, { projects: ['(unknown)', '(quota-check)', 'foo'], sessions: [], turns: [] });
      assert.equal(sets.retainedProjects.has('(unknown)'), false);
      assert.equal(sets.retainedProjects.has('(quota-check)'), false);
      assert.ok(sets.retainedProjects.has('foo'));
    });

    it('handles empty stars without throwing', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: [] });
      assert.equal(sets.retainedSessions.size, 0);
      assert.equal(sets.retainedProjects.size, 0);
      assert.equal(sets.starredTurnIds.size, 0);
    });
  });

  describe('isProtectedByStar', () => {
    const idx = [
      { id: 't1', sessionId: 's1', cwd: '/x/foo' },
      { id: 't2', sessionId: 's1', cwd: '/x/foo' },
      { id: 'd1', sessionId: 'direct-api', cwd: '(unknown)' },
      { id: 'd2', sessionId: 'direct-api', cwd: '(unknown)' },
    ];

    it('directly starred turn is protected', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['t1'] });
      assert.ok(isProtectedByStar({ id: 't1', sessionId: 's1', cwd: '/x/foo' }, sets));
    });

    it('sibling in same real session is protected via session lift', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['t1'] });
      assert.ok(isProtectedByStar({ id: 't2', sessionId: 's1', cwd: '/x/foo' }, sets));
    });

    it('sibling in sentinel session is NOT protected', () => {
      const sets = computeRetentionSets(idx, { projects: [], sessions: [], turns: ['d1'] });
      assert.equal(isProtectedByStar({ id: 'd2', sessionId: 'direct-api', cwd: '(unknown)' }, sets), false);
      // The direct star is still protected (leaf-level)
      assert.ok(isProtectedByStar({ id: 'd1', sessionId: 'direct-api', cwd: '(unknown)' }, sets));
    });

    it('starred project covers all entries within', () => {
      const sets = computeRetentionSets(idx, { projects: ['foo'], sessions: [], turns: [] });
      assert.ok(isProtectedByStar({ id: 't1', sessionId: 's1', cwd: '/x/foo' }, sets));
      assert.ok(isProtectedByStar({ id: 't2', sessionId: 's1', cwd: '/x/foo' }, sets));
    });

    it('returns false for null inputs', () => {
      const sets = computeRetentionSets([], { projects: [], sessions: [], turns: [] });
      assert.equal(isProtectedByStar(null, sets), false);
      assert.equal(isProtectedByStar({ id: 'x' }, null), false);
    });
  });
});
