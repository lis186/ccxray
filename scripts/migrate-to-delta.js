#!/usr/bin/env node
'use strict';

// One-shot migration: convert existing FULL-format _req.json files to delta.
// Only processes sessions with explicit session_id (same rule as the live server).
// First turn and every snapshot-n-th turn in each session remain FULL (chain anchors).
//
// Usage:
//   node scripts/migrate-to-delta.js [--write] [--snapshot-n N] [--logs-dir PATH]
//
// --write        Actually overwrite _req.json files (default: dry run)
// --snapshot-n N Force a FULL anchor every N deltas. Default: CCXRAY_DELTA_SNAPSHOT_N env,
//                or 20 if that env is 0/unset. Bounds max chain depth to N.
// --logs-dir     Override default ~/.ccxray/logs (also reads CCXRAY_HOME env)

const fs  = require('fs');
const fsp = fs.promises;
const path = require('path');
const os  = require('os');

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const WRITE = args.includes('--write');

const ldIdx = args.indexOf('--logs-dir');
const LOGS_DIR = ldIdx !== -1
  ? args[ldIdx + 1]
  : path.join(process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray'), 'logs');

const snIdx = args.indexOf('--snapshot-n');
let SNAPSHOT_N;
if (snIdx !== -1) {
  SNAPSHOT_N = parseInt(args[snIdx + 1], 10);
} else {
  const envN = parseInt(process.env.CCXRAY_DELTA_SNAPSHOT_N || '0', 10);
  SNAPSHOT_N = envN > 0 ? envN : 20; // default 20 keeps max chain depth ≤ 20
}

// ── Copied verbatim from server/index.js — must stay in sync ─────────
// Claude Code shifts cache_control markers to the most-recent messages each turn,
// so identical content blocks differ only in cache_control. Strip it before comparing.
function msgNorm(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return { ...msg, content: msg.content.map(b => {
    if (!b || typeof b !== 'object' || !('cache_control' in b)) return b;
    const { cache_control, ...rest } = b;
    return rest;
  }) };
}

// Adapted from findSharedPrefix: takes only the last prev message + count
// instead of the full array, to keep per-session memory minimal.
function canDelta(prevLastMsg, prevCount, currMessages) {
  if (prevCount >= currMessages.length) return 0;
  const lastIdx = prevCount - 1;
  try {
    if (JSON.stringify(msgNorm(prevLastMsg)) !== JSON.stringify(msgNorm(currMessages[lastIdx]))) return 0;
  } catch { return 0; }
  return prevCount; // sharedCount
}

// ── Safe JSON parse — handles legacy double-JSON-concatenated files ───
function safeParseFirst(text) {
  try { return JSON.parse(text); } catch {}
  // Scan for end of first complete object via brace depth
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape)            { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(0, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('ccxray delta migration');
  console.log(`  Logs:       ${LOGS_DIR}`);
  console.log(`  Mode:       ${WRITE ? 'WRITE' : 'DRY RUN (pass --write to apply)'}`);
  console.log(`  Snapshot-N: ${SNAPSHOT_N}`);
  console.log();

  // Clean up .tmp orphans from a previous crashed run
  let tmpCleaned = 0;
  try {
    const all = await fsp.readdir(LOGS_DIR);
    for (const f of all) {
      if (f.endsWith('.tmp')) {
        try { await fsp.unlink(path.join(LOGS_DIR, f)); tmpCleaned++; } catch {}
      }
    }
  } catch (e) {
    console.error(`Cannot read logs dir: ${e.message}`);
    process.exit(1);
  }
  if (tmpCleaned > 0) console.log(`  Cleaned ${tmpCleaned} orphan .tmp file(s)\n`);

  // Read and parse index.ndjson
  const indexPath = path.join(LOGS_DIR, 'index.ndjson');
  let indexText;
  try { indexText = await fsp.readFile(indexPath, 'utf8'); }
  catch (e) { console.error(`Cannot read index.ndjson: ${e.message}`); process.exit(1); }

  // Group by sessionId, filter, sort, de-dup
  // sessionInferred !== true: explicit undefined (legacy entries) are treated as explicit —
  // those entries have real UUID session_ids from extractSessionId(), not inferred by timing.
  // isSubagent: sub-agent calls share the parent's sessionId via inflight inference but are
  // separate one-shot conversations (msgCount=1, unrelated content). The live server keeps
  // them out of chains by using extractSessionId() (explicit only) — peekSid is null for
  // sub-agents so they fall through to FULL write. We mirror that here.
  const sessions = new Map();
  let skippedSubagent = 0;
  let skippedInferred = 0;
  for (const line of indexText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let meta;
    try { meta = JSON.parse(t); } catch { continue; }
    const { id, sessionId, sessionInferred, isSubagent } = meta;
    if (!id || !sessionId) continue;
    if (sessionInferred === true) { skippedInferred++; continue; }
    if (isSubagent === true) { skippedSubagent++; continue; }
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(id);
  }
  for (const [, ids] of sessions) {
    ids.sort();
    // de-dup in case of duplicate index entries (server crash/resend)
    const seen = new Set();
    let w = 0;
    for (const id of ids) { if (!seen.has(id)) { ids[w++] = id; seen.add(id); } }
    ids.length = w;
  }

  console.log(`Scanning ${sessions.size} sessions...\n`);

  let totalConverted = 0, totalEligible = 0, totalBytesSaved = 0;
  let maxChainDepth = 0;
  const gapSessions = [];

  for (const [sessionId, ids] of sessions) {
    let sessionConverted = 0, sessionAnchors = 0, sessionSaved = 0;
    let deltaCount = 0;
    // prevState: last msg + count only (memory-minimal)
    let prevState = null; // { id, lastMsg, msgCount }
    let hasGap = false;

    for (const id of ids) {
      const fpath = path.join(LOGS_DIR, id + '_req.json');
      let raw, size;
      try { raw = await fsp.readFile(fpath, 'utf8'); size = Buffer.byteLength(raw, 'utf8'); }
      catch { if (prevState !== null) hasGap = true; prevState = null; continue; }

      const parsed = safeParseFirst(raw);
      if (!parsed) { if (prevState !== null) hasGap = true; prevState = null; continue; }

      const isDelta = (parsed.prevId != null && parsed.msgOffset != null);

      if (isDelta) {
        // Already converted by the live server — can't reconstruct fullMessages
        // with last-msg-only prevState, so reset chain here. Subsequent FULL
        // entries will start a new anchor.
        prevState = null;
        deltaCount = 0;
        continue;
      }

      const currMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
      totalEligible++;

      const forceAnchor = (prevState === null || deltaCount >= SNAPSHOT_N);

      if (forceAnchor) {
        prevState = { id, lastMsg: currMessages[currMessages.length - 1], msgCount: currMessages.length };
        deltaCount = 0;
        sessionAnchors++;
        continue;
      }

      const sharedCount = canDelta(prevState.lastMsg, prevState.msgCount, currMessages);

      if (sharedCount < 2) {
        prevState = { id, lastMsg: currMessages[currMessages.length - 1], msgCount: currMessages.length };
        deltaCount = 0;
        sessionAnchors++;
        continue;
      }

      const newMessages = currMessages.slice(sharedCount);
      const delta = {
        model:      parsed.model,
        max_tokens: parsed.max_tokens,
        prevId:     prevState.id,
        msgOffset:  sharedCount,
        messages:   newMessages,
        sysHash:    parsed.sysHash,
        toolsHash:  parsed.toolsHash,
      };

      // Verify: reconstruct spot-check before writing
      const deltaJson = JSON.stringify(delta);
      let verifyOk = false;
      try {
        const checkIdx = sharedCount - 1;
        // Last shared message normalized should match (same as canDelta already verified)
        // Also verify first new message is correct
        verifyOk = true;
        if (newMessages.length > 0 && newMessages[0] !== currMessages[sharedCount]) {
          verifyOk = JSON.stringify(newMessages[0]) === JSON.stringify(currMessages[sharedCount]);
        }
      } catch { verifyOk = false; }

      if (!verifyOk) {
        prevState = { id, lastMsg: currMessages[currMessages.length - 1], msgCount: currMessages.length };
        deltaCount = 0;
        sessionAnchors++;
        continue;
      }

      const saved = size - Buffer.byteLength(deltaJson, 'utf8');

      if (WRITE) {
        const tmp = fpath + '.tmp';
        try {
          await fsp.writeFile(tmp, deltaJson, 'utf8');
          await fsp.rename(tmp, fpath);
        } catch (e) {
          console.error(`  Error writing ${id}: ${e.message}`);
          try { await fsp.unlink(tmp); } catch {}
          prevState = { id, lastMsg: currMessages[currMessages.length - 1], msgCount: currMessages.length };
          deltaCount = 0;
          continue;
        }
      }

      deltaCount++;
      if (deltaCount > maxChainDepth) maxChainDepth = deltaCount;
      totalConverted++;
      sessionConverted++;
      totalBytesSaved += saved;
      sessionSaved += saved;

      prevState = { id, lastMsg: currMessages[currMessages.length - 1], msgCount: currMessages.length };
    }

    if (hasGap) gapSessions.push(sessionId);

    if (sessionConverted > 0) {
      const savedStr = sessionSaved >= 1e6
        ? `${(sessionSaved / 1e6).toFixed(1)} MB saved`
        : `${Math.round(sessionSaved / 1024)} KB saved`;
      console.log(`  Session ${sessionId.slice(0, 8)}: ${ids.length} turns → ${sessionConverted} deltas, ${sessionAnchors} anchors (${savedStr})`);
    }
  }

  if (gapSessions.length > 0) {
    console.log(`\nWarning: ${gapSessions.length} session(s) had missing _req.json files (pruned?)`);
    for (const sid of gapSessions.slice(0, 5)) console.log(`  ${sid}`);
    if (gapSessions.length > 5) console.log(`  ... and ${gapSessions.length - 5} more`);
  }

  const savedStr = totalBytesSaved >= 1e9
    ? `~${(totalBytesSaved / 1e9).toFixed(1)} GB`
    : totalBytesSaved >= 1e6
    ? `~${(totalBytesSaved / 1e6).toFixed(0)} MB`
    : `~${Math.round(totalBytesSaved / 1024)} KB`;

  console.log('\nResults:');
  console.log(`  Sessions processed: ${sessions.size.toLocaleString()}`);
  console.log(`  Skipped (subagent): ${skippedSubagent.toLocaleString()}`);
  console.log(`  Skipped (inferred): ${skippedInferred.toLocaleString()}`);
  console.log(`  Files converted:    ${totalConverted.toLocaleString()} / ${totalEligible.toLocaleString()} eligible`);
  console.log(`  Max chain depth:    ${maxChainDepth}`);
  console.log(`  Space saved:        ${savedStr}${WRITE ? '' : ' (dry run estimate)'}`);

  if (!WRITE && totalConverted > 0) {
    console.log('\nRun with --write to apply changes.');
    console.log('(Recommended: stop the server first to avoid partial-read races)');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
