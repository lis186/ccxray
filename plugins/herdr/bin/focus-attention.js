#!/usr/bin/env node
'use strict';

const {
  missionControlSnapshot,
  runHerdr,
  shortModel,
} = require('./lib/ccxray');

function main() {
  const snapshot = missionControlSnapshot({ env: process.env });
  const row = snapshot.rows.find(candidate => (
    candidate.paneId && candidate.severity !== 'green'
  ));
  if (!row) {
    console.log('No ccxray agent currently needs attention.');
    process.exit(0);
  }

  const result = runHerdr(['agent', 'focus', row.paneId], {
    env: process.env,
    timeoutMs: 3000,
  });
  if (result.status !== 0 || result.error) {
    process.stderr.write(result.stderr || result.stdout || result.error?.message || 'Unable to focus agent.\n');
    process.exit(1);
  }

  const action = row.action || 'inspect pane';
  console.log(`Focused ${row.paneId} · ${row.severity.toUpperCase()} ${shortModel(row.agent || row.model)} · ${action}`);
}

main();
