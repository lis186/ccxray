'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_DIR = process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

const DEFAULTS = { statusLine: true };

// In-memory cache — populated on first readSettings() call (server startup).
// writeSettings() updates the cache before the async disk write so subsequent
// reads never go back to disk.
let _cache = null;

function readSettings() {
  if (_cache) return { ..._cache };
  try {
    _cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return { ..._cache };
}

function writeSettings(data) {
  _cache = { ...data };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), (err) => {
    if (err) console.error('[ccxray] writeSettings failed:', err.message);
  });
}

// Test helper — reset cache so unit tests get a clean slate
function _resetSettingsCache() { _cache = null; }

module.exports = { readSettings, writeSettings, _resetSettingsCache };
