#!/usr/bin/env node
'use strict';

const {
  capabilityReview,
  readIndexTailEntries,
  runHerdr,
} = require('./lib/ccxray');
const {
  budgetedListViewport,
  displayWidth,
  restoreFrameCursor,
  truncateText,
  writeFrame,
  wrapText,
} = require('./lib/tui');

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

function fitColumns(left, right, max) {
  const gap = max - displayWidth(left) - displayWidth(right || '');
  if (right && gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  return truncateText(left, max);
}

function windowLabel(windowMs) {
  const days = windowMs / (24 * 60 * 60000);
  return days >= 1 ? `${Math.round(days)}d` : `${Math.round(windowMs / 3600000)}h`;
}

function capabilityRows(review) {
  const rows = review.mcp.map(row => ({
    ...row,
    key: `mcp:${row.server}`,
    type: 'mcp',
    label: `MCP ${row.server}`,
  }));
  const denominator = review.sessionsWithSkillCoverage || review.totalSessions;
  rows.push(...review.skills.map(row => ({
    ...row,
    key: `skill:${row.name}`,
    type: 'skill',
    label: `Skill ${row.name}`,
    denominator,
  })));
  return rows;
}

function capabilityKeyIntent(key) {
  if (key === '\x1b[A' || key === '\x1bOA' || key === 'k' || key === 'K') return { type: 'move', delta: -1 };
  if (key === '\x1b[B' || key === '\x1bOB' || key === 'j' || key === 'J') return { type: 'move', delta: 1 };
  if (key === 'f' || key === 'F') return { type: 'filter' };
  if (key === 'r' || key === 'R') return { type: 'refresh' };
  if (key === '?') return { type: 'help' };
  if (key === '\u0003' || key === '\x1b' || key === 'q' || key === 'Q') return { type: 'close' };
  return { type: 'ignore' };
}

function filteredCapabilityRows(rows, filter) {
  if (filter === 'mcp') return rows.filter(row => row.type === 'mcp');
  if (filter === 'skills') return rows.filter(row => row.type === 'skill');
  return rows;
}

function reconcileCapabilityState(state = {}, rows = []) {
  const previousIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : 0;
  let selectedIndex = rows.findIndex(row => row.key === state.selectedKey);
  if (selectedIndex < 0 && rows.length) selectedIndex = Math.min(Math.max(previousIndex, 0), rows.length - 1);
  if (!rows.length) selectedIndex = -1;
  return {
    ...state,
    filter: state.filter || 'all',
    selectedIndex,
    selectedKey: selectedIndex >= 0 ? rows[selectedIndex].key : null,
  };
}

function moveCapabilitySelection(state, rows, delta) {
  if (!rows.length) return reconcileCapabilityState(state, rows);
  const current = rows.findIndex(row => row.key === state.selectedKey);
  const selectedIndex = Math.min(Math.max((current < 0 ? 0 : current) + delta, 0), rows.length - 1);
  return { ...state, selectedIndex, selectedKey: rows[selectedIndex].key };
}

function cycleCapabilityFilter(filter) {
  const filters = ['all', 'mcp', 'skills'];
  const index = filters.indexOf(filter);
  return filters[(index + 1) % filters.length];
}

function interpretation(row) {
  if (row.type === 'skill') return 'observed use only; catalog eligibility is unknown';
  if (row.recommendation === 'DEFER CANDIDATE') return 'experiment candidate';
  if (row.recommendation === 'FILTER CANDIDATE') return 'allowlist experiment candidate';
  if (row.recommendation === 'KEEP') return 'frequently used observation';
  if (row.recommendation === 'DEFERRED') return 'already deferred from upfront schema';
  if (row.recommendation === 'OBSERVE') return 'sample incomplete';
  return 'mixed usage; inspect before designing an experiment';
}

function nextAction(row) {
  if (row.type === 'skill') return 'keep observing; no removal decision is supported';
  if (row.recommendation === 'DEFER CANDIDATE') return 'validate with a project-scoped experiment';
  if (row.recommendation === 'FILTER CANDIDATE') return 'test an allowlist on the same task case';
  if (row.recommendation === 'OBSERVE') return 'collect at least 5 eligible sessions';
  if (row.recommendation === 'DEFERRED') return 'no configuration change needed';
  return 'compare the same task case before changing configuration';
}

function rowSummary(row) {
  if (row.type === 'skill') return `seen ${row.sessions}/${row.denominator} sessions · ${row.calls} calls · observed only`;
  return `~${compactTokens(row.avgSchemaTokens)}/session · used ${row.usedSessions}/${row.eligibleSessions} eligible`;
}

function detailLines(row, max) {
  if (!row) return [];
  const lines = [];
  const add = text => lines.push(...wrapText(text, max));
  add(`Selected ${row.label}`);
  if (row.type === 'skill') {
    add(`Observed: seen ${row.sessions}/${row.denominator} sessions · ${row.calls} calls · observed only`);
  } else {
    add(`Observed: schema ~${compactTokens(row.avgSchemaTokens)}/session · used ${row.usedSessions}/${row.eligibleSessions} eligible`);
  }
  add(`Interpretation: ${interpretation(row)}`);
  add('Confidence: derived estimate · outcome impact unknown');
  add(`Next: ${nextAction(row)}`);
  return lines;
}

function decisionDetailLines(row, max) {
  if (!row) return [];
  return [
    ...wrapText(`Next: ${nextAction(row)}`, max),
    ...wrapText('Confidence: derived estimate · outcome impact unknown', max),
  ];
}

function renderHelp(max, lineBudget = Infinity) {
  const lines = [
    'Capability Footprint shows observed exposure and calls; it does not measure task value.',
    'Up/Down or j/k: move selection',
    'f: filter all, MCP, or skills · r: refresh',
    'Esc or q: close · ?: hide this help',
  ];
  return lines.flatMap(value => wrapText(value, max)).slice(0, lineBudget);
}

function render(args, uiState = {}, message = '') {
  const nowMs = Number(process.env.CCXRAY_HERDR_NOW_MS) || Date.now();
  const review = capabilityReview(readIndexTailEntries({ env: process.env }), {
    env: process.env,
    nowMs,
    windowMs: args.windowMs,
  });
  const cols = Math.max(24, Math.min(Number(process.env.CCXRAY_CAPABILITY_COLS) || process.stdout.columns || 80, 120));
  const max = cols - 1;
  const terminalRows = Math.max(12, Math.min(Number(process.env.CCXRAY_CAPABILITY_ROWS) || process.stdout.rows || 24, 80));
  const allRows = capabilityRows(review);
  const rows = filteredCapabilityRows(allRows, uiState.filter || 'all');
  let state = reconcileCapabilityState(uiState, rows);
  const experimentalLines = wrapText('Experimental · observations, not outcome-backed recommendations', max);
  const footerLines = wrapText('Up/Down or j/k move · f filter · r refresh · ? help · q close', max);
  const headerLines = 3 + experimentalLines.length;
  const maxMessageLines = Math.max(0, terminalRows - headerLines - footerLines.length - 2);
  const messageLines = message ? wrapText(message, max).slice(0, maxMessageLines) : [];
  const bodyBudget = Math.max(1, terminalRows - headerLines - 1 - footerLines.length - messageLines.length);
  let detail = detailLines(rows[state.selectedIndex], max);
  const minListLines = rows.length > 1 ? 2 : 1;
  if (detail.length + minListLines + 1 > bodyBudget) {
    detail = decisionDetailLines(rows[state.selectedIndex], max);
  }
  const maxDetailLines = Math.max(0, bodyBudget - minListLines - (detail.length ? 1 : 0));
  detail = detail.slice(0, maxDetailLines);
  const detailGap = detail.length ? 1 : 0;
  const listHeight = Math.max(1, bodyBudget - detail.length - detailGap);
  const viewport = budgetedListViewport(rows.length, state.selectedIndex, listHeight, state.viewportStart || 0);
  state = { ...state, viewportStart: viewport.start };

  const output = [];
  output.push(fitColumns('ccxray Capability Footprint', `Filter ${state.filter}`, max));
  output.push(...experimentalLines);
  output.push(truncateText(`Window ${windowLabel(review.windowMs)} · ${review.sessionsWithSchema} sessions with schema · estimates`, max));
  output.push('');

  if (state.help) {
    output.push(...renderHelp(max, bodyBudget));
  } else if (!rows.length) {
    const empty = allRows.length ? `No rows match the ${state.filter} filter.` : 'No MCP or skill observations in this window.';
    const emptyLines = wrapText(empty, max);
    const recoveryLines = wrapText(allRows.length ? 'Press f to change the filter.' : 'Run traced sessions before reviewing capability footprint.', max);
    output.push(...[...emptyLines, ...recoveryLines].slice(0, bodyBudget));
  } else {
    if (viewport.overflow && viewport.overflowBefore) output.push(truncateText(`  ${viewport.overflow}`, max));
    for (let index = viewport.start; index < viewport.end; index++) {
      const row = rows[index];
      const selected = index === state.selectedIndex;
      const cursor = selected ? '›' : ' ';
      const line = fitColumns(`${cursor} ${row.label}`, rowSummary(row), max);
      if (!args.once && selected) output.push(`\x1b[7m${line}\x1b[0m`);
      else output.push(line);
    }
    if (viewport.overflow && !viewport.overflowBefore) output.push(truncateText(`  ${viewport.overflow}`, max));
    if (detailGap) output.push('');
    output.push(...detail);
  }

  output.push('');
  output.push(...footerLines);
  output.push(...messageLines);
  writeFrame(output, { clear: !args.once, interactive: !args.once });
  return { review, rows, state, selected: rows[state.selectedIndex] || null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const interactive = !args.once
    && process.stdin.isTTY
    && process.stdout.isTTY
    && typeof process.stdin.setRawMode === 'function';
  let state = { filter: 'all', selectedIndex: 0, selectedKey: null, viewportStart: 0, help: false };
  let message = '';
  let timer = null;
  let view = render(args, state, message);
  state = view.state;
  if (!interactive) return;

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    process.stdin.removeListener('data', onData);
    process.stdout.removeListener('resize', onResize);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    restoreFrameCursor();
  };
  const draw = () => {
    view = render(args, state, message);
    state = view.state;
  };
  const close = () => {
    if (timer) clearInterval(timer);
    restoreTerminal();
    if (process.env.HERDR_PANE_ID) {
      runHerdr(['plugin', 'pane', 'close', process.env.HERDR_PANE_ID], { timeoutMs: 2000 });
    }
    process.exit(0);
  };
  const onResize = () => draw();
  const onData = key => {
    const intent = capabilityKeyIntent(key);
    if (intent.type === 'ignore') return;
    if (intent.type === 'close') return close();
    if (intent.type === 'move') {
      state = moveCapabilitySelection(state, view.rows, intent.delta);
      message = '';
    } else if (intent.type === 'filter') {
      state = { ...state, filter: cycleCapabilityFilter(state.filter), viewportStart: 0 };
      message = `Filter changed to ${state.filter}.`;
    } else if (intent.type === 'help') {
      state = { ...state, help: !state.help };
      message = '';
    } else if (intent.type === 'refresh') {
      message = 'Refreshed from ccxray observations.';
    }
    draw();
  };

  process.stdout.write('\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  timer = setInterval(draw, Math.max(args.intervalMs, 5000));
  const stop = code => {
    if (timer) clearInterval(timer);
    restoreTerminal();
    process.exit(code);
  };
  process.once('exit', restoreTerminal);
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
}

if (require.main === module) main();

module.exports = {
  capabilityKeyIntent,
  capabilityRows,
  cycleCapabilityFilter,
  filteredCapabilityRows,
  main,
  moveCapabilitySelection,
  reconcileCapabilityState,
  render,
};
