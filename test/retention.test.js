'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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

  it('yields the same Taipei cutoff no matter which timezone the host runs in', () => {
    // The cutoff is compared against Taipei-dated index filenames, so it must be a
    // pure function of (now, days). Subtracting with the host's local calendar and
    // formatting in Taipei is NOT: at 2026-03-08T15:30Z with days=1 that hybrid
    // returns 2026-03-08 on a Los Angeles host (US spring-forward) but 2026-03-07
    // on a UTC or Taipei host — one extra Taipei day pruned, purely from where the
    // process happens to run. Southern-hemisphere zones skew the other way.
    // A DST-observing zone is mandatory here: Asia/Taipei has no DST, so on its own
    // it cannot tell a correct implementation from the hybrid one.
    const cutoffUnder = tz => {
      const child = spawnSync(process.execPath, ['-e', `
        const { retentionCutoffDate } = require('../server/retention');
        process.stdout.write(retentionCutoffDate(1, new Date('2026-03-08T15:30:00.000Z')));
      `], { cwd: __dirname, env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout;
    };

    const zones = ['UTC', 'Asia/Taipei', 'America/Los_Angeles', 'Europe/Berlin', 'Australia/Sydney'];
    const results = Object.fromEntries(zones.map(tz => [tz, cutoffUnder(tz)]));
    assert.deepEqual(results, Object.fromEntries(zones.map(tz => [tz, '2026-03-07'])));
  });

  it('pins 14 as the single canonical default retention window', () => {
    // This default is the ONLY definition in the tree (config.js derives from it),
    // so it silently governs restore, pruning AND the usage disclosure. Changing
    // it must break a test, not just change behaviour.
    assert.equal(retentionDays({}), 14);
    assert.equal(retentionDays({ LOG_RETENTION_DAYS: '' }), 14);
    assert.equal(retentionDays({ LOG_RETENTION_DAYS: '7' }), 7);
  });

  it('does not normalize malformed retention settings, so pruning stays a no-op', () => {
    assert.equal(Number.isFinite(retentionDays({ LOG_RETENTION_DAYS: 'not-a-number' })), false);
  });
});
