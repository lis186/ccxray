'use strict';

const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { calculateCost } = require('./pricing');
const { extractAgentType, extractPromptAgentType, splitB2IntoBlocks } = require('./system-prompt');
const { normalizeOpenAIResponseSummary } = require('./forward');
const { readSettings, serializeStars } = require('./settings');
const { computeRetentionSets, isProtectedByStar } = require('./helpers');
const { normalizeUsageForProvider } = require('./providers');

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
          const prevEntry = store.entries.find(e => e.id === stripped.prevId);
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

  // 1. Read the lightweight index (one file read for all metadata)
  console.time('restore:index');
  const indexContent = await config.storage.readIndex();
  console.timeEnd('restore:index');

  if (!indexContent) {
    console.timeEnd('restore:total');
    return;
  }

  // 2. Parse index lines and filter by RESTORE_DAYS
  console.time('restore:parse');
  let cutoffStr = null;
  if (config.RESTORE_DAYS > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.RESTORE_DAYS);
    cutoffStr = cutoff.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10);
  }

  const lines = indexContent.split('\n').filter(Boolean);
  let restored = 0;

  // Pre-pass: parse minimal fields once and build star-protection sets so
  // entries older than RESTORE_DAYS that are protected by stars are still
  // restored. Single allocation; reused below in the main loop.
  const stars = readStarsSafe();
  const hasAnyStar = stars.projects.length || stars.sessions.length || stars.turns.length || stars.steps.length;
  let retentionSets = null;
  if (hasAnyStar && cutoffStr) {
    const lightweight = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m && m.id) lightweight.push({ id: m.id, sessionId: m.sessionId, cwd: m.cwd });
      } catch {}
    }
    retentionSets = computeRetentionSets(lightweight, stars);
  }

  for (const line of lines) {
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }

    if (cutoffStr && meta.id.slice(0, 10) < cutoffStr) {
      if (!retentionSets || !isProtectedByStar(meta, retentionSets)) continue;
    }

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
    if (meta.provider === 'anthropic') {
      const inferred = config.inferMaxContext(meta.model, null, meta.usage);
      meta.maxContext = Math.max(meta.maxContext || 0, inferred);
    }

    if (meta.usage) {
      const before = meta.usage;
      meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);
      if (meta.usage !== before && meta.usage._ccxrayUsageNormalized && meta.model) {
        meta.cost = calculateCost(meta.usage, meta.model);
      }
    }

    store.entries.push({ ...meta, req: null, res: null, _loaded: false });

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
    }
    if (meta.cost?.cost != null && meta.sessionId) {
      store.sessionCosts.set(meta.sessionId, (store.sessionCosts.get(meta.sessionId) || 0) + meta.cost.cost);
    }
    restored++;
  }
  store.trimEntries();
  console.timeEnd('restore:parse');

  // 3. Build version index from shared/ system prompts (scans a handful of small files)
  console.time('restore:versions');
  const sysHashToAgentKey = await buildVersionIndex();
  console.timeEnd('restore:versions');

  // 4. Replay title-generator entries onto sess.title using the existing `title` column.
  // Legacy entries (written before the title-gen JSON fix) stored verbatim user text —
  // heuristic filter skips them: JSON-shaped, multi-line, or over the cap.
  console.time('restore:titles');
  if (sysHashToAgentKey && process.env.CCXRAY_DISABLE_TITLES !== '1') {
    for (const entry of store.entries) {
      if (!entry.sessionId || !entry.sysHash || !entry.title) continue;
      if (sysHashToAgentKey.get(entry.sysHash) !== 'title-generator') continue;
      const t = entry.title;
      if (t[0] === '{' || t.includes('\n') || t.length > 200) continue;
      store.setSessionTitle(entry.sessionId, t, entry.receivedAt || 0);
    }
  }
  console.timeEnd('restore:titles');

  console.timeEnd('restore:total');
  if (restored) {
    const msg = config.RESTORE_DAYS > 0
      ? `Restored ${restored} entries from last ${config.RESTORE_DAYS} days`
      : `Restored ${restored} entries from index`;
    console.log(`\x1b[90m   ${msg}\x1b[0m`);
  }
}

