'use strict';

const { retentionCutoffDate } = require('./retention');

// Shared helpers for delta log storage. Used by both the live server
// (server/index.js) when deciding whether to write a delta, and by the
// one-shot migration script (scripts/migrate-to-delta.js) when retrofitting
// existing FULL files. Keeping a single source prevents the two from
// drifting out of sync (cache_control normalization is subtle).

// Claude Code shifts cache_control markers to the most-recent messages each
// turn, so identical content blocks differ only in cache_control. Strip it
// before comparing so the two turns count as sharing a prefix.
function msgNorm(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return { ...msg, content: msg.content.map(b => {
    if (!b || typeof b !== 'object' || !('cache_control' in b)) return b;
    const { cache_control, ...rest } = b;
    return rest;
  }) };
}

// Returns the number of leading messages shared between prevMsgs and currMsgs.
// Assumes conversation history is strictly append-only; verifies only the last
// prev message at its matching position (O(1) hash of that message string).
// Returns 0 when prev is empty, prev is not a strict prefix (compaction or
// different session), or the last shared message disagrees post-normalization.
function findSharedPrefix(prevMsgs, currMsgs) {
  if (!Array.isArray(prevMsgs) || prevMsgs.length === 0) return 0;
  if (!Array.isArray(currMsgs)) return 0;
  if (prevMsgs.length >= currMsgs.length) return 0;
  const lastIdx = prevMsgs.length - 1;
  try {
    if (JSON.stringify(msgNorm(prevMsgs[lastIdx])) !== JSON.stringify(msgNorm(currMsgs[lastIdx]))) return 0;
  } catch { return 0; }
  return prevMsgs.length;
}

// Variant for memory-minimal callers (migration script): receives only the
// last prev message + count rather than the full prev array.
function findSharedPrefixFromLast(prevLastMsg, prevCount, currMsgs) {
  if (!prevLastMsg || !prevCount) return 0;
  if (!Array.isArray(currMsgs)) return 0;
  if (prevCount >= currMsgs.length) return 0;
  const lastIdx = prevCount - 1;
  try {
    if (JSON.stringify(msgNorm(prevLastMsg)) !== JSON.stringify(msgNorm(currMsgs[lastIdx]))) return 0;
  } catch { return 0; }
  return prevCount;
}

// Build a FULL-format _req.json record from an edited (intercept-approved) body.
// The edited turn is always persisted full — never delta — because the edit may
// touch a message inside what would have been the shared prefix, and a delta
// stores only the suffix, so a delta record could silently serve original
// content for an edited prefix index on the read path. Writing full sidesteps
// that and makes the edited turn a fresh chain anchor. system/tools stay
// content-addressed via sysHash/toolsHash (the caller writes the shared files
// when the hashes changed).
function buildEditedReqRecord(parsedBody, { sysHash = null, toolsHash = null, sessionId = null } = {}) {
  const messages = Array.isArray(parsedBody && parsedBody.messages) ? parsedBody.messages : [];
  return {
    model: parsedBody ? parsedBody.model : undefined,
    max_tokens: parsedBody ? parsedBody.max_tokens : undefined,
    messages,
    sysHash,
    toolsHash,
    ...(sessionId ? { metadata: { session_id: sessionId } } : {}),
  };
}

// ── Disk chain resolution (#774) ─────────────────────────────────────
//
// The ONE resolver that turns a delta `_req.json` chain back into a message
// list. loadEntryReqRes (lazy load, ancestor not in memory), rebuild-index
// (reconstructReq) and the prune re-anchor all call it — separate copies are
// how the read path ended up silently truncating where rebuild-index returned
// null.
//
// A resolved state is { messages, base, missing }:
//   base    — absolute index of messages[0]; 0 = complete conversation, N>0 =
//             the first N messages are unavailable (an ancestor is missing).
//   missing — null when complete, else { prevId, msgOffset } of the broken
//             link (msgOffset === base: how many leading messages were lost).

// A chain deeper than this is treated as broken. Without
// CCXRAY_DELTA_SNAPSHOT_N a chain runs from the session-start anchor, so the
// real ceiling is turns per session; this only has to stop a corrupt chain.
const DELTA_CHAIN_MAX_DEPTH = 100000;

function isDeltaRecord(rec) {
  return !!rec && rec.prevId != null && rec.msgOffset != null;
}

// State of a FULL record. One carrying a persisted `incomplete` (a prune
// re-anchor of an already-truncated chain, #774) holds only messages from
// absolute index incomplete.msgOffset on — treating it as complete would
// misalign every delta that chains to it.
function anchorState(rec) {
  const inc = rec.incomplete;
  if (inc && inc.persisted) {
    if (Number.isInteger(inc.msgOffset) && inc.msgOffset >= 0) {
      return { messages: rec.messages, base: inc.msgOffset, missing: { prevId: inc.prevId, msgOffset: inc.msgOffset } };
    }
    // Persisted from a corrupt offset: alignment is UNKNOWN (msgOffset null) and
    // stays unknown — descendants must not invent a base for it.
    return { messages: rec.messages, base: null, missing: { prevId: inc.prevId, msgOffset: null } };
  }
  return { messages: rec.messages, base: 0, missing: null };
}

