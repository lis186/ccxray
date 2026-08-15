#!/usr/bin/env node
'use strict';

const { capabilityReview, readIndexTailEntries } = require('./lib/ccxray');

function parseArgs(argv) {
  return {
    once: argv.includes('--once') || process.env.CCXRAY_CAPABILITY_ONCE === '1',
    intervalMs: Number(process.env.CCXRAY_CAPABILITY_INTERVAL_MS || 30000),
    windowMs: Number(process.env.CCXRAY_CAPABILITY_WINDOW_MS || 7 * 24 * 60 * 60000),
  };
}

function compactTokens(value) {
  const tokens = Number(value || 0);
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

function fit(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + '~';
}

function recommendationDetail(value) {
  if (value === 'DEFER CANDIDATE') return 'validate with a project-scoped experiment';
  if (value === 'FILTER CANDIDATE') return 'allowlist commonly used tools in an experiment';
  if (value === 'KEEP') return 'frequently used in eligible sessions';
  if (value === 'DEFERRED') return 'already excluded from upfront schema';
  if (value === 'OBSERVE') return 'need at least 5 eligible sessions';
  return 'review usage before changing configuration';
}

function windowLabel(windowMs) {
  const days = windowMs / (24 * 60 * 60000);
  return days >= 1 ? `${Math.round(days)}d` : `${Math.round(windowMs / 3600000)}h`;
}

function render(args) {
  const nowMs = Number(process.env.CCXRAY_HERDR_NOW_MS) || Date.now();
  const review = capabilityReview(readIndexTailEntries({ env: process.env }), {
    env: process.env,
    nowMs,
    windowMs: args.windowMs,
  });
  const cols = Math.max(32, Math.min(Number(process.env.CCXRAY_CAPABILITY_COLS) || process.stdout.columns || 80, 120));
  const max = cols - 1;
  if (!args.once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(fit('ccxray Capability Review', max));
  console.log(fit(`Window ${windowLabel(review.windowMs)} · ${review.sessionsWithSchema} sessions with schema · estimates`, max));
  console.log('');

  if (!review.mcp.length) {
    console.log('No MCP schema observations in this window.');
  }
  for (const row of review.mcp) {
    console.log(fit(`MCP ${row.server}`, max));
    console.log(fit(`  schema ~${compactTokens(row.avgSchemaTokens)}/session · used ${row.usedSessions}/${row.eligibleSessions} eligible`, max));
    console.log(fit(`  ${row.recommendation} · ${recommendationDetail(row.recommendation)}`, max));
    console.log('');
  }

  if (review.skills.length) {
    console.log('Observed skills (no catalog eligibility):');
    const denominator = review.sessionsWithSkillCoverage || review.totalSessions;
    for (const skill of review.skills.slice(0, 8)) {
      console.log(fit(`  ${skill.name} · seen ${skill.sessions}/${denominator} sessions · ${skill.calls} calls · observed only`, max));
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  render(args);
  if (args.once) process.exit(0);
  const timer = setInterval(() => render(args), Math.max(args.intervalMs, 5000));
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
