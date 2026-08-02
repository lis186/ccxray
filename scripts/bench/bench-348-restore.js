#!/usr/bin/env node
// Bench driver for #348: run restoreFromLogs against a synthetic fixture and
// exit. Measure with: /usr/bin/time -l node scripts/bench/bench-348-restore.js
// Env: CCXRAY_HOME must point at the fixture dir (with logs/index.ndjson).
'use strict';
if (!process.env.CCXRAY_HOME) {
  console.error('Set CCXRAY_HOME to the fixture dir (e.g. /tmp/ccxray-bench-348)');
  process.exit(1);
}
if (!('RESTORE_DAYS' in process.env)) process.env.RESTORE_DAYS = '0';
process.env.CCXRAY_DISABLE_TITLES = '1';

const config = require('../../server/config');
config.storage.list = async () => [];
config.storage.readShared = async () => { throw new Error('no shared'); };
config.storage.statShared = null;

const { restoreFromLogs } = require('../../server/restore');
restoreFromLogs().then(() => {
  const store = require('../../server/store');
  console.log(`entries: ${store.entries.length}`);
}).catch(e => { console.error(e); process.exit(1); });
