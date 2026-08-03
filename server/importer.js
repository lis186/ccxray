'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const store = require('./store');
const config = require('./config');
const { broadcastRaw } = require('./sse-broadcast');
const { buildIndexLine } = require('./entry');
const sessionIdx = require('./session-index');

const DEFAULT_CONTEXT_WINDOW = 200000;
const CODEX_CONTEXT_WINDOW = 400000;

// #397: calculateCostSimple lives in default-rates.js — the single source of
// truth for offline model pricing shared with cost-worker.js.
const { calculateCostSimple } = require('./default-rates');

function tsToId(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[:.]/g, '-').slice(0, -2);
}

function slugToProject(slug) {
  return slug.replace(/^-/, '/').replace(/-/g, '/').replace(/\/\//g, '/-');
}

function discoverHomes() {
  if (process.env.CCXRAY_IMPORT_HOMES) {
    return [{ dir: process.env.CCXRAY_IMPORT_HOMES }];
  }
  const home = os.homedir();
  const results = [];
  const inodes = new Set();
  let items;
  try { items = fs.readdirSync(home); } catch { return results; }
  for (const d of items) {
    if (!d.startsWith('.claude') || d.includes('.bak')) continue;
    const isNamed = d.startsWith('.claude-');
    if (d !== '.claude' && !isNamed) continue;
    const subdir = path.join(home, d, 'projects');
    try {
      const ino = fs.statSync(subdir).ino;
      if (inodes.has(ino)) continue;
      inodes.add(ino);
      results.push({ dir: subdir });
    } catch {}
  }
  const xdg = path.join(home, '.config', 'claude', 'projects');
  try {
    const ino = fs.statSync(xdg).ino;
    if (!inodes.has(ino)) results.push({ dir: xdg });
  } catch {}
  return results;
}

function discoverCodexHomes() {
  if (process.env.CCXRAY_IMPORT_CODEX_HOMES) {
    return [{ dir: process.env.CCXRAY_IMPORT_CODEX_HOMES }];
  }
  const home = os.homedir();
  const results = [];
  const inodes = new Set();
  let items;
  try { items = fs.readdirSync(home); } catch { return results; }
  for (const d of items) {
    if (!d.startsWith('.codex') || d.includes('.bak')) continue;
    const isNamed = d.startsWith('.codex-');
    if (d !== '.codex' && !isNamed) continue;
    const subdir = path.join(home, d, 'sessions');
    try {
      const ino = fs.statSync(subdir).ino;
      if (inodes.has(ino)) continue;
      inodes.add(ino);
      results.push({ dir: subdir });
    } catch {}
  }
  return results;
}

async function collectJsonlFiles(dir) {
  const results = [];
  let items;
  try { items = await fs.promises.readdir(dir); } catch { return results; }
  for (const item of items) {
    if (!item.endsWith('.jsonl')) continue;
    results.push(path.join(dir, item));
  }
  return results;
}

// Codex sessions live nested under sessions/YYYY/MM/DD/*.jsonl, unlike
// Claude's flat projects/<slug>/*.jsonl — needs a recursive walk.
async function collectJsonlFilesRecursive(dir, results = []) {
  let items;
  try { items = await fs.promises.readdir(dir); } catch { return results; }
  for (const item of items) {
    const fullPath = path.join(dir, item);
    let stat;
    try { stat = await fs.promises.stat(fullPath); } catch { continue; }
    if (stat.isDirectory()) await collectJsonlFilesRecursive(fullPath, results);
    else if (item.endsWith('.jsonl')) results.push(fullPath);
  }
  return results;
}

function buildTokens(usage, contextWindow = DEFAULT_CONTEXT_WINDOW) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const total = input + output + cacheRead + cacheCreate;
  const contextPct = contextWindow > 0 ? Math.round(((input + cacheRead + cacheCreate) / contextWindow) * 100) : 0;
  return { input, output, cacheRead, cacheCreate, contextPct, contextWindow };
}

