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
const helpers = require('./helpers');

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

// CCXRAY_IMPORT_HOMES is named like a config home, but each comma-separated
// value is the Claude `projects/` scan root itself, not `~/.claude`. Resolve
// configured roots so symlink aliases of one store are scanned only once.
//
// CONTRACT: entries must be ABSOLUTE paths. A relative entry is rejected, not
// resolved, because the same string reaches a hub and a Herdr plugin whose working
// directories differ by construction — resolving it would silently mean two different
// directories in the two processes. Rejection is only safe if it is audible: an
// operator who mistypes a root would otherwise see imports quietly go to zero. The
// warning goes to stderr because `console.log` is muted in agent and hub mode
// (server/index.js), and it fires once per process because the value is static config.
// Suppression is keyed by (variable, raw value), not a single process-wide boolean:
// one flag would swallow a second bad entry, the other variable's bad value, and any
// later correction, while re-warning on every scan would be noise. A changed value is
// news and warns again. `_resetRootWarnings` exists because the key set outlives a
// single test in a shared process.
const _warnedRoots = new Set();
function _resetRootWarnings() { _warnedRoots.clear(); }
function warnRelativeRoots(envName, values) {
  // Keyed per (variable, VALUE), not per rejected-list: keying the joined list meant
  // `bad1,bad2` -> `bad1,bad3` re-reported bad1, and merely reordering the same two
  // values warned again. Only genuinely unseen values are news.
  const unseen = values.filter(v => {
    const key = `${envName}\u0000${v}`;
    if (_warnedRoots.has(key)) return false;
    _warnedRoots.add(key);
    return true;
  });
  if (!unseen.length) return;
  console.error(`[ccxray] ${envName}: ignoring non-absolute ${unseen.length === 1 ? 'path' : 'paths'} `
    + `${unseen.map(v => JSON.stringify(v)).join(', ')} — entries must be absolute scan roots `
    + '(the projects/ or sessions/ directory itself).');
}

// One predicate, so what the client reports and what the parser rejects cannot drift.
function rejectedRootValues(rawValue) {
  return String(rawValue).split(',').map(v => v.trim()).filter(v => v && !path.isAbsolute(v));
}

function rawWarningArgs(args) {
  try {
    const encoded = JSON.stringify(args);
    return encoded === undefined ? String(args) : encoded;
  } catch {
    return String(args);
  }
}

function renderConfigWarning(warning) {
  const code = typeof warning?.code === 'string' ? warning.code : String(warning?.code);
  if (code === 'relative-import-root'
    && typeof warning?.args?.variable === 'string'
    && Array.isArray(warning.args.values)) {
    return warning.args.variable + ': '
      + warning.args.values.map(value => JSON.stringify(value)).join(', ');
  }
  // Unknown codes must remain visible to an older surface. Dropping them would turn
  // producer/surface skew into silent loss of a configuration diagnostic.
  return code + ': ' + rawWarningArgs(warning?.args);
}

function codedConfigWarning(code, args) {
  const warning = { code, args };
  // server/index.js predates coded warnings and interpolates each complaint directly.
  // Keep that call site's rendered bytes stable without putting prose in the producer;
  // the compatibility coercion delegates to the single renderer above.
  Object.defineProperty(warning, 'toString', {
    value() { return renderConfigWarning(this); },
  });
  return warning;
}

// The complaint as a VALUE, for the foreground client. warnRelativeRoots writes to
// stderr, which is correct for a standalone run but NOT sufficient under `ccxray
// <agent>`: hub.js spawns the hub with `stdio: ['ignore', fd, fd]`, so both streams go
// to hub.log and no one reads it. Not being muted is not the same as being reachable —
// the same gap that made the CCXRAY_EXPORT_CONFIG_DIRS refusal invisible.
function relativeRootComplaints(env = process.env) {
  const out = [];
  for (const name of ['CCXRAY_IMPORT_HOMES', 'CCXRAY_IMPORT_CODEX_HOMES']) {
    const raw = env[name];
    if (raw === undefined) continue;
    const bad = rejectedRootValues(raw);
    if (bad.length) {
      out.push(codedConfigWarning('relative-import-root', { variable: name, values: bad }));
    }
  }
  return out;
}

