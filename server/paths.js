'use strict';

const path = require('path');
const os = require('os');

// Single source of truth for ccxray's on-disk locations. config.js and
// storage/index.js both resolve the logs dir from here, so the startup banner
// and legacy-migration target can no longer drift from where logs actually
// get written. hub.js, settings.js, ratelimit-log.js, and auth.js still
// duplicate the home-dir resolution inline and are candidates for future
// consolidation here.
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
