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

function nextStep(state) {
  const provider = state.providers.find(item => item.available);
  if (!state.ccxrayReady) return 'Run Doctor to repair the ccxray command before launching an agent.';
  if (state.sessions === 0) {
    if (!provider) return 'Install one supported CLI: claude, codex, or grok.';
    return `Press ${provider.key} to launch ${provider.label} through ccxray.`;
  }
  if (state.sessions < 5) return 'Press M to inspect live pressure, cost, and failures.';
  return 'Press R to review capability usage before changing configuration.';
}

function render(state, message = '') {
  const cols = Math.max(36, Math.min(Number(process.env.CCXRAY_ONBOARDING_COLS) || process.stdout.columns || 72, 100));
  const line = value => String(value).slice(0, cols - 1);
  if (process.stdout.isTTY && process.env.CCXRAY_ONBOARDING_ONCE !== '1') process.stdout.write('\x1b[2J\x1b[H');
  console.log(line('ccxray Quick Start'));
  console.log(line('Get your first live session signal'));
  console.log('');
  console.log(line(`${state.ccxrayReady ? 'READY' : 'FIX'}  ccxray ${state.ccxrayReady ? 'available' : 'not found'}${state.hubRunning ? ' · hub running' : ''}`));
  console.log(line(`${state.sidebar ? 'READY' : 'SETUP'}  sidebar ${state.sidebar ? 'installed' : 'optional, not installed'}`));
  console.log(line(`${state.sessions ? 'READY' : 'START'}  ${state.sessions} traced session${state.sessions === 1 ? '' : 's'}`));
  console.log('');
  console.log(line('Launch a traced session'));
  for (const provider of state.providers) {
    console.log(line(`  [${provider.key}] ${provider.label.padEnd(7)} ${provider.available ? 'available' : 'not found'}`));
  }
  console.log('');
  console.log(line(`  [S] ${state.sidebar ? 'Sidebar summary installed' : 'Install sidebar summary (optional)'}`));
  if (state.sessions > 0) console.log(line('  [M] Open Mission Control'));
  if (state.sessions >= 5) console.log(line('  [R] Open Capability Review'));
  console.log(line('  [D] Run Doctor'));
  console.log(line('  [Q] Close Quick Start'));
  console.log('');
  console.log(line(`Next: ${nextStep(state)}`));
  if (message) console.log(line(message));
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

function main() {
  let state = snapshot();
  render(state);
  if (process.argv.includes('--once') || process.env.CCXRAY_ONBOARDING_ONCE === '1' || !process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', key => {
    const normalized = key.toLowerCase();
    if (normalized === '\u0003' || normalized === 'q') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (process.env.HERDR_PANE_ID) runHerdr(['plugin', 'pane', 'close', process.env.HERDR_PANE_ID], { timeoutMs: 2000 });
      return;
    }

    const provider = state.providers.find(item => item.key === normalized);
    let message = '';
    if (provider) {
      if (!provider.available) {
        message = `${provider.label} CLI was not found; install it and reopen Quick Start.`;
      } else {
        const result = runNode('launch-agent.js', [provider.id]);
        message = resultMessage(result, `${provider.label} launched in a traced pane.`);
      }
    } else if (normalized === 's') {
      if (state.sidebar) {
        message = 'Sidebar summary is already installed.';
      } else {
        const result = runNode('install-sidebar-summary.js');
        message = resultMessage(result, 'Sidebar summary installed.');
      }
    } else if (normalized === 'm') {
      if (state.sessions === 0) {
        message = 'Launch a traced session before opening Mission Control.';
      } else {
        const result = runHerdr([
          'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
          '--entrypoint', 'mission-control', '--placement', 'split', '--focus',
        ], { timeoutMs: 5000 });
        message = resultMessage(result, 'Mission Control opened.');
      }
    } else if (normalized === 'r') {
      if (state.sessions < 5) {
        message = 'Capability Review needs at least five traced sessions.';
      } else {
        const result = runHerdr([
          'plugin', 'pane', 'open', '--plugin', 'ccxray.herdr',
          '--entrypoint', 'capability-review', '--placement', 'tab', '--focus',
        ], { timeoutMs: 5000 });
        message = resultMessage(result, 'Capability Review opened.');
      }
    } else if (normalized === 'd') {
      const result = runNode('doctor.js');
      message = resultMessage(result, 'Doctor passed.');
    } else {
      return;
    }
    state = snapshot();
    render(state, message);
  });
}

main();
