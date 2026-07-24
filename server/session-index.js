'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

const sessionIndex = new Map();
// #333: responseId → { cost, sid } of the max cost already counted for that
// response, so cost is counted once (at its richest) across duplicate copies
// seen live, via the importer, or during a rebuild. Cleared on rebuild.
const _costByRid = new Map();
// #333: responseIds whose turn COUNT has already been tallied, so a response's
// 2–8 duplicate copies bump s.count only once (the session card then shows merged
// turns, not raw lines). Parallels _costByRid but is a plain Set: a cost-null
// partial copy is still a real duplicate that must occupy a count slot, so it
// can't reuse _costByRid (which only holds cost-bearing lines). Cleared on rebuild.
const _countedRids = new Set();
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

// Parse index.ndjson content into an array of metas. #345: only used by the
// string-accepting back-compat wrappers below (tests, small indexes). Throws
// ERR_STRING_TOO_LONG if `indexContent` came from readIndex() on a >512MB file —
// production callers stream via storage.readIndexLines() and call the *FromMetas
// variants directly, never building that string.
function _parseLines(indexContent) {
  const out = [];
  if (!indexContent) return out;
  for (const line of indexContent.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Build session index from an array of parsed index metas.
function rebuildFromMetas(metas) {
  sessionIndex.clear();
  _costByRid.clear();
  _countedRids.clear();
  if (!Array.isArray(metas)) return;
  // #333: a shared log holds 2–8 duplicate copies per turn (same responseId).
  // Both COST and COUNT are deduped by responseId here (_upsert via _costByRid /
  // _countedRids), so the session card shows merged turns and cost is counted once.
  // reconcile() dedups its index-side comparison the SAME way — the two must stay
  // paired: deduping count without deduping reconcile's tally would make merged
  // s.count (e.g. 15) never equal the raw line total (45) and thrash rebuilds.
  for (const m of metas) {
    if (!m || !m.sessionId) continue;
    _upsert(m.sessionId, m);
  }
  dirty = true;
}

// Back-compat string entry point (tests / small indexes).
function rebuildFromIndexContent(indexContent) {
  rebuildFromMetas(_parseLines(indexContent));
}

// #333: seed the dedup state (cost + count) from the responseIds already present
// in the log, WITHOUT touching any session total or count. Called before the
// importer runs so that an imported transcript line whose responseId a proxy
// already logged (and whose cost/count are already in the loaded/reconciled
// sessions.json totals) is recognised as a duplicate and skipped by _upsert.
// This closes the cross-restart double count on the fast-load path: loadSessionIndex
// reads s.count/totalCost straight from sessions.json without repopulating the
// in-memory _costByRid/_countedRids, so without this seed an imported duplicate
// would re-add both (cost = fable round-4 M1; count = its count-side twin).
// Idempotent: re-seeding a known responseId only lifts its tracked cost max and is
// a no-op on the count Set. Never adds to totalCost or s.count.
function seedDedupFromMetas(metas) {
  if (!Array.isArray(metas)) return;
  for (const m of metas) {
    const rid = m && m.responseId;
    if (!rid) continue;
    // COUNT: any responseId already in the log is counted — even a cost-null
    // partial (it is still a real duplicate line for count purposes).
    _countedRids.add(rid);
    // COST: only cost-bearing lines seed the tracked max.
    if (m.cost?.cost == null) continue;
    const c = m.cost.cost;
    const prev = _costByRid.get(rid);
    if (prev === undefined) _costByRid.set(rid, { cost: c, sid: m.sessionId });
    else if (c > prev.cost) prev.cost = c;
  }
}

// Back-compat string entry point (tests / small indexes).
function seedDedupState(indexContent) {
  seedDedupFromMetas(_parseLines(indexContent));
}

// Compare loaded sessions.json against index.ndjson content. Returns true if
// drift detected (and rebuilds). Checks both unique session count and total
// entry count — the latter catches appendIndex failures for existing sessions
// where session count stays the same but per-session counts diverge. (#309)
// #333: the entry tally is deduped by responseId so it matches the merged s.count
// _upsert now keeps; a raw-line tally here would always exceed merged s.count on a
// duplicate-heavy shared log and rebuild on every reconcile.
function reconcileMetas(metas) {
  if (!Array.isArray(metas) || !metas.length || !sessionIndex.size) return false;
  let indexSessions = 0, indexEntries = 0;
  const seen = new Set();
  const seenRid = new Set();
  for (const m of metas) {
    if (!m || !m.sessionId) continue;
    // Count once per responseId (merged turns); a line without responseId
    // (legacy/exempt) has no dedup key ⇒ always counts. Mirrors _upsert.
    const rid = m.responseId || null;
    if (!rid || !seenRid.has(rid)) {
      indexEntries++;
      if (rid) seenRid.add(rid);
    }
    if (!seen.has(m.sessionId)) { seen.add(m.sessionId); indexSessions++; }
  }
  let totalEntries = 0;
  for (const s of sessionIndex.values()) totalEntries += s.count;
  if (indexSessions === sessionIndex.size && indexEntries === totalEntries) return false;
  console.warn(`\x1b[33m[session-index] drift detected: sessions.json has ${sessionIndex.size} sessions / ${totalEntries} entries, index.ndjson has ${indexSessions} sessions / ${indexEntries} entries — rebuilding\x1b[0m`);
  rebuildFromMetas(metas);
  return true;
}

// Back-compat string entry point (tests / small indexes).
function reconcile(indexContent) {
  return reconcileMetas(_parseLines(indexContent));
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
  // #333: bump COUNT once per responseId so the session card shows merged turns,
  // not the 2–8 raw duplicate lines a shared log holds. A line without responseId
  // (legacy/exempt) has no dedup key ⇒ always counts. Kept paired with reconcile's
  // matching dedup so a merged s.count never thrashes against the raw line total.
  {
    const crid = entry.responseId;
    if (!crid || !_countedRids.has(crid)) {
      s.count++;
      if (crid) _countedRids.add(crid);
    }
  }
  if (!s.firstId || entry.id < s.firstId) s.firstId = entry.id;
  if (!s.lastId || entry.id > s.lastId) s.lastId = entry.id;
  if (entry.model) s.model = entry.model;
  if (entry.cwd && entry.cwd !== '(quota-check)') s.cwd = entry.cwd;
  // #333: count cost ONCE per responseId, keeping the MAX across duplicate copies
  // (a partial capture can log cost 0 before the complete copy — codex round-3 M3).
  // Persistent _costByRid makes this race-free across live + importer + rebuild
  // (no destructive mid-flight rebuild — codex round-3 M2). Cost stays in the
  // first-seen session's bucket so a cross-session duplicate isn't double-counted.
  // A line without responseId (legacy/exempt) is always counted (no dedup key).
  if (entry.cost?.cost != null) {
    const rid = entry.responseId;
    const c = entry.cost.cost;
    if (!rid) {
      s.totalCost = (s.totalCost || 0) + c;
    } else {
      const prev = _costByRid.get(rid);
      if (prev === undefined) {
        s.totalCost = (s.totalCost || 0) + c;
        _costByRid.set(rid, { cost: c, sid });
      } else if (c > prev.cost) {
        const ps = sessionIndex.get(prev.sid);
        if (ps) ps.totalCost = (ps.totalCost || 0) + (c - prev.cost);
        prev.cost = c;
      }
    }
  }
  if (entry.title && !s.title) s.title = entry.title;
  const recvAt = entry.receivedAt || 0;
  if (recvAt > (s.lastReceivedAt || 0)) s.lastReceivedAt = recvAt;
  if (entry.provider) s.provider = entry.provider;
  if (entry.agent) s.agent = entry.agent;
  // Track whether session has any non-imported entries
  if (entry.imported) { if (s.importedOnly === undefined) s.importedOnly = true; }
  else s.importedOnly = false;
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

module.exports = {
  loadSessionIndex,
  rebuildFromIndexContent, rebuildFromMetas,
  seedDedupState, seedDedupFromMetas,
  reconcile, reconcileMetas,
  updateFromEntry, setTitle, flush, getAll, size,
};
