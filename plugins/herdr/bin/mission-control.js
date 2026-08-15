#!/usr/bin/env node
'use strict';

const {
  formatMoney,
  missionControlSnapshot,
  reportPaneTokens,
  runCcxray,
  runHerdr,
  shortId,
  shortModel,
  statusReport,
} = require('./lib/ccxray');
const {
  budgetedListViewport,
  displayWidth,
  truncateText,
  wrapText,
} = require('./lib/tui');

function parseArgs(argv) {
  return {
    once: argv.includes('--once') || process.env.CCXRAY_MISSION_ONCE === '1',
    intervalMs: Number(process.env.CCXRAY_MISSION_INTERVAL_MS || 5000),
    maxRows: Number(process.env.CCXRAY_MISSION_MAX_ROWS || 24),
    showCapabilities: argv.includes('--capabilities') || process.env.CCXRAY_MISSION_SHOW_CAPABILITIES === '1',
  };
}

function missionRowKey(row) {
  return row?.paneId || row?.sessionId || null;
}

function missionKeyIntent(key) {
  if (key === '\x1b[A' || key === '\x1bOA' || key === 'k' || key === 'K') return { type: 'move', delta: -1 };
  if (key === '\x1b[B' || key === '\x1bOB' || key === 'j' || key === 'J') return { type: 'move', delta: 1 };
  if (key === '\r' || key === '\n') return { type: 'focus' };
  if (key === 'd' || key === 'D') return { type: 'dashboard' };
  if (key === 'f' || key === 'F') return { type: 'filter' };
  if (key === 'r' || key === 'R') return { type: 'refresh' };
  if (key === '?') return { type: 'help' };
  if (key === '\u0003' || key === '\x1b' || key === 'q' || key === 'Q') return { type: 'close' };
  return { type: 'ignore' };
}

function reconcileMissionState(state = {}, rows = []) {
  const previousIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : 0;
  let selectedIndex = rows.findIndex(row => missionRowKey(row) === state.selectedKey);
  if (selectedIndex < 0 && rows.length) selectedIndex = Math.min(Math.max(previousIndex, 0), rows.length - 1);
  if (!rows.length) selectedIndex = -1;
  return {
    ...state,
    filter: state.filter || 'all',
    selectedIndex,
    selectedKey: selectedIndex >= 0 ? missionRowKey(rows[selectedIndex]) : null,
  };
}

function moveMissionSelection(state, rows, delta) {
  if (!rows.length) return reconcileMissionState(state, rows);
  const current = rows.findIndex(row => missionRowKey(row) === state.selectedKey);
  const selectedIndex = Math.min(Math.max((current < 0 ? 0 : current) + delta, 0), rows.length - 1);
  return {
    ...state,
    selectedIndex,
    selectedKey: missionRowKey(rows[selectedIndex]),
  };
}

function fit(value, max) {
  return truncateText(value, max);
}

