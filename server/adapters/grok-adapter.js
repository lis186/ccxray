'use strict';

/**
 * Grok provider adapter — Usage tab account card mirrors Grok CLI `/usage`.
 *
 * Source of truth (obs 2026-07-19):
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   {
 *     config: {
 *       currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
 *       creditUsagePercent: 46,
 *       productUsage: [{ product: "GrokBuild", usagePercent: 46 }, ...],
 *       billingPeriodStart, billingPeriodEnd, onDemandCap, prepaidBalance, ...
 *     }
 *   }
 *
 * This is what the CLI shows as "Weekly SuperGrok Limit / N% used / Resets …".
 * Without `?format=credits`, `/v1/billing` returns monthly credit dollars
 * (monthlyLimit/used) — a different meter. Prefer format=credits for the
 * account card.
 *
 * Provider-local: do not extend shared ratelimit-log / cost-budget.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

/** CLI /usage weekly pool — must include format=credits. */
const BILLING_PATH = '/v1/billing?format=credits';

/**
 * Per-credential throttle of last successful billing refresh (ms).
 * Key = `${alias}:${sha256(auth).slice(0,16)}` — raw token never stored.
 * Hub = one process. Bound to MAX_BILLING_THROTTLE_KEYS (evict oldest).
 */
const _billingOkAtByAlias = new Map();
const MAX_BILLING_THROTTLE_KEYS = 32;

const DEFAULT_BILLING_TTL_MS = 60_000;

function billingThrottleKey(alias, authHeaderValue) {
  const digest = crypto.createHash('sha256').update(String(authHeaderValue)).digest('hex').slice(0, 16);
  return `${alias || 'default'}:${digest}`;
}

function markBillingOk(key, atMs) {
  if (_billingOkAtByAlias.has(key)) {
    _billingOkAtByAlias.delete(key); // re-insert as newest
  } else {
    while (_billingOkAtByAlias.size >= MAX_BILLING_THROTTLE_KEYS) {
      const oldest = _billingOkAtByAlias.keys().next().value;
      _billingOkAtByAlias.delete(oldest);
    }
  }
  _billingOkAtByAlias.set(key, atMs);
}

function billingTtlMs(opts = {}) {
  if (opts.ttlMs != null && Number.isFinite(opts.ttlMs)) return opts.ttlMs;
  const envN = Number(process.env.CCXRAY_GROK_BILLING_TTL_MS);
  return Number.isFinite(envN) && envN >= 0 ? envN : DEFAULT_BILLING_TTL_MS;
}

/** Test seam: clear throttle state between cases. */
function _resetBillingThrottleForTests() {
  _billingOkAtByAlias.clear();
}

// ── Billing parse ─────────────────────────────────────────────────────

function numVal(x) {
  if (x == null) return null;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'object' && typeof x.val === 'number') return x.val;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function periodTypeLabel(type) {
  if (!type || typeof type !== 'string') return null;
  const t = type.toUpperCase();
  if (t.includes('WEEKLY')) return 'Weekly';
  if (t.includes('MONTHLY')) return 'Monthly';
  if (t.includes('DAILY')) return 'Daily';
  return null;
}

/**
 * Build usage-status snap from /v1/billing JSON body.
 * Prefers format=credits (weekly SuperGrok pool); falls back to monthlyLimit/used.
 * @param {object} body  parsed billing response
 */
