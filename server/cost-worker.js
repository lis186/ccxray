'use strict';

// Worker process for JSONL cost parsing — runs in a child process
// to avoid blocking the main event loop during heavy I/O + JSON.parse.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

function calculateCostSimple(usage, model) {
  // Per-token rates (USD). Grok rows mirror server/pricing.js DEFAULT_PRICING / MTok.
  const rates = {
    'claude-sonnet-4-5-20250514': { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6 },
    'claude-opus-4-5-20250514': { input: 15e-6, output: 75e-6, cache_read: 1.5e-6, cache_create: 18.75e-6 },
    'claude-haiku-3-5-20241022': { input: 0.8e-6, output: 4e-6, cache_read: 0.08e-6, cache_create: 1e-6 },
    'gpt-5.5': { input: 2e-6, output: 10e-6, cache_read: 1e-6, cache_create: 0 },
    'gpt-5': { input: 2e-6, output: 10e-6, cache_read: 1e-6, cache_create: 0 },
    'gpt-4o': { input: 2.5e-6, output: 10e-6, cache_read: 1.25e-6, cache_create: 0 },
    'o3': { input: 2e-6, output: 8e-6, cache_read: 0.5e-6, cache_create: 0 },
    'o4-mini': { input: 1.1e-6, output: 4.4e-6, cache_read: 0.55e-6, cache_create: 0 },
    'grok-4.5': { input: 2e-6, output: 6e-6, cache_read: 0.5e-6, cache_create: 0 },
    'grok-4.3': { input: 1.25e-6, output: 2.5e-6, cache_read: 0.2e-6, cache_create: 0 },
    'grok-build': { input: 1e-6, output: 2e-6, cache_read: 0.2e-6, cache_create: 0 },
  };
  let r = null;
  // Longest key first so grok-4.5-build → grok-4.5 (not grok-build).
  // Prefix strip `-202…` keeps the historical Claude dated-id match.
  const keys = Object.keys(rates).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!model) break;
    const prefix = k.split('-202')[0];
    if (model === k || model.startsWith(k) || model.startsWith(prefix)) { r = rates[k]; break; }
  }
  if (!r) r = { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6 };
  return (usage.input_tokens || 0) * r.input
    + (usage.output_tokens || 0) * r.output
    + (usage.cache_read_input_tokens || 0) * r.cache_read
    + (usage.cache_creation_input_tokens || 0) * r.cache_create;
}

async function collectJsonlFiles(dir, results = []) {
  let items;
  try { items = await fs.promises.readdir(dir); } catch { return results; }
  for (const item of items) {
    const fullPath = path.join(dir, item);
    let stat;
    try { stat = await fs.promises.stat(fullPath); } catch { continue; }
    if (stat.isDirectory()) await collectJsonlFiles(fullPath, results);
    else if (item.endsWith('.jsonl')) results.push(fullPath);
  }
  return results;
}

// ponytail: shared home discovery for both Claude and Codex
function discoverHomes(prefix) {
  const home = os.homedir();
  const results = [];
  const inodes = new Set();
  let items;
  try { items = fs.readdirSync(home); } catch { return results; }
  for (const d of items) {
    if (!d.startsWith(prefix) || d.includes('.bak')) continue;
    const isNamed = d.startsWith(prefix + '-');
    if (d !== prefix && !isNamed) continue;
    const subdir = prefix === '.codex'
      ? path.join(home, d, 'sessions')
      : path.join(home, d, 'projects');
    try {
      const ino = fs.statSync(subdir).ino;
      if (inodes.has(ino)) continue;
      inodes.add(ino);
      results.push({ dir: subdir, alias: isNamed ? d.slice(prefix.length + 1) : 'default' });
    } catch {}
  }
  results._inodes = inodes;
  return results;
}

function processFile(filePath, accountId) {
  return new Promise((resolve) => {
    const localEntries = [];
    let rl;
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    } catch { resolve(localEntries); return; }

    rl.on('line', (line) => {
      if (!line.includes('"usage"')) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const timestamp = obj.timestamp;
      const msg = obj.message;
      if (!timestamp || !msg || !msg.usage) return;
      const usage = msg.usage;
      const model = msg.model || obj.model || 'unknown';
      const messageId = msg.id || null;
      const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      if (totalTokens === 0) return;
      const costUSD = calculateCostSimple(usage, model);
      const sessionId = path.basename(filePath, '.jsonl');
      localEntries.push({ timestamp: new Date(timestamp).getTime(), usage, costUSD, model, sessionId, messageId, accountId });
    });
    rl.on('close', () => resolve(localEntries));
    rl.on('error', () => resolve(localEntries));
  });
}

function processCodexFile(filePath, accountId) {
  return new Promise((resolve) => {
    const localEntries = [];
    let rl;
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    } catch { resolve(localEntries); return; }

    let lastModel = 'unknown';
    const sessionId = path.basename(filePath, '.jsonl');

    rl.on('line', (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const payload = obj.payload;
      if (!payload) return;

      if (payload.model) lastModel = payload.model;

      if (payload.type !== 'token_count') return;
      const tu = payload.info && payload.info.last_token_usage;
      if (!tu) return;

      const cached = tu.cached_input_tokens || 0;
      const usage = {
        input_tokens: Math.max(0, (tu.input_tokens || 0) - cached),
        output_tokens: (tu.output_tokens || 0) + (tu.reasoning_output_tokens || 0),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      };
      const totalTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens;
      if (totalTokens === 0) return;

      if (!obj.timestamp) return;
      const costUSD = calculateCostSimple(usage, lastModel);
      const tsMs = new Date(obj.timestamp).getTime();
      const messageId = `${tsMs}::${sessionId}`;
      localEntries.push({ timestamp: tsMs, usage, costUSD, model: lastModel, sessionId, messageId, accountId });
    });
    rl.on('close', () => resolve(localEntries));
    rl.on('error', () => resolve(localEntries));
  });
}

