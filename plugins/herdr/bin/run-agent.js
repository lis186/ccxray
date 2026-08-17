#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { resolveCcxrayCommand } = require('./lib/ccxray');

const SUPPORTED = new Set(['claude', 'codex', 'grok']);

function parseArgs(argv) {
  const args = {
    agent: argv[0],
    paneId: argv[1],
    workspaceId: argv[2],
    tabId: argv[3],
    sourcePaneId: argv[4],
    dryRun: argv.includes('--dry-run') || process.env.CCXRAY_HERDR_RUNNER_DRY_RUN === '1',
  };
  return args;
}

function uniquePath(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(path.delimiter);
}

function launchPath(env = process.env) {
  const home = env.HOME || os.homedir();
  const existing = String(env.PATH || '').split(path.delimiter);
  return uniquePath([
    path.join(home, '.local', 'bin'),
    path.join(home, '.grok', 'bin'),
    '/Applications/ChatGPT.app/Contents/Resources',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...existing,
  ]);
}

function launchEnv(args) {
  const env = {
    ...process.env,
    CCXRAY_AGENT_ID: `herdr:${args.paneId || 'unknown-pane'}`,
    CCXRAY_AGENT_TYPE: args.agent,
    CCXRAY_HERDR_WORKSPACE_ID: args.workspaceId || '',
    CCXRAY_HERDR_PANE_ID: args.paneId || '',
    CCXRAY_HERDR_TAB_ID: args.tabId || '',
    CCXRAY_HERDR_SOURCE_PANE_ID: args.sourcePaneId || '',
  };
  env.PATH = launchPath(env);
  return env;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPPORTED.has(args.agent)) {
    console.error(`Unsupported agent "${args.agent || ''}". Expected claude, codex, or grok.`);
    process.exit(2);
  }

  const env = launchEnv(args);
  const command = resolveCcxrayCommand(env);
  const argv = [...command.argsPrefix, '--no-browser', args.agent];

  if (args.dryRun) {
    console.log(JSON.stringify({
      bin: command.bin,
      args: argv,
      env: {
        CCXRAY_AGENT_ID: env.CCXRAY_AGENT_ID,
        CCXRAY_AGENT_TYPE: env.CCXRAY_AGENT_TYPE,
        CCXRAY_HERDR_WORKSPACE_ID: env.CCXRAY_HERDR_WORKSPACE_ID,
        CCXRAY_HERDR_PANE_ID: env.CCXRAY_HERDR_PANE_ID,
        CCXRAY_HERDR_TAB_ID: env.CCXRAY_HERDR_TAB_ID,
        CCXRAY_HERDR_SOURCE_PANE_ID: env.CCXRAY_HERDR_SOURCE_PANE_ID,
        PATH: env.PATH,
      },
    }, null, 2));
    process.exit(0);
  }

  console.log(`ccxray launching ${args.agent} (${env.CCXRAY_AGENT_ID})`);
  const child = spawn(command.bin, argv, {
    stdio: 'inherit',
    env,
  });
  child.on('error', err => {
    console.error(`Failed to launch ccxray ${args.agent}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGHUP', () => child.kill('SIGHUP'));
}

main();
