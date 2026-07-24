'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const config = require('./config');
const store = require('./store');
const { calculateCost } = require('./pricing');
const { extractAgentType, extractPromptAgentType, splitB2IntoBlocks, rawCoreHash, computeCoreHash } = require('./system-prompt');
const { normalizeOpenAIResponseSummary } = require('./forward');
const { readSettings, serializeStars } = require('./settings');
const { computeRetentionSets, isProtectedByStar } = require('./helpers');
const { normalizeUsageForProvider } = require('./providers');
const { broadcastEntryUpdate } = require('./sse-broadcast');
const sessionIdx = require('./session-index');

// #211: model marker ("The exact model ID is ...") from the persisted system
// prompt for this sysHash, or null (unreadable / no marker line). Cached per
// hash — restore sees the same few sysHashes across many entries.
const sysMarkerCache = new Map();
async function sysModelMarker(sysHash) {
  if (sysMarkerCache.has(sysHash)) return sysMarkerCache.get(sysHash);
  let marker = null;
  try {
    const system = JSON.parse(await config.storage.readShared(`sys_${sysHash}.json`));
    marker = config.extractModelFromSystem(system);
  } catch { /* unreadable/pruned → unverifiable */ }
  sysMarkerCache.set(sysHash, marker);
  return marker;
}

// Pull stars from settings and shape for computeRetentionSets. Returns the
// canonical empty shape on any failure — the prune/restore paths must never
// throw because of star bookkeeping.
function readStarsSafe() {
  try {
    return serializeStars(readSettings());
  } catch { return { projects: [], sessions: [], turns: [], steps: [] }; }
}

// ── Lazy-load req/res from disk on demand ────────────────────────────

function loadEntryReqRes(entry) {
  if (entry._loaded) return Promise.resolve();
  if (entry._loadingPromise) return entry._loadingPromise;
  entry._loadingPromise = (async () => {
    if (entry._writePromise) await entry._writePromise.catch(() => {});
    try {
      const stripped = JSON.parse(await config.storage.read(entry.id, '_req.json'));
      // EXCEPTION(#158): data-layer — reads persisted provider to choose load path (openai=raw, anthropic=delta+sys+tools)
      if (entry.provider === 'openai' || stripped.provider === 'openai') {
        entry.req = stripped;
      } else {
        const sys = stripped.sysHash
          ? await config.storage.readShared(`sys_${stripped.sysHash}.json`).then(JSON.parse).catch(() => null)
          : null;
        const tools = stripped.toolsHash
          ? await config.storage.readShared(`tools_${stripped.toolsHash}.json`).then(JSON.parse).catch(() => null)
          : null;

        // Delta format: reconstruct full messages by following prevId chain.
        // Each hop loads the previous entry (itself potentially a delta) via the
        // same lazy-load mechanism, so the chain is resolved depth-first with
        // per-entry promise deduplication. Missing prev entries (pruned) degrade
        // gracefully — the delta portion is returned as-is.
        let messages = stripped.messages || [];
        if (stripped.prevId != null && stripped.msgOffset != null) {
          const prevEntry = store.getEntryById(stripped.prevId);
          if (prevEntry) {
            await loadEntryReqRes(prevEntry);
            if (Array.isArray(prevEntry.req?.messages)) {
              messages = [...prevEntry.req.messages.slice(0, stripped.msgOffset), ...messages];
            }
          }
        }

        entry.req = { ...stripped, system: sys, tools, messages };
        delete entry.req.sysHash;
        delete entry.req.toolsHash;
        delete entry.req.prevId;
        delete entry.req.msgOffset;
      }

      // Intercept-edited turn: surface the edited flag, the server-authoritative
      // edit summary (for the badge), and the forensic original from the
      // _req.received.json sidecar (the "original before edit" view). Display-only:
      // the sidecar is NEVER spliced for delta reconstruction (line ~52 always
      // uses the canonical as-sent _req.json messages).
      if (entry.edited && entry.req) {
        entry.req.edited = true;
        entry.req.editSummary = Array.isArray(entry.editSummary) ? entry.editSummary : [];
        try {
          const original = JSON.parse(await config.storage.read(entry.id, '_req.received.json'));
          const oSys = original.sysHash
            ? await config.storage.readShared(`sys_${original.sysHash}.json`).then(JSON.parse).catch(() => null)
            : (original.system != null ? original.system : null);
          const oTools = original.toolsHash
            ? await config.storage.readShared(`tools_${original.toolsHash}.json`).then(JSON.parse).catch(() => null)
            : (original.tools != null ? original.tools : null);
          entry.req.original = { ...original, system: oSys, tools: oTools };
          delete entry.req.original.sysHash;
          delete entry.req.original.toolsHash;
        } catch { /* sidecar missing → degrade: edited flag + summary still shown */ }
      }
    } catch { entry.req = null; }
    try {
      const raw = await config.storage.read(entry.id, '_res.json');
      let resData;
      try { resData = JSON.parse(raw); } catch { resData = raw; }
      // EXCEPTION(#158): data-layer — persisted provider determines response normalization format
      if (entry.provider === 'openai') {
        const normalized = normalizeOpenAIResponseSummary(entry, resData);
        Object.assign(entry, normalized.summary);
        entry.res = normalized.resData;
      } else {
        entry.res = resData;
      }
    } catch { entry.res = null; }
    entry._loaded = true;
    entry._loadingPromise = null;
  })();
  return entry._loadingPromise;
}

