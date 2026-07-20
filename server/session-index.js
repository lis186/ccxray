'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

const sessionIndex = new Map();
let dirty = false;
let flushTimer = null;
const FLUSH_DELAY_MS = 2000;

function sessionsPath() {
  return path.join(config.LOGS_DIR, 'sessions.json');
}

function tmpPath() {
  return sessionsPath() + '.tmp';
}

// Read sessions.json (NDJSON). Returns true on success, false on missing/corrupt/stale.
async function loadSessionIndex() {
  try {
    const sp = sessionsPath();
    const indexPath = path.join(config.LOGS_DIR, 'index.ndjson');
    // Stale check: if index.ndjson is newer than sessions.json, rebuild
    try {
      const [sStat, iStat] = await Promise.all([fsp.stat(sp), fsp.stat(indexPath)]);
      if (iStat.mtimeMs > sStat.mtimeMs) {
        console.log('\x1b[33m[session-index] sessions.json stale (index.ndjson newer) — will rebuild\x1b[0m');
        return false;
      }
    } catch { /* either file missing → load attempt will handle it */ }
    const raw = await fsp.readFile(sp, 'utf8');
    sessionIndex.clear();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (s && s.sid) sessionIndex.set(s.sid, s);
      } catch {}
    }
    return sessionIndex.size > 0;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[session-index] load failed:', e.message);
    return false;
  }
}

// Build session index from raw index.ndjson content string.
function rebuildFromIndexContent(indexContent) {
  sessionIndex.clear();
  if (!indexContent) return;
  for (const line of indexContent.split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (!m || !m.sessionId) continue;
      _upsert(m.sessionId, m);
    } catch {}
  }
  dirty = true;
}

// Upsert a session summary from an entry's index fields.
function updateFromEntry(entry) {
  if (!entry || !entry.sessionId) return;
  _upsert(entry.sessionId, entry);
  _scheduleDirtyFlush();
}

function _upsert(sid, entry) {
  let s = sessionIndex.get(sid);
  if (!s) {
    s = { sid, firstId: null, lastId: null, count: 0, model: null, cwd: null, totalCost: 0, title: null, lastReceivedAt: 0, provider: null, agent: null };
    sessionIndex.set(sid, s);
  }
  s.count++;
  if (!s.firstId || entry.id < s.firstId) s.firstId = entry.id;
  if (!s.lastId || entry.id > s.lastId) s.lastId = entry.id;
  if (entry.model) s.model = entry.model;
  if (entry.cwd && entry.cwd !== '(quota-check)') s.cwd = entry.cwd;
  if (entry.cost?.cost != null) s.totalCost = (s.totalCost || 0) + entry.cost.cost;
  if (entry.title && !s.title) s.title = entry.title;
  const recvAt = entry.receivedAt || 0;
  if (recvAt > (s.lastReceivedAt || 0)) s.lastReceivedAt = recvAt;
  if (entry.provider) s.provider = entry.provider;
  if (entry.agent) s.agent = entry.agent;
}

function setTitle(sid, title) {
  const s = sessionIndex.get(sid);
  if (s && title) { s.title = title; _scheduleDirtyFlush(); }
}

function _scheduleDirtyFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(e => console.error('[session-index] flush error:', e.message)); }, FLUSH_DELAY_MS);
}

// Write full sessions.json atomically (tmp + rename).
async function flush() {
  if (!dirty && !flushTimer) return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  dirty = false;
  if (!sessionIndex.size) return;
  const lines = [];
  for (const s of sessionIndex.values()) lines.push(JSON.stringify(s));
  const tmp = tmpPath();
  try {
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    await fsp.writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    await fsp.rename(tmp, sessionsPath());
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function getAll() {
  return [...sessionIndex.values()];
}

function size() {
  return sessionIndex.size;
}

module.exports = { loadSessionIndex, rebuildFromIndexContent, updateFromEntry, setTitle, flush, getAll, size };