function configuredImportRoots(rawValue, envName = 'CCXRAY_IMPORT_HOMES') {
  const results = [];
  const rejected = [];
  const seen = new Map();
  for (const raw of String(rawValue).split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!path.isAbsolute(value)) { rejected.push(value); continue; }
    const absolute = path.resolve(value);
    let resolved = absolute;
    try { resolved = fs.realpathSync(absolute); } catch {}
    // The same physical projects directory can be reached by two Claude config
    // homes. Scan the transcript once, but retain BOTH settings.json locations:
    // their positive-only hints are independently relevant to this import.
    const existing = seen.get(resolved);
    if (existing) {
      existing.settingsDirs.push(path.dirname(absolute));
      continue;
    }
    const home = { dir: resolved, settingsDirs: [path.dirname(absolute)] };
    seen.set(resolved, home);
    results.push(home);
  }
  warnRelativeRoots(envName, rejected);
  return results;
}

function discoverHomes() {
  if (process.env.CCXRAY_IMPORT_HOMES !== undefined) {
    return configuredImportRoots(process.env.CCXRAY_IMPORT_HOMES);
  }
  const home = os.homedir();
  const results = [];
  const inodes = new Map();
  let items;
  try { items = fs.readdirSync(home); } catch { return results; }
  for (const d of items) {
    if (!d.startsWith('.claude') || d.includes('.bak')) continue;
    const isNamed = d.startsWith('.claude-');
    if (d !== '.claude' && !isNamed) continue;
    const subdir = path.join(home, d, 'projects');
    try {
      const ino = fs.statSync(subdir).ino;
      const existing = inodes.get(ino);
      if (existing) {
        existing.settingsDirs.push(path.dirname(subdir));
        continue;
      }
      const found = { dir: subdir, settingsDirs: [path.dirname(subdir)] };
      inodes.set(ino, found);
      results.push(found);
    } catch {}
  }
  const xdg = path.join(home, '.config', 'claude', 'projects');
  try {
    const ino = fs.statSync(xdg).ino;
    const existing = inodes.get(ino);
    if (existing) existing.settingsDirs.push(path.dirname(xdg));
    else {
      const found = { dir: xdg, settingsDirs: [path.dirname(xdg)] };
      inodes.set(ino, found);
      results.push(found);
    }
  } catch {}
  return results;
}

function discoverCodexHomes() {
  if (process.env.CCXRAY_IMPORT_CODEX_HOMES !== undefined) {
    return configuredImportRoots(process.env.CCXRAY_IMPORT_CODEX_HOMES, 'CCXRAY_IMPORT_CODEX_HOMES');
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

function oneMillionBase(model) {
  const value = typeof model === 'string' ? model.trim() : '';
  return /\[1m\]$/i.test(value) ? value.slice(0, -4) : null;
}

function oneMillionSettingsModels(importHome) {
  const models = new Set();
  const dirs = importHome?.settingsDirs || (importHome?.dir ? [path.dirname(importHome.dir)] : []);
  for (const dir of dirs) {
    try {
      const model = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))?.model;
      const base = oneMillionBase(model);
      if (base) models.add(base);
    } catch {}
  }
  return models;
}

function attachImported1mFacts(entries, costStateModels, settingsModels) {
  for (const entry of entries) {
    const base = typeof entry.model === 'string' ? entry.model.replace(/\[1m\]$/i, '') : '';
    // Reuse the #211 capability gate. A transcript/settings declaration on a
    // model that cannot serve 1M is retained nowhere as a window claim.
    if (!config.modelSupports1M(base)) continue;
    if (costStateModels.has(base)) entry.imported1mCostState = true;
    if (settingsModels.has(base)) entry.imported1mSettings = true;
  }
}

