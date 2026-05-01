'use strict';

const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { calculateCost } = require('./pricing');
const { extractAgentType, splitB2IntoBlocks } = require('./system-prompt');

// ── Lazy-load req/res from disk on demand ────────────────────────────

function loadEntryReqRes(entry) {
  if (entry._loaded) return Promise.resolve();
  if (entry._loadingPromise) return entry._loadingPromise;
  entry._loadingPromise = (async () => {
    if (entry._writePromise) await entry._writePromise.catch(() => {});
    try {
      const stripped = JSON.parse(await config.storage.read(entry.id, '_req.json'));
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
    } catch { entry.req = null; }
    try {
      const raw = await config.storage.read(entry.id, '_res.json');
      try { entry.res = JSON.parse(raw); } catch { entry.res = raw; }
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

  for (const line of lines) {
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }

    if (cutoffStr && meta.id.slice(0, 10) < cutoffStr) continue;

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
    if (!filename.startsWith('sys_')) continue;
    try {
      const sys = JSON.parse(await config.storage.readShared(filename));
      if (!Array.isArray(sys) || sys.length < 3) continue;
      const b0 = sys[0]?.text || '';
      const b2 = sys[2]?.text || '';
      const m = b0.match(/cc_version=(\S+?)[; ]/);
      const ver = m ? m[1] : null;
      const { key: agentKey, label: agentLabel } = extractAgentType(sys);
      const sysHash = filename.replace(/^sys_/, '').replace(/\.json$/, '');
      if (sysHash && agentKey) sysHashToAgentKey.set(sysHash, agentKey);
      if (ver && b2.length >= 500) {
        const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
        const coreLen = coreText.length;
        const coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
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

  const protectedIds = new Set(store.entries.map(e => e.id));

  let files;
  try { files = await config.storage.list(); } catch { return; }

  let deleted = 0, kept = 0;
  for (const filename of files) {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2}T.*?)_(req|res)\.json$/);
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
