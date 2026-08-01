'use strict';

const path = require('path');
const { fork } = require('child_process');

// ── Cost Budget: JSONL reader via child process ─────────────────────
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// Legacy fallbacks (Max 20x values). Prefer getEffectivePlanConfig() which
// consults the detected plan; field accessors below wrap it for callers.
const TOKEN_LIMIT = 220_000;
const SUBSCRIPTION_USD = 200;

function getEffectivePlanConfig() {
  try {
    const store = require('./store');
    const { getEffectivePlan } = require('./plan-detector');
    const { getPlanConfig } = require('./plans');
    const recentUsages = store.entries.filter(e => e && e.usage).slice(-200).map(e => e.usage);
    const { plan } = getEffectivePlan({ recentUsages });
    return getPlanConfig(plan);
  } catch {
    return null;
  }
}

function getEffectiveTokenLimit() {
  return getEffectivePlanConfig()?.tokens5h ?? TOKEN_LIMIT;
}

function getEffectiveMonthlyUSD() {
  return getEffectivePlanConfig()?.monthlyUSD ?? SUBSCRIPTION_USD;
}

// 5-minute server-side cache
let costsCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;
const WORKER_TIMEOUT_MS = 120_000;
let lastFailureAt = 0;
const FAILURE_BACKOFF_MS = 60_000;

