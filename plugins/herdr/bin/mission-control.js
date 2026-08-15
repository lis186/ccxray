#!/usr/bin/env node
'use strict';

const {
  formatMoney,
  missionControlSnapshot,
  reportPaneTokens,
  shortId,
  shortModel,
  statusReport,
} = require('./lib/ccxray');

function parseArgs(argv) {
  return {
    once: argv.includes('--once') || process.env.CCXRAY_MISSION_ONCE === '1',
    intervalMs: Number(process.env.CCXRAY_MISSION_INTERVAL_MS || 5000),
    maxRows: Number(process.env.CCXRAY_MISSION_MAX_ROWS || 8),
    showCapabilities: argv.includes('--capabilities') || process.env.CCXRAY_MISSION_SHOW_CAPABILITIES === '1',
  };
}

function fit(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + '~';
}

function signedPercent(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return null;
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function rowCost(row) {
  const cost = formatMoney(row.cost);
  return row.exactCost || row.cost === 0 ? cost : `~${cost}`;
}

function confidenceCost(value, exact) {
  const cost = formatMoney(value);
  return exact || value === 0 ? cost : `~${cost}`;
}

function rowIdentity(row) {
  const location = row.paneId || shortId(row.sessionId);
  const agent = shortModel(row.agent || row.model);
  return `${row.severity.toUpperCase()} ${location} ${agent}`;
}

function rowMetrics(row, opts = {}) {
  const parts = [];
  if (Number.isFinite(row.ctxPct)) {
    const delta = signedPercent(row.ctxDelta);
    parts.push(`ctx ${Math.round(row.ctxPct)}%${delta ? ` (${delta}/turn)` : ''}`);
  } else {
    parts.push('ctx ?');
  }
  parts.push(`main ${rowCost(row)}`);
  if (opts.includeRecent !== false && row.totalRecentCost > 0) {
    parts.push(`+${confidenceCost(row.totalRecentCost, row.exactRecentCost)}/5m`);
  }
  return parts.join(' · ');
}

function rowSignals(row) {
  const parts = row.reasons.filter(reason => reason !== row.status);
  if (row.sessionId && row.mapping !== 'exact') parts.push(`session ${shortId(row.sessionId)}`);
  if (row.subagents) {
    const seen = `, seen 5m ${row.subagents.seenRecently}`;
    const cost = row.subagents.cost > 0
      ? `, total ${confidenceCost(row.subagents.cost, row.subagents.exactCost)}`
      : '';
    parts.push(`subagents ${row.subagents.count}${seen}${cost}`);
  }
  if (Number.isFinite(row.cachePct)) parts.push(`cache ${Math.round(row.cachePct)}%`);
  parts.push(`seen ${row.freshness}`);
  if (row.mapping !== 'recent') parts.push(row.mapping);
  return parts.join(' · ');
}

function compactTokens(value) {
  const tokens = Number(value || 0);
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

function rowCapabilities(row) {
  const cap = row.capabilities;
  if (!cap) return null;
  const parts = [];
  if (Number.isFinite(cap.exposedTools)) {
    parts.push(`tools ${cap.usedTools}/${cap.exposedTools}`);
    parts.push(`schema est ~${compactTokens(cap.schemaTokens)}`);
    if (cap.deferredTools) parts.push(`deferred ${cap.deferredTools}`);
  }
  if (cap.largestUnusedMcp) {
    parts.push(`not called here MCP ${cap.largestUnusedMcp.server} ~${compactTokens(cap.largestUnusedMcp.tokens)}`);
  }
  if (cap.skills?.length) {
    parts.push(`skills ${cap.skills.slice(0, 2).map(skill => `${skill.name} x${skill.count}`).join(', ')}`);
  }
  return parts.join(' · ');
}

function renderRows(snapshot, cols, tiny, showCapabilities) {
  const max = Math.max(cols - 1, 15);
  if (!snapshot.rows.length) {
    console.log(fit(snapshot.herdrOk ? 'No traced sessions yet' : 'No recent ccxray sessions', max));
    console.log(fit('Next: open ccxray Quick Start and launch an agent', max));
    return;
  }

  for (const row of snapshot.rows) {
    if (tiny) {
      console.log(fit(rowIdentity(row), max));
      console.log(fit(rowMetrics(row, { includeRecent: false }), max));
      console.log(fit(`${rowSignals(row)}${row.action ? ` · next ${row.action}` : ''}`, max));
    } else {
      console.log(fit(`${rowIdentity(row)} · ${row.status}${row.action ? ` · next ${row.action}` : ''}`, max));
      console.log(fit(`  ${rowMetrics(row)}`, max));
      console.log(fit(`  ${rowSignals(row)}`, max));
      if (showCapabilities) {
        const capabilities = rowCapabilities(row);
        if (capabilities) console.log(fit(`  ${capabilities}`, max));
      }
    }
    console.log('');
  }
}

function render(args) {
  const status = statusReport();
  const snapshot = missionControlSnapshot({
    env: process.env,
    maxRows: args.maxRows,
  });
  const now = new Date().toLocaleTimeString();
  const state = status.parsed.running ? 'ok' : 'no-hub';
  const cols = Math.max(16, Math.min(Number(process.env.CCXRAY_MISSION_COLS) || process.stdout.columns || 48, 120));
  const tiny = cols < 32;
  const max = cols - 1;

  if (!args.once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(fit(tiny ? 'ccxray MC' : 'ccxray Mission Control', max));
  const sourceLabel = snapshot.source === 'agents' ? 'panes' : (tiny ? 'recent' : 'recent sessions');
  const summary = tiny
    ? `${snapshot.totalRows} ${sourceLabel} / ${snapshot.attention} alert`
    : `${snapshot.totalRows} ${sourceLabel} · ${snapshot.attention} attention · +${confidenceCost(snapshot.recentCost, snapshot.exactRecentCost)}/5m`;
  console.log(fit(summary, max));
  const hubLabel = status.parsed.running ? 'ok' : (tiny ? 'no' : 'unavailable');
  console.log(fit(tiny ? `Hub ${hubLabel}` : `Updated ${now} · Hub ${hubLabel}`, max));
  console.log('');
  renderRows(snapshot, cols, tiny, args.showCapabilities);

  const meta = reportPaneTokens({
    xray: state,
    mc_attention: String(snapshot.attention),
    mc_agents: String(snapshot.totalRows),
  }, { ttlMs: Math.max(args.intervalMs * 2, 10000) });
  if (process.env.HERDR_PANE_ID) {
    console.log(fit(tiny ? `Meta ${meta.ok ? 'ok' : 'miss'}` : `Pane metadata: ${meta.ok ? 'reported' : 'not reported'}`, max));
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
