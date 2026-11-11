'use strict';

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

// Apply one delta record on top of its resolved parent state. `parent` null
// means the ancestor could not be read. A delta's messages start at absolute
// index msgOffset, so the parent contributes absolute [parent.base, msgOffset);
// when the parent starts later than that (or is absent) the result starts at
// msgOffset and the lost prefix is reported via `missing`.
function spliceDelta(parent, rec) {
  const own = Array.isArray(rec.messages) ? rec.messages : [];
  if (!parent) return { messages: own, base: rec.msgOffset, missing: { prevId: rec.prevId, msgOffset: rec.msgOffset } };
  const take = rec.msgOffset - parent.base;
  if (take < 0) return { messages: own, base: rec.msgOffset, missing: { prevId: rec.prevId, msgOffset: rec.msgOffset } };
  return { messages: [...parent.messages.slice(0, take), ...own], base: parent.base, missing: parent.missing };
}

// Resolve `id` from storage. Returns a state, or null when `id` itself is
// unreadable (missing/corrupt/no messages array, cycle, depth limit).
// `cache` (optional Map id → state | null) memoizes across calls and ends the
// walk at an already-resolved ancestor; states carry messages only (never
// system/tools) so a run over many ids stays bounded. Iterative: a long chain
// must not blow the JS stack.
async function resolveChainMessages(storage, id, { cache, maxDepth = DELTA_CHAIN_MAX_DEPTH } = {}) {
  if (cache && cache.has(id)) return cache.get(id);
  const hops = []; // delta records, newest → oldest
  const seen = new Set();
  let state = null; // resolved parent of the oldest hop; null = unreadable
  let cur = id;
  while (true) {
    if (cache && cache.has(cur)) { state = cache.get(cur); break; }
    let rec = null;
    let unreadable = false;
    if (seen.has(cur) || seen.size >= maxDepth) break; // cycle / depth: broken, but `cur` itself may be fine
    seen.add(cur);
    try { rec = JSON.parse(await storage.read(cur, '_req.json')); } catch { unreadable = true; }
    if (unreadable || !rec || !Array.isArray(rec.messages)) { if (cache) cache.set(cur, null); break; }
    if (!isDeltaRecord(rec)) {
      state = { messages: rec.messages, base: 0, missing: null };
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

module.exports = {
  msgNorm, findSharedPrefix, findSharedPrefixFromLast, buildEditedReqRecord,
  DELTA_CHAIN_MAX_DEPTH, isDeltaRecord, spliceDelta, resolveChainMessages,
};
