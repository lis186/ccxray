#!/usr/bin/env node
'use strict';

const {
  recordSessionOutcome,
  reportPaneTokens,
} = require('./lib/ccxray');

function main() {
  const outcome = process.argv[2];
  const result = recordSessionOutcome(outcome, { env: process.env });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }

  const label = outcome === 'clear' ? 'cleared' : outcome;
  if (outcome === 'clear') {
    reportPaneTokens({}, { clearTokens: ['outcome'] });
  } else {
    reportPaneTokens({ outcome }, { ttlMs: 30 * 24 * 60 * 60000 });
  }
  console.log(`Marked session ${result.sessionId} as ${label}.`);
}

main();
