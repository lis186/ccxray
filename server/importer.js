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
// S-1: reuse the proxy path's agentKey → label table instead of duplicating it.
const { KNOWN_AGENTS } = require('./system-prompt');

const DEFAULT_CONTEXT_WINDOW = 200000;
const CODEX_CONTEXT_WINDOW = 400000;

// #397: calculateCostSimple lives in default-rates.js — the single source of
// truth for offline model pricing shared with cost-worker.js.
const { calculateCostSimple } = require('./default-rates');

function tsToId(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;
  // S-2/A-2.3: keep all 3 ms digits (drop only the trailing `Z`), not 2 —
  // the 10ms-precision id made same-millisecond collisions common once
  // subagent turns (S-1) interleave with the main session's own turns.
  return d.toISOString().replace(/[:.]/g, '-').slice(0, -1);
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

// S-1: Claude Code writes Task-tool subagent transcripts under
// `<projectDir>/<sid>/subagents/agent-<agentId>.jsonl` (+ a sidecar
// `.meta.json`), a second directory level `collectJsonlFiles` never visits.
// Kept separate (A-1.3) rather than folded into `collectJsonlFiles` so that
// function's return shape stays unchanged for its existing callers.
async function collectSubagentFiles(projectDir) {
  const results = [];
  let sids;
  try { sids = await fs.promises.readdir(projectDir); } catch { return results; }
  for (const sid of sids) {
    const subagentsDir = path.join(projectDir, sid, 'subagents');
    let files;
    try { files = await fs.promises.readdir(subagentsDir); } catch { continue; }
    for (const file of files) {
      if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
      results.push({
        file: path.join(subagentsDir, file),
        metaPath: path.join(subagentsDir, `${file.slice(0, -'.jsonl'.length)}.meta.json`),
        sid,
      });
    }
  }
  return results;
}

// Missing/unreadable meta → still import, just with no agentKey/toolUseId (A-1.1).
function readSubagentMeta(metaPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return {
      agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
    };
  } catch {
    return { agentType: null, toolUseId: null };
  }
}

// agentLabel is only set when the proxy path would assign the SAME label for
// this key (A-1.1) — otherwise it stays unset rather than inventing a label
// the live classifier never uses.
function labelForAgentKey(key) {
  if (!key) return null;
  const known = KNOWN_AGENTS.find(a => a.key === key);
  return known ? known.label : null;
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
  // S-1: a subagent transcript's filename is `agent-<agentId>`, not the parent
  // session id — derive sessionId from the transcript line's own `sessionId`
  // instead (verified present on every line).
  let sessionId = opts.subagent ? null : path.basename(filePath, '.jsonl');
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
  // S-6/A-6.2: a `system`/`turn_duration` line arrives AFTER the assistant line
  // it measures, keyed by nothing but proximity — track the dedup key of the
  // last assistant entry written so the duration can be back-filled onto it.
  let lastDedupKey = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (opts.subagent && typeof obj.sessionId === 'string' && obj.sessionId) sessionId = obj.sessionId;

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

    // S-6/A-6.2: attach to the last assistant entry parsed before this line in
    // the same file, only if that entry has no value yet (a duplicate
    // turn_duration line, or one whose target was evicted, must not overwrite).
    if (obj.type === 'system' && obj.subtype === 'turn_duration') {
      const prevEntry = lastDedupKey ? byResponseId.get(lastDedupKey) : null;
      if (prevEntry && prevEntry.turnDurationMs == null) prevEntry.turnDurationMs = obj.durationMs || null;
      continue;
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

    // S-6/A-6.2: perTurnEffort (per-turn override) wins over the session-level
    // effort declaration when both are present and non-empty.
    const effort = (typeof obj.perTurnEffort === 'string' && obj.perTurnEffort)
      || (typeof obj.effort === 'string' && obj.effort)
      || null;
    const thinkingTokens = Number.isFinite(usage.output_tokens_details?.thinking_tokens)
      ? usage.output_tokens_details.thinking_tokens
      : null;

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
      effort,
      thinkingTokens,
      // S-6/A-6.2: back-filled by a later system/turn_duration line (above);
      // preserve it across a duplicate assistant line for the same msg.id.
      turnDurationMs: prev?.turnDurationMs ?? null,
      imported: true,
      importSource: 'claude-code',
      sessionInferred: false,
      provider: 'anthropic',
      // S-1: a subagent transcript's own cwd (rare) wins, then the parent
      // session's cwd, before falling back to the slug-derived approximation.
      cwd: obj.cwd || cwd || opts.parentCwd || slugToProject(projectSlug),
      contextUsageKnown: helpers.hasContextUsage(usage),
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        // S-4: keep the 5m/1h ephemeral breakdown so a later cost recompute
        // (calculateCostSimple) prices the split instead of the flat counter.
        ...(usage.cache_creation && typeof usage.cache_creation === 'object' ? {
          cache_creation: {
            ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens || 0,
            ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens || 0,
          },
        } : {}),
      },
      ...(opts.subagent ? {
        isSubagent: true,
        subagentId: obj.agentId || null,
        subagentToolUseId: opts.subagentToolUseId || null,
        agentKey: opts.agentKey || null,
        ...(opts.agentLabel ? { agentLabel: opts.agentLabel } : {}),
      } : {}),
    };
    byResponseId.set(dedupKey, entry);
    lastDedupKey = dedupKey;
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
  // S-6/A-6.3: latest turn_context effort applies to every subsequent entry.
  let lastEffort = null;

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
    if (obj.type === 'turn_context' && typeof payload.effort === 'string' && payload.effort) lastEffort = payload.effort;

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
      effort: lastEffort || null,
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

