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
      entry.req = { ...stripped, system: sys, tools };
      delete entry.req.sysHash;
      delete entry.req.toolsHash;
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
  console.timeEnd('restore:parse');

  // 3. Build version index from shared/ system prompts (scans a handful of small files)
  console.time('restore:versions');
  await buildVersionIndex();
  console.timeEnd('restore:versions');

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
  try { sharedFiles = await config.storage.listShared(); } catch { return; }

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
      if (ver && b2.length >= 500) {
        const idxKey = `${agentKey}::${ver}`;
        const existing = store.versionIndex.get(idxKey);
        if (!existing || b2.length > existing.b2Len) {
          const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
          const coreLen = coreText.length;
          const coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
          store.versionIndex.set(idxKey, {
            reqId: null, sharedFile: filename, b2Len: b2.length, coreLen, coreHash,
            firstSeen: filename.slice(4, 14) || '?',
            agentKey, agentLabel, version: ver,
          });
        }
      }
    } catch {}
  }
}

module.exports = { loadEntryReqRes, restoreFromLogs };