async function scanHomes(homes, processFn, seen, entries) {
  for (const { dir, alias } of homes) {
    const provider = processFn === processCodexFile ? 'codex' : 'claude';
    const accountId = `${provider}-${alias}`;
    try { await fs.promises.access(dir); } catch { continue; }
    const jsonlFiles = await collectJsonlFiles(dir);

    const BATCH_SIZE = 20;
    for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
      const batch = jsonlFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(f => processFn(f, accountId)));
      for (const localEntries of results) {
        for (const e of localEntries) {
          if (e.messageId && seen.has(e.messageId)) continue;
          if (e.messageId) seen.add(e.messageId);
          entries.push(e);
        }
      }
    }
  }
}

// Grok CLI does not persist per-turn usage in ~/.grok/sessions (events are
// phase markers only). The Usage tab therefore reads proxy index lines for
// agent=grok — the same cost already computed at capture time.
function entryCostUSD(obj) {
  if (obj.cost == null) return null;
  if (typeof obj.cost === 'number' && Number.isFinite(obj.cost)) return obj.cost;
  if (typeof obj.cost === 'object' && typeof obj.cost.cost === 'number' && Number.isFinite(obj.cost.cost)) {
    return obj.cost.cost;
  }
  return null;
}

function entryTimestampMs(obj) {
  if (typeof obj.receivedAt === 'number' && Number.isFinite(obj.receivedAt)) return obj.receivedAt;
  if (typeof obj.id === 'string' && obj.id.length >= 19) {
    // id form: 2026-07-19T08-55-50-786
    const iso = obj.id.slice(0, 10) + 'T' + obj.id.slice(11, 19).replace(/-/g, ':') + 'Z';
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function processGrokIndexEntry(obj, accountId = 'grok-default') {
  if (!obj || obj.agent !== 'grok') return null;
  const usage = obj.usage;
  if (!usage || typeof usage !== 'object') return null;
  const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  if (totalTokens === 0) return null;
  const timestamp = entryTimestampMs(obj);
  if (timestamp == null) return null;
  const model = obj.model || 'unknown';
  let costUSD = entryCostUSD(obj);
  if (costUSD == null) costUSD = calculateCostSimple(usage, model);
  const messageId = obj.id ? `grok::${obj.id}` : null;
  return {
    timestamp,
    usage,
    costUSD,
    model,
    sessionId: obj.sessionId || null,
    messageId,
    accountId,
  };
}

function processGrokIndexFile(filePath, accountId = 'grok-default') {
  return new Promise((resolve) => {
    const localEntries = [];
    let rl;
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    } catch { resolve(localEntries); return; }

    rl.on('line', (line) => {
      if (!line || !line.includes('"agent":"grok"') && !line.includes('"agent": "grok"')) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const e = processGrokIndexEntry(obj, accountId);
      if (e) localEntries.push(e);
    });
    rl.on('close', () => resolve(localEntries));
    rl.on('error', () => resolve(localEntries));
  });
}

async function scanGrokFromCcxrayIndex(seen, entries, env = process.env) {
  // Prefer LOGS_DIR / CCXRAY_HOME so smoke + multi-home tests stay isolated.
  // Inline path resolution avoids requiring the full server graph in the worker.
  const home = env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
  const logsDir = env.LOGS_DIR || path.join(home, 'logs');
  const indexPath = path.join(logsDir, 'index.ndjson');
  try { await fs.promises.access(indexPath); } catch { return; }
  const local = await processGrokIndexFile(indexPath, 'grok-default');
  for (const e of local) {
    if (e.messageId && seen.has(e.messageId)) continue;
    if (e.messageId) seen.add(e.messageId);
    entries.push(e);
  }
}

async function run() {
  const seen = new Set();
  const entries = [];

  const claudeHomes = discoverHomes('.claude');
  // ponytail: XDG path for Linux — discoverHomes only scans $HOME/.claude*
  const xdgClaude = path.join(os.homedir(), '.config', 'claude', 'projects');
  try {
    const xdgIno = fs.statSync(xdgClaude).ino;
    if (!claudeHomes._inodes.has(xdgIno)) claudeHomes.push({ dir: xdgClaude, alias: 'default' });
  } catch {}
  const codexHomes = discoverHomes('.codex');

  await scanHomes(claudeHomes, processFile, seen, entries);
  await scanHomes(codexHomes, processCodexFile, seen, entries);
  await scanGrokFromCcxrayIndex(seen, entries);

  entries.sort((a, b) => a.timestamp - b.timestamp);
  process.stdout.write(JSON.stringify(entries));
}

if (require.main === module) {
  run().catch(err => {
    process.stderr.write(err.message);
    process.exitCode = 1;
  });
} else {
  module.exports = {
    calculateCostSimple,
    processGrokIndexEntry,
    processGrokIndexFile,
    scanGrokFromCcxrayIndex,
  };
}