// S-2/A-2.1/A-2.2: the dedup context keeps two things apart that look similar
// but answer different questions. `idsBySession`/`importedResponseIds` are the
// PRIOR state (what a previous scan already wrote) — frozen once the scan
// starts pushing entries, via `seedDedupCtx`. `existingIds` is the id
// namespace as it grows THROUGH this scan, used only to detect a millisecond
// collision so it can be suffixed (A-2.2). Conflating the two would make a
// same-millisecond sibling processed later in the same scan (e.g. a main turn
// and its subagent, S-1) look like an already-imported copy of the first one
// the moment the first one is folded in.
function createDedupCtx() {
  return {
    existingIds: new Set(),
    importedResponseIds: new Set(),
    idsBySession: new Map(),
    responseIdById: new Map(),
  };
}

// Seeds the frozen "prior state" half of the context from an existing record
// (a live store.entries entry or an index.ndjson line). Only ever called
// before a scan starts pushing new entries — see createDedupCtx.
function seedDedupCtx(ctx, rec) {
  if (!rec || !rec.id) return;
  ctx.existingIds.add(rec.id);
  if (rec.sessionId) {
    let ids = ctx.idsBySession.get(rec.sessionId);
    if (!ids) { ids = new Set(); ctx.idsBySession.set(rec.sessionId, ids); }
    ids.add(rec.id);
  }
  // A-2.1: a proxy (non-imported) line sharing a responseId must never
  // suppress the imported copy — ADR 0012's read-time merge already
  // reconciles those at read time.
  if (rec.responseId && rec.imported === true) ctx.importedResponseIds.add(rec.responseId);
  if (rec.responseId) ctx.responseIdById.set(rec.id, rec.responseId);
}

// A-2.1: an imported entry is already present when a PRIOR import already
// logged this exact logical turn. Claude turns carry `responseId`
// (Anthropic's own message id — stable across the id-format change and any
// A-2.2 suffix below). Otherwise the same session holding the entry's new
// full-ms id or legacy 10ms id is the same turn, unless that line carries a
// different responseId: rows imported before responseId existed (#333) have
// none, and Codex turns never do.
function isAlreadyImported(entry, ctx) {
  if (entry.responseId && ctx.importedResponseIds.has(entry.responseId)) return true;
  const sessionIds = ctx.idsBySession.get(entry.sessionId);
  if (!sessionIds) return false;
  const sameTurn = id => {
    const rid = ctx.responseIdById.get(id);
    return !rid || !entry.responseId || rid === entry.responseId;
  };
  for (const id of [entry.id, entry.id.slice(0, -1)]) {
    if (sessionIds.has(id) && sameTurn(id)) return true;
  }
  if (entry.responseId) return false;
  // A prior scan may have written this turn under an A-2.2 suffix because
  // another session held the bare id; without this, every rescan re-imports it.
  const prefix = `${entry.id}-`;
  for (const id of sessionIds) {
    if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) return true;
  }
  return false;
}

