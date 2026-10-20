'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Single source of truth for ccxray's on-disk locations. config.js,
// storage/index.js, hub.js, settings.js, ratelimit-log.js, and auth.js all
// resolve their ccxray home/logs paths from here, so the startup banner,
// legacy-migration target, and every other consumer stay in sync and can no
// longer drift from where logs actually get written.
//
// Precedence (mirrors the storage adapter's historical resolution):
//   logs dir : LOGS_DIR  >  <home>/logs
//   home     : CCXRAY_HOME  >  ~/.ccxray

function resolveCcxrayHome(env = process.env) {
  return env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
}

function resolveLogsDir(env = process.env) {
  return env.LOGS_DIR || path.join(resolveCcxrayHome(env), 'logs');
}

// #690: the home holds secrets (local-secret, hub.json, logs), so every site
// that creates it or a directory inside it passes HOME_DIR_MODE.
const HOME_DIR_MODE = 0o700;

// Tighten an existing group/world-accessible home to 0700. Only the owner's
// own directory is touched: a home owned by someone else (a shared or
// root-provisioned CCXRAY_HOME) is left alone, as is one that is already tight
// or missing. POSIX mode bits are meaningless on Windows, so it is a no-op
// there. Returns 'tightened' | 'tight' | 'not-owned' | 'missing' | 'skipped'.
function tightenCcxrayHome(home = resolveCcxrayHome(), { log = null, platform = process.platform } = {}) {
  if (platform === 'win32' || typeof process.getuid !== 'function') return 'skipped';
  let st;
  try { st = fs.statSync(home); } catch { return 'missing'; }
  if (!st.isDirectory()) return 'skipped';
  if ((st.mode & 0o077) === 0) return 'tight';
  if (st.uid !== process.getuid()) return 'not-owned';
  // Keep setuid/setgid/sticky: a setgid home keeps its group inheritance.
  const special = st.mode & 0o7000;
  try { fs.chmodSync(home, HOME_DIR_MODE | special); } catch { return 'skipped'; }
  if (log) {
    const fmt = m => `0${m.toString(8)}`;
    log(`[ccxray] tightened ${home} permissions to ${fmt(HOME_DIR_MODE | special)} (was ${fmt(st.mode & 0o7777)})`);
  }
  return 'tightened';
}

// Create the home owner-only, then tighten it if it already existed loose.
// Missing parents of a custom CCXRAY_HOME get the default mode: they are not
// ccxray's to restrict.
function ensureCcxrayHome(env = process.env, opts = {}) {
  const home = resolveCcxrayHome(env);
  fs.mkdirSync(path.dirname(home), { recursive: true });
  try { fs.mkdirSync(home, { mode: HOME_DIR_MODE }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  tightenCcxrayHome(home, opts);
  return home;
}

// A path without trailing slashes, `/` kept; null and undefined pass through.
// Shared by every cwd-to-root comparison (agentflow report, usage query).
function stripSlash(p) { return p && p.length > 1 ? p.replace(/\/+$/u, '') : p; }

module.exports = { resolveCcxrayHome, resolveLogsDir, HOME_DIR_MODE, tightenCcxrayHome, ensureCcxrayHome, stripSlash };