async function buildVersionIndex() {
  let sharedFiles;
  try { sharedFiles = await config.storage.listShared(); } catch { return null; }
  const sysHashToAgentKey = new Map();

  for (const filename of sharedFiles) {
    if (!filename.startsWith('sys_') && !filename.startsWith('openai_instructions_')) continue;
    try {
      const sys = JSON.parse(await config.storage.readShared(filename));
      const isOpenAI = filename.startsWith('openai_instructions_');
      if (!isOpenAI && (!Array.isArray(sys) || sys.length < 3)) continue;
      const b0 = isOpenAI ? '' : (sys[0]?.text || '');
      const b2 = isOpenAI ? (typeof sys === 'string' ? sys : JSON.stringify(sys, null, 2)) : (sys[2]?.text || '');
      const m = b0.match(/cc_version=(\S+?)[; ]/);
      const sysHash = filename.replace(/^sys_/, '').replace(/^openai_instructions_/, '').replace(/\.json$/, '');
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
      if (sysHash && agentKey) sysHashToAgentKey.set(sysHash, agentKey);
      if (b2.length >= (isOpenAI ? 1 : 500)) {
        const coreText = isOpenAI ? b2 : (splitB2IntoBlocks(b2).coreInstructions || '');
        const coreLen = coreText.length;
        const coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
        const ver = isOpenAI ? coreHash : (m ? m[1] : null);
        if (!ver) continue;
        const idxKey = `${agentKey}::${coreHash}`;
        const existing = store.versionIndex.get(idxKey);
        if (!existing || b2.length > existing.b2Len) {
          // Get file mtime as firstSeen date
          const stat = config.storage.statShared ? await config.storage.statShared(filename) : null;
          const firstSeen = stat?.mtime ? stat.mtime.toISOString().slice(0, 10) : null;
          store.versionIndex.set(idxKey, {
            reqId: null, sharedFile: filename, b2Len: b2.length, coreLen, coreHash,
            firstSeen,
            agentKey, agentLabel, version: ver,
          });
        } else {
          if (ver > existing.version) existing.version = ver;
        }
      }
    } catch {}
  }
  return sysHashToAgentKey;
}

// ── Prune log files older than LOG_RETENTION_DAYS ───────────────────
// Files belonging to entries currently restored in memory are never pruned —
// otherwise lazy-load (loadEntryReqRes) would return null after restart.

async function pruneLogs() {
  if (!config.LOG_RETENTION_DAYS || config.LOG_RETENTION_DAYS <= 0) return;

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
      const idx = await config.storage.readIndex();
      if (idx) {
        const indexEntries = [];
        for (const line of idx.split('\n')) {
          if (!line) continue;
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
    }
  } catch (err) {
    console.error('[ccxray] star-protection pre-pass failed:', err.message);
  }

  let files;
  try { files = await config.storage.list(); } catch { return; }

  let deleted = 0, kept = 0;
  for (const filename of files) {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2}T.*?)_(req\.received|req|res)\.json$/);
    if (!m) continue;
    if (filename.slice(0, 10) >= cutoffStr) continue;
    if (protectedIds.has(m[1])) { kept++; continue; }
    try {
      await config.storage.deleteFile(filename);
      deleted++;
    } catch {}
  }

  if (deleted > 0 || kept > 0) {
    const keptMsg = kept > 0 ? `, kept ${kept} referenced by restored entries` : '';
    console.log(`\x1b[90m   Pruned ${deleted} log files older than ${config.LOG_RETENTION_DAYS} days${keptMsg}\x1b[0m`);
  }
}

module.exports = { loadEntryReqRes, restoreFromLogs, pruneLogs };