async function parseSessionFile(filePath, projectSlug) {
  const sessionId = path.basename(filePath, '.jsonl');
  let lastUserText = null;
  let cwd = null;
  // #428: aggregate by message.id — Claude Code writes multiple assistant lines
  // per API response (one per content block), each with a different timestamp.
  // Key = msg.id; value = entry object. Last-seen line wins (richest usage).
  // Lines without msg.id pass through keyed by their timestamp-derived id.
  const byResponseId = new Map();

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.cwd && !cwd) cwd = obj.cwd;

    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (typeof content === 'string') {
        lastUserText = content.slice(0, 120);
      } else if (Array.isArray(content)) {
        const textBlock = content.find(b => b.type === 'text');
        if (textBlock) lastUserText = (textBlock.text || '').slice(0, 120);
      }
      continue;
    }

    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;
    const usage = msg.usage;
    const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    if (totalTokens === 0) continue;

    const id = tsToId(obj.timestamp);
    if (!id) continue;

    const model = msg.model || 'unknown';
    const costResult = calculateCostSimple(usage, model);
    const tokens = buildTokens(usage);
    const receivedAt = new Date(obj.timestamp).getTime();

    const responseId = msg.id || null;
    const dedupKey = responseId || id;
    const prev = byResponseId.get(dedupKey);

    const entry = {
      id: prev ? prev.id : id,
      ts: prev ? prev.ts : obj.timestamp,
      method: 'POST',
      url: '/v1/messages',
      req: null,
      res: null,
      _loaded: false,
      elapsed: null,
      status: 200,
      isSSE: false,
      receivedAt: prev ? prev.receivedAt : receivedAt,
      responseId,
      tokens,
      cost: { cost: costResult.cost, confidence: costResult.confidence },
      model,
      sessionId,
      title: prev ? prev.title : (lastUserText || '(imported)'),
      stopReason: msg.stop_reason || prev?.stopReason || null,
      imported: true,
      importSource: 'claude-code',
      sessionInferred: false,
      provider: 'anthropic',
      cwd: obj.cwd || cwd || slugToProject(projectSlug),
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    };
    byResponseId.set(dedupKey, entry);
  }
  return [...byResponseId.values()];
}

// Codex transcript lines are {timestamp, type, payload}. `payload.model` and
// `payload.cwd` show up opportunistically on turn_context/session_meta lines;
// usage lives on event_msg lines where payload.type === 'token_count'.
// Mirrors server/cost-worker.js's processCodexFile against real ~/.codex*/sessions data.
async function parseCodexSessionFile(filePath) {
  const entries = [];
  let sessionId = path.basename(filePath, '.jsonl');
  let cwd = null;
  let lastModel = 'unknown';

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const payload = obj.payload;
    if (!payload) continue;

    if (payload.cwd && !cwd) cwd = payload.cwd;
    if (payload.model) lastModel = payload.model;
    if (obj.type === 'session_meta' && typeof payload.session_id === 'string') sessionId = payload.session_id;

    if (payload.type !== 'token_count') continue;
    const tu = payload.info && payload.info.last_token_usage;
    if (!tu) continue;

    const cached = tu.cached_input_tokens || 0;
    const usage = {
      input_tokens: Math.max(0, (tu.input_tokens || 0) - cached),
      output_tokens: (tu.output_tokens || 0) + (tu.reasoning_output_tokens || 0),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    };
    const totalTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens;
    if (totalTokens === 0) continue;

    const id = tsToId(obj.timestamp);
    if (!id) continue;

    const contextWindow = (payload.info && payload.info.model_context_window) || CODEX_CONTEXT_WINDOW;
    const costResult = calculateCostSimple(usage, lastModel);
    const tokens = buildTokens(usage, contextWindow);
    const receivedAt = new Date(obj.timestamp).getTime();

    entries.push({
      id,
      ts: obj.timestamp,
      method: 'POST',
      url: '/v1/responses',
      req: null,
      res: null,
      _loaded: false,
      elapsed: null,
      status: 200,
      isSSE: false,
      receivedAt,
      tokens,
      cost: { cost: costResult.cost, confidence: costResult.confidence },
      model: lastModel,
      // #384: the transcript's model_context_window is authoritative — write it
      // so weather/session-fold/cold-load all see the real denominator.
      maxContext: contextWindow,
      sessionId,
      title: '(imported)',
      stopReason: null,
      imported: true,
      importSource: 'codex',
      provider: 'openai',
      cwd,
      usage,
    });
  }
  return entries;
}

