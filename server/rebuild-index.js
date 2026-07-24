'use strict';

// `ccxray rebuild-index` — rebuild index.ndjson from surviving log files.
//
// The dashboard restores history ONLY from index.ndjson (server/restore.js). If
// that file is lost or truncated, history disappears even when the underlying
// _req/_res log files are still on disk. This command replays the SAME canonical
// projection the live pipeline uses (getParser(provider).buildEntryFields →
// buildIndexLine, see server/forward.js ~716-743) over the surviving files, so a
// rebuilt line is shape-identical to a live one and can never drift from the
// production field layout (that drift was the old recovery script's core bug).
//
// Hard guarantees (issue #48,做法 1):
//   • merge-only, add-only — ADD lines for ids that have a _req.json on disk but
//     are missing from the index (the "orphan set"). Existing lines, including
//     the ~85% whose _req/_res were pruned (LOG_RETENTION_DAYS) while the index
//     kept the line forever, are copied through verbatim. The index never shrinks
//     and a present line is never DEGRADED. The one sanctioned overwrite is the
//     #333 add-only responseId backfill: a legacy line missing the dedup key gets
//     it appended (all other fields byte-identical) when its _res.json survives —
//     strictly non-degrading, so #48's intent holds. See ADR 0012.
//   • never degrade — a delta turn whose ancestor _req.json was pruned cannot be
//     fully reconstructed; we SKIP it and count it unrecoverable rather than emit
//     a truncated line. Rebuild must never produce a worse line than doing nothing.
//   • atomic — write a temp file, then fs.rename() onto index.ndjson.
//   • hub-safe — refuse to run while a live hub may be appending concurrently.
//
// Recovers offline: model/usage/cost/maxContext/toolCalls (canonical), cwd (from
// the rehydrated system prompt — shared sys_*.json files are never pruned),
// title, thinkingDuration, stopReason, session attribution, and prompt identity
// (sysHash/coreHash/agentKey — recomputed from the rehydrated system prompt).
// Honestly null for runtime-only fields it cannot know (elapsed, receivedAt).

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const hub = require('./hub');
const helpers = require('./helpers');
const { getParser } = require('./wire-parsers');
const { buildIndexLine } = require('./entry');
const { extractAgentType, splitB2IntoBlocks, computeCoreHash } = require('./system-prompt');

// Offline twin of registerPromptVersion's identity computation (no versionIndex
// side effects): agent identity + coreHash from a rehydrated system array.
function promptIdentity(system) {
  const none = { coreHash: null, agentKey: null, agentLabel: null };
  if (!Array.isArray(system) || system.length < 2) return none;
  const at = extractAgentType(system);
  const agentKey = at && at.key !== 'unknown' ? at.key : null;
  const agentLabel = agentKey ? at.label : null;
  let coreHash = null;
  const b2 = (system[2]?.text || '');
  if (b2.length >= 500) {
    const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
    // INVARIANT: coreHash via computeCoreHash (platform-normalized) — see system-prompt.js (#219)
    coreHash = computeCoreHash(coreText);
  }
  return { coreHash, agentKey, agentLabel };
}

// #345: write [{ line }] objects to a file one line at a time (backpressure-
// aware), never building a single >512MB string via Array.join.
function writeLinesToFile(filePath, objs) {
  return new Promise((resolve, reject) => {
    // mode 0600: the rebuilt index replaces a 0600 file; default 0666&~umask
    // would downgrade it to 0644 and expose log metadata (codex m10).
    const ws = fs.createWriteStream(filePath, { mode: 0o600 });
    ws.on('error', reject);
    // Resolve only on 'close' — the fd is closed by then, so a close-time error
    // (which emits 'error' first → reject wins) can't arrive after we settle and
    // the caller renames (codex B1 + round-2 minor).
    ws.on('close', resolve);
    let i = 0;
    (function pump() {
      while (i < objs.length) {
        const ok = ws.write(objs[i].line + '\n');
        i++;
        if (!ok) { ws.once('drain', pump); return; }
      }
      ws.end();
    })();
  });
}

