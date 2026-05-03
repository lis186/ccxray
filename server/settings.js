'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_DIR = process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

const DEFAULTS = {
  statusLine: true,
  starredProjects: [],
  starredSessions: [],
  starredTurns: [],
};

// Coerce a settings field to a string array, dropping non-strings. Returns a
// fresh array so callers can mutate without poisoning the defaults.
function coerceStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(v => typeof v === 'string');
}

// In-memory cache — populated on first readSettings() call (server startup).
// writeSettings() updates the cache before the async disk write so subsequent
// reads never go back to disk.
let _cache = null;

function readSettings() {
  if (_cache) return { ..._cache, starredProjects: [..._cache.starredProjects], starredSessions: [..._cache.starredSessions], starredTurns: [..._cache.starredTurns] };
  let firstLoad = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _cache = {
        ...DEFAULTS,
        ...parsed,
        starredProjects: coerceStringArray(parsed.starredProjects),
        starredSessions: coerceStringArray(parsed.starredSessions),
        starredTurns: coerceStringArray(parsed.starredTurns),
      };
    } else {
      console.error(`[ccxray] settings.json at ${SETTINGS_PATH} did not parse to an object — using defaults.`);
      _cache = { ...DEFAULTS, starredProjects: [], starredSessions: [], starredTurns: [] };
    }
    firstLoad = true;
  } catch {
    _cache = { ...DEFAULTS, starredProjects: [], starredSessions: [], starredTurns: [] };
    firstLoad = true;
  }
  if (firstLoad) {
    console.log(`\x1b[90m   Context HUD: ${_cache.statusLine ? 'enabled' : 'disabled'} (settings.json)\x1b[0m`);
  }
  return { ..._cache, starredProjects: [..._cache.starredProjects], starredSessions: [..._cache.starredSessions], starredTurns: [..._cache.starredTurns] };
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
