'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const store = require('./store');
const config = require('./config');
const { broadcast } = require('./sse-broadcast');
const { buildIndexLine } = require('./entry');

const DEFAULT_CONTEXT_WINDOW = 200000;

const RATES = {
  'claude-sonnet-4-5': { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6 },
  'claude-opus-4': { input: 15e-6, output: 75e-6, cache_read: 1.5e-6, cache_create: 18.75e-6 },
  'claude-haiku-3-5': { input: 0.8e-6, output: 4e-6, cache_read: 0.08e-6, cache_create: 1e-6 },
  'claude-fable-5': { input: 5e-6, output: 25e-6, cache_read: 0.5e-6, cache_create: 6.25e-6 },
};

function calculateCostSimple(usage, model) {
  let r = null;
  for (const [k, v] of Object.entries(RATES)) {
    if (model && model.startsWith(k)) { r = v; break; }
  }
  if (!r) r = RATES['claude-sonnet-4-5'];
  return (usage.input_tokens || 0) * r.input
    + (usage.output_tokens || 0) * r.output
    + (usage.cache_read_input_tokens || 0) * r.cache_read
    + (usage.cache_creation_input_tokens || 0) * r.cache_create;
}

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

function buildTokens(usage) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const total = input + output + cacheRead + cacheCreate;
  const contextWindow = DEFAULT_CONTEXT_WINDOW;
  const contextPct = contextWindow > 0 ? Math.round(((input + cacheRead + cacheCreate) / contextWindow) * 100) : 0;
  return { input, output, cacheRead, cacheCreate, contextPct, contextWindow };
}

async function parseSessionFile(filePath, projectSlug) {
  const entries = [];
  const sessionId = path.basename(filePath, '.jsonl');
  let lastUserText = null;
  let cwd = null;

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
    const cost = calculateCostSimple(usage, model);
    const tokens = buildTokens(usage);
    const receivedAt = new Date(obj.timestamp).getTime();

    entries.push({
      id,
      ts: obj.timestamp,
      method: 'POST',
      url: '/v1/messages',
      req: null,
      res: null,
      _loaded: false,
      elapsed: null,
      status: 200,
      isSSE: false,
      receivedAt,
      tokens,
      cost: { cost },
      model,
      sessionId,
      title: lastUserText || '(imported)',
      stopReason: msg.stop_reason || null,
      imported: true,
      importSource: 'claude-code',
      provider: 'anthropic',
      cwd: obj.cwd || cwd || slugToProject(projectSlug),
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    });
  }
  return entries;
}

async function scanAndImport() {
  if (process.env.CCXRAY_IMPORT_DISABLE === '1') return { imported: 0, skipped: 0 };

  const homes = discoverHomes();
  let imported = 0;
  let skipped = 0;
  const existingIds = new Set(store.entries.map(e => e.id));

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
          if (existingIds.has(entry.id)) { skipped++; continue; }
          existingIds.add(entry.id);
          // INVARIANT: push + entryIndex.set must pair — see docs/decisions/0003-entry-index-map.md
          store.entries.push(entry);
          store.entryIndex.set(entry.id, entry);
          broadcast(entry);
          imported++;
        }
      }
    }
  }

  if (imported > 0) {
    store.trimEntries();
    console.log(`[importer] Imported ${imported} turns from local transcripts (${skipped} duplicates skipped)`);
  }
  return { imported, skipped };
}

module.exports = { scanAndImport, parseSessionFile, discoverHomes, slugToProject, tsToId };