// ── Restore entries from index.ndjson on startup ─────────────────────

async function restoreFromLogs() {
  console.time('restore:total');

  // 0. Load session index (materialized view, <1MB, <100ms)
  console.time('restore:session-index');
  const sessionIndexLoaded = await sessionIdx.loadSessionIndex();
  console.timeEnd('restore:session-index');
  if (sessionIndexLoaded) {
    console.log(`\x1b[90m   Session index: ${sessionIdx.size()} sessions\x1b[0m`);
  }

  // 1. Read the lightweight index by STREAMING lines into parsed metas. #345:
  // the index can exceed Node's ~512MB single-string limit, so we must not call
  // readIndex() (readFile utf8) here — it would throw ERR_STRING_TOO_LONG and
  // fail restore. readIndexLines() streams without materializing the whole file.
  console.time('restore:index');
  const parsed = [];
  for await (const line of config.storage.readIndexLines()) {
    try { parsed.push(JSON.parse(line)); } catch {}
  }
  console.timeEnd('restore:index');

  if (!parsed.length) {
    console.timeEnd('restore:total');
    return;
  }

  // 1b. Reconcile sessions.json against index.ndjson if loaded (#309)
  if (sessionIndexLoaded) {
    if (sessionIdx.reconcileMetas(parsed)) {
      console.log(`\x1b[90m   Session index reconciled: ${sessionIdx.size()} sessions\x1b[0m`);
    }
  }

  // 2. Filter by RESTORE_DAYS
  console.time('restore:parse');
  let cutoffStr = null;
  if (config.RESTORE_DAYS > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.RESTORE_DAYS);
    cutoffStr = cutoff.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10);
  }

  let restored = 0;

  // Star-protection + session pre-count in one pass over pre-parsed data.
  const stars = readStarsSafe();
  const hasAnyStar = stars.projects.length || stars.sessions.length || stars.turns.length || stars.steps.length;
  let retentionSets = null;
  if (hasAnyStar && cutoffStr) {
    const lightweight = [];
    for (const m of parsed) {
      if (m && m.id) lightweight.push({ id: m.id, sessionId: m.sessionId, cwd: m.cwd });
    }
    retentionSets = computeRetentionSets(lightweight, stars);
  }

  const sessionTotals = new Map();
  for (const m of parsed) {
    if (cutoffStr && m.id && m.id.slice(0, 10) < cutoffStr) {
      if (!retentionSets || !isProtectedByStar(m, retentionSets)) continue;
    }
    if (m.sessionId) sessionTotals.set(m.sessionId, (sessionTotals.get(m.sessionId) || 0) + 1);
  }
  const oversizedSessions = new Map();
  for (const [sid, count] of sessionTotals) {
    if (count > store.SESSION_ENTRY_CAP) oversizedSessions.set(sid, count);
  }
  const sessionLoadedFirst = new Set();
  // #333: collect built entries, then fold duplicate copies by responseId in one
  // batch before they enter the store (see the merge block after this loop).
  const restoredList = [];

  for (let meta of parsed) {

    if (cutoffStr && meta.id.slice(0, 10) < cutoffStr) {
      if (!retentionSets || !isProtectedByStar(meta, retentionSets)) continue;
    }

    // Per-session cap: oversized sessions load only the first entry
    if (meta.sessionId && oversizedSessions.has(meta.sessionId)) {
      if (sessionLoadedFirst.has(meta.sessionId)) continue;
      sessionLoadedFirst.add(meta.sessionId);
      meta.truncated = true;
      meta.totalEntryCount = oversizedSessions.get(meta.sessionId);
    }

    // EXCEPTION(#158): data-layer — index-line provider gates re-parse of incomplete openai metadata
    if (meta.provider === 'openai' && (!meta.model || !meta.stopReason || !meta.usage || !meta.isSSE)) {
      try {
        const raw = await config.storage.read(meta.id, '_res.json');
        let resData;
        try { resData = JSON.parse(raw); } catch { resData = raw; }
        meta = normalizeOpenAIResponseSummary(meta, resData).summary;
      } catch {}
    }

    // Re-apply usage-aware context inference. Historical index lines may
    // carry maxContext=200000 for Claude 1M-plan turns whose original request
    // had no system prompt (e.g. title-gen, some subagent paths) — without
    // this, the dashboard would show "600K / 200K (clamped to 100%)" for
    // entries that predate the inferMaxContext fix. Math.max keeps previously
    // correct 1M values when current usage happens to fit inside 200K.
    // EXCEPTION(#158): data-layer — anthropic-specific maxContext inference from persisted usage
    if (meta.provider === 'anthropic') {
      const inferred = config.inferMaxContext(meta.model, null, meta.usage);
      // #211: a stored value is only trusted over the re-inference for
      // SUPPORTS_1M models, where it can encode a beta-header signal that is
      // not re-derivable here (headers are not persisted). For non-capable
      // models a stored 1M can only be pre-clamp LiteLLM pollution (or the
      // usage hatch, which re-inference reproduces) — re-derive instead.
      const stripped = (meta.model || '').replace(/\[.*\]/, '');
      let trustStored = !stripped.startsWith('claude-') || config.SUPPORTS_1M.test(stripped);
      // Even for SUPPORTS_1M models, a stored value above the re-inference can
      // be pre-clamp LiteLLM pollution (the #211 fable-5 lines). The persisted
      // system prompt carries the ground-truth [1m] marker — when it names
      // THIS entry's model and provably lacks [1m], the stored value is bogus.
      // A marker naming another model (post-switch lag window) is not evidence
      // about this entry. Unverifiable cases (no sysHash: title-gen/subagent
      // legs; pruned shared file; foreign marker) keep the stored value, so
      // genuine 1M turns never downgrade.
      if (trustStored && (meta.maxContext || 0) > inferred && meta.sysHash) {
        const marker = await sysModelMarker(meta.sysHash);
        const markerMatches = !!marker && marker.replace(/\[.*\]/, '') === stripped;
        if (markerMatches && !/\[1m\]/i.test(marker)) trustStored = false;
      }
      meta.maxContext = trustStored ? Math.max(meta.maxContext || 0, inferred) : inferred;
    }

    if (meta.usage) {
      const before = meta.usage;
      meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);
      if (meta.usage !== before && meta.usage._ccxrayUsageNormalized && meta.model) {
        meta.cost = calculateCost(meta.usage, meta.model);
      }
    }

    const restoredEntry = { ...meta, req: null, res: null, _loaded: false };
    // Deferred: pushed after the loop, once duplicate copies are merged (#333).
    restoredList.push(restoredEntry);

    // Track earliest timestamp per sysHash for version dating
    if (meta.sysHash && meta.id) {
      const existing = store._sysHashDates && store._sysHashDates.get(meta.sysHash);
      if (!existing || meta.id < existing) {
        if (!store._sysHashDates) store._sysHashDates = new Map();
        store._sysHashDates.set(meta.sysHash, meta.id.slice(0, 10));
      }
    }

    if (meta.sessionId) {
      if (!store.sessionMeta[meta.sessionId]) store.sessionMeta[meta.sessionId] = {};
      if (meta.provider) store.sessionMeta[meta.sessionId].provider = meta.provider;
      if (meta.cwd) store.sessionMeta[meta.sessionId].cwd = meta.cwd;
      if (meta.receivedAt) store.sessionMeta[meta.sessionId].lastSeenAt = meta.receivedAt;
      // Mark resume-eligibility before any summarizeEntry pass so every entry in
      // the session reports the final (monotonic) resumable value, not the value
      // as of its position in the index.
      store.markSessionUsage(meta);
    }
  }

  // #333: fold multi-instance duplicate copies into one canonical BEFORE they
  // enter the store, so a non-oversized session doesn't render 2–8× rows and
  // its cost is counted once. Merged-away copy ids stay in entryIndex as ALIASES
  // pointing at the canonical, so a later delta turn whose prevId names a dropped
  // copy still resolves via getEntryById (restore.js:64). Oversized sessions
  // contributed only their first entry to restoredList, so they pass through
  // unmerged here and stay served by cold-load (which merges independently).
  // See docs/decisions/0012-response-id-read-time-merge.md.
  const canonicalEntries = store.mergeByResponseId(restoredList);
  for (const entry of canonicalEntries) {
    // restoreFromLogs runs post-listen (server/index.js runPostListenStartupTasks),
    // so a live turn can complete and register its responseId while restore is
    // still replaying the log. Route each restored canonical through the SAME
    // live-merge helper: if a live entry already owns this responseId, the
    // restored copy folds into it (no duplicate row, no double cost); otherwise
    // registerOrMerge registers it as canonical (setting responseIndex) and we
    // push (codex round-1 M1).
    // INVARIANT: a first-copy push pairs with entryIndex.set; a merged copy aliases
    // via registerOrMerge — see docs/decisions/0003-entry-index-map.md + 0012.
    const { merged, canonical } = store.registerOrMerge(entry);
    if (merged) {
      // A merge here means a LIVE turn (completed during this post-listen restore)
      // already owns the responseId — registerOrMerge folded the restored copy in
      // and absorbed its aliases. That live entry was already broadcast, so push
      // the enriched canonical to any connected client (codex round-2 M6). Harmless
      // no-op when no client is connected yet (the common startup case).
      broadcastEntryUpdate(canonical);
      continue;
    }
    store.entries.push(entry);
    store.entryIndex.set(entry.id, entry);
    if (entry._mergedIds) {
      for (const aliasId of entry._mergedIds) store.entryIndex.set(aliasId, entry);
    }
    if (entry.cost?.cost != null && entry.sessionId) {
      store.sessionCosts.set(entry.sessionId, (store.sessionCosts.get(entry.sessionId) || 0) + entry.cost.cost);
    }
    restored++;
  }
  store.trimEntries();
  console.timeEnd('restore:parse');

  // 3. Build version index from shared/ system prompts — driven by hashes seen
  //    during parse, NOT by scanning shared/ (which may have 100K+ files).
  console.time('restore:versions');
  const knownHashes = store._sysHashDates ? [...store._sysHashDates.keys()] : [];
  const sysHashToAgentKey = await buildVersionIndex(knownHashes);
  console.timeEnd('restore:versions');

  // Backfill agent identity for index lines written before agentKey landed —
  // the shared sys_ file scan already detected the agent per sysHash.
  if (sysHashToAgentKey) {
    for (const entry of store.entries) {
      if (entry.agentKey || !entry.sysHash) continue;
      const at = sysHashToAgentKey.get(entry.sysHash);
      if (at) { entry.agentKey = at.key; entry.agentLabel = at.label; }
    }
  }

  // 4. Replay title-generator entries onto sess.title using the existing `title` column.
  // Legacy entries (written before the title-gen JSON fix) stored verbatim user text —
  // heuristic filter skips them: JSON-shaped, multi-line, or over the cap.
  console.time('restore:titles');
  if (sysHashToAgentKey && process.env.CCXRAY_DISABLE_TITLES !== '1') {
    for (const entry of store.entries) {
      if (!entry.sessionId || !entry.sysHash || !entry.title) continue;
      if (sysHashToAgentKey.get(entry.sysHash)?.key !== 'title-generator') continue;
      const t = entry.title;
      if (t[0] === '{' || t.includes('\n') || t.length > 200) continue;
      store.setSessionTitle(entry.sessionId, t, entry.receivedAt || 0);
    }
  }
  console.timeEnd('restore:titles');

  // 5. Session index: rebuild from index.ndjson if sessions.json was missing,
  //    then replay titles into the session index.
  if (!sessionIndexLoaded && parsed.length) {
    console.time('restore:session-index-rebuild');
    sessionIdx.rebuildFromMetas(parsed);
    console.timeEnd('restore:session-index-rebuild');
    console.log(`\x1b[90m   Session index rebuilt: ${sessionIdx.size()} sessions\x1b[0m`);
  }
  for (const [sid, meta] of Object.entries(store.sessionMeta)) {
    if (meta.title) sessionIdx.setTitle(sid, meta.title);
  }
  await sessionIdx.flush();

  console.timeEnd('restore:total');
  if (restored) {
    const truncated = oversizedSessions.size;
    const msg = config.RESTORE_DAYS > 0
      ? `Restored ${restored} entries from last ${config.RESTORE_DAYS} days`
      : `Restored ${restored} entries from index`;
    const extra = truncated ? ` (${truncated} oversized sessions capped at 1 entry)` : '';
    console.log(`\x1b[90m   ${msg}${extra}\x1b[0m`);
  }
}

