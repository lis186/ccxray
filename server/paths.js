'use strict';

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

module.exports = { resolveCcxrayHome, resolveLogsDir };
