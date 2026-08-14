#!/usr/bin/env node
'use strict';

const { runCcxray, statusReport, stripAnsi } = require('./lib/ccxray');

function main() {
  const env = process.env.CCXRAY_HERDR_NO_BROWSER === '1'
    ? { ...process.env, BROWSER: 'none' }
    : process.env;
  const status = statusReport({ env });
  if (!status.parsed.running) {
    console.log('ccxray hub is not running.');
    console.log('Start ccxray first, then run this action again.');
    process.exit(1);
  }

  const result = runCcxray(['open'], { timeoutMs: 8000, env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');

  if (result.error) {
    console.error(stripAnsi(result.error.message));
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

main();