function buildGrokSnapFromBilling(body, opts = {}) {
  const cfg = body?.config;
  if (!cfg) return null;

  const alias = opts.alias || 'default';
  const nowS = Math.floor((opts.nowMs || Date.now()) / 1000);

  // ── Primary: format=credits weekly SuperGrok pool (CLI /usage) ──
  const creditPct = numVal(cfg.creditUsagePercent);
  if (creditPct != null) {
    let usedPct = Math.round(creditPct * 10) / 10;
    if (creditPct > 0 && usedPct < 0.1) usedPct = 0.1;
    usedPct = Math.max(0, Math.min(100, usedPct));

    const period = cfg.currentPeriod || {};
    const startIso = period.start || cfg.billingPeriodStart || null;
    const endIso = period.end || cfg.billingPeriodEnd || null;
    let resetsAt = null;
    if (endIso) {
      const ms = Date.parse(endIso);
      if (Number.isFinite(ms)) resetsAt = Math.floor(ms / 1000);
    }

    const typeLabel = periodTypeLabel(period.type);
    let windowLabel = typeLabel ? `${typeLabel} SuperGrok Limit` : 'SuperGrok Limit';
    // If type missing, infer from period length.
    if (!typeLabel && startIso && endIso) {
      const days = (Date.parse(endIso) - Date.parse(startIso)) / 86400000;
      if (days >= 6 && days <= 8) windowLabel = 'Weekly SuperGrok Limit';
      else if (days >= 25 && days <= 32) windowLabel = 'Monthly SuperGrok Limit';
    }

    const productUsage = Array.isArray(cfg.productUsage) ? cfg.productUsage : null;
    return {
      id: `grok-${alias}`,
      label: alias === 'default' ? 'Grok' : `Grok · ${alias}`,
      provider: 'xai',
      planType: null,
      fiveHour: null,
      sevenDay: {
        usedPct,
        resetsAt,
        unit: 'pct',
        window: 'weekly-pool',
        windowLabel,
        periodStart: startIso,
        periodEnd: endIso,
        periodType: period.type || null,
        productUsage,
        onDemandCap: numVal(cfg.onDemandCap),
        prepaidBalance: numVal(cfg.prepaidBalance),
      },
      updatedAt: nowS,
      source: 'billing-credits',
    };
  }

  // ── Fallback: monthly credit meter (no format=credits) ──
  const limit = numVal(cfg.monthlyLimit);
  const used = numVal(cfg.used);
  if (limit == null || limit <= 0 || used == null) return null;

  const startIso = cfg.billingPeriodStart || null;
  const endIso = cfg.billingPeriodEnd || null;
  let resetsAt = null;
  if (endIso) {
    const ms = Date.parse(endIso);
    if (Number.isFinite(ms)) resetsAt = Math.floor(ms / 1000);
  }

  let usedPct = Math.round((used / limit) * 1000) / 10;
  if (used > 0 && usedPct < 0.1) usedPct = 0.1;
  usedPct = Math.max(0, Math.min(100, usedPct));

  let periodLabel = 'Period';
  if (startIso && endIso) {
    const days = (Date.parse(endIso) - Date.parse(startIso)) / 86400000;
    if (days >= 25 && days <= 32) periodLabel = 'Monthly';
    else if (days >= 6 && days <= 8) periodLabel = 'Weekly';
  }

  return {
    id: `grok-${alias}`,
    label: alias === 'default' ? 'Grok' : `Grok · ${alias}`,
    provider: 'xai',
    planType: null,
    fiveHour: null,
    sevenDay: {
      usedPct,
      resetsAt,
      used,
      limit,
      unit: 'credits',
      window: 'billing-period',
      windowLabel: periodLabel,
      periodStart: startIso,
      periodEnd: endIso,
      onDemandCap: numVal(cfg.onDemandCap),
    },
    updatedAt: nowS,
    source: 'billing',
  };
}

