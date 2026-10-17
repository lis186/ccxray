'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCcxrayHome } = require('./paths');

const SETTINGS_DIR = resolveCcxrayHome();
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

const DEFAULTS = {
  // #692 (3.0.0): the Context HUD is off unless settings.json says true — it can
  // truncate subagent returns. An explicit `statusLine: true` is kept as is.
  statusLine: false,
  starredProjects: [],
  starredSessions: [],
  starredTurns: [],
  starredSteps: [],
  hiddenProjects: [],
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

function cloneSettings(s) {
  return {
    ...s,
    starredProjects: [...(s.starredProjects || [])],
    starredSessions: [...(s.starredSessions || [])],
    starredTurns: [...(s.starredTurns || [])],
    starredSteps: [...(s.starredSteps || [])],
    hiddenProjects: [...(s.hiddenProjects || [])],
  };
}

function serializeStars(s) {
  return {
    projects: s.starredProjects || [],
    sessions: s.starredSessions || [],
    turns: s.starredTurns || [],
    steps: s.starredSteps || [],
  };
}

function readSettings() {
  if (_cache) return cloneSettings(_cache);
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _cache = {
        ...DEFAULTS,
        ...parsed,
        starredProjects: coerceStringArray(parsed.starredProjects),
        starredSessions: coerceStringArray(parsed.starredSessions),
        starredTurns: coerceStringArray(parsed.starredTurns),
        starredSteps: coerceStringArray(parsed.starredSteps),
        hiddenProjects: coerceStringArray(parsed.hiddenProjects),
      };
    } else {
      console.error(`[ccxray] settings.json at ${SETTINGS_PATH} did not parse to an object — using defaults.`);
      _cache = { ...DEFAULTS };
    }
  } catch {
    _cache = { ...DEFAULTS };
  }
  return cloneSettings(_cache);
}

// The one-line HUD state shown at proxy/launcher startup and by `ccxray hud
// status` (#692) — not by every subcommand, so readSettings() itself is silent.
function hudStatusText(enabled) {
  return `Context HUD: ${enabled ? 'enabled' : 'disabled'} (settings.json)`;
}

function writeSettings(data) {
  _cache = { ...data };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), (err) => {
    if (err) console.error('[ccxray] writeSettings failed:', err.message);
  });
}

// `ccxray hud on|off` (#692): a CLI process that exits right away, so the write
// is synchronous and atomic. Only `statusLine` changes; every other key on disk
// is kept. A settings.json that does not parse to an object is never rewritten.
function setStatusLineSync(enabled) {
  let current = {};
  let raw = null;
  try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${SETTINGS_PATH} is not a JSON object; fix or delete it, then retry`);
    }
    current = parsed;
  }
  const next = { ...current, statusLine: !!enabled };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_PATH}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, SETTINGS_PATH);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  _cache = null;
  return SETTINGS_PATH;
}

// Test helper — reset cache so unit tests get a clean slate
function _resetSettingsCache() { _cache = null; }

module.exports = { readSettings, writeSettings, serializeStars, hudStatusText, setStatusLineSync, SETTINGS_PATH, _resetSettingsCache };
