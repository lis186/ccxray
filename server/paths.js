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

function isDefaultCcxrayHome(home, homedir = os.homedir()) {
  return path.resolve(home) === path.resolve(homedir, '.ccxray');
}

// The user's $HOME or any directory above it. Never chmod'ed, whatever
// CCXRAY_HOME says: locking $HOME to 0700 breaks every other user and service
// that reads through it.
function isHomedirOrAncestor(home, homedir = os.homedir()) {
  const rel = path.relative(path.resolve(home), path.resolve(homedir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Tighten an existing group/world-accessible home to 0700. Only the default
// ~/.ccxray is chmod'ed. A custom CCXRAY_HOME may be a shared project dir, a
// mount, or the user's own $HOME, and files inside it (even ccxray's own
// local-secret or hub.sock, which ccxray writes into whatever home it is
// given) prove only that ccxray used it, not that it owns it exclusively; so a
// loose custom home gets a one-line warning on every invocation and keeps its
// mode. $HOME and its ancestors are refused even if passed as the home. Only
// the owner's own directory is touched: a home owned by someone else is left
// alone, as is one that is already tight or missing. POSIX mode bits are
// meaningless on Windows, so it is a no-op there. Returns 'tightened' |
// 'warned' | 'tight' | 'not-owned' | 'missing' | 'skipped'. `homedir` is
// injectable for tests (default: os.homedir()).
function tightenCcxrayHome(home = resolveCcxrayHome(), { log = null, platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === 'win32' || typeof process.getuid !== 'function') return 'skipped';
  let st;
  try { st = fs.statSync(home); } catch { return 'missing'; }
  if (!st.isDirectory()) return 'skipped';
  if ((st.mode & 0o077) === 0) return 'tight';
  if (st.uid !== process.getuid()) return 'not-owned';
  const fmt = m => `0${m.toString(8)}`;
  if (isHomedirOrAncestor(home, homedir) || !isDefaultCcxrayHome(home, homedir)) {
    if (log) log(`[ccxray] warning: CCXRAY_HOME ${home} is group/world-accessible (${fmt(st.mode & 0o7777)}); ccxray stores secrets and logs there — run chmod 700 on it if it is not shared`);
    return 'warned';
  }
  // Keep setuid/setgid/sticky: a setgid home keeps its group inheritance.
  const special = st.mode & 0o7000;
  try { fs.chmodSync(home, HOME_DIR_MODE | special); } catch { return 'skipped'; }
  if (log) log(`[ccxray] tightened ${home} permissions to ${fmt(HOME_DIR_MODE | special)} (was ${fmt(st.mode & 0o7777)})`);
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