// Apply one delta record on top of its resolved parent state. `parent` null
// means the ancestor could not be read. A delta's messages start at absolute
// index msgOffset, so the parent contributes absolute [parent.base, msgOffset).
// The result is only COMPLETE when the parent really covers that range
// (base <= msgOffset <= base + parent.messages.length) and msgOffset is a
// non-negative integer; a gap, a parent that starts too late, or a corrupt
// offset yields an incomplete state starting at msgOffset instead of splicing
// non-contiguous history and calling it whole (#774).
function spliceDelta(parent, rec) {
  const own = Array.isArray(rec.messages) ? rec.messages : [];
  const off = rec.msgOffset;
  // A corrupt offset leaves the alignment UNKNOWN (base/msgOffset null): the UI
  // says "earlier messages unavailable" without a count, and a descendant never
  // builds on a base that was never known.
  if (!(Number.isInteger(off) && off >= 0)) {
    return { messages: own, base: null, missing: { prevId: rec.prevId, msgOffset: null } };
  }
  const missing = { prevId: rec.prevId, msgOffset: off };
  const pb = parent && Number.isInteger(parent.base) ? parent.base : null;
  if (pb === null || off < pb || off > pb + parent.messages.length) {
    return { messages: own, base: off, missing };
  }
  return { messages: [...parent.messages.slice(0, off - pb), ...own], base: pb, missing: parent.missing };
}

// A chain read that failed for a reason OTHER than "the file is not there".
// Thrown only by the strict resolver (prune); see resolveChainMessages.
class ChainReadError extends Error {
  constructor(id, cause) {
    super(`${id}: ${cause}`);
    this.name = 'ChainReadError';
    this.id = id;
  }
}

// Resolve `id` from storage. Returns a state, or null when `id` itself is
// unreadable (missing/corrupt/no messages array, cycle, depth limit).
// `strict` (prune's re-anchor) separates "confirmed absent" from "could not
// read": only ENOENT yields a missing link; any other read error, unparseable
// JSON, a record without a messages array, a cycle or the depth limit throws
// ChainReadError, so a transient failure can never be persisted as a truncation
// and then used to delete a recoverable ancestor. Lazy load stays non-strict.
// `cache` (optional Map id → state | null) memoizes across calls and ends the
// walk at an already-resolved ancestor; states carry messages only (never
// system/tools) so a run over many ids stays bounded. Iterative: a long chain
// must not blow the JS stack.
async function resolveChainMessages(storage, id, { cache, maxDepth = DELTA_CHAIN_MAX_DEPTH, strict = false } = {}) {
  if (cache && cache.has(id)) return cache.get(id);
  const hops = []; // delta records, newest → oldest
  const seen = new Set();
  let state = null; // resolved parent of the oldest hop; null = unreadable
  let cur = id;
  while (true) {
    if (cache && cache.has(cur)) { state = cache.get(cur); break; }
    if (seen.has(cur) || seen.size >= maxDepth) {
      if (strict) throw new ChainReadError(cur, seen.has(cur) ? 'prevId cycle' : 'chain too deep');
      break; // cycle / depth: broken, but `cur` itself may be fine
    }
    seen.add(cur);
    let rec = null;
    let absent = false;
    try {
      rec = JSON.parse(await storage.read(cur, '_req.json'));
    } catch (err) {
      if (strict && !(err && err.code === 'ENOENT')) throw new ChainReadError(cur, (err && err.message) || 'unreadable');
      absent = true;
    }
    if (absent || !rec || !Array.isArray(rec.messages)) {
      if (strict && !absent) throw new ChainReadError(cur, 'record has no messages array');
      if (cache) cache.set(cur, null);
      break;
    }
    if (!isDeltaRecord(rec)) {
      state = anchorState(rec);
      if (cache) cache.set(cur, state);
      break;
    }
    hops.push({ id: cur, messages: rec.messages, prevId: rec.prevId, msgOffset: rec.msgOffset });
    cur = rec.prevId;
  }
  for (let i = hops.length - 1; i >= 0; i--) {
    state = spliceDelta(state, hops[i]);
    if (cache) cache.set(hops[i].id, state);
  }
  return state;
}

// ── Effective retention for the writer rule ──────────────────────────
//
// INVARIANT(#774): the writer's force-full threshold must use the SMALLEST
// retention that can prune this data root: min(config.LOG_RETENTION_DAYS, the
// retention fixed in an enrolled export home's enrollment file). export-sync's
// pruneDecision prunes with the enrollment's retentionDays when enrolled, which
// can be shorter than this process's env. Read through export-sync's own
// readEnrollment (same validity rules) and cached — one file read per hour.
const WRITER_RETENTION_TTL_MS = 3600000;
let _writerRetention = null; // { key, at, days }

