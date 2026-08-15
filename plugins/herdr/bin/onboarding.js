#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pluginRoot,
  readIndexTailEntries,
  resolveCcxrayCommand,
  runHerdr,
  statusReport,
} = require('./lib/ccxray');

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
  const file = env.HERDR_CONFIG_PATH || path.join(env.HOME || os.homedir(), '.config', 'herdr', 'config.toml');
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
  const entries = readIndexTailEntries({ env });
  const linkedSessionIds = new Set(entries
    .filter(entry => !entry.isSubagent && String(entry.agentId || '').startsWith('herdr:') && entry.sessionId)
    .map(entry => entry.sessionId));
  return {
    ccxrayReady,
    ccxrayCommand: resolveCcxrayCommand(env).label,
    hubRunning: status.parsed.running,
    sidebar: sidebarInstalled(env),
    providers: availableProviders(env),
    sessions: linkedSessionIds.size,
  };
}

function recommendedItemId(state) {
  const provider = state.providers.find(item => item.available);
  if (!state.ccxrayReady || (state.sessions === 0 && !provider)) return 'doctor';
  if (state.sessions === 0) return `launch-${provider.id}`;
  if (state.sessions < 5) return 'mission-control';
  return 'capability-review';
}

function recommendationText(state) {
  const provider = state.providers.find(item => item.available);
  if (!state.ccxrayReady) return 'Repair the ccxray command before launching an agent.';
  if (state.sessions === 0) {
    if (!provider) return 'Install one supported CLI: claude, codex, or grok.';
    return `Launch ${provider.label} through ccxray.`;
  }
  if (state.sessions < 5) return 'Inspect live pressure, cost, and failures.';
  return 'Review capability usage before changing configuration.';
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
      label: 'Capability Review',
      detail: state.sessions >= 5 ? `${state.sessions} sessions` : 'needs 5 sessions',
      enabled: state.sessions >= 5,
      unavailableMessage: 'Capability Review needs at least five traced sessions.',
    },
    { type: 'section', label: 'Setup' },
    {
      id: 'sidebar',
      key: 'S',
      label: 'Sidebar summary',
      detail: state.sidebar ? 'installed' : 'optional',
      enabled: !state.sidebar,
      unavailableMessage: 'Sidebar summary is already installed.',
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
  if (!right) return left.slice(0, max);
  const gap = max - left.length - right.length;
  if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  return `${left} · ${right}`.slice(0, max);
}

function render(state, message = '', selectedId = recommendedItemId(state)) {
  const cols = Math.max(36, Math.min(Number(process.env.CCXRAY_ONBOARDING_COLS) || process.stdout.columns || 72, 100));
  const line = value => String(value).slice(0, cols - 1);
  const interactive = process.stdout.isTTY && process.env.CCXRAY_ONBOARDING_ONCE !== '1';
  if (interactive) process.stdout.write('\x1b[2J\x1b[H');
  console.log(fitRow('ccxray Quick Start', state.ccxrayReady ? 'READY' : 'NEEDS SETUP', cols));
  console.log(line('Get your first live session signal'));
  console.log('');
  console.log(line(`ccxray       ${state.ccxrayReady ? 'READY' : 'FIX'}${state.hubRunning ? ' · hub running' : ''}`));
  console.log(line(`sidebar      ${state.sidebar ? 'READY · installed' : 'SETUP · optional'}`));
  console.log(line(`sessions     ${state.sessions ? 'READY' : 'START'} · ${state.sessions} observed`));

  for (const item of menuItems(state)) {
    if (item.type === 'section') {
      console.log('');
      console.log(line(item.label));
      continue;
    }
    const cursor = item.id === selectedId ? '›' : ' ';
    const left = `  ${cursor} [${item.key}] ${item.label}`;
    const row = fitRow(left, item.detail, cols);
    if (interactive && item.id === selectedId) console.log(`\x1b[7m${row}\x1b[0m`);
    else if (interactive && !item.enabled) console.log(`\x1b[2m${row}\x1b[0m`);
    else console.log(row);
  }
  console.log('');
  console.log(line('↑↓ or j/k move · Enter select · 1-3 launch · q close'));
  console.log(line(message || `Recommended: ${recommendationText(state)}`));
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [path.join(pluginRoot(), 'bin', script), ...args], {
    cwd: pluginRoot(),
    env: process.env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

function resultMessage(result, success) {
  const text = String(result.stdout || result.stderr || '').trim().split('\n').at(-1);
  return result.status === 0 ? success : `Could not complete: ${text || 'unknown error'}`;
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
    const result = runNode('install-sidebar-summary.js');
    return { message: resultMessage(result, 'Sidebar summary installed.') };
  }
  if (item.id === 'mission-control') {
    const result = runHerdr([
      'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
      '--entrypoint', 'mission-control', '--placement', 'split', '--focus',
    ], { timeoutMs: 5000 });
    return { message: resultMessage(result, 'Mission Control opened.') };
  }
  if (item.id === 'capability-review') {
    const result = runHerdr([
      'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
      '--entrypoint', 'capability-review', '--placement', 'tab', '--focus',
    ], { timeoutMs: 5000 });
    return { message: resultMessage(result, 'Capability Review opened.') };
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
    process.stdout.write('\x1b[?25h');
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
  keyIntent,
  main,
  menuItems,
  moveSelection,
  normalizeSelection,
  recommendedItemId,
};