async function buildVersionIndex(knownHashes) {
  if (!knownHashes || knownHashes.length === 0) return null;
  const sysHashToAgentKey = new Map();

  async function processHash(sysHash) {
    for (const prefix of ['sys_', 'openai_instructions_']) {
      const filename = `${prefix}${sysHash}.json`;
      const isOpenAI = prefix === 'openai_instructions_';
      let sys;
      try { sys = JSON.parse(await config.storage.readShared(filename)); } catch { continue; }
      if (!isOpenAI && (!Array.isArray(sys) || sys.length < 3)) continue;
      const b0 = isOpenAI ? '' : (sys[0]?.text || '');
      const b2 = isOpenAI ? (typeof sys === 'string' ? sys : JSON.stringify(sys, null, 2)) : (sys[2]?.text || '');
      const m = b0.match(/cc_version=(\S+?)[; ]/);
      let agentInfo = null;
      if (isOpenAI) {
        const meta = await config.storage.readShared(`openai_prompt_meta_${sysHash}.json`)
          .then(JSON.parse)
          .catch(() => null);
        if (meta?.agentKey) {
          agentInfo = { key: meta.agentKey, label: meta.agentLabel || meta.agentKey };
        }
      }
      const { key: agentKey, label: agentLabel } = agentInfo || (isOpenAI
        ? extractPromptAgentType('openai', { instructions: b2 })
        : extractAgentType(sys));
      return { sysHash, filename, isOpenAI, b0, b2, m, agentKey, agentLabel };
    }
    return null;
  }

  // Parallel read in batches of 50 to limit open file descriptors
  const BATCH = 50;
  for (let i = 0; i < knownHashes.length; i += BATCH) {
    const batch = knownHashes.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(h => processHash(h).catch(() => null)));
    for (const r of results) {
      if (!r) continue;
      const { sysHash, filename, isOpenAI, b2, m, agentKey, agentLabel } = r;
      if (sysHash && agentKey) sysHashToAgentKey.set(sysHash, { key: agentKey, label: agentLabel });
      if (b2.length >= (isOpenAI ? 1 : 500)) {
        const coreText = isOpenAI ? b2 : (splitB2IntoBlocks(b2).coreInstructions || '');
        const coreLen = coreText.length;
        const coreHash = isOpenAI ? rawCoreHash(coreText) : computeCoreHash(coreText);
        const ver = isOpenAI ? coreHash : (m ? m[1] : null);
        if (!ver) continue;
        const idxKey = `${agentKey}::${coreHash}`;
        const existing = store.versionIndex.get(idxKey);
        if (!existing || b2.length > existing.b2Len) {
          const stat = config.storage.statShared ? await config.storage.statShared(filename) : null;
          const firstSeen = stat?.mtime ? stat.mtime.toISOString().slice(0, 10) : null;
          store.versionIndex.set(idxKey, {
            reqId: null, sharedFile: filename, b2Len: b2.length, coreLen, coreHash,
            firstSeen,
            agentKey, agentLabel, version: ver, provider: isOpenAI ? 'openai' : 'anthropic',
          });
        } else {
          if (ver > existing.version) existing.version = ver;
        }
      }
    }
  }
  return sysHashToAgentKey;
}

