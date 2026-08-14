#!/usr/bin/env node
'use strict';

const { summarizeUsage, usageReport } = require('./lib/ccxray');

function parseArgs(argv) {
  const args = { last: process.env.CCXRAY_HERDR_LAST || '24h', cwd: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--last' && argv[i + 1]) args.last = argv[++i];
    else if (argv[i] === '--cwd' && argv[i + 1]) args.cwd = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const usage = usageReport({ last: args.last, cwd: args.cwd });

  console.log(`ccxray Usage Summary (${args.last})`);
  console.log('');

  if (!usage.ok) {
    const hint = usage.errorData?.hint || usage.text || 'No usage data available.';
    console.log(hint);
    process.exit(0);
  }

  for (const line of summarizeUsage(usage.data)) console.log(`- ${line}`);
  process.exit(0);
}

main();
