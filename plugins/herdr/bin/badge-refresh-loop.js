#!/usr/bin/env node
'use strict';

// A small lifecycle wrapper around refresh-badges. Herdr only emits status
// transitions, while a transcript can continue to advance without another
// transition. The pure tick below keeps the policy testable; the runner only
// supplies time, agent state, and the existing badge command.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  herdrAgentReport,
  pluginStateDir,
} = require('./lib/ccxray');

const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function numberEnv(env, name, fallback, min = 1) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function isWorking(status) {
  return ['working', 'running', 'active'].includes(String(status || '').toLowerCase());
}

function loopTick(state = {}, input = {}) {
  const config = input.config || {};
  const now = Number(input.now) || Date.now();
  const startedAt = Number(state.startedAt) || now;
  const intervalMs = Number(config.intervalMs) > 0 ? Number(config.intervalMs) : DEFAULT_INTERVAL_MS;
  const maxAgeMs = Number(config.maxAgeMs) > 0 ? Number(config.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const pane = (input.agents || []).find(agent => agent.pane_id === config.paneId);
  const nextState = {
    ...state,
    startedAt,
    lastIndexMtime: input.indexMtime ?? state.lastIndexMtime ?? null,
  };

  if (now - startedAt >= maxAgeMs) return { refresh: false, exit: 'max-age', nextState };
  if (!pane) return { refresh: false, exit: 'pane-gone', nextState };
  const due = state.lastRefreshAt == null || now - Number(state.lastRefreshAt) >= intervalMs;
  const indexChanged = input.indexMtime != null && input.indexMtime !== state.lastIndexMtime;
  const refresh = due || indexChanged;
  if (refresh) nextState.lastRefreshAt = now;
  // Herdr may not emit a separate idle event after the last working tick. Give
  // the loop one final repaint when the index advanced, then let the bounded
  // worker die; otherwise the native statusbar/dashboard can be newer than the
  // pane badge exactly at the working -> idle transition.
  if (!isWorking(pane.agent_status)) return { refresh: indexChanged, exit: 'idle', nextState };
  return { refresh, exit: null, nextState };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function pidPath(paneId, env = process.env) {
  return path.join(pluginStateDir(env), `loop-${encodeURIComponent(paneId)}.pid`);
}

function claimPid(paneId, env = process.env) {
  const file = pidPath(paneId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return { file, owned: true };
    } catch (error) {
      if (error.code !== 'EEXIST') return { file, owned: false, reason: 'pidfile-error' };
      let pid = null;
      try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch {}
      if (pidAlive(pid)) return { file, owned: false, reason: 'already-running' };
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return { file, owned: false, reason: 'already-running' };
}

function releasePid(lock) {
  if (!lock?.owned) return;
  try { fs.unlinkSync(lock.file); } catch {}
}

function indexMtime(env = process.env) {
  try {
    const home = env.CCXRAY_HOME || require('os').homedir() + '/.ccxray';
    return fs.statSync(path.join(home, 'logs', 'index.ndjson')).mtimeMs;
  } catch {
    return null;
  }
}

function childEnv(env, intervalMs, finalRefresh = false) {
  const out = { ...env };
  // A loop refresh is an internal repaint. It must not re-enter the event path
  // or show a notification for every timer tick.
  delete out.HERDR_PLUGIN_EVENT;
  delete out.HERDR_PLUGIN_EVENT_JSON;
  out.CCXRAY_BADGE_LOOP_CHILD = '1';
  out.CCXRAY_BADGE_TTL_MS = finalRefresh
    ? (out.CCXRAY_BADGE_FINAL_TTL_MS || '600000')
    : (out.CCXRAY_BADGE_LOOP_TTL_MS || String(intervalMs * 3));
  return out;
}

function refreshOnce(env, intervalMs, finalRefresh = false) {
  const script = path.join(__dirname, 'refresh-badges.js');
  return spawnSync(process.execPath, [script], {
    env: childEnv(env, intervalMs, finalRefresh),
    cwd: process.cwd(),
    stdio: 'ignore',
    timeout: numberEnv(env, 'CCXRAY_BADGE_LOOP_REFRESH_TIMEOUT_MS', 10000),
  });
}

function main() {
  const env = process.env;
  const paneId = env.HERDR_PANE_ID;
  if (!paneId || env.CCXRAY_BADGE_LOOP_DISABLE === '1') return 0;
  const intervalMs = numberEnv(env, 'CCXRAY_BADGE_LOOP_INTERVAL_MS', DEFAULT_INTERVAL_MS, 10);
  const maxAgeMs = numberEnv(env, 'CCXRAY_BADGE_LOOP_MAX_MS', DEFAULT_MAX_AGE_MS, intervalMs);
  const lock = claimPid(paneId, env);
  if (!lock.owned) return 0;

  let state = { startedAt: Date.now(), lastRefreshAt: Date.now() };
  let timer = null;
  const finish = () => {
    if (timer) clearTimeout(timer);
    releasePid(lock);
  };
  const tick = () => {
    const report = herdrAgentReport({ env, timeoutMs: 3000 });
    const result = loopTick(state, {
      agents: report.agents,
      indexMtime: indexMtime(env),
      now: Date.now(),
      config: { paneId, intervalMs, maxAgeMs },
    });
    state = result.nextState;
    if (result.refresh) refreshOnce(env, intervalMs, result.exit === 'idle');
    if (result.exit) return finish();
    timer = setTimeout(tick, intervalMs);
  };
  tick();
  return null;
}

if (require.main === module) {
  const result = main();
  if (result !== null) process.exit(result);
}

module.exports = { loopTick, claimPid, releasePid, pidPath, isWorking };
