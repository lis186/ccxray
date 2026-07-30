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

const BILLING_HOST = 'cli-chat-proxy.grok.com';
/** CLI /usage weekly pool — must include format=credits. */
const BILLING_PATH = '/v1/billing?format=credits';

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
 */
function refreshGrokBillingFromAuth(reqHeaders, outDir, alias = 'default') {
  try {
    const auth = reqHeaders?.authorization || reqHeaders?.Authorization;
    if (!auth) return;
    const headers = {
      authorization: auth,
      accept: 'application/json',
      'user-agent': reqHeaders['user-agent'] || 'grok-shell/0.2.103 (ccxray)',
      'x-xai-token-auth': reqHeaders['x-xai-token-auth'] || 'xai-grok-cli',
      'x-grok-client-version': reqHeaders['x-grok-client-version'] || '0.2.103',
    };
    const req = https.request({
      hostname: BILLING_HOST,
      path: BILLING_PATH,
      method: 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return;
        try {
          refreshGrokFromBillingBody(Buffer.concat(chunks).toString('utf8'), outDir, alias);
        } catch { /* ignore */ }
      });
    });
    req.on('error', () => {});
    req.setTimeout(8000, () => { try { req.destroy(); } catch {} });
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
    const d = dayMap.get(dateStr) || { totalTokens: 0, costUSD: 0 };
    d.totalTokens += tokens;
    d.costUSD += cost;
    dayMap.set(dateStr, d);
    const dt = new Date(ts);
    const mk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const m = monthMap.get(mk) || { totalTokens: 0, costUSD: 0 };
    m.totalTokens += tokens;
    m.costUSD += cost;
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
      byAccount['grok-default'] = { totalTokens: g.totalTokens, costUSD: round2(g.costUSD) };
      const prevTok = prev?.totalTokens || 0;
      const prevCost = prev?.costUSD || 0;
      return {
        ...day,
        totalTokens: day.totalTokens - prevTok + g.totalTokens,
        costUSD: round2((day.costUSD || 0) - prevCost + g.costUSD),
        byAccount,
      };
    }),
    monthly: (data.monthly || []).map(month => {
      const g = monthMap.get(month.month);
      if (!g) return month;
      const byAccount = { ...(month.byAccount || {}) };
      const prev = byAccount['grok-default'];
      byAccount['grok-default'] = { totalTokens: g.totalTokens, costUSD: round2(g.costUSD) };
      const prevTok = prev?.totalTokens || 0;
      const prevCost = prev?.costUSD || 0;
      return {
        ...month,
        totalTokens: month.totalTokens - prevTok + g.totalTokens,
        costUSD: round2((month.costUSD || 0) - prevCost + g.costUSD),
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
  // legacy exports kept so old tests fail cleanly / callers no-op
  parseGrokRatelimitHeaders,
  buildGrokSnap,
  refreshGrokFromHeaders,
  refreshGrokUsageOnly,
  weekBoundsUtc,
  sumGrokWeeklyTokens,
  tokensFromUsage,
};