// "2026-05-01T11-47-17-808" → "11:47:17". The id IS a Taipei-local timestamp, so
// ts (the live pipeline's wall-clock time-of-day) is exact, not a guess.
function tsFromId(id) {
  const m = id.match(/^\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : '';
}

// Reconstruct the full as-sent request body for one id from disk — the offline
// twin of loadEntryReqRes (server/restore.js). Returns { provider, parsedBody }
// or null when the delta chain is broken (an ancestor _req.json is missing), so
// the caller can skip rather than emit a degraded line. `cache` memoizes across
// the run (one anchor is the ancestor of many deltas); `seen` guards prevId cycles.
async function reconstructReq(id, storage, cache, seen = new Set()) {
  if (cache.has(id)) return cache.get(id);

  let stripped;
  try {
    stripped = JSON.parse(await storage.read(id, '_req.json'));
  } catch {
    cache.set(id, null); // missing source = broken link in any chain through it
    return null;
  }

  // Anthropic-only recovery. OpenAI/Codex turns (raw `input` body) and WS
  // transport-only records (no payload — Codex's main traffic is recorded live
  // through the WS proxy) cannot be faithfully replayed offline: their _res.json
  // is not an SSE event array and their session id lives outside `metadata`.
  // SKIP them (counted unrecoverable) rather than emit a mislabeled Anthropic
  // line — a safe skip beats silent degradation. A real Anthropic turn always
  // carries a `messages` array (anchor or delta slice).
  // EXCEPTION(#158): data-layer — persisted format detection; only anthropic logs are rebuildable offline
  if (stripped.provider === 'openai' || Array.isArray(stripped.input)
      || stripped.transport != null || stripped.capture === 'transport-only'
      || !Array.isArray(stripped.messages)) {
    cache.set(id, null);
    return null;
  }

  // Anthropic: rehydrate system/tools from content-addressed shared files (never
  // pruned, so always available when the hash is present).
  const system = stripped.sysHash
    ? await readSharedJson(storage, `sys_${stripped.sysHash}.json`)
    : null;
  const tools = stripped.toolsHash
    ? await readSharedJson(storage, `tools_${stripped.toolsHash}.json`)
    : null;

  // Delta turn: splice prevMessages[0..msgOffset] + delta messages. If the
  // ancestor can't be reconstructed (pruned anywhere up the chain), the whole
  // turn is unrecoverable.
  let messages = Array.isArray(stripped.messages) ? stripped.messages : [];
  if (stripped.prevId != null && stripped.msgOffset != null) {
    if (seen.has(id)) { cache.set(id, null); return null; } // cycle guard
    seen.add(id);
    const prev = await reconstructReq(stripped.prevId, storage, cache, seen);
    if (!prev || !Array.isArray(prev.parsedBody?.messages)) {
      cache.set(id, null);
      return null;
    }
    messages = [...prev.parsedBody.messages.slice(0, stripped.msgOffset), ...messages];
  }

  const parsedBody = { ...stripped, system, tools, messages };
  delete parsedBody.sysHash;
  delete parsedBody.toolsHash;
  delete parsedBody.prevId;
  delete parsedBody.msgOffset;

  const result = { provider: 'anthropic', parsedBody, prevId: stripped.prevId || null, sysHash: stripped.sysHash || null, toolsHash: stripped.toolsHash || null };
  // ponytail: cache only what delta splicing needs (messages array). Full parsedBody
  // (system 50-100KB + tools 10-50KB per entry) is returned to caller but NOT retained.
  // Without this, 65K entries × 100KB = 4GB+ cache → OOM.
  cache.set(id, { provider: 'anthropic', parsedBody: { messages } });
  return result;
}

async function readSharedJson(storage, filename) {
  try { return JSON.parse(await storage.readShared(filename)); } catch { return null; }
}

// Parsed _res.json (captured SSE event array), or null if absent. usage / cost /
// maxContext are derived from these by the canonical buildEntryFields.
async function readResEvents(storage, id) {
  try {
    const parsed = JSON.parse(await storage.read(id, '_res.json'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Anthropic stop_reason lives in the message_delta event. buildEntryFields takes
// it via ctx.stopReason with NO event fallback (the live pipeline extracts it in
// forward.js and passes it in), so we must supply it or the column comes back
// blank — a silent degradation of every recovered line.
function stopReasonFromEvents(events) {
  if (!Array.isArray(events)) return '';
  const delta = events.find(e => e && e.type === 'message_delta');
  return delta?.delta?.stop_reason || '';
}

// Replay the live title logic (forward.js:705-711) over the data we have offline.
// Title is the dashboard's turn label; both prototypes left it null. Anthropic-only.
function recoverTitle(parsedBody, events, isSubagent) {
  if (isSubagent) return helpers.extractFirstUserText(parsedBody) || null;
  return helpers.extractResponseTitle(Array.isArray(events) ? events : [])
    || helpers.extractLastUserText(parsedBody)
    || helpers.extractToolResultSummary(parsedBody)
    || null;
}

// Largest timeline entry with id strictly before `id` (sorted ascending). Used to
// attribute an inferred/subagent turn to the session that was active when it ran.
function nearestPrecedingSession(timeline, id) {
  let lo = 0, hi = timeline.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].id < id) { ans = timeline[mid].sid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function liveHubBlocking() {
  const lock = hub.readHubLock();
  return lock && lock.pid && hub.isPidAlive(lock.pid) ? lock : null;
}

async function rebuildIndex({ apply = false, storage = config.storage, log = console.log } = {}) {
  // ── Hub safety: refuse to race a live hub's appends. ──
  const blockingHub = liveHubBlocking();
  if (blockingHub) {
    log(`\x1b[31mA ccxray hub is running (pid ${blockingHub.pid}). Stop it first.\x1b[0m`);
    log('  Run `ccxray status` to inspect, stop all `ccxray claude` clients, then retry.');
    return { refused: true };
  }

  await storage.init();

  // ── 1. Existing index → merge base + explicit-session timeline + cwd hints. ──
  // Keep every parseable existing line verbatim (merge-only), with ONE add-only
  // exception: a legacy line that predates the #333 responseId key is enriched
  // with it when its _res.json survives on disk (see below). Unparseable lines
  // are dropped exactly as restoreFromLogs already ignores them.
  const existingIds = new Set();
  const existingLineObjs = []; // [{ id, line }] — preserved verbatim, re-sorted by id on write
  const explicitTimeline = []; // [{ id, sid, cwd }] — explicit, non-inferred sessions
  const sessionCwd = new Map(); // sid → latest cwd, for backfilling inferred turns
  let enrichedResponseIds = 0;  // #333 legacy backfill count
  let enrichedIdentity = 0;     // #342 legacy identity backfill count
  // #345: stream lines — a recovered index can exceed Node's ~512MB single-string
  // limit, where readIndex() (readFile utf8) throws ERR_STRING_TOO_LONG.
  for await (const line of storage.readIndexLines()) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; } // one bad line must not abort
    if (!m || !m.id) continue;
    existingIds.add(m.id);
    // #333 add-only enrichment: a line with no responseId (legacy, pre-key) is
    // the reason a shared-log duplicate can't be merged at read time. When its
    // _res.json is still on disk, add the key and keep every other field
    // verbatim — strictly non-degrading, so it honours #48's "never degrade"
    // intent while extending "never overwrite" to "never overwrite EXCEPT this
    // additive key". Pruned _res (the ~85% aged out by retention) ⇒ untouched.
    // OpenAI lines are exempt (different id scheme) — skip the read.
    let outLine = line;
    // == null catches both missing (legacy) and a persisted null (an earlier
    // non-SSE orphan that couldn't extract before the raw-object fallback landed);
    // only rewrite when extraction actually succeeds (codex round-2 m1).
    if (m.responseId == null && m.provider !== 'openai') {
      let rid = null;
      try { rid = getParser('anthropic').extractResponseId(JSON.parse(await storage.read(m.id, '_res.json'))); } catch {}
      if (rid) { m.responseId = rid; outLine = JSON.stringify(m); enrichedResponseIds++; }
    }
    // #342 add-only identity backfill: a legacy line predating identity-field
    // extraction lacks convId/coreHash/agentKey/msgCount/isSubagent, so lane
    // inference (ADR 0005/0009/0010) defaults it into the main lane — the
    // context% sawtooth. When its _req.json is reconstructable, recompute those
    // fields from the on-disk request and ADD only the ones currently absent —
    // never overwrite an existing value (#48 never-degrade). Imported lines and
    // lines whose _req was pruned have no reconstructable body ⇒ untouched.
    // `convId === undefined` (the key is absent, not a persisted null) is the
    // legacy-line marker; a value/null convId is added via computeConvId — the
    // SAME function the live pipeline uses, so the recovered key matches exactly.
    if (m.convId === undefined && m.provider !== 'openai') {
      try {
        // Fresh cache per line: reconstructReq stores a messages-only entry per
        // id, so any shared cache can hand THIS leaf a messages-only ancestor
        // entry (losing system → null coreHash/agentKey) when index lines are
        // physically out of id order (codex round-3). Per-line isolation keeps
        // every backfill leaf a full reconstruction; legacy lines are few.
        const r = await reconstructReq(m.id, storage, new Map());
        const pb = r && r.parsedBody;
        if (pb && Array.isArray(pb.messages)) {
          const identity = promptIdentity(pb.system);
          // Strict add-only: `=== undefined` (key ABSENT) only — never overwrite
          // a persisted null (a legitimately-computed empty value) with a fresh
          // computation (#48 never-degrade). Each field gated independently.
          if (m.convId === undefined) m.convId = getParser('anthropic').computeConvId(pb); // may be null
          if (m.coreHash === undefined && identity.coreHash) m.coreHash = identity.coreHash;
          if (m.agentKey === undefined && identity.agentKey) m.agentKey = identity.agentKey;
          if (m.agentLabel === undefined && identity.agentLabel) m.agentLabel = identity.agentLabel;
          if (m.msgCount === undefined) m.msgCount = pb.messages.length;
          if (m.isSubagent === undefined) m.isSubagent = store.isAnthropicSubagent(pb);
          outLine = JSON.stringify(m);
          enrichedIdentity++;
        }
      } catch { /* unreconstructable (_req pruned / delta broken) → leave verbatim */ }
    }
    existingLineObjs.push({ id: m.id, line: outLine });
    if (m.sessionId && !m.sessionInferred && m.sessionId !== 'direct-api') {
      explicitTimeline.push({ id: m.id, sid: m.sessionId, cwd: m.cwd || null });
    }
  }

  // ── 2. Orphan set: ids with a _req.json on disk but no index line. ──
  let files;
  try { files = await storage.list(); } catch { files = []; }
  const orphanIds = files
    .filter(f => f.endsWith('_req.json') && !f.endsWith('_req.received.json'))
    .map(f => f.slice(0, -'_req.json'.length))
    .filter(id => !existingIds.has(id))
    .sort();

  // ── 3. Pass 1: reconstruct every orphan body; extend the explicit timeline. ──
  // (Only Anthropic turns survive reconstructReq; non-Anthropic/WS are skipped.)
  // Own cache (not the #342 backfillCache) so orphan leaves are always projected
  // from a full reconstruction, never a messages-only ancestor entry.
  const cache = new Map();
  const recon = []; // { id, parsedBody, explicitSid, prevId }
  let unrecoverable = 0;
  for (const id of orphanIds) {
    let r;
    try { r = await reconstructReq(id, storage, cache); } catch { r = null; }
    if (!r) { unrecoverable++; continue; }
    // Canonical explicit-session read (handles metadata.session_id + the
    // user_id-embedded formats), same primitive the live pipeline uses.
    const explicitSid = store.extractSessionId(r.parsedBody);
    recon.push({ id, parsedBody: r.parsedBody, explicitSid, prevId: r.prevId, sysHash: r.sysHash, toolsHash: r.toolsHash });
    if (explicitSid) explicitTimeline.push({ id, sid: explicitSid, cwd: store.extractCwd(r.parsedBody) });
  }

  // ponytail: lazy refcount eviction — delete cache entries once their last
  // downstream consumer is projected. Combined with the stripped cache in
  // reconstructReq, memory stays O(active chain depth × messages-only size).
  const ancestorRefs = new Map();
  for (const { prevId } of recon) {
    if (prevId) ancestorRefs.set(prevId, (ancestorRefs.get(prevId) || 0) + 1);
  }

  explicitTimeline.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Latest cwd wins per session (timeline is id-ascending) — mirrors the live
  // pipeline using the session's current store.sessionMeta[sid].cwd.
  for (const e of explicitTimeline) if (e.cwd) sessionCwd.set(e.sid, e.cwd);

  // ── 4. Pass 2: project each (Anthropic) orphan through the canonical pipeline. ──
  const recovered = []; // [{ id, line }]
  for (const { id, parsedBody, explicitSid, prevId, sysHash, toolsHash } of recon) {
    const events = await readResEvents(storage, id);
    // responseId: SSE streams carry it in message_start (events, an array); a
    // non-SSE anthropic turn's _res.json is a bare object readResEvents returns
    // null for, so fall back to the raw parse there (codex round-1 m3) — else the
    // orphan persists responseId:null and the undefined-only backfill never fixes it.
    let orphanResponseId = getParser('anthropic').extractResponseId(events);
    if (orphanResponseId == null) {
      try { orphanResponseId = getParser('anthropic').extractResponseId(JSON.parse(await storage.read(id, '_res.json'))); } catch {}
    }

    // Session attribution. Explicit metadata.session_id is authoritative (every
    // delta and main-session turn carries it). Otherwise the turn is a subagent /
    // inferred turn whose parent is a runtime-temporal property we can't read off
    // its own file — attribute it to the session active just before it by id
    // timestamp. Deterministic, unlike store.detectSession's inflight/30s-window
    // inference which is meaningless offline.
    // ponytail: nearest-preceding-by-timestamp approximates live parent inference;
    // if it proves wrong in practice, fall back to null + sessionInferred.
    let sessionId, sessionInferred;
    if (explicitSid) {
      sessionId = explicitSid;
      sessionInferred = false;
    } else {
      sessionId = nearestPrecedingSession(explicitTimeline, id) || 'direct-api';
      sessionInferred = true;
    }

    const isSubagent = store.isAnthropicSubagent(parsedBody);
    const cwd = store.extractCwd(parsedBody) || sessionCwd.get(sessionId) || null;
    const stopReason = stopReasonFromEvents(events);
    const title = recoverTitle(parsedBody, events, isSubagent);
    const thinkingDuration = Array.isArray(events) ? helpers.computeThinkingDuration(events) : null;

    const identity = promptIdentity(parsedBody.system);
    const fields = getParser('anthropic').buildEntryFields({
      provider: 'anthropic',
      transport: 'sse',
      parsedBody,
      events,
      sessionId,
      sessionInferred,
      cwd,
      isSubagent,
      sysHash: sysHash || null,
      toolsHash: toolsHash || null,
      coreHash: identity.coreHash,
      agentKey: identity.agentKey,
      agentLabel: identity.agentLabel,
      stopReason,
      title,
      thinkingDuration,
      thinkingStripped: undefined,
    });

    const entry = {
      id,
      ts: tsFromId(id),
      isSSE: Array.isArray(events),
      // status: tie to an actual success signal (a captured stop_reason) rather
      // than fabricating 200 for any captured stream — honestly null otherwise.
      status: stopReason ? 200 : null,
      receivedAt: null,
      elapsed: null,
      // Backfill dedup key onto recovered orphan lines (#333) — docs/decisions/0012.
      responseId: orphanResponseId,
      ...fields,
    };
    recovered.push({ id, line: buildIndexLine(entry) });

    // ── Cache eviction: entries are already stripped (messages-only) by
    // reconstructReq; here we delete entries no longer needed as ancestors. ──
    if (!ancestorRefs.has(id)) cache.delete(id);
    if (prevId && ancestorRefs.has(prevId)) {
      const remaining = ancestorRefs.get(prevId) - 1;
      if (remaining <= 0) { ancestorRefs.delete(prevId); cache.delete(prevId); }
      else ancestorRefs.set(prevId, remaining);
    }
  }

  // ── 5. Report. ──
  const M = orphanIds.length;
  const N = recovered.length;
  log(`recovered ${N} / ${M} turns; ${unrecoverable} unrecoverable (source pruned)`);
  log(`  index: ${existingIds.size} existing lines${N ? ` + ${N} recovered` : ''}`);
  if (enrichedResponseIds) log(`  backfilled responseId onto ${enrichedResponseIds} legacy line(s) (#333)`);
  if (enrichedIdentity) log(`  backfilled convId/coreHash/agentKey onto ${enrichedIdentity} legacy line(s) (#342)`);

  // A run with no orphans to add can still have enriched existing lines — those
  // rewritten lines must be flushed, so the write is gated on any change.
  const hasChanges = N > 0 || enrichedResponseIds > 0 || enrichedIdentity > 0;
  if (!hasChanges) {
    log(apply ? '  nothing to add — index left unchanged.' : '  dry run — nothing to add.');
    return { refused: false, recovered: 0, enriched: 0, enrichedIdentity: 0, total: M, unrecoverable, applied: false, cacheFinalSize: cache.size };
  }
  if (!apply) {
    log(`  dry run — pass --apply to write ${storage.location || 'index.ndjson'}.`);
    return { refused: false, recovered: N, enriched: enrichedResponseIds, enrichedIdentity, total: M, unrecoverable, applied: false, cacheFinalSize: cache.size };
  }

  // ── 6. Atomic merge-write (local filesystem only). ──
  if (!storage.supportsDelta || !storage.location) {
    log('  --apply needs the local filesystem backend; aborting without writing.');
    return { refused: false, recovered: N, enriched: enrichedResponseIds, enrichedIdentity, total: M, unrecoverable, applied: false };
  }
  const indexPath = path.join(storage.location, 'index.ndjson');
  const tmpPath = `${indexPath}.rebuild-${process.pid}.tmp`;
  // Merge existing (verbatim, or add-only enriched with responseId #333 /
  // identity #342) + recovered, ordered by id so recovered turns land in
  // chronological position instead of all at the end. Existing lines are never
  // dropped and never degraded — at most additive keys are appended to a legacy
  // line (#333 responseId, #342 convId/coreHash/agentKey/msgCount/isSubagent).
  const merged = [...existingLineObjs, ...recovered]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // #345: stream lines to the temp file — merged.join('\n') would throw
  // ERR_STRING_TOO_LONG once the combined index passes ~512MB. (The lines are
  // still held in memory to sort; a manual recovery CLI can afford that.)
  await writeLinesToFile(tmpPath, merged);
  try { fs.chmodSync(tmpPath, 0o600); } catch {} // guarantee 0600 even if a stale tmp pre-existed
  fs.renameSync(tmpPath, indexPath);
  log(`  wrote ${indexPath} (${existingIds.size + N} lines). Restart the dashboard to see recovered turns.`);
  return { refused: false, recovered: N, enriched: enrichedResponseIds, enrichedIdentity, total: M, unrecoverable, applied: true, cacheFinalSize: cache.size };
}

module.exports = { rebuildIndex, reconstructReq, tsFromId, nearestPrecedingSession };