function fitColumns(left, right, max) {
  if (!right) return fit(left, max);
  const gap = max - displayWidth(left) - displayWidth(right);
  if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  return fit(left, max);
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

function filteredMissionRows(rows, filter) {
  if (filter === 'attention') return rows.filter(row => row.severity === 'red' || row.severity === 'yellow');
  if (filter === 'ready') return rows.filter(row => row.severity === 'ready');
  return rows;
}

function rowReasonText(row) {
  const reasons = [];
  if (Number.isFinite(row.ctxPct) && row.ctxPct > 40) reasons.push(`context pressure ${Math.round(row.ctxPct)}%`);
  for (const reason of row.reasons || []) {
    if (reason !== row.status && !reasons.includes(reason)) reasons.push(reason);
  }
  if (!reasons.length && row.severity === 'ready') return 'Agent finished; output still needs human review.';
  if (!reasons.length) return 'No current high-risk signal observed.';
  return reasons.join(' · ');
}

function detailLines(row, max, showCapabilities) {
  if (!row) return [];
  const lines = [];
  const add = text => lines.push(...wrapText(text, max));
  const turns = `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`;
  const tools = `${row.toolCalls} ${row.toolCalls === 1 ? 'tool' : 'tools'}`;
  add(`Selected ${row.paneId || shortId(row.sessionId)} · ${shortModel(row.agent || row.model)} · ${row.status}`);
  add(`Session: ${shortModel(row.model)} · age ${row.sessionAge} · ${turns} · ${tools}`);
  add(`Metrics: ${rowMetrics(row)}`);
  add(`Why: ${rowReasonText(row)}`);
  add(`Next: ${row.action || 'continue monitoring'}`);
  add(`Evidence: pane/session ${row.mapping} · cost ${row.exactCost ? 'exact' : 'estimated'} · seen ${row.freshness}`);
  const signals = rowSignals(row);
  if (signals) add(`Signals: ${signals}`);
  if (showCapabilities) {
    const capabilities = rowCapabilities(row);
    if (capabilities) add(`Capabilities: ${capabilities}`);
  }
  return lines;
}

function decisionDetailLines(row, max) {
  if (!row) return [];
  return [
    ...wrapText(`Next: ${row.action || 'continue monitoring'}`, max),
    ...wrapText(`Why: ${rowReasonText(row)}`, max),
  ];
}

function renderMissionHelp(max, lineBudget = Infinity) {
  const help = [
    'Mission Control prioritizes attention; color is not an outcome or quality score.',
    '~ cost is estimated; exact cost has no prefix.',
    'Up/Down or j/k: move selection',
    'Enter: focus selected Herdr pane',
    'd: open ccxray dashboard · f: change filter · r: refresh',
    'Esc or q: close · ?: hide this help',
  ];
  const lines = help.flatMap(item => wrapText(item, max)).slice(0, lineBudget);
  for (const line of lines) console.log(line);
}

function render(args, uiState = {}, message = '') {
  const status = statusReport();
  const snapshot = missionControlSnapshot({
    env: process.env,
    maxRows: args.maxRows,
  });
  const now = new Date().toLocaleTimeString();
  const xrayState = status.parsed.running ? 'ok' : 'no-hub';
  const cols = Math.max(16, Math.min(Number(process.env.CCXRAY_MISSION_COLS) || process.stdout.columns || 48, 120));
  const tiny = cols < 32;
  const compact = cols < 48;
  const max = cols - 1;
  const terminalRows = Math.max(12, Math.min(Number(process.env.CCXRAY_MISSION_ROWS) || process.stdout.rows || 24, 80));
  const rows = filteredMissionRows(snapshot.rows, uiState.filter || 'all');
  let state = reconcileMissionState(uiState, rows);
  const footerLines = wrapText('Enter focus · d dashboard · f filter · r refresh · ? help · q close', max);
  const headerLines = 4;
  const maxMessageLines = Math.max(0, terminalRows - headerLines - footerLines.length - 2);
  const messageLines = message ? wrapText(message, max).slice(0, maxMessageLines) : [];
  const bodyBudget = Math.max(1, terminalRows - headerLines - 1 - footerLines.length - messageLines.length);
  let detail = detailLines(rows[state.selectedIndex], max, args.showCapabilities);
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

  if (!args.once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(fitColumns(compact ? 'ccxray MC' : 'ccxray Mission Control', `Filter ${state.filter || 'all'}`, max));
  const sourceLabel = snapshot.source === 'agents' ? 'panes' : (tiny ? 'recent' : 'recent sessions');
  const summary = compact
    ? `${snapshot.totalRows} ${sourceLabel} / ${snapshot.attention} alert`
    : `${snapshot.totalRows} ${sourceLabel} · ${snapshot.attention} attention · +${confidenceCost(snapshot.recentCost, snapshot.exactRecentCost)}/5m`;
  console.log(fit(summary, max));
  const hubLabel = status.parsed.running ? 'ok' : (tiny ? 'no' : 'unavailable');
  console.log(fit(tiny ? `Hub ${hubLabel}` : `Updated ${now} · Hub ${hubLabel}`, max));
  console.log('');

  if (state.help) {
    renderMissionHelp(max, bodyBudget);
  } else if (!rows.length) {
    const empty = snapshot.rows.length
      ? `No agents match the ${state.filter} filter`
      : (snapshot.herdrOk ? 'No traced sessions yet' : 'No recent ccxray sessions');
    const emptyLines = wrapText(empty, max);
    const recoveryLines = wrapText(snapshot.rows.length
      ? 'Press f to change the filter.'
      : 'Next: open ccxray Quick Start and launch an agent.', max);
    for (const line of [...emptyLines, ...recoveryLines].slice(0, bodyBudget)) console.log(line);
  } else {
    if (viewport.overflow && viewport.overflowBefore) console.log(fit(`  ${viewport.overflow}`, max));
    for (let index = viewport.start; index < viewport.end; index++) {
      const row = rows[index];
      const selected = index === state.selectedIndex;
      const cursor = selected ? '›' : ' ';
      const identity = `${cursor} ${rowIdentity(row)} · ${row.status}`;
      const ctx = Number.isFinite(row.ctxPct) ? `ctx ${Math.round(row.ctxPct)}%` : 'ctx ?';
      const line = fitColumns(identity, `${ctx} · ${rowCost(row)}`, max);
      if (!args.once && selected) console.log(`\x1b[7m${line}\x1b[0m`);
      else console.log(line);
    }
    if (viewport.overflow && !viewport.overflowBefore) console.log(fit(`  ${viewport.overflow}`, max));
    if (detailGap) console.log('');
    for (const line of detail) console.log(line);
  }

  console.log('');
  for (const line of footerLines) console.log(line);
  for (const line of messageLines) console.log(line);

  const meta = reportPaneTokens({
    xray: xrayState,
    mc_attention: String(snapshot.attention),
    mc_agents: String(snapshot.totalRows),
  }, { ttlMs: Math.max(args.intervalMs * 2, 10000) });
  return { snapshot, rows, state, selected: rows[state.selectedIndex] || null, meta };
}

function cycleMissionFilter(filter) {
  const filters = ['all', 'attention', 'ready'];
  const index = filters.indexOf(filter);
  return filters[(index + 1) % filters.length];
}

function executeMissionAction(intent, row, env = process.env) {
  if (intent.type === 'focus') {
    if (!row?.paneId) return 'This session has no active Herdr pane to focus.';
    const result = runHerdr(['agent', 'focus', row.paneId], { env, timeoutMs: 3000 });
    if (result.status !== 0 || result.error) return 'Could not focus the selected pane. Run Doctor for details.';
    return `Focused ${row.paneId}.`;
  }
  if (intent.type === 'dashboard') {
    const status = statusReport({ env });
    if (!status.parsed.running) return 'Dashboard unavailable: start a traced agent or run Doctor.';
    const args = ['open'];
    if (row?.sessionId) args.push('--session', row.sessionId);
    const result = runCcxray(args, { env, timeoutMs: 8000 });
    if (result.status !== 0 || result.error) return 'Could not open the dashboard. Run Doctor for details.';
    return row?.sessionId ? `Opened dashboard for session ${shortId(row.sessionId)}.` : 'Opened ccxray dashboard.';
  }
  return '';
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
    process.stdout.write('\x1b[?25h');
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
    const intent = missionKeyIntent(key);
    if (intent.type === 'ignore') return;
    if (intent.type === 'close') return close();
    if (intent.type === 'move') {
      state = moveMissionSelection(state, view.rows, intent.delta);
      message = '';
    } else if (intent.type === 'filter') {
      state = { ...state, filter: cycleMissionFilter(state.filter), viewportStart: 0 };
      message = `Filter changed to ${state.filter}.`;
    } else if (intent.type === 'help') {
      state = { ...state, help: !state.help };
      message = '';
    } else if (intent.type === 'refresh') {
      message = 'Refreshed from ccxray and Herdr.';
    } else {
      message = executeMissionAction(intent, view.selected);
    }
    draw();
  };

  process.stdout.write('\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  timer = setInterval(draw, Math.max(args.intervalMs, 1000));
  const stop = code => {
    clearInterval(timer);
    restoreTerminal();
    process.exit(code);
  };
  process.once('exit', restoreTerminal);
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
}

if (require.main === module) main();

module.exports = {
  main,
  cycleMissionFilter,
  executeMissionAction,
  filteredMissionRows,
  missionKeyIntent,
  moveMissionSelection,
  reconcileMissionState,
  render,
};
