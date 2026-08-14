#!/usr/bin/env node
'use strict';

const {
  reportPaneTokens,
  statusReport,
  summarizeUsageCompact,
  summarizeUsageTiny,
  usageReport,
} = require('./lib/ccxray');

function parseArgs(argv) {
  return {
    once: argv.includes('--once') || process.env.CCXRAY_MISSION_ONCE === '1',
    intervalMs: Number(process.env.CCXRAY_MISSION_INTERVAL_MS || 5000),
    last: process.env.CCXRAY_HERDR_LAST || '24h',
  };
}

function render(args) {
  const status = statusReport();
  const usage = usageReport({ last: args.last });
  const now = new Date().toLocaleTimeString();
  const state = status.parsed.running ? 'ok' : 'no-hub';
  const cols = Number(process.env.CCXRAY_MISSION_COLS) || process.stdout.columns || 48;
  const tiny = cols < 32;

  if (!args.once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(tiny ? 'ccxray MC' : 'ccxray Mission Control');
  console.log(`Updated: ${now}`);
  console.log('');

  if (tiny && status.parsed.running) {
    console.log('Hub ok');
    if (status.parsed.port) console.log(`Port ${status.parsed.port}`);
    if (status.parsed.pid) console.log(`PID ${status.parsed.pid}`);
  } else if (tiny) {
    console.log('Hub no');
  } else if (status.parsed.running) {
    const parts = [];
    if (status.parsed.port) parts.push(`port ${status.parsed.port}`);
    if (status.parsed.pid) parts.push(`pid ${status.parsed.pid}`);
    console.log(`Hub: running${parts.length ? ` (${parts.join(', ')})` : ''}`);
  } else {
    console.log('Hub: not running');
  }

  console.log('');
  if (usage.ok) {
    const lines = tiny
      ? summarizeUsageTiny(usage.data, { cols })
      : summarizeUsageCompact(usage.data, { cols });
    for (const line of lines) console.log(tiny ? line : `- ${line}`);
  } else {
    const hint = usage.errorData?.hint || usage.text || 'No usage data available.';
    console.log(tiny ? 'Usage none' : `Usage: ${String(hint).slice(0, Math.max(cols - 8, 20))}`);
  }

  const meta = reportPaneTokens({ xray: state }, { ttlMs: Math.max(args.intervalMs * 2, 10000) });
  if (process.env.HERDR_PANE_ID) {
    console.log('');
    console.log(tiny ? `Meta ${meta.ok ? 'ok' : 'miss'}` : `Pane metadata: ${meta.ok ? 'reported' : 'not reported'}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  render(args);
  if (args.once) process.exit(0);
  const timer = setInterval(() => render(args), Math.max(args.intervalMs, 1000));
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(143);
  });
}

main();
