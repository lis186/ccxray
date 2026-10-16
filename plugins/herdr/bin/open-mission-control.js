#!/usr/bin/env node
'use strict';

// A keybinding can only point at an action, never at a pane entrypoint, so the
// bound key comes through here. Opening via this script rather than a bare
// `herdr plugin pane open` in the manifest keeps one placement rule for every
// entry point — the manifest, Quick Start, and the key all agree.

const { herdrRuntime, panePlacement, runHerdr } = require('./lib/ccxray');

function openArgs(env = process.env) {
  const runtime = herdrRuntime(env);
  const context = runtime.context || {};
  const args = [
    'plugin', 'pane', 'open',
    '--plugin', 'ccxray.herdr',
    '--entrypoint', 'mission-control',
    '--placement', panePlacement(env),
    '--focus',
  ];
  const workspaceId = runtime.workspaceId || context.workspace_id;
  if (workspaceId) args.push('--workspace', workspaceId);
  return args;
}

function main() {
  const result = runHerdr(openArgs(), { timeoutMs: 5000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0 || result.error) {
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { openArgs };
