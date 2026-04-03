'use strict';

// Worker process for JSONL cost parsing — runs in a child process
// to avoid blocking the main event loop during heavy I/O + JSON.parse.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

function calculateCostSimple(usage, model) {
  // Simplified cost calc — doesn't need full pricing module
  // Rates per token (not per million)
  const rates = {
    'claude-sonnet-4-5-20250514': { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6 },
    'claude-opus-4-5-20250514': { input: 15e-6, output: 75e-6, cache_read: 1.5e-6, cache_create: 18.75e-6 },
    'claude-haiku-3-5-20241022': { input: 0.8e-6, output: 4e-6, cache_read: 0.08e-6, cache_create: 1e-6 },
  };
  // Find matching rate by prefix
  let r = null;
  for (const [k, v] of Object.entries(rates)) {
    if (model && model.startsWith(k.split('-202')[0])) { r = v; break; }
  }
  if (!r) r = { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6 }; // default sonnet
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

function processFile(filePath) {
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
      localEntries.push({ timestamp: new Date(timestamp).getTime(), usage, costUSD, model, sessionId, messageId });
    });
    rl.on('close', () => resolve(localEntries));
    rl.on('error', () => resolve(localEntries));
  });
}

async function run() {
  const homedir = os.homedir();
  const dirs = [
    path.join(homedir, '.claude', 'projects'),
    path.join(homedir, '.config', 'claude', 'projects'),
  ];
  const seen = new Set();
  const entries = [];

  for (const baseDir of dirs) {
    try { await fs.promises.access(baseDir); } catch { continue; }
    const jsonlFiles = await collectJsonlFiles(baseDir);

    const BATCH_SIZE = 20;
    for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
      const batch = jsonlFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(processFile));
      for (const localEntries of results) {
        for (const e of localEntries) {
          if (e.messageId && seen.has(e.messageId)) continue;
          if (e.messageId) seen.add(e.messageId);
          entries.push(e);
        }
      }
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  // Use stdout instead of IPC — process.send() can fail silently with large payloads
  process.stdout.write(JSON.stringify(entries));
}

run().catch(err => {
  process.stderr.write(err.message);
  process.exitCode = 1;
});
