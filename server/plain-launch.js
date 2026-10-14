'use strict';

// Launching the agent WITHOUT the proxy, shared by the normal launcher and the
// bootstrap fail-open handler in server/index.js.
//
// INVARIANT: this module and everything it loads must stay usable when the
// proxy stack cannot load (STORAGE_BACKEND=s3, a missing `ws`).
// test/plain-launch.test.js pins its load closure to an exact file list; a
// require here that reaches config/store/hub/ws silently disables bootstrap
// fail-open again.

const fs = require('fs');
const path = require('path');
const { resolveAgentLaunch } = require('./win-launch');
const { signalExitCode } = require('./client-shutdown');

// Must equal Object.keys(AGENT_PROVIDERS) (asserted in test/plain-launch.test.js);
// providers.js is not required here because it may be the module that failed.
const BOOTSTRAP_AGENTS = ['claude', 'codex', 'grok'];

// Global flags are removed from ANYWHERE in argv (first occurrence each), so
// `ccxray claude --port 9000` and `ccxray --port 9000 claude` mean the same.
// Pure: validation and error reporting stay with the caller.
function parseGlobalFlags(argv) {
  const rest = argv.slice();
  let portValue;
  let hasPort = false;
  const portIdx = rest.indexOf('--port');
  if (portIdx !== -1) {
    hasPort = true;
    portValue = rest[portIdx + 1];
    rest.splice(portIdx, 2);
  }
  const take = flag => {
    const at = rest.indexOf(flag);
    if (at === -1) return false;
    rest.splice(at, 1);
    return true;
  };
  const hubMode = take('--hub-mode');
  const allowUpstreamLoop = take('--allow-upstream-loop');
  const noBrowser = take('--no-browser');
  return { argv: rest, hasPort, portValue, hubMode, allowUpstreamLoop, noBrowser };
}

function parsePort(value) {
  const parsed = parseInt(value, 10);
  if (!value || isNaN(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

// resolveHome runs inside the try: a launch must never be lost because the
// home directory could not be resolved.
function appendFailOpen(resolveHome, record) {
  try {
    const home = resolveHome();
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(home, 'fail-open.log'), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {}
}

// launch: { bin, args, env, label, installHint }. onExit fires exactly once with
// the agent's exit code (or 1 when it could not start).
function spawnPlain(launch, { provider = null, onExit, onChild, signalsOwnedByCaller = false } = {}) {
  const { spawn } = require('child_process');
  let finished = false;
  const finish = code => {
    if (finished) return;
    finished = true;
    onExit(code);
  };
  const reportLaunchFailure = err => {
    if (err.code === 'ENOENT') {
      console.error(`\x1b[31mError: "${launch.bin}" command not found. Install ${launch.label} first:\x1b[0m`);
      console.error(`\x1b[31m${launch.installHint}\x1b[0m`);
    } else {
      console.error(`\x1b[31mFailed to start ${launch.bin}: ${err.message}\x1b[0m`);
    }
  };
  let child;
  try {
    const plan = resolveAgentLaunch(launch.bin, launch.args, launch.env, provider);
    if (plan.kind === 'error') {
      reportLaunchFailure(plan.code === 'ENOENT' ? { code: 'ENOENT' } : { message: plan.message });
      finish(1);
      return;
    }
    child = spawn(plan.file, plan.args, {
      stdio: 'inherit',
      env: launch.env,
    });
  } catch (err) {
    reportLaunchFailure(err);
    finish(1);
    return;
  }
  if (onChild) onChild(child);
  child.on('error', (err) => {
    reportLaunchFailure(err);
    finish(1);
  });
  child.on('exit', (code, signal) => {
    finish(code ?? signalExitCode(signal));
  });
  // INVARIANT (hub client mode): when the caller armed its own handlers BEFORE
  // registering with the hub, installing these would double-handle the signal.
  // The caller's handlers read the child through onChild, so they cover this
  // window too — including SIGINT, which they no-op while the agent owns the
  // terminal exactly as this does. See server/client-shutdown.js.
  if (!signalsOwnedByCaller) {
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGHUP', () => child.kill('SIGHUP'));
  }
}

module.exports = { BOOTSTRAP_AGENTS, parseGlobalFlags, parsePort, appendFailOpen, spawnPlain };
