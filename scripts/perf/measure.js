#!/usr/bin/env node
'use strict';

/**
 * Baseline performance measurement harness for ccxray (#183).
 *
 * Metrics:
 *   A. GET /_api/entries latency (P50/P95/P99 over N runs)
 *   B. loadEntryReqRes expansion for the 8-hop delta chain tail (median over N runs)
 *   C. Full-column rebuild count per 100 SSE entries (placeholder — null)
 *
 * Usage:
 *   node scripts/perf/measure.js [--home /tmp/perf-home] [--runs 5]
 *
 * If --home not given, generates a fixture first.
 * Outputs JSON to stdout. Self-bounded at 120s.
 */

const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fsp = require('fs').promises;

const { generate } = require('./generate-fixture');
const { simulateSseLoad } = require('./sse-load');

const TIMEOUT_MS = 120_000;
const SERVER_START_TIMEOUT_MS = 40_000;
const SERVER_POLL_INTERVAL_MS = 150;
const DEFAULT_RUNS = 5;
const WARMUP_REQUESTS = 3;
const MIN_METRIC_A_REQUESTS = 10;

// ── Utilities ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpGetRaw(`http://127.0.0.1:${port}/_api/entries`);
      if (r.status === 200) return;
    } catch { /* not ready yet */ }
    await sleep(SERVER_POLL_INTERVAL_MS);
  }
  throw new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`);
}

// ── Metric A: GET /_api/entries latency ─────────────────────────────

async function measureApiEntries(port, totalRequests) {
  const latencies = [];
  for (let i = 0; i < totalRequests; i++) {
    const t0 = performance.now();
    await httpGetRaw(`http://127.0.0.1:${port}/_api/entries`);
    latencies.push(performance.now() - t0);
  }
  return latencies;
}

// ── Metric B: delta chain expansion ─────────────────────────────────

async function measureDeltaExpand(logsDir, deltaChainIds, runs) {
  const config = require('../../server/config');
  const store = require('../../server/store');
  const { createLocalStorage } = require('../../server/storage/local');
  const { loadEntryReqRes } = require('../../server/restore');

  // Point config.storage at our fixture (matches pattern in delta-restore.test.js)
  const origStorage = config.storage;
  const tmpStorage = createLocalStorage(logsDir);
  await tmpStorage.init();
  config.storage = tmpStorage;

  // Register all delta chain entries in store.entries so prevId lookups work
  const origEntries = store.entries.splice(0);
  try {
    for (const id of deltaChainIds) {
      store.entries.push({ id, req: null, res: null, _loaded: false, provider: 'anthropic' });
    }

    const tailId = deltaChainIds[deltaChainIds.length - 1];
    const latencies = [];

    for (let i = 0; i < runs; i++) {
      // Reset _loaded on the entire chain to force cold expansion
      for (const e of store.entries) {
        e._loaded = false;
        e._loadingPromise = null;
        e.req = null;
        e.res = null;
      }

      const entry = store.entries.find(e => e.id === tailId);
      const t0 = performance.now();
      await loadEntryReqRes(entry);
      latencies.push(performance.now() - t0);
    }

    return latencies;
  } finally {
    // Restore original state
    store.entries.splice(0);
    for (const e of origEntries) store.entries.push(e);
    config.storage = origStorage;
  }
}

// ── Delta chain discovery (for real --home copies) ───────────────────
//
// Scans ALL index entries' _req.json headers for prevId fields, builds
// forward chains, returns the longest one. Reports honestly whether the
// chain was discovered or fell back.

async function discoverDeltaChain(logsDir, indexLines) {
  const HEADER_BYTES = 500;
  const BATCH_SIZE = 500;

  const ids = [];
  for (const l of indexLines) {
    try { ids.push(JSON.parse(l).id); } catch { /* skip */ }
  }

  // Read first HEADER_BYTES of each _req.json in batches to find prevId
  const prevIdMap = new Map();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async id => {
      try {
        const reqPath = path.join(logsDir, id + '_req.json');
        const fd = await fsp.open(reqPath, 'r');
        const buf = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await fd.read(buf, 0, HEADER_BYTES, 0);
        await fd.close();
        const header = buf.slice(0, bytesRead).toString('utf8');
        const m = header.match(/"prevId"\s*:\s*"([^"]+)"/);
        if (m) prevIdMap.set(id, m[1]);
      } catch { /* missing file — skip */ }
    }));
  }

  if (prevIdMap.size === 0) {
    return { deltaChainIds: [], chainLength: 0, method: 'none' };
  }

  // Build forward map and find anchors
  const childMap = new Map();
  for (const [id, prevId] of prevIdMap) {
    childMap.set(prevId, id);
  }

  const deltaIds = new Set(prevIdMap.keys());
  const anchors = new Set();
  for (const prevId of prevIdMap.values()) {
    if (!deltaIds.has(prevId)) anchors.add(prevId);
  }

  let longest = [];
  for (const anchor of anchors) {
    const chain = [anchor];
    let cur = childMap.get(anchor);
    while (cur) {
      chain.push(cur);
      cur = childMap.get(cur);
    }
    if (chain.length > longest.length) longest = chain;
  }

  if (longest.length === 0) {
    return { deltaChainIds: [], chainLength: 0, method: 'none' };
  }

  return { deltaChainIds: longest, chainLength: longest.length, method: 'discovered' };
}

// ── Main ─────────────────────────────────────────────────────────────

