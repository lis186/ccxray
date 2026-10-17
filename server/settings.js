'use strict';

const crypto = require('crypto');
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
// writeSettings() refreshes it from the merged file it writes, so subsequent
// reads never go back to disk.
let _cache = null;

function normalizeSettings(parsed) {
  return {
    ...DEFAULTS,
    ...parsed,
    starredProjects: coerceStringArray(parsed.starredProjects),
    starredSessions: coerceStringArray(parsed.starredSessions),
    starredTurns: coerceStringArray(parsed.starredTurns),
    starredSteps: coerceStringArray(parsed.starredSteps),
    hiddenProjects: coerceStringArray(parsed.hiddenProjects),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The on-disk file as { state: 'absent' | 'object' | 'invalid', value }. Read
// errors other than ENOENT are thrown.
function readSettingsFile() {
  let raw;
  try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', value: null };
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  return isPlainObject(parsed) ? { state: 'object', value: parsed } : { state: 'invalid', value: null };
}

// Atomic replace that keeps a symlinked settings.json (dotfile managers): the
// tmp file is created next to the real target, owner-only, under a random name
// so a stale tmp from a crashed run never blocks the next write.
function writeSettingsAtomic(next) {
  let target = SETTINGS_PATH;
  try { target = fs.realpathSync(SETTINGS_PATH); } catch {}
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

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
    if (isPlainObject(parsed)) {
      _cache = normalizeSettings(parsed);
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

// `data` is the caller's full settings object (readSettings() plus its edit).
// Only the keys that differ from the cached copy are patched into the file as
// it is on disk now, so a running server never reverts a change another
// process made — e.g. `ccxray hud on` followed by a dashboard star (#696).
// A missing or non-object file is written from `data` as a whole.
function writeSettings(data) {
  const previous = _cache;
  let next = { ...data };
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    const disk = readSettingsFile();
    if (disk.state === 'object') {
      next = { ...disk.value };
      for (const key of Object.keys(data)) {
        if (!previous || JSON.stringify(data[key]) !== JSON.stringify(previous[key])) next[key] = data[key];
      }
    }
    writeSettingsAtomic(next);
  } catch (err) {
    console.error('[ccxray] writeSettings failed:', err.message);
  }
  _cache = normalizeSettings(next);
}

// The on-disk statusLine for `ccxray hud status`; throws on a file that is not
// a JSON object, like setStatusLineSync.
function readStatusLineSync() {
  const disk = readSettingsFile();
  if (disk.state === 'invalid') throw new Error(`${SETTINGS_PATH} is not a JSON object; fix or delete it, then retry`);
  return disk.state === 'object' && Boolean(disk.value.statusLine);
}

// `ccxray hud on|off` (#692): a CLI process that exits right away, so the write
// is synchronous and atomic. Only `statusLine` changes; every other key on disk
// is kept. A settings.json that does not parse to an object is never rewritten.
function setStatusLineSync(enabled) {
  const disk = readSettingsFile();
  if (disk.state === 'invalid') throw new Error(`${SETTINGS_PATH} is not a JSON object; fix or delete it, then retry`);
  const next = { ...(disk.value || {}), statusLine: !!enabled };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  writeSettingsAtomic(next);
  _cache = null;
  return SETTINGS_PATH;
}

// Test helper — reset cache so unit tests get a clean slate
function _resetSettingsCache() { _cache = null; }

module.exports = { readSettings, writeSettings, serializeStars, hudStatusText, setStatusLineSync, readStatusLineSync, SETTINGS_PATH, _resetSettingsCache };