// ── Prune index.ndjson lines whose _req/_res files are gone (#344) ───
// Pure decision function: given the raw index content plus which req files
// still survive on disk and which ids are star/in-memory protected, return the
// lines to keep and the drop count. No I/O — the caller owns read/write so this
// is unit-testable in isolation.
//
// Rules (see #344):
//   • Protected (starred cascade / in-memory) line → always kept.
//   • Proxy (non-imported) line → kept iff its _req.json survives on disk. This
//     also cleans PRE-EXISTING ghosts left by prunes from before this fix, not
//     just files deleted in the current pass.
//   • Imported line (never had _req/_res, by design) → kept, UNLESS it is the
//     orphaned duplicate of a pruned proxy turn: it carries a responseId that
//     some proxy line also carried (a read-time merge twin, #333/#329) and NO
//     surviving proxy copy carries that responseId anymore. Standalone imported
//     lines (no proxy twin, or no responseId key) are always kept — they are the
//     importer's durable domain, re-imported from ~/.claude while the source
//     transcript exists.
//   • Unparseable / id-less lines → kept verbatim (never lose data we can't
//     classify; mirrors restore's ignore-and-keep handling).
//
// NOTE (delta chains): a delta line whose OWN _req.json survives is kept even
// when its pruned anchor makes reconstruction partial — the delta is within the
// retention window and loadEntryReqRes degrades gracefully, so dropping it would
// delete a within-retention turn (a retention-contract violation). This diverges
// from the issue's literal "prune the delta line too" for the anchor-gone case.
// Per-line keep decision, shared by the in-memory pruneIndexLines (tests) and
// the streaming prune passes in pruneLogs. `ctx` carries the survivor/protection
// sets plus the responseId pre-scan.
function _shouldKeepIndexLine(m, ctx) {
  if (!m || !m.id) return true;                     // unclassifiable — keep verbatim
  if (ctx.protectedIds.has(m.id)) return true;
  if (m.imported) {
    const rid = m.responseId;
    const orphanDup = rid && ctx.proxyResponseIds.has(rid) && !ctx.survivingProxyResponseIds.has(rid);
    return !orphanDup;
  }
  return ctx.survivingReqIds.has(m.id);             // proxy line: keep iff its _req.json is on disk
}