function streamUsageEntries(opts = {}) {
  const workerPath = opts.workerPath || path.join(__dirname, 'cost-worker.js');
  const timeoutMs = opts.timeoutMs || WORKER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const worker = fork(workerPath, [], { silent: true, windowsHide: true });
    const chunks = [];
    let stderrBuf = '';
    let settled = false;

    // Reap: once the result (or a fatal error) is in hand, the child must die.
    // disconnect() triggers the worker's #395 'disconnect' -> exit(0) listener;
    // the unref'd SIGKILL timer is the backstop for a truly wedged child, and
    // the one place we still surface that the worker could not exit on its own.
    const reap = () => {
      try { if (worker.connected) worker.disconnect(); } catch {}
      const killTimer = setTimeout(() => {
        if (worker.exitCode === null && worker.signalCode === null) {
          console.error('cost-worker still alive after completion; escalating to SIGKILL');
          try { worker.kill('SIGKILL'); } catch {}
        }
      }, 2000);
      killTimer.unref();
      worker.once('exit', () => clearTimeout(killTimer));
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    // Backstop only — normal completion no longer depends on process death.
    const timeout = setTimeout(() => {
      try { worker.kill(); } catch {}
      reap();
      settle(reject, new Error(`Worker timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    worker.stdout.on('data', (chunk) => chunks.push(chunk));
    worker.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'result') {
        reap();
        if (!Array.isArray(msg.entries)) {
          settle(reject, new Error(`Worker returned ${typeof msg.entries}, expected array`));
          return;
        }
        settle(resolve, msg.entries);
      } else if (msg.type === 'error') {
        reap();
        settle(reject, new Error(msg.message || stderrBuf || 'Worker failed'));
      }
    });

    worker.on('error', (err) => { reap(); settle(reject, err); });

    // Fallback: process death without an IPC result (crash before send, or a
    // legacy stdout-only worker). 'close', NOT 'exit' — 'exit' can fire before
    // stdio is drained, so the old exit-based parse had a latent truncation
    // race on large payloads.
    worker.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== null) {
        settle(reject, new Error(stderrBuf || `Worker exited with code ${code}`));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString();
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) {
          settle(reject, new Error(`Worker returned ${typeof data}, expected array`));
          return;
        }
        settle(resolve, data);
      } catch (e) {
        settle(reject, new Error(`Worker output parse error: ${e.message}`));
      }
    });
  });
}

function floorToHour(tsMs) {
  const d = new Date(tsMs);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function groupIntoBlocks(entries) {
  if (!entries.length) return [];
  const blocks = [];
  let current = null;

  for (const e of entries) {
    const quotaTokens = (e.usage.input_tokens || 0) + (e.usage.output_tokens || 0);
    const timeSinceBlockStart = current ? e.timestamp - current.startTime : Infinity;
    const timeSinceLastEntry = current ? e.timestamp - current.lastTs : Infinity;
    const needsNewBlock = !current || timeSinceBlockStart > FIVE_HOURS_MS || timeSinceLastEntry > FIVE_HOURS_MS;

    if (needsNewBlock) {
      const blockStart = floorToHour(e.timestamp);
      current = {
        startTime: blockStart,
        endTime: blockStart + FIVE_HOURS_MS,
        totalTokens: 0,
        costUSD: 0,
        models: new Set(),
        firstTs: e.timestamp,
        lastTs: e.timestamp,
      };
      blocks.push(current);
    }
    current.totalTokens += quotaTokens;
    current.costUSD += e.costUSD || 0;
    if (e.model) current.models.add(e.model);
    current.lastTs = e.timestamp;
  }

  const now = Date.now();
  return blocks.map(b => ({
    startTime: new Date(b.startTime).toISOString(),
    endTime: new Date(b.endTime).toISOString(),
    totalTokens: b.totalTokens,
    costUSD: b.costUSD,
    models: [...b.models],
    isActive: now < b.endTime && (now - b.lastTs) < FIVE_HOURS_MS,
    _startMs: b.startTime,
    _endMs: b.endTime,
    _firstTs: b.firstTs,
    _lastTs: b.lastTs,
  }));
}

function calculateBurnRate(block) {
  if (!block.isActive) return null;
  const now = Date.now();
  const durationMin = (block._lastTs - block._firstTs) / 60_000;
  if (durationMin <= 0) return null;
  const tokensPerMinute = block.totalTokens / durationMin;
  const costPerHour = (block.costUSD / durationMin) * 60;
  const minutesRemaining = Math.max(0, (block._endMs - now) / 60_000);
  const projectedAdditionalTokens = tokensPerMinute * minutesRemaining;
  const projectedTotalTokens = block.totalTokens + projectedAdditionalTokens;
  const projectedAdditionalCost = (costPerHour / 60) * minutesRemaining;
  const projectedTotalCost = block.costUSD + projectedAdditionalCost;
  return {
    burnRate: { tokensPerMinute: Math.round(tokensPerMinute), costPerHour: Math.round(costPerHour * 100) / 100 },
    projection: { totalTokens: Math.round(projectedTotalTokens), totalCost: Math.round(projectedTotalCost * 100) / 100 },
    minutesRemaining: Math.round(minutesRemaining),
  };
}

function groupByDay(entries) {
  const days = {};
  for (const e of entries) {
    const date = new Date(e.timestamp).toLocaleDateString('sv-SE');
    if (!days[date]) days[date] = { date, totalTokens: 0, costUSD: 0, models: new Set(), sessions: new Set(), byAccount: {} };
    const d = days[date];
    const tokens =
      (e.usage.input_tokens || 0) +
      (e.usage.output_tokens || 0) +
      (e.usage.cache_creation_input_tokens || 0) +
      (e.usage.cache_read_input_tokens || 0);
    d.totalTokens += tokens;
    d.costUSD += e.costUSD || 0;
    if (e.model) d.models.add(e.model);
    if (e.sessionId) d.sessions.add(e.sessionId);
    if (e.accountId) {
      const a = d.byAccount[e.accountId] || (d.byAccount[e.accountId] = { totalTokens: 0, costUSD: 0 });
      a.totalTokens += tokens;
      a.costUSD += e.costUSD || 0;
    }
  }
  const result = [];
  const now = new Date();
  for (let i = 181; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('sv-SE');
    const day = days[dateStr] || { date: dateStr, totalTokens: 0, costUSD: 0, models: new Set(), sessions: new Set(), byAccount: {} };
    const byAccount = {};
    for (const [k, v] of Object.entries(day.byAccount)) {
      byAccount[k] = { totalTokens: v.totalTokens, costUSD: Math.round(v.costUSD * 100) / 100 };
    }
    result.push({ date: day.date, totalTokens: day.totalTokens, costUSD: Math.round(day.costUSD * 100) / 100, models: [...day.models], sessionCount: day.sessions.size, byAccount });
  }
  return result;
}

function groupByMonth(entries) {
  const months = {};
  for (const e of entries) {
    const d = new Date(e.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = { month: key, totalTokens: 0, costUSD: 0, models: new Set(), byAccount: {} };
    const m = months[key];
    const tokens =
      (e.usage.input_tokens || 0) +
      (e.usage.output_tokens || 0) +
      (e.usage.cache_creation_input_tokens || 0) +
      (e.usage.cache_read_input_tokens || 0);
    m.totalTokens += tokens;
    m.costUSD += e.costUSD || 0;
    if (e.model) m.models.add(e.model);
    if (e.accountId) {
      const a = m.byAccount[e.accountId] || (m.byAccount[e.accountId] = { totalTokens: 0, costUSD: 0 });
      a.totalTokens += tokens;
      a.costUSD += e.costUSD || 0;
    }
  }
  return Object.values(months)
    .map(m => {
      const byAccount = {};
      for (const [k, v] of Object.entries(m.byAccount)) {
        byAccount[k] = { totalTokens: v.totalTokens, costUSD: Math.round(v.costUSD * 100) / 100 };
      }
      return { month: m.month, totalTokens: m.totalTokens, costUSD: Math.round(m.costUSD * 100) / 100, models: [...m.models], byAccount };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

let costsInflight = null;

function startComputation() {
  if (costsInflight) return costsInflight;
  if (lastFailureAt && (Date.now() - lastFailureAt) < FAILURE_BACKOFF_MS) {
    return Promise.reject(new Error('Cost computation in backoff'));
  }
  costsInflight = (async () => {
    try {
      const usageEntries = await streamUsageEntries();
      const blocks = groupIntoBlocks(usageEntries);
      const daily = groupByDay(usageEntries);
      const monthly = groupByMonth(usageEntries);
      const data = { blocks, daily, monthly };
      costsCache = { data, computedAt: Date.now() };
      lastFailureAt = 0;
      return data;
    } catch (err) {
      lastFailureAt = Date.now();
      console.error('Cost computation failed:', err.message);
      throw err;
    } finally {
      costsInflight = null;
    }
  })();
  return costsInflight;
}

async function getOrComputeCosts() {
  const now = Date.now();
  if (costsCache && (now - costsCache.computedAt) < CACHE_TTL_MS) {
    return costsCache.data;
  }
  return startComputation();
}

// Returns cached data immediately, or null if not ready yet.
// Triggers background computation if cache is stale/missing.
function getCostsCacheOrNull() {
  const now = Date.now();
  if (costsCache && (now - costsCache.computedAt) < CACHE_TTL_MS) {
    return costsCache.data;
  }
  // Kick off background computation but don't wait
  startComputation().catch(() => {});
  return null;
}

// Call at startup to begin warming the cache in the background
function warmUp() {
  startComputation().catch(() => {});
}

module.exports = {
  TOKEN_LIMIT,
  SUBSCRIPTION_USD,
  streamUsageEntries,
  getEffectiveTokenLimit,
  getEffectiveMonthlyUSD,
  getOrComputeCosts,
  getCostsCacheOrNull,
  calculateBurnRate,
  warmUp,
};
