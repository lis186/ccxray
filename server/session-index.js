'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
// #381: shared L1 agentKey classification — aligns the server window fold's
// subagent gate with the client classification pipeline (ADR 0005 site table).
const { isMainTurnByAgentKey } = require('../public/agent-classification');

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
    // #368: force rebuild when sessions.json predates maxContext tracking.
    // After rebuild, _upsert populates maxContext from index.ndjson entries.
    let needsMigration = false;
    for (const s of sessionIndex.values()) {
      if (s.count > 0 && s.maxContext === undefined) { needsMigration = true; break; }
    }
    if (needsMigration) {
      console.log('\x1b[33m[session-index] schema migration (maxContext) — will rebuild\x1b[0m');
      sessionIndex.clear();
      return false;
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

// Shared rebuild logic: clear state, iterate metas (upsert + weather grouping),
// compute weather. Called by both sync (array) and async (generator) entry points.
function _rebuildCore(feedFn) {
  sessionIndex.clear();
  _costByRid.clear();
  _countedRids.clear();
  const { assessWeather } = require('../public/weather');
  const _weatherSeenRid = new Set();
  const bySid = new Map();
  const consume = (m) => {
    if (!m || !m.sessionId) return;
    _upsert(m.sessionId, m);
    if (m.isSubagent) return;
    const rid = m.responseId;
    if (rid) {
      if (_weatherSeenRid.has(rid)) return;
      _weatherSeenRid.add(rid);
    }
    let arr = bySid.get(m.sessionId);
    if (!arr) { arr = []; bySid.set(m.sessionId, arr); }
    arr.push(m);
  };
  const finalize = () => {
    for (const [sid, turns] of bySid) {
      const s = sessionIndex.get(sid);
      if (s) s.weather = assessWeather(turns);
    }
    dirty = true;
  };
  return { consume, finalize };
}

// #348: streaming rebuild — accepts async iterable (generator). Single pass:
// _upsert + weather grouping happen together so the caller can feed a streaming
// generator that never materializes the full array.
async function rebuildFromMetasAsync(iter) {
  const { consume, finalize } = _rebuildCore();
  for await (const m of iter) consume(m);
  finalize();
}

// Build session index from an array of parsed index metas (synchronous).
function rebuildFromMetas(metas) {
  if (!Array.isArray(metas)) return;
  const { consume, finalize } = _rebuildCore();
  for (const m of metas) consume(m);
  finalize();
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
// #348: the tally is incremental (createReconcileTally) so restore's streaming
// read can feed it line by line without holding every parsed meta resident;
// only sessionId + responseId are read per meta.
function createReconcileTally() {
  const seenSessions = new Set();
  const seenRid = new Set();
  let indexEntries = 0;
  return {
    feed(m) {
      if (!m || !m.sessionId) return;
      // Count once per responseId (merged turns); a line without responseId
      // (legacy/exempt) has no dedup key ⇒ always counts. Mirrors _upsert.
      const rid = m.responseId || null;
      if (!rid || !seenRid.has(rid)) {
        indexEntries++;
        if (rid) seenRid.add(rid);
      }
      seenSessions.add(m.sessionId);
    },
    // True iff the fed tally disagrees with the loaded sessions.json totals.
    // Logs the drift warning; the caller owns the rebuild.
    drift() {
      if (!sessionIndex.size) return false;
      let totalEntries = 0;
      for (const s of sessionIndex.values()) totalEntries += s.count;
      if (seenSessions.size === sessionIndex.size && indexEntries === totalEntries) return false;
      console.warn(`\x1b[33m[session-index] drift detected: sessions.json has ${sessionIndex.size} sessions / ${totalEntries} entries, index.ndjson has ${seenSessions.size} sessions / ${indexEntries} entries — rebuilding\x1b[0m`);
      return true;
    },
  };
}

function reconcileMetas(metas) {
  if (!Array.isArray(metas) || !metas.length || !sessionIndex.size) return false;
  const tally = createReconcileTally();
  for (const m of metas) tally.feed(m);
  if (!tally.drift()) return false;
  rebuildFromMetas(metas);
  return true;
}

// Back-compat string entry point (tests / small indexes).
function reconcile(indexContent) {
  return reconcileMetas(_parseLines(indexContent));
}

// #348 codex R3: buffer live updates during async rebuild so they survive the
// clear. beginRestoreBuffer → updateFromEntry still applies live (dashboard stays
// current) AND pushes to a side buffer. endRestoreBuffer(true) replays the buffer
// into the rebuilt state; responseId dedup (_countedRids/_costByRid) makes replay
// idempotent for entries whose line was also inside the snapshot byte bound.
let _restoreBuffer = null;
function _restoreBufferActive() { return _restoreBuffer !== null; }
function beginRestoreBuffer() { _restoreBuffer = []; }
function endRestoreBuffer(replay) {
  const buf = _restoreBuffer;
  _restoreBuffer = null;
  if (replay && buf && buf.length) {
    for (const entry of buf) _upsert(entry.sessionId, entry);
    _scheduleDirtyFlush();
  }
}

// Upsert a session summary from an entry's index fields.
function updateFromEntry(entry) {
  if (!entry || !entry.sessionId) return;
  _upsert(entry.sessionId, entry);
  if (_restoreBuffer) _restoreBuffer.push(entry);
  _recomputeWeather(entry.sessionId);
  _scheduleDirtyFlush();
}

function _recomputeWeather(sid) {
  const store = require('./store');
  const { assessWeather } = require('../public/weather');
  const turns = [];
  for (const e of store.entries) {
    if (e.sessionId === sid && !e.isSubagent) turns.push(e);
  }
  const s = sessionIndex.get(sid);
  if (s) s.weather = assessWeather(turns, { sessionWindow: sessionWindow(sid) });
}

function _upsert(sid, entry) {
  let s = sessionIndex.get(sid);
  if (!s) {
    s = { sid, firstId: null, lastId: null, count: 0, model: null, cwd: null, totalCost: 0, title: null, firstPrompt: null, lastReceivedAt: 0, provider: null, agent: null };
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
  // Attribution can resolve before the parent's first entry is indexed, so the
  // store's session title is authoritative; entry.title is only a fallback.
  if (!s.title) {
    const { stripInjectedTags, getSessionTitle } = require('./store');
    s.title = getSessionTitle(sid) || (entry.title ? stripInjectedTags(entry.title) : null) || null;
  }
  const recvAt = entry.receivedAt || 0;
  if (recvAt > (s.lastReceivedAt || 0)) s.lastReceivedAt = recvAt;
  if (entry.provider) s.provider = entry.provider;
  if (entry.agent) s.agent = entry.agent;
  // #367: derived fields for cold session cards (context bar, cache stats, cache breaks)
  // #381 INVARIANT: gate on isMainTurnByAgentKey (shared L1 classification) — see
  // docs/decisions/0005-agent-key-unreliable-shared-contract.md
  var _isMain = isMainTurnByAgentKey(entry);
  if (_isMain && entry.usage) {
    var u = entry.usage;
    var cacheRead = u.cache_read_input_tokens || 0;
    var cacheCreate = u.cache_creation_input_tokens || 0;
    var input = u.input_tokens || 0;
    var ctxUsed = input + cacheRead + cacheCreate;
    var ctxInputTotal = cacheRead + cacheCreate + input;
    if (ctxUsed > 0) {
      s.maxContext = Math.max(s.maxContext || 0, entry.maxContext || 0) || null;
      s.latestCtxPct = s.maxContext ? Math.round(ctxUsed / s.maxContext * 1000) / 10 : null;
      s.latestCacheHitRatio = ctxInputTotal > 0 ? Math.round(cacheRead / ctxInputTotal * 1000) / 1000 : 0;
      s.latestCacheReadTokens = cacheRead;
    }
  }
  // #367: cache breaks — gap exceeding cache TTL between non-subagent turns
  if (_isMain && recvAt > 0 && s._lastMainRecvAt > 0) {
    var gapMs = recvAt - s._lastMainRecvAt;
    if (gapMs > 300000) s.cacheBreaks = (s.cacheBreaks || 0) + 1;
  }
  if (_isMain && recvAt > 0) s._lastMainRecvAt = recvAt;
  // Track whether session has any non-imported entries
  if (entry.imported) { if (s.importedOnly === undefined) s.importedOnly = true; }
  else s.importedOnly = false;
  // #381 INVARIANT: gate on isMainTurnByAgentKey (shared L1 classification) — see
  // docs/decisions/0005-agent-key-unreliable-shared-contract.md
  if (_isMain && (entry.maxContext || 0) > (s.maxContext || 0)) s.maxContext = entry.maxContext;
  if (_isMain && entry.beta1m === true) s.beta1m = true;
}

function setTitle(sid, title) {
  const s = sessionIndex.get(sid);
  if (s && title) { s.title = title; _scheduleDirtyFlush(); }
}

function setFirstPrompt(sid, text) {
  const s = sessionIndex.get(sid);
  if (s && text && !s.firstPrompt) { s.firstPrompt = text; _scheduleDirtyFlush(); }
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
  for (const s of sessionIndex.values()) {
    var obj = {};
    for (var k in s) { if (k[0] !== '_') obj[k] = s[k]; }
    lines.push(JSON.stringify(obj));
  }
  const tmp = tmpPath();
  try {
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    await fsp.writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    await fsp.rename(tmp, sessionsPath());
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function get(sid) {
  return sessionIndex.get(sid) || null;
}

function sessionWindow(sid) {
  const s = sessionIndex.get(sid);
  if (!s) return 0;
  return s.beta1m === true ? 1000000 : (s.maxContext || 0);
}

function getAll() {
  return [...sessionIndex.values()];
}

function size() {
  return sessionIndex.size;
}

function setWeather(sid, weather) {
  const s = sessionIndex.get(sid);
  if (s && weather) { s.weather = weather; _scheduleDirtyFlush(); }
}

module.exports = {
  loadSessionIndex,
  rebuildFromIndexContent, rebuildFromMetas, rebuildFromMetasAsync,
  seedDedupState, seedDedupFromMetas,
  reconcile, reconcileMetas, createReconcileTally,
  updateFromEntry, beginRestoreBuffer, endRestoreBuffer, _restoreBufferActive,
  setTitle, setFirstPrompt, flush, getAll, get, size, setWeather, sessionWindow,
};