async function run({ homeDir, runs }) {
  const overallDeadline = Date.now() + TIMEOUT_MS;

  const cpuBefore = os.loadavg();
  if (cpuBefore[0] > 4.0) {
    process.stderr.write(`[perf] Warning: 1-min load avg ${cpuBefore[0].toFixed(2)} > 4.0 — results may be unreliable\n`);
  }

  // If no home dir given, generate fixture
  let generatedDir = null;
  let logsDir;
  let deltaChainIds;
  let entryCount;

  if (homeDir) {
    logsDir = path.join(homeDir, 'logs');
    const raw = await fsp.readFile(path.join(logsDir, 'index.ndjson'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    entryCount = lines.length;
    // For real --home copies, scan recent entries for prevId chains rather than
    // assuming the first 8 lines are the delta chain (only true for fixtures).
    const discovered = await discoverDeltaChain(logsDir, lines);
    deltaChainIds = discovered.deltaChainIds;
    if (discovered.method === 'none') {
      process.stderr.write(`[perf] No delta chains found in ${entryCount} entries — skipping Metric B\n`);
    } else {
      process.stderr.write(`[perf] Delta chain: ${discovered.chainLength} hops (${discovered.method})\n`);
    }
  } else {
    process.stderr.write('[perf] No --home given, generating fixture...\n');
    const result = await generate();
    generatedDir = result.outputDir;
    logsDir = result.logsDir;
    deltaChainIds = result.deltaChainIds;
    entryCount = result.entryCount;
    process.stderr.write(`[perf] Fixture: ${generatedDir} (${entryCount} entries)\n`);
  }

  const port = await findFreePort();
  const serverEnv = {
    ...process.env,
    CCXRAY_HOME: path.dirname(logsDir),  // parent of /logs
    PORT: String(port),                   // consumed by server/config.js
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com', // ponytail: suppress self-loop warning; no real traffic
    RESTORE_DAYS: '9999',         // ponytail: don't filter fixture entries by date
    LOG_RETENTION_DAYS: '9999',   // ponytail: don't prune fixture files
  };

  const serverPath = path.join(__dirname, '../../server/index.js');
  const serverProc = spawn('node', [serverPath, '--port', String(port), '--no-browser'], {
    env: serverEnv,
    stdio: 'ignore',  // no pipes — avoids keeping parent event loop alive
  });
  serverProc.unref();  // parent can exit without waiting for server subprocess

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { serverProc.kill('SIGTERM'); } catch {}
    if (generatedDir) {
      fsp.rm(generatedDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  process.on('exit', cleanup);

  try {
    const remaining = overallDeadline - Date.now();
    process.stderr.write(`[perf] Waiting for server on port ${port}...\n`);
    await waitForServer(port, Math.min(SERVER_START_TIMEOUT_MS, remaining));
    process.stderr.write('[perf] Server ready.\n');

    // Warmup
    for (let i = 0; i < WARMUP_REQUESTS; i++) {
      await httpGetRaw(`http://127.0.0.1:${port}/_api/entries`);
    }

    // Metric A
    const totalA = Math.max(runs, MIN_METRIC_A_REQUESTS);
    process.stderr.write(`[perf] Metric A: ${totalA} requests to /_api/entries...\n`);
    const aLatencies = await measureApiEntries(port, totalA);
    const apiP50 = percentile(aLatencies, 50);
    const apiP95 = percentile(aLatencies, 95);
    const apiP99 = percentile(aLatencies, 99);

    // Metric B (skip if no delta chain found)
    let deltaMedian = null;
    if (deltaChainIds.length > 1) {
      process.stderr.write(`[perf] Metric B: delta chain expansion (${runs} runs, chain length ${deltaChainIds.length})...\n`);
      const bLatencies = await measureDeltaExpand(logsDir, deltaChainIds, runs);
      deltaMedian = median(bLatencies);
    }

    // SSE load generator: exercises the broadcast/serialization path
    process.stderr.write('[perf] SSE load: injecting 100 synthetic entries via broadcast path...\n');
    const sseEntriesInjected = simulateSseLoad(100);
    process.stderr.write(`[perf] SSE load: ${sseEntriesInjected} entries injected.\n`);

    const cpuAfter = os.loadavg();

    const result = {
      timestamp: new Date().toISOString(),
      node_version: process.version,
      entries_count: entryCount,
      delta_chain_length: deltaChainIds.length,
      metrics: {
        api_entries_p50_ms: Math.round(apiP50 * 100) / 100,
        api_entries_p95_ms: Math.round(apiP95 * 100) / 100,
        api_entries_p99_ms: Math.round(apiP99 * 100) / 100,
        delta_expand_median_ms: deltaMedian !== null ? Math.round(deltaMedian * 100) / 100 : null,
        rebuild_per_100_sse: null, // ponytail: activates when #167 adds renderProjectsCol counter hook
        sse_entries_injected: sseEntriesInjected,
      },
      cpu_load_before: cpuBefore,
      cpu_load_after: cpuAfter,
    };

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    cleanup();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let homeDir = null;
  let runs = DEFAULT_RUNS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1]) {
      homeDir = args[i + 1];
      i++;
    } else if (args[i] === '--runs' && args[i + 1]) {
      runs = parseInt(args[i + 1], 10);
      i++;
    }
  }

  // Top-level timeout guard
  const globalTimer = setTimeout(() => {
    process.stderr.write('[perf] TIMEOUT: exceeded 120s hard limit\n');
    process.exit(2);
  }, TIMEOUT_MS);
  globalTimer.unref();

  run({ homeDir, runs })
    .catch(err => {
      process.stderr.write(`[perf] Error: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}
