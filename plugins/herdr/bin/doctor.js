#!/usr/bin/env node
'use strict';

const {
  currentWorkspaceScope,
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
  const scope = currentWorkspaceScope();

  console.log('ccxray Herdr Doctor');
  console.log('');
  console.log(`Herdr runtime: ${yesNo(runtime.present)}`);
  console.log(`Plugin id: ${runtime.pluginId || 'n/a'}`);
  console.log(`Action id: ${runtime.actionId || 'n/a'}`);
  console.log(`Workspace: ${runtime.workspaceId || 'n/a'}`);
  console.log(`Pane: ${runtime.paneId || 'n/a'}`);
  console.log(`ccxray command: ${command.label}`);
  console.log('');

  if (!status.ok) {
    const reason = status.result.error?.message
      || status.text
      || `status command exited ${status.result.status ?? 'without a result'}`;
    const exit = status.result.error?.code || status.result.status;
    console.log(`Hub: check failed${exit != null ? ` (${exit})` : ''}`);
    console.log(reason);
    console.log('Next: reinstall the plugin, then run ccxray doctor again.');
    process.exit(1);
  }

  const usage = usageReport({
    last: process.env.CCXRAY_HERDR_LAST || '24h',
    cwd: scope.cwd,
  });

  if (status.parsed.running) {
    const bits = [];
    if (status.parsed.port) bits.push(`port ${status.parsed.port}`);
    if (status.parsed.pid) bits.push(`pid ${status.parsed.pid}`);
    if (status.parsed.clients != null) bits.push(`${status.parsed.clients} clients`);
    console.log(`Hub: running${bits.length ? ` (${bits.join(', ')})` : ''}`);
  } else {
    console.log('Hub: not running');
    // #555: status appends Note lines when the default port is held by a
    // non-hub process — the one hint that explains why a launch would fail.
    for (const note of status.parsed.notes || []) console.log(note);
  }

  if (usage.ok) {
    console.log('');
    const scopeLabel = scope.cwd ? `, workspace ${scope.cwd}` : ', all imported history';
    console.log(`Usage (${process.env.CCXRAY_HERDR_LAST || '24h'}${scopeLabel}):`);
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