async function parseSessionFile(filePath, projectSlug, opts = {}) {
  const sessionId = path.basename(filePath, '.jsonl');
  let lastUserText = null;
  let cwd = null;
  // #500: tool_result blocks from the most recent user line, carried to next assistant
  let pendingToolResults = [];
  // #428: aggregate by message.id — Claude Code writes multiple assistant lines
  // per API response (one per content block), each with a different timestamp.
  // Key = msg.id; value = entry object. Last-seen line wins (richest usage).
  // Lines without msg.id pass through keyed by their timestamp-derived id.
  const byResponseId = new Map();
  const costStateModels = new Set();
  const settingsModels = opts.settingsModels || new Set();

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.cwd && !cwd) cwd = obj.cwd;

    // `cost-state` arrives late and is often after every assistant record, so
    // collect its positive declaration across the complete transcript then
    // attach it to imported turns only after the stream ends. A bare key is
    // deliberately neither evidence nor a denial.
    if (obj.type === 'cost-state' && obj.modelUsage && typeof obj.modelUsage === 'object') {
      for (const key of Object.keys(obj.modelUsage)) {
        const base = oneMillionBase(key);
        if (base) costStateModels.add(base);
      }
    }

    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (typeof content === 'string') {
        lastUserText = content.slice(0, 120);
        pendingToolResults = [];
      } else if (Array.isArray(content)) {
        const textBlock = content.find(b => b.type === 'text');
        if (textBlock) lastUserText = (textBlock.text || '').slice(0, 120);
        // #500: extract tool_result blocks from user content
        pendingToolResults = [];
        for (const b of content) {
          if (b?.type === 'tool_result') {
            pendingToolResults.push({
              callId: b.tool_use_id || null,
              toolFail: 'is_error' in b ? (b.is_error === true) : undefined,
              eligible: true,
            });
          }
        }
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
    // #384 did this for Codex, whose transcript declares model_context_window.
    // Claude Code's transcript declares nothing and never records the
    // anthropic-beta header, so the only evidence here is the observation:
    // a turn carrying more than the default window proves a bigger one. Leaving
    // maxContext unset instead made every reader fall back to 200K, which is how
    // a 1M session renders as phantom context pressure.
    const contextWindow = config.inferMaxContext(model, null, usage);
    const tokens = buildTokens(usage, contextWindow);
    const receivedAt = new Date(obj.timestamp).getTime();

    // #500: extract tool_use call ids from assistant content
    const turnToolCallIds = {};
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id) {
          turnToolCallIds[b.id] = b.name || null;
        }
      }
    }

    const responseId = msg.id || null;
    const dedupKey = responseId || id;
    const prev = byResponseId.get(dedupKey);

    // #500: merge tool evidence across duplicate assistant lines (same msg.id)
    const mergedToolCallIds = prev ? { ...prev.turnToolCallIds, ...turnToolCallIds } : turnToolCallIds;
    const mergedToolResults = prev ? prev.turnToolResults : pendingToolResults;

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
      turnToolCallIds: mergedToolCallIds,
      turnToolResults: mergedToolResults,
      tokens,
      cost: { cost: costResult.cost, confidence: costResult.confidence },
      model,
      maxContext: contextWindow,
      sessionId,
      title: prev ? prev.title : (lastUserText || '(imported)'),
      stopReason: msg.stop_reason || prev?.stopReason || null,
      imported: true,
      importSource: 'claude-code',
      sessionInferred: false,
      provider: 'anthropic',
      cwd: obj.cwd || cwd || slugToProject(projectSlug),
      contextUsageKnown: helpers.hasContextUsage(usage),
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    };
    byResponseId.set(dedupKey, entry);
    pendingToolResults = [];
  }
  const entries = [...byResponseId.values()];
  attachImported1mFacts(entries, costStateModels, settingsModels);
  return entries;
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
  // #500: accumulate tool calls/results between token_count boundaries.
  // Results carry to the NEXT entry (matching proxy convention: turnToolResults
  // = what was fed INTO this request, i.e. results from the previous turn).
  let pendingCalls = {};
  let pendingResults = [];
  let prevResults = [];
  let pendingCompacted = false;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // Codex emits this marker without a token_count payload. Keep it latched
    // across zero-token boundaries: the fact belongs to the next entry that
    // actually reaches the index, not to an entry that will be skipped.
    if (obj.type === 'compacted') {
      pendingCompacted = true;
      continue;
    }
    const payload = obj.payload;
    if (!payload) continue;

    if (payload.cwd && !cwd) cwd = payload.cwd;
    if (payload.model) lastModel = payload.model;
    if (obj.type === 'session_meta' && typeof payload.session_id === 'string') sessionId = payload.session_id;

    // #500: tool call lines (response side)
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id || payload.id;
      if (callId) {
        const rawName = payload.name || payload.function?.name || payload.tool_name;
        pendingCalls[callId] = rawName
          ? (helpers.OPENAI_PROCESS_TOOLS.has(rawName) ? 'Bash' : (helpers.OPENAI_TOOL_ALIASES[rawName] || rawName))
          : null;
      }
      continue;
    }

    // #500: tool result lines (request side)
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const decoded = helpers.decodeCodexToolOutput(payload.output);
      const isAsyncStart = decoded === helpers.CODEX_ASYNC_START;
      pendingResults.push({
        callId: payload.call_id || null,
        eligible: !isAsyncStart,
        toolFail: isAsyncStart ? undefined : decoded,
      });
      continue;
    }

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
      turnToolCallIds: pendingCalls,
      turnToolResults: prevResults,
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
      ...(pendingCompacted ? { compacted: true } : {}),
      provider: 'openai',
      cwd,
      contextUsageKnown: true,
      usage,
    });
    pendingCalls = {};
    prevResults = pendingResults;
    pendingResults = [];
    pendingCompacted = false;
  }
  return entries;
}