function writerRetentionDays(configDays, { now = Date.now(), home, readEnrollment, ttlMs = WRITER_RETENTION_TTL_MS } = {}) {
  const key = `${configDays}|${home || ''}`;
  if (_writerRetention && _writerRetention.key === key && now - _writerRetention.at < ttlMs) return _writerRetention.days;
  let days = configDays;
  try {
    const read = readEnrollment || require('./export-sync').readEnrollment;
    const enrollment = read(home || require('./paths').resolveCcxrayHome());
    if (enrollment && enrollment.state === 'enrolled' && enrollment.retentionDays > 0) {
      days = configDays > 0 ? Math.min(configDays, enrollment.retentionDays) : enrollment.retentionDays;
    }
  } catch { /* unreadable enrollment: pruneDecision falls back to config too */ }
  _writerRetention = { key, at: now, days };
  return days;
}

function _resetWriterRetentionCache() { _writerRetention = null; }

// ── Writer rule: a new delta must not chain to an ancestor prune could reach (#774) ──
//
// INVARIANT(#774): pruneLogs deletes by Taipei-date prefix. A delta written NOW
// whose previous record (prevId) is within reach of that cutoff could be
// orphaned by a prune running in another process at the same moment (no lock
// spans processes). So the writer forces a FULL record whenever the previous
// record is older than floor(retention/2) days (1 day minimum); retention off
// (<= 0 / non-numeric) never forces. Ancestors the writer can still chain to are
// therefore at least half a retention window away from being deletable, and
// prune's re-anchor only has to handle chains that AGED past the cutoff.
// Guarded by test/delta-chain-integrity.test.js (writer rule).
function deltaAncestorTooOld(prevId, retentionDays, now = new Date()) {
  if (typeof prevId !== 'string' || !(retentionDays > 0)) return false;
  const forceDays = Math.max(1, Math.floor(retentionDays / 2));
  return prevId.slice(0, 10) < retentionCutoffDate(forceDays, now);
}

// The writer's whole "start a full record instead of a delta" decision, in one
// place so tests can drive it with old ids (server/index.js is the only caller).
// prev = { id, deltaCount } of the session's previous record, or undefined.
function shouldForceFullRecord(prev, { snapshotN = 0, retentionDays, now } = {}) {
  return !prev ||
    (snapshotN > 0 && (prev.deltaCount || 0) >= snapshotN) ||
    deltaAncestorTooOld(prev.id, retentionDays, now);
}

// ── Head classification for the prune re-anchor scan (#774) ──────────
//
// INVARIANT(#774): relies on the writer's key order — prevId/msgOffset are emitted
// BEFORE messages, and the writer's extraParams never contain a top-level
// "messages" (server/index.js; every ccxray writer since 1.8.0 and
// scripts/migrate-to-delta.js do the same). A record with messages first is
// therefore never a delta WE wrote. Pinned by test/delta-writer-order.e2e.test.js,
// which builds a delta through the real writer. Do not reorder the writer's
// keys, or change this classification, without changing both.
// Minimal top-level key scanner over the first bytes of a `_req.json`. Only
// depth-1 keys count (a nested "messages"/"prevId" inside an extra parameter
// must not be mistaken for the record's own). The delta writer emits prevId
// BEFORE messages, so: a depth-1 "prevId" seen first => 'delta'; a depth-1
// "messages" seen first => 'full'; neither within the head => 'unknown' (the
// caller reads and parses the whole file).
function classifyReqHead(head) {
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') {
      let j = i + 1;
      let key = '';
      for (; j < head.length; j++) {
        if (head[j] === '\\') { key += head[j] + (head[j + 1] || ''); j++; continue; }
        if (head[j] === '"') break;
        key += head[j];
      }
      if (j >= head.length) return 'unknown'; // string cut by the head boundary
      if (depth === 1 && expectKey) {
        if (key === 'prevId') return 'delta';
        if (key === 'messages') return 'full';
        expectKey = false;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      depth++;
      expectKey = c === '{' && depth === 1;
    } else if (c === '}' || c === ']') {
      depth--;
      expectKey = false;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
    }
  }
  return 'unknown';
}

module.exports = {
  msgNorm, findSharedPrefix, findSharedPrefixFromLast, buildEditedReqRecord,
  DELTA_CHAIN_MAX_DEPTH, isDeltaRecord, anchorState, spliceDelta, resolveChainMessages,
  ChainReadError, writerRetentionDays, _resetWriterRetentionCache,
  deltaAncestorTooOld, shouldForceFullRecord, classifyReqHead,
};