// Pre-scan a list of parsed metas: responseIds carried by any proxy line, and
// the subset that still has a surviving (loadable) proxy copy.
function _buildResponseIdSets(metas, { survivingReqIds, protectedIds }) {
  const proxyResponseIds = new Set();
  const survivingProxyResponseIds = new Set();
  for (const m of metas) {
    if (!m || !m.id || m.imported || !m.responseId) continue;
    proxyResponseIds.add(m.responseId);
    if (protectedIds.has(m.id) || survivingReqIds.has(m.id)) survivingProxyResponseIds.add(m.responseId);
  }
  return { proxyResponseIds, survivingProxyResponseIds };
}

// In-memory variant (tests / small indexes). pruneLogs uses the streaming passes.
function pruneIndexLines(indexContent, { survivingReqIds, protectedIds }) {
  const parsed = [];
  for (const line of (indexContent || '').split('\n')) {
    if (!line) continue;
    let m = null;
    try { m = JSON.parse(line); } catch {}
    parsed.push({ line, m });
  }
  const sets = _buildResponseIdSets(parsed.map(p => p.m), { survivingReqIds, protectedIds });
  const ctx = { survivingReqIds, protectedIds, ...sets };
  const keptLines = [];
  let dropped = 0;
  for (const { line, m } of parsed) {
    if (_shouldKeepIndexLine(m, ctx)) keptLines.push(line); else dropped++;
  }
  return { keptLines, dropped };
}

