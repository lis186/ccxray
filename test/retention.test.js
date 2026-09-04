'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { retentionDays, retentionCutoffDate, taipeiDate } = require('../server/retention');

const SYNTHETIC_RETENTION_NOW = new Date('2026-03-15T20:30:00.000Z');

describe('retention', () => {
  it('uses the shared Taipei cutoff calculation at the restore and prune sites', () => {
    const restoreSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'restore.js'), 'utf8');
    const configSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'config.js'), 'utf8');
    const env = { LOG_RETENTION_DAYS: '14' };

    // This instant is already the following day in Taipei, proving the cutoff
    // follows the index filename timezone rather than UTC's calendar date.
    assert.equal(taipeiDate(SYNTHETIC_RETENTION_NOW), '2026-03-16');
    assert.equal(retentionCutoffDate(retentionDays(env), SYNTHETIC_RETENTION_NOW), '2026-03-02');
    const cutoffCalls = [...restoreSource.matchAll(/retentionCutoffDate\(config\.(RESTORE_DAYS|LOG_RETENTION_DAYS)\)/g)].map(m => m[1]);
    assert.deepEqual(cutoffCalls, ['RESTORE_DAYS', 'LOG_RETENTION_DAYS']);
    assert.match(configSource, /const LOG_RETENTION_DAYS = retentionDays\(\);/);
    assert.doesNotMatch(configSource, /LOG_RETENTION_DAYS \|\| '14'/);
  });

  it('does not normalize malformed retention settings, so pruning stays a no-op', () => {
    assert.equal(Number.isFinite(retentionDays({ LOG_RETENTION_DAYS: 'not-a-number' })), false);
  });
});
