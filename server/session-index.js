'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
// #381: shared L1 agentKey classification — aligns the server window fold's
// subagent gate with the client classification pipeline (ADR 0005 site table).
const { isMainTurnByAgentKey } = require('../public/agent-classification');

const sessionIndex = new Map();
// #333: responseId → { cost, sid, confidence } of the max cost already counted for that
// response, so cost is counted once (at its richest) across duplicate copies
// seen live, via the importer, or during a rebuild. Cleared on rebuild.
const _costByRid = new Map();
// #333: responseIds whose turn COUNT has already been tallied, so a response's
// 2–8 duplicate copies bump s.count only once (the session card then shows merged
// turns, not raw lines). Parallels _costByRid but is a plain Set: a cost-null
// partial copy is still a real duplicate that must occupy a count slot, so it
// can't reuse _costByRid (which only holds cost-bearing lines). Cleared on rebuild.
const _countedRids = new Set();
// #420/ADR 0017: responseId → sid whose unknownCount slot this rid occupies.
// When a priced duplicate later arrives for the same rid, the unknown tally is
// retracted from that session so the `+` under-count marker doesn't survive a
// copy that turned out to have a price (codex R1 M2). Cleared on rebuild.
const _unknownByRid = new Map();
let dirty = false;
let flushTimer = null;
const FLUSH_DELAY_MS = 2000;

// #503: revision of the DERIVATION behind persisted weather, stamped on every
// session record that carries one. The schema probe in loadSessionIndex tests
// field EXISTENCE only, and reconcile compares counts only — neither notices a
// change in HOW weather was computed, so without this stamp a semantics change
// would leave every cold session card rendering weather derived by the old rule
// while all checks pass. Bump whenever the derivation changes.
//   1 (absent) — responseId first-seen skip, no field merge, pre-merge subagent filter
//   2          — store.mergeByResponseId per session, subagent filtered post-merge
//   3 (#509)   — a capable Bash call with no recorded result escalates to ❔ instead
//                of rendering sunny (weather.js sigToolFailure 'unmeasured')
//   4 (#516)   — retire error_cumulative/error_cluster/sig_stuck (severity → 0);
//                same inputs that produced stormy now produce sunny
// INVARIANT: see docs/decisions/0013-beta1m-persist-session-window-derive.md
const WEATHER_REV = 4;