// ── Prune log files older than LOG_RETENTION_DAYS ───────────────────
// Files belonging to entries currently restored in memory are never pruned —
// otherwise lazy-load (loadEntryReqRes) would return null after restart.

async function pruneLogs() {
  if (!config.LOG_RETENTION_DAYS || config.LOG_RETENTION_DAYS <= 0) return;

  // ponytail: if index is empty/missing, star-protection cascade can't map
  // turn→session→project — starred old entries would be silently deleted.
  // Skip prune entirely so files survive for `ccxray rebuild-index`.
  // #345: stream — the index can exceed Node's 512MB single-string limit.
  let hasAnyIndexLine = false;
  for await (const _line of config.storage.readIndexLines()) { hasAnyIndexLine = true; break; }
  if (!hasAnyIndexLine) {
    console.log('\x1b[33m[ccxray] Skipping prune: index.ndjson empty/missing — star protection cannot be computed.\x1b[0m');
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.LOG_RETENTION_DAYS);
  const cutoffStr = cutoff.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10);

  // Baseline: in-memory entries are always protected (existing behavior).
  // After star-aware restoreFromLogs, this already includes most starred
  // entries; the index sweep below is belt-and-suspenders for ids that fell
  // outside the restore window or got trimmed by MAX_ENTRIES.
  const protectedIds = new Set(store.entries.map(e => e.id));

  try {
    const stars = readStarsSafe();
    if (stars.projects.length || stars.sessions.length || stars.turns.length || stars.steps.length) {
      const indexEntries = [];
      // #345: stream — the index can exceed Node's 512MB single-string limit.
      for await (const line of config.storage.readIndexLines()) {
        try {
          const m = JSON.parse(line);
          if (m && m.id) indexEntries.push({ id: m.id, sessionId: m.sessionId, cwd: m.cwd });
        } catch {}
      }
      const sets = computeRetentionSets(indexEntries, stars);
      for (const e of indexEntries) {
        if (isProtectedByStar(e, sets)) protectedIds.add(e.id);
      }
    }
  } catch (err) {
    console.error('[ccxray] star-protection pre-pass failed:', err.message);
  }

  let files;
  try { files = await config.storage.list(); } catch { return; }

  let deleted = 0, kept = 0;
  const deletedIds = new Set();
  for (const filename of files) {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2}T.*?)_(req\.received|req|res)\.json$/);
    if (!m) continue;
    if (filename.slice(0, 10) >= cutoffStr) continue;
    if (protectedIds.has(m[1])) { kept++; continue; }
    try {
      await config.storage.deleteFile(filename);
      deleted++;
      deletedIds.add(m[1]);
    } catch {}
  }

  if (deleted > 0 || kept > 0) {
    const keptMsg = kept > 0 ? `, kept ${kept} referenced by restored entries` : '';
    console.log(`\x1b[90m   Pruned ${deleted} log files older than ${config.LOG_RETENTION_DAYS} days${keptMsg}\x1b[0m`);
  }

  // #344 + #345: sync index.ndjson + sessions.json with the files that survived,
  // by STREAMING (the index can exceed Node's 512MB single-string limit). The
  // scan runs every prune (not just when files were deleted this pass) so ghost
  // lines from prunes predating this fix are cleaned up too. Three passes keep
  // memory O(responseIds + survivor metas): (1) build responseId sets, (2) count
  // drops — early-exit with NO rewrite (and no index-mtime bump) when nothing is
  // droppable, (3) stream survivors to a temp file, then rename + rebuild.
  if (!config.storage.location) return; // non-local backend: no atomic index rewrite
  try {
    const survivingReqIds = new Set();
    for (const filename of files) {
      if (filename.endsWith('_req.json') && !filename.endsWith('_req.received.json')) {
        const id = filename.slice(0, -'_req.json'.length);
        if (!deletedIds.has(id)) survivingReqIds.add(id);
      }
    }

    // Pass 1: responseId sets (for the imported-orphan-dup rule). Built inline
    // to avoid holding every meta in memory — mirrors _buildResponseIdSets.
    const proxyResponseIds = new Set();
    const survivingProxyResponseIds = new Set();
    for await (const line of config.storage.readIndexLines()) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || !m.id || m.imported || !m.responseId) continue;
      proxyResponseIds.add(m.responseId);
      if (protectedIds.has(m.id) || survivingReqIds.has(m.id)) survivingProxyResponseIds.add(m.responseId);
    }
    const ctx = { survivingReqIds, protectedIds, proxyResponseIds, survivingProxyResponseIds };

    // Pass 2: count drops; bail without rewriting when nothing is droppable.
    let dropped = 0;
    for await (const line of config.storage.readIndexLines()) {
      let m; try { m = JSON.parse(line); } catch { m = null; }
      if (!_shouldKeepIndexLine(m, ctx)) dropped++;
    }
    if (dropped === 0) return;

    // Pass 3: stream survivors to a temp file (verbatim lines), collecting metas
    // for the session rebuild. Atomic rename commits.
    const indexPath = path.join(config.storage.location, 'index.ndjson');
    const tmpPath = `${indexPath}.prune-${process.pid}.tmp`;
    const survivorMetas = [];
    async function* survivorLines() {
      for await (const line of config.storage.readIndexLines()) {
        let m; try { m = JSON.parse(line); } catch { m = null; }
        if (!_shouldKeepIndexLine(m, ctx)) continue;
        if (m) survivorMetas.push(m);
        yield line + '\n';
      }
    }
    await pipeline(survivorLines(), fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, indexPath);

    // INVARIANT: index.ndjson is the source of truth for sessions.json — rebuild
    // from the surviving metas so card counts/costs match the pruned index
    // (dedup-by-responseId preserved) — @docs/decisions/0012-response-id-read-time-merge.md
    sessionIdx.rebuildFromMetas(survivorMetas);
    await sessionIdx.flush();
    console.log(`\x1b[90m   Pruned ${dropped} orphaned index line(s); session index rebuilt (${sessionIdx.size()} sessions)\x1b[0m`);
  } catch (err) {
    console.error('[ccxray] index prune failed:', err.message);
  }
}

module.exports = { loadEntryReqRes, restoreFromLogs, pruneLogs, pruneIndexLines };