const _pendingIndexWrites = [];

function pushImportedEntry(entry, existingIds) {
  if (existingIds.has(entry.id)) return false;
  existingIds.add(entry.id);
  // Write to index.ndjson + session index only — skip store.entries and SSE
  // broadcast to avoid 158K memory spike + client SSE flood. Imported sessions
  // are cold; their entries load on-demand via /_api/session/:sid/entries.
  const indexLine = buildIndexLine(entry);
  // Log-first: only update session index after index.ndjson write succeeds (#309)
  _pendingIndexWrites.push(config.storage.appendIndex(indexLine + '\n').then(() => {
    sessionIdx.updateFromEntry(entry);
  }).catch(e => console.error('Write import index failed:', e.message)));
  return true;
}

async function scanAndImport() {
  if (process.env.CCXRAY_IMPORT_DISABLE === '1') return { imported: 0, skipped: 0 };

  const homes = discoverHomes();
  let imported = 0;
  let skipped = 0;
  // Durable dedup: imported entries never enter store.entries, so rescans and
  // restarts must dedup against index.ndjson itself — memory alone re-imports
  // everything (unbounded index growth + doubled session-index counts).
  // "id" is the first INDEX_FIELDS key, so the first match is the entry id.
  const existingIds = new Set(store.entries.map(e => e.id));
  try {
    // #345: stream — the index can exceed Node's ~512MB single-string limit,
    // where readIndex() throws ERR_STRING_TOO_LONG and the import dedup breaks
    // (re-importing everything, unbounded index growth + doubled counts). One
    // parse per line builds existingIds and the metas for dedup seeding.
    const metas = [];
    for await (const line of config.storage.readIndexLines()) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && m.id) existingIds.add(m.id);
      metas.push(m);
    }
    // #333: seed dedup state (cost + count) from responseIds already logged by a
    // proxy, so an imported duplicate of the same turn re-adds neither its cost
    // (fable round-4 M1) nor its turn count (the count-side twin) — the fix for
    // the cross-restart double count on the fast-load-sessions.json path. Must
    // run BEFORE the import loops below so their updateFromEntry is deduped.
    sessionIdx.seedDedupFromMetas(metas);
  } catch {}

  for (const { dir } of homes) {
    let projectDirs;
    try { projectDirs = await fs.promises.readdir(dir); } catch { continue; }

    for (const slug of projectDirs) {
      const projectPath = path.join(dir, slug);
      let stat;
      try { stat = await fs.promises.stat(projectPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const jsonlFiles = await collectJsonlFiles(projectPath);
      for (const filePath of jsonlFiles) {
        const entries = await parseSessionFile(filePath, slug);
        for (const entry of entries) {
          if (pushImportedEntry(entry, existingIds)) imported++; else skipped++;
        }
      }
    }
  }

  const codexHomes = discoverCodexHomes();
  for (const { dir } of codexHomes) {
    const jsonlFiles = await collectJsonlFilesRecursive(dir);
    for (const filePath of jsonlFiles) {
      const entries = await parseCodexSessionFile(filePath);
      for (const entry of entries) {
        if (pushImportedEntry(entry, existingIds)) imported++; else skipped++;
      }
    }
  }

  if (imported > 0) {
    await Promise.all(_pendingIndexWrites);
    _pendingIndexWrites.length = 0;
    // #333/#329: an imported line sharing a proxy line's responseId does not
    // double a cold session's cost — session-index._upsert counts cost once per
    // responseId (its persistent _costByRid), so the per-entry updateFromEntry
    // above is already deduped. No destructive rebuild here (avoids the mid-flight
    // race with concurrent live updates — codex round-3 M2).
    await sessionIdx.flush();
    broadcastRaw({ _type: 'sessions_updated' });
    console.log(`[importer] Imported ${imported} turns from local transcripts (${skipped} duplicates skipped)`);
  }
  return { imported, skipped };
}

module.exports = {
  scanAndImport,
  parseSessionFile,
  parseCodexSessionFile,
  discoverHomes,
  discoverCodexHomes,
  slugToProject,
  tsToId,
};