// Single writer for persisted weather so the stamp can never be missed by one of
// the three paths (rebuild finalize, _recomputeWeather, setWeather). A record
// whose weather was written without the current stamp forces a rebuild at load.
function _assignWeather(s, weather) {
  if (!s || !weather) return;
  s.weather = weather;
  s.weatherRev = WEATHER_REV;
}

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
    // #368/#420/#426/#475: force rebuild when sessions.json predates a derived
    // field. After rebuild, _upsert/weather repopulate from index.ndjson entries.
    let needsMigration = false;
    for (const s of sessionIndex.values()) {
      if (s.count > 0 && (
        s.maxContext === undefined
        || s.fallbackCount === undefined
        || s.firstReceivedAt === undefined
        || (s.weather !== undefined && s.weather?.stats?.toolSignal === undefined)
        || (s.weather !== undefined && s.weather?.stats?.toolTurns === undefined)
        // #503: not a field probe — a derivation-semantics probe. See WEATHER_REV.
        || (s.weather !== undefined && s.weatherRev !== WEATHER_REV)
      )) { needsMigration = true; break; }
    }
    if (needsMigration) {
      console.log('\x1b[33m[session-index] schema migration (derived session fields) — will rebuild\x1b[0m');
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
  _unknownByRid.clear();
  const { assessWeather } = require('../public/weather');
  const bySid = new Map();
  const consume = (m) => {
    if (!m || !m.sessionId) return;
    // Cost/count attribution stays on the raw line (first-seen by responseId) —
    // ADR 0012 documents that as an accepted limitation and it is not in scope
    // here. Only the weather grouping below changes.
    _upsert(m.sessionId, m);
    // INVARIANT(#503): EVERY copy is kept for the weather group, including
    // subagent-flagged ones. The merge in finalize() needs the whole group, and
    // isSubagent is filtered POST-merge because the flag travels as part of the
    // identity unit a merge adopts (ADR 0012) — an imported copy never sets it
    // (importer.js), so a pre-merge filter would admit the imported half of a
    // subagent turn as a main turn.
    let arr = bySid.get(m.sessionId);
    if (!arr) { arr = []; bySid.set(m.sessionId, arr); }
    arr.push(m);
  };
  const finalize = () => {
    // Lazy require: store.js requires THIS module at its top (store.js:3), so a
    // top-level import here would close the cycle.
    const { mergeByResponseId } = require('./store');
    for (const [sid, turns] of bySid) {
      const s = sessionIndex.get(sid);
      if (!s) continue;
      // #503: fold duplicate copies with the real field merge instead of keeping
      // only the first-seen copy. On a shared ~/.ccxray ~48% of responseId-bearing
      // lines are duplicate copies carrying COMPLEMENTARY evidence (one copy has
      // the tool results, another the agentKey), so first-seen silently dropped
      // signal that the store path (_recomputeWeather over merged store.entries)
      // and cold-load (routes/api.js:122) both see. Same helper as those two, so
      // a cold session card and a hot one can no longer disagree.
      // Per session, not global: cross-session duplicate attribution is #222 /
      // ADR 0012 territory and deliberately untouched.
      const merged = mergeByResponseId(turns).filter(t => !t.isSubagent);
      _assignWeather(s, assessWeather(merged));
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
    if (m.cost?.cost == null) {
      // INVARIANT(#420/ADR 0017): an unknown-priced line whose rid never gains a
      // priced copy keeps its slot here, so a post-restart priced duplicate can
      // retract the persisted unknownCount (codex R1 M2). First-seen wins — the
      // original run's count slot went to the first copy's session, so a later
      // cross-session duplicate must not steal the retract target (codex R2 M1).
      if (m.cost?.confidence === 'unknown' && !_costByRid.has(rid) && !_unknownByRid.has(rid)) _unknownByRid.set(rid, m.sessionId);
      continue;
    }
    const c = m.cost.cost;
    _unknownByRid.delete(rid);
    // INVARIANT(#420/ADR 0017): carry the winning copy's confidence so a
    // post-restart max-upgrade adjusts fallbackCost correctly (codex R1 M1).
    const conf = m.cost.confidence === 'fallback' ? 'fallback' : null;
    const prev = _costByRid.get(rid);
    if (prev === undefined) _costByRid.set(rid, { cost: c, sid: m.sessionId, confidence: conf });
    else if (c > prev.cost) { prev.cost = c; prev.confidence = conf; }
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

// INVARIANT (ADR 0016): buffer live updates during async rebuild so they survive
// the clear. beginRestoreBuffer → updateFromEntry still applies live (dashboard
// stays current) AND pushes to a side buffer. endRestoreBuffer(true) replays the
// buffer into the rebuilt state; responseId dedup (_countedRids/_costByRid) makes
// replay idempotent for entries WITH a responseId. No-responseId entries
// (OpenAI/WS) have no dedup key — _upsert unconditionally increments on replay,
// producing a sub-second over-count residual (up to 3× depending on timing vs
// clear; accepted, drift-healed on next startup; see ADR 0016 Known limitation).
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
  // #503: store.entries is already the merged canonical set, so no merge here —
  // but the stamp must match the rebuild's, or every startup would see rev-less
  // weather and rebuild forever.
  if (s) _assignWeather(s, assessWeather(turns, { sessionWindow: sessionWindow(sid) }));
}

function _upsert(sid, entry) {
  let s = sessionIndex.get(sid);
  if (!s) {
    // INVARIANT(#420/ADR 0017): session aggregate confidence is folded beside
    // totalCost/count so every persisted session can render the same view.
    s = { sid, firstId: null, lastId: null, count: 0, model: null, cwd: null, totalCost: 0, fallbackCost: 0, fallbackCount: 0, unknownCount: 0, title: null, firstPrompt: null, firstReceivedAt: 0, lastReceivedAt: 0, provider: null, agent: null };
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
      // INVARIANT(#420/ADR 0017): unknown turns occupy the same count
      // denominator as priced turns, but are excluded from totalCost.
      if (entry.cost && entry.cost.cost == null && entry.cost.confidence === 'unknown') {
        s.unknownCount++;
        if (crid) _unknownByRid.set(crid, sid);
      }
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
  // INVARIANT(#420/ADR 0017): fold fallback cost/count with the same responseId
  // max-upgrade decision as totalCost; never count a duplicate copy twice.
  if (entry.cost?.cost != null) {
    const rid = entry.responseId;
    const c = entry.cost.cost;
    const isFallback = entry.cost.confidence === 'fallback';
    if (!rid) {
      s.totalCost = (s.totalCost || 0) + c;
      if (isFallback) {
        s.fallbackCost = (s.fallbackCost || 0) + c;
        s.fallbackCount = (s.fallbackCount || 0) + 1;
      }
    } else {
      const prev = _costByRid.get(rid);
      if (prev === undefined) {
        // INVARIANT(#420/ADR 0017): this rid's count slot may have been claimed
        // by an unknown-priced copy — a priced duplicate retracts that unknown
        // tally from the session that recorded it (codex R1 M2).
        const unkSid = _unknownByRid.get(rid);
        if (unkSid !== undefined) {
          const us = sessionIndex.get(unkSid);
          if (us && us.unknownCount > 0) us.unknownCount--;
          _unknownByRid.delete(rid);
        }
        s.totalCost = (s.totalCost || 0) + c;
        if (isFallback) {
          s.fallbackCost = (s.fallbackCost || 0) + c;
          s.fallbackCount = (s.fallbackCount || 0) + 1;
        }
        _costByRid.set(rid, { cost: c, sid, confidence: isFallback ? 'fallback' : null });
      } else if (c > prev.cost) {
        const ps = sessionIndex.get(prev.sid);
        if (ps) {
          ps.totalCost = (ps.totalCost || 0) + (c - prev.cost);
          if (isFallback) {
            // A fallback winner carries only the max-cost delta when the
            // previous winning copy was already fallback.
            ps.fallbackCost = (ps.fallbackCost || 0) + (c - (prev.confidence === 'fallback' ? prev.cost : 0));
            if (prev.confidence !== 'fallback') ps.fallbackCount = (ps.fallbackCount || 0) + 1;
          } else if (prev.confidence === 'fallback') {
            ps.fallbackCost = (ps.fallbackCost || 0) - prev.cost;
            ps.fallbackCount = Math.max(0, (ps.fallbackCount || 0) - 1);
          }
        }
        prev.cost = c;
        prev.confidence = isFallback ? 'fallback' : null;
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
  // #426: min-fold for duration — finite-positive guard because rebuild-index
  // emits receivedAt:null for orphan lines (Number(null)===0 would poison to 1970).
  if (recvAt > 0 && (!s.firstReceivedAt || recvAt < s.firstReceivedAt)) s.firstReceivedAt = recvAt;
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
    // New entries carry provenance so an explicit zero is a real observation,
    // while a missing report stays unknown. Legacy rows remain inferable only
    // when their positive context sum proves usage was present.
    var contextKnown = entry.contextUsageKnown === true
      || (entry.contextUsageKnown !== false && ctxUsed > 0);
    if (contextKnown) {
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
  // #603: retain importer-only positive declarations for cold consumers. These
  // facts are intentionally separate from beta1m/maxContext: they widen only
  // the render fold, never weather or context-pressure classification.
  if (_isMain && entry.imported1mCostState === true) s.imported1mCostState = true;
  if (_isMain && entry.imported1mSettings === true) s.imported1mSettings = true;
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
  // An append-only importer deliberately leaves the hub-owned derived view
  // untouched. Do not keep that detached process alive for a timer whose flush
  // is guaranteed to return immediately under the same guard.
  if (process.env.CCXRAY_SESSION_INDEX_NO_FLUSH === '1') return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(e => console.error('[session-index] flush error:', e.message)); }, FLUSH_DELAY_MS);
}

// Write full sessions.json atomically (tmp + rename).
//
// INVARIANT (ADR 0019): `tmpPath()` is a FIXED name with no pid in it, so "atomically" holds
// against a crash, not against a second writer. Two processes flushing at once
// can have one rename the other's half-written bytes. Every other writer in this
// repo is the single hub process, which is why the name has been safe; a second
// process that merely APPENDS index lines (`ccxray import --once`) must set
// CCXRAY_SESSION_INDEX_NO_FLUSH=1 and leave this derived view alone. It is
// rebuildable: `loadSessionIndex` already rebuilds when index.ndjson is newer
// than sessions.json (:68-72), which is exactly the state such an append leaves
// behind. Giving the tmp file a pid suffix would make concurrent flushes safe
// but would still race last-writer-wins over the whole file, which is a
// correctness question about WHOSE view wins — not one to settle here.
// See docs/decisions/0019-second-writer-appends-never-derives.md.
async function flush() {
  if (process.env.CCXRAY_SESSION_INDEX_NO_FLUSH === '1') return;
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
  // Stamped like the other two writers (#503): restore's step-6 pass runs AFTER a
  // rebuild and overwrites its weather, so an unstamped write here would undo the
  // rebuild's stamp and force a rebuild on every subsequent startup.
  if (s && weather) { _assignWeather(s, weather); _scheduleDirtyFlush(); }
}

module.exports = {
  loadSessionIndex,
  rebuildFromIndexContent, rebuildFromMetas, rebuildFromMetasAsync,
  seedDedupState, seedDedupFromMetas,
  reconcile, reconcileMetas, createReconcileTally,
  updateFromEntry, beginRestoreBuffer, endRestoreBuffer, _restoreBufferActive,
  setTitle, setFirstPrompt, flush, getAll, get, size, setWeather, sessionWindow,
};
