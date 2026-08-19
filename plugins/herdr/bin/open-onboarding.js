#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  herdrRuntime,
  pluginStateDir,
  runHerdr,
} = require('./lib/ccxray');

const STATE_VERSION = 1;

function statePath(env = process.env) {
  return path.join(pluginStateDir(env), 'onboarding-v1.json');
}

function alreadyOpened(env = process.env) {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(env), 'utf8'));
    return saved?.version === STATE_VERSION && Boolean(saved.openedAt);
  } catch {
    return false;
  }
}

function writeOpened(env = process.env) {
  const file = statePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({
    version: STATE_VERSION,
    openedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function openArgs(env = process.env) {
  const runtime = herdrRuntime(env);
  const context = runtime.context || {};
  const args = [
    'plugin', 'pane', 'open',
    '--plugin', 'ccxray.herdr',
    '--entrypoint', 'onboarding',
    '--focus',
  ];
  const workspaceId = runtime.workspaceId || context.workspace_id;
  const cwd = context.focused_pane_cwd || context.workspace_cwd;
  if (workspaceId) args.push('--workspace', workspaceId);
  if (cwd) args.push('--cwd', cwd);
  return args;
}

function acquireLock(lock, firstRun) {
  try {
    return fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const ageMs = Date.now() - fs.statSync(lock).mtimeMs;
      if (ageMs > 30000) {
        fs.unlinkSync(lock);
        return fs.openSync(lock, 'wx', 0o600);
      }
    } catch (retryError) {
      if (retryError.code !== 'ENOENT') throw retryError;
      return fs.openSync(lock, 'wx', 0o600);
    }
    if (firstRun) return null;
    throw new Error('ccxray Quick Start is already opening.');
  }
}

function main() {
  const firstRun = process.argv.includes('--first-run');
  if (firstRun && process.env.CCXRAY_HERDR_SKIP_ONBOARDING === '1') {
    console.log('ccxray Quick Start skipped by configuration.');
    return;
  }
  if (firstRun && alreadyOpened()) return;

  const file = statePath();
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFd = acquireLock(lock, firstRun);
  if (lockFd == null) return;

  try {
    if (firstRun && alreadyOpened()) return;
    const opened = runHerdr(openArgs(), { timeoutMs: 5000 });
    if (opened.status !== 0 || opened.error) {
      if (firstRun && opened.parsed?.error?.code === 'no_active_workspace') {
        console.log('ccxray Quick Start deferred until a workspace is created.');
        return;
      }
      process.stderr.write(opened.stderr || opened.stdout || opened.error?.message || 'Could not open ccxray Quick Start.\n');
      process.exitCode = 1;
      return;
    }
    writeOpened();
    console.log('Opened ccxray Quick Start.');
  } finally {
    if (lockFd != null) fs.closeSync(lockFd);
    try { fs.unlinkSync(lock); } catch {}
  }
}

main();
