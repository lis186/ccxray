#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pluginRoot,
  filterEntriesToWorkspace,
  readIndexTailEntries,
  resolveCcxrayCommand,
  resolveHerdrConfigPath,
  runHerdr,
  statusReport,
} = require('./lib/ccxray');
const { displayWidth, restoreFrameCursor, truncateText, writeFrame, wrapText } = require('./lib/tui');

const PROVIDERS = [
  { id: 'claude', label: 'Claude', key: '1' },
  { id: 'codex', label: 'Codex', key: '2' },
  { id: 'grok', label: 'Grok', key: '3' },
];

function searchPath(env = process.env) {
  const home = env.HOME || os.homedir();
  const parts = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.grok', 'bin'),
    '/Applications/ChatGPT.app/Contents/Resources',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...String(env.PATH || '').split(path.delimiter),
  ];
  return [...new Set(parts.filter(Boolean))];
}

function executable(name, env = process.env) {
  for (const dir of searchPath(env)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function availableProviders(env = process.env) {
  if (env.CCXRAY_ONBOARDING_PROVIDERS != null) {
    const selected = new Set(env.CCXRAY_ONBOARDING_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean));
    return PROVIDERS.map(provider => ({ ...provider, available: selected.has(provider.id) }));
  }
  return PROVIDERS.map(provider => ({ ...provider, available: Boolean(executable(provider.id, env)) }));
}

function sidebarInstalled(env = process.env) {
  const file = resolveHerdrConfigPath(env);
  try {
    const config = fs.readFileSync(file, 'utf8');
    return /token\s*=\s*"\$summary"/.test(config) && /token\s*=\s*"\$ctx_bar_(?:green|yellow|red)"/.test(config);
  } catch {
    return false;
  }
}

function snapshot(env = process.env) {
  const status = statusReport({ env, timeoutMs: 4000 });
  const ccxrayReady = !status.result.error;
  const scoped = filterEntriesToWorkspace(readIndexTailEntries({ env }), env);
  const linkedSessionIds = new Set(scoped.entries
    .filter(entry => !entry.isSubagent && String(entry.agentId || '').startsWith('herdr:') && entry.sessionId)
    .map(entry => entry.sessionId));
  return {
    ccxrayReady: status.ok,
    ccxrayCommand: resolveCcxrayCommand(env).label,
    hubRunning: status.parsed.running,
    sidebar: sidebarInstalled(env),
    providers: availableProviders(env),
    sessions: linkedSessionIds.size,
    scope: scoped.scope,
  };
}

function recommendedItemId(state) {
  const provider = state.providers.find(item => item.available);
  if (!state.ccxrayReady || (state.sessions === 0 && !provider)) return 'doctor';
  if (state.sessions === 0) return `launch-${provider.id}`;
  return 'mission-control';
}

function recommendationText(state) {
  const provider = state.providers.find(item => item.available);
  if (!state.ccxrayReady) return 'Repair the ccxray command before launching an agent.';
  if (state.sessions === 0) {
    if (!provider) return 'Install one supported CLI: claude, codex, or grok.';
    return `Launch ${provider.label} through ccxray.`;
  }
  return 'Inspect live pressure, cost, and failures.';
}

function menuItems(state) {
  return [
    { type: 'section', label: 'Start an agent' },
    ...state.providers.map(provider => ({
      id: `launch-${provider.id}`,
      key: provider.key,
      label: provider.label,
      detail: provider.available ? 'available' : 'not found',
      enabled: provider.available,
      unavailableMessage: `${provider.label} CLI was not found; install it and reopen Quick Start.`,
    })),
    { type: 'section', label: 'Inspect' },
    {
      id: 'mission-control',
      key: 'M',
      label: 'Mission Control',
      detail: state.sessions > 0 ? 'live attention' : 'needs 1 session',
      enabled: state.sessions > 0,
      unavailableMessage: 'Launch a traced session before opening Mission Control.',
    },
    {
      id: 'capability-review',
      key: 'R',
      label: 'Capability Footprint',
      detail: state.sessions >= 5 ? `experimental · ${state.sessions} sessions` : 'experimental · needs 5',
      enabled: state.sessions >= 5,
      unavailableMessage: 'Capability Footprint needs at least five traced sessions.',
    },
    { type: 'section', label: 'Setup' },
    {
      id: 'sidebar',
      key: 'S',
      label: 'Sidebar summary',
      detail: state.sidebar ? 'installed · Enter remove' : 'optional · Enter install',
      enabled: true,
    },
    { id: 'doctor', key: 'D', label: 'Doctor', detail: 'diagnostics', enabled: true },
    { id: 'close', key: 'Q', label: 'Close', detail: '', enabled: true },
  ];
}

function keyIntent(key) {
  if (key === '\x1b[A' || key === '\x1bOA' || key === 'k' || key === 'K') return { type: 'move', delta: -1 };
  if (key === '\x1b[B' || key === '\x1bOB' || key === 'j' || key === 'J') return { type: 'move', delta: 1 };
  if (key === '\r' || key === '\n') return { type: 'activate' };
  if (key === '\u0003' || key === '\x1b' || key === 'q' || key === 'Q') return { type: 'close' };
  if (/^[123smrd]$/i.test(key)) return { type: 'hotkey', key: key.toLowerCase() };
  return { type: 'ignore' };
}

function moveSelection(items, selectedId, delta) {
  const enabled = items.filter(item => item.type !== 'section' && item.enabled);
  if (enabled.length === 0) return null;
  const current = enabled.findIndex(item => item.id === selectedId);
  if (current < 0) return enabled[delta < 0 ? enabled.length - 1 : 0].id;
  return enabled[(current + delta + enabled.length) % enabled.length].id;
}

function normalizeSelection(items, selectedId, fallbackId) {
  const selected = items.find(item => item.id === selectedId && item.enabled);
  if (selected) return selected.id;
  const fallback = items.find(item => item.id === fallbackId && item.enabled);
  if (fallback) return fallback.id;
  return items.find(item => item.type !== 'section' && item.enabled)?.id || null;
}

function fitRow(left, right, cols) {
  const max = cols - 1;
  if (!right) return truncateText(left, max);
  const gap = max - displayWidth(left) - displayWidth(right);
  if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  return truncateText(`${left} · ${right}`, max);
}

// Home-relative and tail-preserving: when the pane is too narrow the project
// name is the part worth keeping, not the leading path segments.
function displayPath(cwd, max = 0, env = process.env) {
  const home = env.HOME || os.homedir();
  const value = home && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  if (!max || displayWidth(value) <= max) return value;
  const segments = value.split('/');
  let tail = segments.pop() || value;
  while (segments.length && displayWidth(`…/${segments.at(-1)}/${tail}`) <= max) {
    tail = `${segments.pop()}/${tail}`;
  }
  return truncateText(`…/${tail}`, max);
}

function menuRowLines(left, right, cols) {
  const max = cols - 1;
  const gap = max - displayWidth(left) - displayWidth(right || '');
  if (!right || gap >= 2) return [fitRow(left, right, cols)];
  return [
    truncateText(left, max),
    ...wrapText(right, max, { initialIndent: '      ', subsequentIndent: '      ' }),
  ];
}

function render(state, message = '', selectedId = recommendedItemId(state)) {
  const cols = Math.max(24, Math.min(Number(process.env.CCXRAY_ONBOARDING_COLS) || process.stdout.columns || 72, 100));
  const terminalRows = Math.max(16, Math.min(Number(process.env.CCXRAY_ONBOARDING_ROWS) || process.stdout.rows || 24, 80));
  const compactHeight = terminalRows <= 24;
  const compactWidth = cols < 40;
  const veryShort = terminalRows < 18;
  const line = value => String(value).slice(0, cols - 1);
  const interactive = process.stdout.isTTY && process.env.CCXRAY_ONBOARDING_ONCE !== '1';
  const output = [];
  output.push(fitRow('ccxray Quick Start', state.ccxrayReady ? 'READY' : 'NEEDS SETUP', cols));
  if (!compactHeight) {
    output.push(line('Get your first live session signal'));
    output.push('');
  }
  output.push(line(`ccxray       ${state.ccxrayReady ? 'READY' : 'FIX'}${state.hubRunning ? ' · hub running' : ''}`));
  output.push(line(`sidebar      ${state.sidebar ? 'READY · installed' : 'SETUP · optional'}`));
  const sessionScope = state.scope?.kind === 'workspace' ? 'traced here' : 'observed';
  output.push(line(`sessions     ${state.sessions ? 'READY' : 'START'} · ${state.sessions} ${sessionScope}`));
  // Launching starts an agent in this directory, so name it before the user
  // commits to it — the same scope launch-agent.js resolves.
  output.push(line(`directory    ${state.scope?.cwd ? displayPath(state.scope.cwd, cols - 14) : 'FIX · none detected'}`));

  for (const item of menuItems(state)) {
    if (item.type === 'section') {
      if (!compactWidth && !veryShort) {
        if (!compactHeight) output.push('');
        output.push(line(item.label));
      }
      continue;
    }
    const cursor = item.id === selectedId ? '›' : ' ';
    const compactLabels = {
      'capability-review': 'Capability (exp)',
      sidebar: 'Sidebar summary',
    };
    const label = compactWidth ? (compactLabels[item.id] || item.label) : item.label;
    const left = `  ${cursor} [${item.key}] ${label}`;
    const rows = menuRowLines(left, compactWidth ? '' : item.detail, cols);
    for (const row of rows) {
      if (interactive && item.id === selectedId) output.push(`\x1b[7m${row}\x1b[0m`);
      else if (interactive && !item.enabled) output.push(`\x1b[2m${row}\x1b[0m`);
      else output.push(row);
    }
  }
  output.push('');
  output.push(...wrapText(veryShort
    ? 'j/k · Enter · q'
    : compactWidth
      ? 'j/k move · Enter select · 1-3 launch · q close'
    : 'Up/Down or j/k move · Enter select · 1-3 launch · q close', cols - 1));
  const shortNext = !state.ccxrayReady
    ? 'Next: run Doctor'
    : state.sessions
      ? 'Next: Mission Control'
      : `Next: launch ${state.providers.find(provider => provider.available)?.label || 'an agent'}`;
  if (veryShort) output.push(truncateText(message || shortNext, cols - 1));
  else output.push(...wrapText(message || `Recommended: ${recommendationText(state)}`, cols - 1));
  writeFrame(output, { clear: interactive, interactive });
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [path.join(pluginRoot(), 'bin', script), ...args], {
    cwd: pluginRoot(),
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

// A failing helper reports its reason on the first line and any manual recovery
// steps below it. Taking the last line instead surfaced the closing bracket of a
// printed TOML snippet as the entire error ("Could not complete: ]").
function resultMessage(result, success) {
  if (result.status === 0) return success;
  const source = String(result.stderr || '').trim() || String(result.stdout || '').trim();
  const reason = source.split('\n').map(value => value.trim()).find(Boolean);
  return `Could not complete: ${reason || 'unknown error'}`;
}

function executeItem(item, state) {
  if (!item) return { message: '' };
  if (!item.enabled) return { message: item.unavailableMessage || `${item.label} is not available.` };
  if (item.id === 'close') return { close: true };

  if (item.id.startsWith('launch-')) {
    const provider = state.providers.find(value => `launch-${value.id}` === item.id);
    const result = runNode('launch-agent.js', [provider.id]);
    return { message: resultMessage(result, `${provider.label} launched in a traced pane.`) };
  }
  if (item.id === 'sidebar') {
    const script = state.sidebar ? 'remove-sidebar-summary.js' : 'install-sidebar-summary.js';
    const result = runNode(script);
    return {
      message: resultMessage(result, state.sidebar
        ? 'Sidebar summary removed; backup retained.'
        : 'Sidebar summary installed.'),
    };
  }
  if (item.id === 'mission-control') {
    const result = runHerdr([
      'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
      '--entrypoint', 'mission-control', '--placement', 'tab', '--focus',
    ], { timeoutMs: 5000 });
    return { message: resultMessage(result, 'Mission Control opened.') };
  }
  if (item.id === 'capability-review') {
    const result = runHerdr([
      'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
      '--entrypoint', 'capability-review', '--placement', 'tab', '--focus',
    ], { timeoutMs: 5000 });
    return { message: resultMessage(result, 'Capability Footprint opened.') };
  }
  if (item.id === 'doctor') {
    const result = runNode('doctor.js');
    return { message: resultMessage(result, 'Doctor passed.') };
  }
  return { message: '' };
}

function main() {
  let state = snapshot();
  const interactive = !process.argv.includes('--once')
    && process.env.CCXRAY_ONBOARDING_ONCE !== '1'
    && process.stdin.isTTY
    && process.stdout.isTTY
    && typeof process.stdin.setRawMode === 'function';
  let selectedId = recommendedItemId(state);
  let message = '';
  render(state, message, selectedId);
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
  const closeMenu = () => {
    restoreTerminal();
    if (process.env.HERDR_PANE_ID) {
      runHerdr(['plugin', 'pane', 'close', process.env.HERDR_PANE_ID], { timeoutMs: 2000 });
    }
  };
  const onResize = () => render(state, message, selectedId);
  const onSignal = code => {
    restoreTerminal();
    process.exit(code);
  };
  const onData = key => {
    const intent = keyIntent(key);
    const items = menuItems(state);
    if (intent.type === 'ignore') return;
    if (intent.type === 'close') {
      closeMenu();
      return;
    }
    if (intent.type === 'move') {
      selectedId = moveSelection(items, selectedId, intent.delta);
      message = '';
      render(state, message, selectedId);
      return;
    }

    const item = intent.type === 'activate'
      ? items.find(value => value.id === selectedId)
      : items.find(value => value.type !== 'section' && value.key.toLowerCase() === intent.key);
    const result = executeItem(item, state);
    if (result.close) {
      closeMenu();
      return;
    }
    state = snapshot();
    const refreshed = menuItems(state);
    selectedId = normalizeSelection(refreshed, item?.id, recommendedItemId(state));
    message = result.message;
    render(state, message, selectedId);
  };

  process.stdout.write('\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  process.once('exit', restoreTerminal);
  process.once('SIGINT', () => onSignal(130));
  process.once('SIGTERM', () => onSignal(143));
}

if (require.main === module) main();

module.exports = {
  displayPath,
  keyIntent,
  main,
  resultMessage,
  menuItems,
  moveSelection,
  normalizeSelection,
  recommendedItemId,
};
