#!/usr/bin/env node
'use strict';

const {
  herdrRuntime,
  reportPaneTokens,
  resolveCcxrayCommand,
  statusReport,
  summarizeUsage,
  usageReport,
} = require('./lib/ccxray');

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function main() {
  const runtime = herdrRuntime();
  const command = resolveCcxrayCommand();
  const status = statusReport();
  const usage = usageReport({ last: process.env.CCXRAY_HERDR_LAST || '24h' });
  const hardFailure = status.result.error && status.result.error.code === 'ENOENT';

  console.log('ccxray Herdr Doctor');
  console.log('');
  console.log(`Herdr runtime: ${yesNo(runtime.present)}`);
  console.log(`Plugin id: ${runtime.pluginId || 'n/a'}`);
  console.log(`Action id: ${runtime.actionId || 'n/a'}`);
  console.log(`Workspace: ${runtime.workspaceId || 'n/a'}`);
  console.log(`Pane: ${runtime.paneId || 'n/a'}`);
  console.log(`ccxray command: ${command.label}`);
  console.log('');

  if (hardFailure) {
    console.log(`ccxray command failed: ${status.result.error.message}`);
    process.exit(1);
  }

  if (status.parsed.running) {
    const bits = [];
    if (status.parsed.port) bits.push(`port ${status.parsed.port}`);
    if (status.parsed.pid) bits.push(`pid ${status.parsed.pid}`);
    if (status.parsed.clients != null) bits.push(`${status.parsed.clients} clients`);
    console.log(`Hub: running${bits.length ? ` (${bits.join(', ')})` : ''}`);
  } else {
    console.log('Hub: not running');
  }

  if (usage.ok) {
    console.log('');
    console.log(`Usage (${process.env.CCXRAY_HERDR_LAST || '24h'}):`);
    for (const line of summarizeUsage(usage.data)) console.log(`- ${line}`);
  } else {
    const hint = usage.errorData?.hint || usage.text || 'usage command returned no data';
    console.log('');
    console.log(`Usage: unavailable (${hint})`);
  }

  if (runtime.paneId) {
    const badge = status.parsed.running ? 'ok' : 'no-hub';
    const meta = reportPaneTokens({ xray: badge }, { ttlMs: 15000 });
    console.log('');
    console.log(`Pane metadata: ${meta.ok ? 'reported' : `skipped (${meta.reason || 'unknown'})`}`);
  }

  process.exit(0);
}

main();
