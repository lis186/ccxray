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

module.exports = { msgNorm, findSharedPrefix, findSharedPrefixFromLast };