function writeGrokSnap(outDir, snap) {
  if (!snap || !outDir) return;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${snap.id}.json`);
    const tmpPath = outPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(snap, null, 2));
    fs.renameSync(tmpPath, outPath);
  } catch { /* never block proxy */ }
}

/** Parse a /v1/billing response body (string or object) and write snap. */
function refreshGrokFromBillingBody(raw, outDir, alias = 'default') {
  let body = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch { return null; }
  }
  const snap = buildGrokSnapFromBilling(body, { alias });
  if (!snap) return null;
  writeGrokSnap(outDir, snap);
  return snap;
}

/**
 * Active fetch of /v1/billing?format=credits using the client's auth headers.
 * Fire-and-forget safe: never throws.
 *
 * @param {object} reqHeaders  client request headers (auth forwarded, not stored)
 * @param {string} outDir      usage-status directory
 * @param {string} [alias='default']
 * @param {object} [opts]
 * @param {object} [opts.upstream]  host profile (default config.UPSTREAMS.xai)
 * @param {number} [opts.ttlMs]     override CCXRAY_GROK_BILLING_TTL_MS (default 60s)
 * @param {number} [opts.nowMs]     clock for throttle check
 * @param {Function} [opts.request] injectable http(s).request (tests)
 * @param {Function} [opts.joinUpstreamPath] injectable path joiner (tests)
 */
function refreshGrokBillingFromAuth(reqHeaders, outDir, alias = 'default', opts = {}) {
  try {
    const auth = reqHeaders?.authorization || reqHeaders?.Authorization;
    if (!auth) return;

    const now = opts.nowMs != null ? opts.nowMs : Date.now();
    const ttl = billingTtlMs(opts);
    const key = billingThrottleKey(alias, auth);
    const lastOk = _billingOkAtByAlias.get(key) || 0;
    if (ttl > 0 && lastOk > 0 && (now - lastOk) < ttl) return;

    const config = require('../config');
    const upstream = opts.upstream || config.UPSTREAMS.xai;
    if (!upstream?.host) return;
    const joinPath = opts.joinUpstreamPath || config.joinUpstreamPath;
    const reqPath = joinPath(upstream, BILLING_PATH);

    const headers = {
      authorization: auth,
      accept: 'application/json',
      'user-agent': reqHeaders['user-agent'] || 'grok-shell/0.2.103 (ccxray)',
      'x-xai-token-auth': reqHeaders['x-xai-token-auth'] || 'xai-grok-cli',
      'x-grok-client-version': reqHeaders['x-grok-client-version'] || '0.2.103',
    };

    const transport = upstream.protocol === 'http' ? http : https;
    const requestFn = opts.request || ((options, cb) => transport.request(options, cb));
    const req = requestFn({
      hostname: upstream.host,
      port: upstream.port,
      path: reqPath,
      method: 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        // Record throttle timestamp only when a usable snap was produced —
        // HTTP 200 with an unusable body must not blank the Usage card for a TTL.
        if (res.statusCode !== 200) return;
        try {
          const snap = refreshGrokFromBillingBody(
            Buffer.concat(chunks).toString('utf8'),
            outDir,
            alias,
          );
          if (snap) markBillingOk(key, Date.now());
        } catch { /* ignore */ }
      });
    });
    req.on('error', () => {});
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(8000, () => { try { req.destroy(); } catch {} });
    }
    req.end();
  } catch { /* ignore */ }
}

/** True if this URL is the CLI billing/usage endpoint (with or without query). */
function isGrokBillingPath(url) {
  if (!url) return false;
  const pathOnly = String(url).split('?')[0];
  return pathOnly === '/v1/billing' || pathOnly.endsWith('/v1/billing');
}

// ── Live cost overlay (proxy turns → daily/monthly grok-default $) ────

function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
}

function entryCostUSD(entry) {
  if (!entry || entry.cost == null) return 0;
  if (typeof entry.cost === 'number' && Number.isFinite(entry.cost)) return entry.cost;
  if (typeof entry.cost === 'object' && typeof entry.cost.cost === 'number') return entry.cost.cost;
  return 0;
}

function entryCostConfidence(entry) {
  if (entry?.costConfidence) return entry.costConfidence;
  if (entry?.cost && typeof entry.cost === 'object') return entry.cost.confidence || null;
  return null;
}

function emptyCostFold() {
  return { fallbackCost: 0, fallbackCount: 0, unknownCount: 0, count: 0 };
}

function addCostFold(target, entry, cost) {
  // INVARIANT(#420/ADR 0017): the live Grok overlay preserves the complete
  // aggregate confidence fold when it replaces cached account rows.
  target.count++;
  const confidence = entryCostConfidence(entry);
  if (confidence === 'fallback') {
    target.fallbackCost += cost;
    target.fallbackCount++;
  }
  if (confidence === 'unknown') target.unknownCount++;
}

function foldValue(row, key) {
  const n = Number(row?.[key]);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) { return Math.round(n * 100) / 100; }

function withGrokLiveCosts(data, storeMod) {
  if (!data) return data;
  let store;
  try { store = storeMod || require('../store'); } catch { return data; }

  const dayMap = new Map();
  const monthMap = new Map();
  for (const e of store.entries || []) {
    if (!e || e.agent !== 'grok' || !e.usage) continue;
    const ts = typeof e.receivedAt === 'number' ? e.receivedAt : 0;
    if (!ts) continue;
    const tokens = tokensFromUsage(e.usage);
    const cost = entryCostUSD(e);
    if (tokens === 0 && cost === 0) continue;
    const dateStr = new Date(ts).toLocaleDateString('sv-SE');
    const d = dayMap.get(dateStr) || { totalTokens: 0, costUSD: 0, ...emptyCostFold() };
    d.totalTokens += tokens;
    d.costUSD += cost;
    addCostFold(d, e, cost);
    dayMap.set(dateStr, d);
    const dt = new Date(ts);
    const mk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const m = monthMap.get(mk) || { totalTokens: 0, costUSD: 0, ...emptyCostFold() };
    m.totalTokens += tokens;
    m.costUSD += cost;
    addCostFold(m, e, cost);
    monthMap.set(mk, m);
  }
  if (!dayMap.size && !monthMap.size) return data;

  return {
    blocks: data.blocks,
    daily: (data.daily || []).map(day => {
      const g = dayMap.get(day.date);
      if (!g) return day;
      const byAccount = { ...(day.byAccount || {}) };
      const prev = byAccount['grok-default'];
      byAccount['grok-default'] = {
        totalTokens: g.totalTokens,
        costUSD: round2(g.costUSD),
        fallbackCost: round2(g.fallbackCost),
        fallbackCount: g.fallbackCount,
        unknownCount: g.unknownCount,
        count: g.count,
      };
      const prevTok = prev?.totalTokens || 0;
      const prevCost = prev?.costUSD || 0;
      return {
        ...day,
        totalTokens: day.totalTokens - prevTok + g.totalTokens,
        costUSD: round2((day.costUSD || 0) - prevCost + g.costUSD),
        fallbackCost: round2(foldValue(day, 'fallbackCost') - foldValue(prev, 'fallbackCost') + g.fallbackCost),
        fallbackCount: foldValue(day, 'fallbackCount') - foldValue(prev, 'fallbackCount') + g.fallbackCount,
        unknownCount: foldValue(day, 'unknownCount') - foldValue(prev, 'unknownCount') + g.unknownCount,
        count: foldValue(day, 'count') - foldValue(prev, 'count') + g.count,
        byAccount,
      };
    }),
    monthly: (data.monthly || []).map(month => {
      const g = monthMap.get(month.month);
      if (!g) return month;
      const byAccount = { ...(month.byAccount || {}) };
      const prev = byAccount['grok-default'];
      byAccount['grok-default'] = {
        totalTokens: g.totalTokens,
        costUSD: round2(g.costUSD),
        fallbackCost: round2(g.fallbackCost),
        fallbackCount: g.fallbackCount,
        unknownCount: g.unknownCount,
        count: g.count,
      };
      const prevTok = prev?.totalTokens || 0;
      const prevCost = prev?.costUSD || 0;
      return {
        ...month,
        totalTokens: month.totalTokens - prevTok + g.totalTokens,
        costUSD: round2((month.costUSD || 0) - prevCost + g.costUSD),
        fallbackCost: round2(foldValue(month, 'fallbackCost') - foldValue(prev, 'fallbackCost') + g.fallbackCost),
        fallbackCount: foldValue(month, 'fallbackCount') - foldValue(prev, 'fallbackCount') + g.fallbackCount,
        unknownCount: foldValue(month, 'unknownCount') - foldValue(prev, 'unknownCount') + g.unknownCount,
        count: foldValue(month, 'count') - foldValue(prev, 'count') + g.count,
        byAccount,
      };
    }),
  };
}

// ── Legacy stubs (tests / old callers) ────────────────────────────────

function parseGrokRatelimitHeaders() { return null; }
function buildGrokSnap() { return null; }
function refreshGrokFromHeaders() { return null; }
function refreshGrokUsageOnly() { return null; }
function weekBoundsUtc(nowMs = Date.now()) {
  return { startMs: nowMs - 7 * 86400000, endMs: nowMs, resetsAt: null, windowLabel: 'Last 7 days' };
}
function sumGrokWeeklyTokens() { return 0; }

module.exports = {
  buildGrokSnapFromBilling,
  refreshGrokFromBillingBody,
  refreshGrokBillingFromAuth,
  isGrokBillingPath,
  writeGrokSnap,
  withGrokLiveCosts,
  _resetBillingThrottleForTests,
  // legacy exports kept so old tests fail cleanly / callers no-op
  parseGrokRatelimitHeaders,
  buildGrokSnap,
  refreshGrokFromHeaders,
  refreshGrokUsageOnly,
  weekBoundsUtc,
  sumGrokWeeklyTokens,
  tokensFromUsage,
};
