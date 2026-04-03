'use strict';

const path = require('path');
const { fork } = require('child_process');

// ── Cost Budget: JSONL reader via child process ─────────────────────
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const TOKEN_LIMIT = 220_000;
const SUBSCRIPTION_USD = 200;

// 5-minute server-side cache
let costsCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function streamUsageEntries() {
  return new Promise((resolve, reject) => {
    const worker = fork(path.join(__dirname, 'cost-worker.js'), [], { silent: true });
    const chunks = [];
    let stderrBuf = '';
    const timeout = setTimeout(() => {
      worker.kill();
      reject(new Error('Worker timeout (60s)'));
    }, 60_000);
    worker.stdout.on('data', (chunk) => chunks.push(chunk));
    worker.stderr.on('data', (chunk) => { stderrBuf += chunk; });
    worker.on('error', (err) => { clearTimeout(timeout); reject(err); });
    worker.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(stderrBuf || `Worker exited with code ${code}`));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString();
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) {
          reject(new Error(`Worker returned ${typeof data}, expected array`));
          return;
        }
        resolve(data);
      } catch (e) {
        reject(new Error(`Worker output parse error: ${e.message}`));
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
    if (!days[date]) days[date] = { date, totalTokens: 0, costUSD: 0, models: new Set(), sessions: new Set() };
    const d = days[date];
    d.totalTokens +=
      (e.usage.input_tokens || 0) +
      (e.usage.output_tokens || 0) +
      (e.usage.cache_creation_input_tokens || 0) +
      (e.usage.cache_read_input_tokens || 0);
    d.costUSD += e.costUSD || 0;
    if (e.model) d.models.add(e.model);
    if (e.sessionId) d.sessions.add(e.sessionId);
  }
  const result = [];
  const now = new Date();
  for (let i = 181; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('sv-SE');
    const day = days[dateStr] || { date: dateStr, totalTokens: 0, costUSD: 0, models: new Set(), sessions: new Set() };
    result.push({ date: day.date, totalTokens: day.totalTokens, costUSD: Math.round(day.costUSD * 100) / 100, models: [...day.models], sessionCount: day.sessions.size });
  }
  return result;
}

function groupByMonth(entries) {
  const months = {};
  for (const e of entries) {
    const d = new Date(e.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = { month: key, totalTokens: 0, costUSD: 0, models: new Set() };
    const m = months[key];
    m.totalTokens +=
      (e.usage.input_tokens || 0) +
      (e.usage.output_tokens || 0) +
      (e.usage.cache_creation_input_tokens || 0) +
      (e.usage.cache_read_input_tokens || 0);
    m.costUSD += e.costUSD || 0;
    if (e.model) m.models.add(e.model);
  }
  return Object.values(months)
    .map(m => ({ month: m.month, totalTokens: m.totalTokens, costUSD: Math.round(m.costUSD * 100) / 100, models: [...m.models] }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

let costsInflight = null;

function startComputation() {
  if (costsInflight) return costsInflight;
  costsInflight = (async () => {
    try {
      const usageEntries = await streamUsageEntries();
      const blocks = groupIntoBlocks(usageEntries);
      const daily = groupByDay(usageEntries);
      const monthly = groupByMonth(usageEntries);
      const data = { blocks, daily, monthly };
      costsCache = { data, computedAt: Date.now() };
      return data;
    } catch (err) {
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
  getOrComputeCosts,
  getCostsCacheOrNull,
  calculateBurnRate,
  warmUp,
};
