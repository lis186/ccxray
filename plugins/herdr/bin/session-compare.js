#!/usr/bin/env node
'use strict';

const {
  formatMoney,
  sessionCompareSnapshot,
  shortId,
  shortModel,
} = require('./lib/ccxray');

function parseArgs(argv) {
  return {
    once: argv.includes('--once') || process.env.CCXRAY_COMPARE_ONCE === '1',
    intervalMs: Number(process.env.CCXRAY_COMPARE_INTERVAL_MS || 5000),
  };
}

function fit(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + '~';
}

function confidenceCost(value, exact) {
  const text = formatMoney(value);
  return exact || value === 0 ? text : `~${text}`;
}

function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '<1m';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 90) return `${minutes}m`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
}

function outcomeText(row) {
  return (row.outcome || 'unlabelled').toUpperCase();
}

function identity(label, row) {
  return `${label}  ${outcomeText(row)}  ${row.paneId || shortId(row.sessionId)}  ${shortModel(row.model)}`;
}

function metricValue(name, row) {
  switch (name) {
    case 'Total cost': return confidenceCost(row.totalCost, row.exactTotalCost);
    case 'Main + child': return `${confidenceCost(row.cost, row.exactCost)} + ${confidenceCost(row.subagents?.cost || 0, row.subagents?.exactCost !== false)}`;
    case 'Duration': return durationText(row.durationMs);
    case 'Turns': return String(row.turns);
    case 'Context': return Number.isFinite(row.ctxPct) ? `${Math.round(row.ctxPct)}%` : '?';
    case 'Cache': return Number.isFinite(row.cachePct) ? `${Math.round(row.cachePct)}%` : '?';
    case 'Tool calls':
    case 'Calls main+child': return `${row.mainToolCalls} + ${row.subagents?.toolCalls || 0}`;
    case 'Tool failures': {
      const failures = row.failures + Number(row.subagents?.failures || 0);
      const coverage = row.failureCoverage + Number(row.subagents?.failureCoverage || 0);
      return coverage ? `${failures}/${coverage} observed` : '?';
    }
    case 'Subagents': return row.subagents ? String(row.subagents.count) : '0';
    default: return '';
  }
}

const METRICS = [
  'Total cost',
  'Main + child',
  'Duration',
  'Turns',
  'Context',
  'Cache',
  'Calls main+child',
  'Tool failures',
  'Subagents',
];

function pad(value, width) {
  return fit(value, width).padEnd(width);
}

function wrappedLines(value, width) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function printWrapped(prefix, value, max) {
  const firstWidth = Math.max(8, max - prefix.length);
  const firstPass = wrappedLines(value, firstWidth);
  console.log(`${prefix}${firstPass[0]}`);
  for (const remaining of firstPass.slice(1).flatMap(line => wrappedLines(line, max))) {
    console.log(remaining);
  }
}

function renderWide(left, right, max) {
  const metricWidth = 16;
  const valueWidth = Math.min(32, Math.max(18, Math.floor((max - metricWidth - 4) / 2)));
  console.log(fit(identity('A', left), max));
  console.log(fit(identity('B', right), max));
  console.log('');
  console.log(`${pad('Metric', metricWidth)}  ${pad('A', valueWidth)}  ${pad('B', valueWidth)}`);
  for (const metric of METRICS) {
    console.log(`${pad(metric, metricWidth)}  ${pad(metricValue(metric, left), valueWidth)}  ${fit(metricValue(metric, right), valueWidth)}`);
  }
}

function renderNarrow(label, row, max) {
  console.log(fit(identity(label, row), max));
  console.log(fit(`  cost ${metricValue('Total cost', row)} (${metricValue('Main + child', row)})`, max));
  console.log(fit(`  ${metricValue('Duration', row)} · ${row.turns} turns · ctx ${metricValue('Context', row)} · cache ${metricValue('Cache', row)}`, max));
  console.log(fit(`  tools ${metricValue('Tool calls', row)} · fail ${metricValue('Tool failures', row)}`, max));
  console.log(fit(`  subagents ${metricValue('Subagents', row)}`, max));
}

function render(args) {
  const cols = Math.max(24, Math.min(Number(process.env.CCXRAY_COMPARE_COLS) || process.stdout.columns || 72, 140));
  const max = cols - 1;
  const snapshot = sessionCompareSnapshot({ env: process.env });
  if (!args.once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(fit('ccxray Session Compare', max));
  console.log(fit(cols >= 72
    ? 'Outcome-aware observation · not a controlled experiment'
    : 'Observation · not controlled A/B', max));
  console.log('');

  if (!snapshot.left || !snapshot.right) {
    const guidance = snapshot.rows.length === 0
      ? 'Start two traced sessions from ccxray Quick Start.'
      : 'One more traced session is needed before comparison.';
    console.log(fit(guidance, max));
    console.log(fit(`Found ${snapshot.rows.length} linked session${snapshot.rows.length === 1 ? '' : 's'}.`, max));
    return;
  }

  if (cols >= 72) {
    renderWide(snapshot.left, snapshot.right, max);
  } else {
    renderNarrow('A', snapshot.left, max);
    console.log('');
    renderNarrow('B', snapshot.right, max);
  }
  console.log('');
  printWrapped('Read: ', snapshot.read, max);
  printWrapped('Guardrail: ', 'Observed sessions are not a controlled A/B test; task difficulty and environment may differ.', max);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  render(args);
  if (args.once) return;
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