const _pendingIndexWrites = [];

function pushImportedEntry(entry, existingIds, opts = {}) {
  if (existingIds.has(entry.id)) return false;
  existingIds.add(entry.id);
  // Write to index.ndjson + session index only — skip store.entries and SSE
  // broadcast to avoid 158K memory spike + client SSE flood. Imported sessions
  // are cold; their entries load on-demand via /_api/session/:sid/entries.
  const indexLine = buildIndexLine(entry);
  // Log-first: only update session index after index.ndjson write succeeds (#309)
  let pending = config.storage.appendIndex(indexLine + '\n').then(() => {
    sessionIdx.updateFromEntry(entry);
  });
  // The full best-effort importer has historically continued past a bad file.
  // A targeted Sidebar repair has a stronger contract: claiming success would
  // permanently mark this exact transcript fingerprint as repaired, so its
  // append failure must reach the worker and leave the link visibly missing.
  if (!opts.strict) pending = pending.catch(e => console.error('Write import index failed:', e.message));
  _pendingIndexWrites.push(pending);
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

  for (const importHome of homes) {
    const { dir } = importHome;
    const settingsModels = oneMillionSettingsModels(importHome);
    let projectDirs;
    try { projectDirs = await fs.promises.readdir(dir); } catch { continue; }

    for (const slug of projectDirs) {
      const projectPath = path.join(dir, slug);
      let stat;
      try { stat = await fs.promises.stat(projectPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const jsonlFiles = await collectJsonlFiles(projectPath);
      for (const filePath of jsonlFiles) {
        const entries = await parseSessionFile(filePath, slug, { settingsModels });
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

function pathInside(file, roots) {
  let resolvedFile;
  try { resolvedFile = fs.realpathSync(file); } catch { return null; }
  for (const root of roots) {
    let resolvedRoot;
    try { resolvedRoot = fs.realpathSync(root.dir); } catch { continue; }
    if (resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      return resolvedFile;
    }
  }
  return null;
}

async function scanAndImportTranscript(target = {}) {
  if (process.env.CCXRAY_IMPORT_DISABLE === '1') return { imported: 0, skipped: 0 };
  const provider = String(target.provider || '').toLowerCase();
  if (provider !== 'claude' && provider !== 'codex') throw new Error('unsupported transcript provider');
  if (!target.file || !target.sessionId || !target.cwd) throw new Error('incomplete transcript target');

  const roots = provider === 'claude' ? discoverHomes() : discoverCodexHomes();
  const file = pathInside(target.file, roots);
  if (!file || path.extname(file) !== '.jsonl') throw new Error('transcript is outside the provider import roots');
  if (provider === 'claude' && path.basename(file, '.jsonl') !== target.sessionId) {
    throw new Error('transcript session identity conflict');
  }

  const existingIds = new Set();
  const ownersById = new Map();
  const rememberOwner = entry => {
    if (!entry?.id) return;
    existingIds.add(entry.id);
    if (!ownersById.has(entry.id)) ownersById.set(entry.id, new Set());
    if (entry.sessionId) ownersById.get(entry.id).add(entry.sessionId);
  };
  store.entries.forEach(rememberOwner);
  const metas = [];
  let exactEvidence = null;
  for await (const line of config.storage.readIndexLines()) {
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }
    rememberOwner(meta);
    metas.push(meta);
    if (meta?.sessionId !== target.sessionId) continue;
    if (meta.cwd && path.resolve(meta.cwd) !== path.resolve(target.cwd)) {
      throw new Error('indexed session cwd identity conflict');
    }
    const metaAt = Number(meta.receivedAt) || 0;
    const evidenceAt = Number(exactEvidence?.receivedAt) || 0;
    if (!exactEvidence || metaAt > evidenceAt
      || (metaAt === evidenceAt && exactEvidence.imported === true && meta.imported !== true)) {
      exactEvidence = meta;
    }
  }
  sessionIdx.seedDedupFromMetas(metas);

  const importHome = provider === 'claude'
    ? roots.find(root => pathInside(file, [root]) === file)
    : null;
  const entries = provider === 'claude'
    ? await parseSessionFile(file, path.basename(path.dirname(file)), { settingsModels: oneMillionSettingsModels(importHome) })
    : await parseCodexSessionFile(file);
  if (entries.some(entry => entry.sessionId !== target.sessionId)) {
    throw new Error('transcript session identity conflict');
  }
  const targetCwd = path.resolve(target.cwd);
  if (entries.some(entry => entry.cwd && path.resolve(entry.cwd) !== targetCwd)) {
    throw new Error('transcript cwd identity conflict');
  }

  let imported = 0;
  let skipped = 0;
  const appendedEntries = [];
  for (const entry of entries) {
    if (existingIds.has(entry.id)) {
      const owners = ownersById.get(entry.id) || new Set();
      if (!owners.has(entry.sessionId)) throw new Error('transcript entry id identity collision');
      skipped += 1;
      continue;
    }
    if (pushImportedEntry(entry, existingIds, { strict: true })) {
      rememberOwner(entry);
      appendedEntries.push(entry);
      imported += 1;
    } else {
      skipped += 1;
    }
  }
  if (imported > 0) {
    try {
      await Promise.all(_pendingIndexWrites);
    } finally {
      _pendingIndexWrites.length = 0;
    }
    await sessionIdx.flush();
    broadcastRaw({ _type: 'sessions_updated' });
    console.log(`[importer] Imported ${imported} turns from targeted ${provider} transcript (${skipped} duplicates skipped)`);
  }
  // Cache only evidence that was already in the exact index, or whose strict
  // append above completed. A parsed-but-skipped entry is not index evidence;
  // in particular timestamp-derived ids can collide across sessions.
  for (const entry of appendedEntries) {
    const entryAt = Number(entry.receivedAt) || 0;
    const evidenceAt = Number(exactEvidence?.receivedAt) || 0;
    if (!exactEvidence || entryAt > evidenceAt
      || (entryAt === evidenceAt && exactEvidence.imported === true && entry.imported !== true)) {
      exactEvidence = entry;
    }
  }

  // A targeted repair has already paid the cost of reading the complete index
  // and transcript. Preserve a small, display-oriented history alongside the
  // newest exact evidence so a bounded Sidebar refresh can recover the context
  // trend without rescanning the global index. Keep the payload deliberately
  // free of request/response bodies: this state is a cache for the Sidebar,
  // not a second transcript store.
  const targetEntries = metas.concat(appendedEntries)
    .filter(entry => entry?.sessionId === target.sessionId)
    .filter(entry => !entry.cwd || path.resolve(entry.cwd) === targetCwd)
    .sort((left, right) => (
      Number(left.receivedAt || 0) - Number(right.receivedAt || 0)
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
  const contextSamples = targetEntries.slice(-64).map(entry => {
    const sample = {};
    for (const key of [
      'id', 'sessionId', 'responseId', 'receivedAt', 'cwd', 'agentId',
      'agentKey', 'agentLabel', 'isSubagent', 'parentSessionId', 'model',
      'maxContext', 'beta1m', 'imported1mCostState', 'imported1mSettings',
      'ctxBeta', 'contextUsageKnown', 'ctxUsed',
      'usage', 'cost', 'imported', 'importSource', 'isCompacted', 'compacted',
      'turnToolFail', 'toolFail', 'title', 'status', 'provider', 'agent',
      'convId', 'responseMetadata',
    ]) {
      if (entry[key] !== undefined) sample[key] = entry[key];
    }
    return sample;
  });
  return { imported, skipped, exactEvidence, contextSamples };
}

module.exports = {
  relativeRootComplaints,
  renderConfigWarning,
  _resetRootWarnings,
  scanAndImport,
  scanAndImportTranscript,
  parseSessionFile,
  parseCodexSessionFile,
  discoverHomes,
  discoverCodexHomes,
  slugToProject,
  tsToId,
};