function pushImportedEntry(entry, ctx, opts = {}) {
  if (isAlreadyImported(entry, ctx)) return false;

  let id = entry.id;
  if (ctx.existingIds.has(id)) {
    // A-2.2: a genuinely different turn sharing this millisecond gets a
    // deterministic suffix — never silently dropped, and (in
    // scanAndImportTranscript) never thrown as a collision error either.
    let suffixed = null;
    for (let i = 1; i <= 99; i++) {
      const candidate = `${entry.id}-${i}`;
      if (!ctx.existingIds.has(candidate)) { suffixed = candidate; break; }
    }
    if (!suffixed) return false; // 99 same-millisecond collisions exhausted
    id = suffixed;
  }
  entry.id = id;
  ctx.existingIds.add(id);
  // Deliberately NOT folded into idsBySession/importedResponseIds — see
  // createDedupCtx: those stay frozen to what existed before this scan.

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
  const ctx = createDedupCtx();
  store.entries.forEach(e => seedDedupCtx(ctx, e));
  try {
    // #345: stream — the index can exceed Node's ~512MB single-string limit,
    // where readIndex() throws ERR_STRING_TOO_LONG and the import dedup breaks
    // (re-importing everything, unbounded index growth + doubled counts). One
    // parse per line seeds the dedup context and collects metas for #333.
    const metas = [];
    for await (const line of config.storage.readIndexLines()) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      seedDedupCtx(ctx, m);
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
      // S-1: remember each parent session's cwd so a subagent transcript that
      // lacks its own `obj.cwd` can fall back to it (A-1.1).
      const parentCwdBySid = new Map();
      for (const filePath of jsonlFiles) {
        const entries = await parseSessionFile(filePath, slug, { settingsModels });
        for (const entry of entries) {
          if (entry.cwd && !parentCwdBySid.has(entry.sessionId)) parentCwdBySid.set(entry.sessionId, entry.cwd);
          if (pushImportedEntry(entry, ctx)) imported++; else skipped++;
        }
      }

      const subagentFiles = await collectSubagentFiles(projectPath);
      for (const { file, metaPath, sid } of subagentFiles) {
        const meta = readSubagentMeta(metaPath);
        const entries = await parseSessionFile(file, slug, {
          settingsModels,
          subagent: true,
          agentKey: meta.agentType,
          agentLabel: labelForAgentKey(meta.agentType),
          subagentToolUseId: meta.toolUseId,
          parentCwd: parentCwdBySid.get(sid) || null,
        });
        for (const entry of entries) {
          // The parent is the directory the file lives under; a line claiming
          // another session is not attributed there (targeted import throws).
          if (entry.sessionId !== sid) { skipped++; continue; }
          if (pushImportedEntry(entry, ctx)) imported++; else skipped++;
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
        if (pushImportedEntry(entry, ctx)) imported++; else skipped++;
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

  const ctx = createDedupCtx();
  store.entries.forEach(e => seedDedupCtx(ctx, e));
  const metas = [];
  let exactEvidence = null;
  for await (const line of config.storage.readIndexLines()) {
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }
    seedDedupCtx(ctx, meta);
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
  const settingsModels = provider === 'claude' ? oneMillionSettingsModels(importHome) : null;
  let entries = provider === 'claude'
    ? await parseSessionFile(file, path.basename(path.dirname(file)), { settingsModels })
    : await parseCodexSessionFile(file);

  // S-1/A-1.2: a targeted import of a parent transcript also imports its
  // Task-tool subagent transcripts (`<sid>/subagents/agent-*.jsonl`), so a
  // targeted repair doesn't miss the subagent turns that make up a large
  // share of a session's real cost. Each subagent file must independently
  // pass pathInside; a parsed subagent entry that fails the sessionId/cwd
  // identity checks below is rejected exactly like a bad parent transcript —
  // no separate relaxation for subagents (A-1.2).
  if (provider === 'claude') {
    const parentCwd = entries.find(entry => entry.cwd)?.cwd || null;
    const projectDir = path.dirname(file);
    const subagentFiles = await collectSubagentFiles(projectDir);
    for (const { file: subFile, metaPath, sid } of subagentFiles) {
      if (sid !== target.sessionId) continue;
      const resolvedSub = pathInside(subFile, roots);
      if (!resolvedSub || path.extname(resolvedSub) !== '.jsonl') {
        throw new Error('transcript is outside the provider import roots');
      }
      const meta = readSubagentMeta(metaPath);
      const subEntries = await parseSessionFile(resolvedSub, path.basename(projectDir), {
        settingsModels,
        subagent: true,
        agentKey: meta.agentType,
        agentLabel: labelForAgentKey(meta.agentType),
        subagentToolUseId: meta.toolUseId,
        parentCwd,
      });
      entries = entries.concat(subEntries);
    }
  }

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
    // A-2.1/A-2.2: an id collision that IS this same logical turn (same
    // responseId already imported, or — for Codex's no-responseId turns —
    // the same session already holding this id or its legacy id) counts as
    // skipped. A collision with a genuinely different turn gets a
    // deterministic suffix instead of the old `transcript entry id identity
    // collision` throw — see pushImportedEntry.
    if (pushImportedEntry(entry, ctx, { strict: true })) {
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
  // A late cost-state can add a positive fact to every parsed assistant turn
  // after those ids were already imported. Those turns are rightly skipped (no
  // duplicate index line), but the repair has just parsed fresher provenance,
  // so OR it into the returned sample view by the already identity-checked id.
  // This remains cache-only: old index rows are not rewritten here.
  const parsedById = new Map(entries.map(entry => [entry.id, entry]));
  const targetEntries = metas.concat(appendedEntries)
    .filter(entry => entry?.sessionId === target.sessionId)
    .filter(entry => !entry.cwd || path.resolve(entry.cwd) === targetCwd)
    .map(entry => {
      const parsed = parsedById.get(entry.id);
      if (parsed?.imported1mCostState !== true && parsed?.imported1mSettings !== true) return entry;
      return {
        ...entry,
        ...(parsed.imported1mCostState === true ? { imported1mCostState: true } : {}),
        ...(parsed.imported1mSettings === true ? { imported1mSettings: true } : {}),
      };
    })
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
  collectSubagentFiles,
  discoverHomes,
  discoverCodexHomes,
  slugToProject,
  tsToId,
};
