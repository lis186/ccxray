'use strict';

// #397: Single source of truth for offline model pricing.
// All rates are per 1M tokens (USD). Three consumers:
//   1. pricing.js — imports DEFAULT_PRICING, LITELLM_LAG_OVERRIDES, applyLagOverrides
//      for buildPricingTable (merges with LiteLLM live data)
//   2. cost-worker.js — imports calculateCostSimple (forked child process, no live pricing)
//   3. importer.js — imports calculateCostSimple (runs at startup before pricing is fetched)
//
// CONSTRAINT (ADR 0015): this module must be side-effect free — purely constants
// and pure functions. No I/O, no event handlers, no process lifecycle effects.
// CONSTRAINT (#397): no circular dependency — this file must NOT require pricing.js.

// ── Stable offline fallback rates (per 1M tokens, USD) ──────────────
// Long-lived safety nets when LiteLLM fetch fails. Not temporary lag patches
// (those go in LITELLM_LAG_OVERRIDES below).
const DEFAULT_PRICING = {
  // ── Anthropic Claude (verified against LiteLLM 2026-08-02) ──────────
  // Active models with index traffic
  'claude-opus-4-6':   { input: 5,     output: 25,  cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4-8':   { input: 5,     output: 25,  cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-5':     { input: 5,     output: 25,  cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4-7':   { input: 5,     output: 25,  cache_create: 6.25,  cache_read: 0.50 },
  'claude-fable-5':    { input: 10,    output: 50,  cache_create: 12.50, cache_read: 1.00 },
  'claude-sonnet-4-6': { input: 3,     output: 15,  cache_create: 3.75,  cache_read: 0.30 },
  'claude-sonnet-5':   { input: 2,     output: 10,  cache_create: 2.50,  cache_read: 0.20 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_create: 1.25, cache_read: 0.10 },
  // Legacy/prefix-match models (no direct index traffic but cover dated wire IDs)
  'claude-opus-4-5':   { input: 5,     output: 25,  cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4-1':   { input: 15,    output: 75,  cache_create: 18.75, cache_read: 1.50 },
  'claude-opus-4':     { input: 15,    output: 75,  cache_create: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-5': { input: 3,     output: 15,  cache_create: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4':   { input: 3,     output: 15,  cache_create: 3.75,  cache_read: 0.30 },
  'claude-haiku-4':    { input: 0.80,  output: 4,   cache_create: 1,     cache_read: 0.08 },
  'claude-3-5-sonnet': { input: 3,     output: 15,  cache_create: 3.75,  cache_read: 0.30 },
  'claude-3-5-haiku':  { input: 0.80,  output: 4,   cache_create: 1,     cache_read: 0.08 },
  'claude-3-opus':     { input: 15,    output: 75,  cache_create: 18.75, cache_read: 1.50 },
  'claude-haiku-3-5':  { input: 0.80,  output: 4,   cache_create: 1,     cache_read: 0.08 },
  // ── OpenAI (verified against LiteLLM 2026-08-02) ───────────────────
  // Active models with index traffic
  'gpt-5.6-sol':       { input: 5,     output: 30,  cache_create: 6.25,  cache_read: 0.50 },
  'gpt-5.6-terra':     { input: 2,     output: 12,  cache_create: 2.50,  cache_read: 0.20 },
  'gpt-5.6-luna':      { input: 0.20,  output: 1.20, cache_create: 0.25, cache_read: 0.02 },
  'gpt-5.6':           { input: 5,     output: 30,  cache_create: 6.25,  cache_read: 0.50 },
  'gpt-5.5-pro':       { input: 30,    output: 180, cache_create: 30,    cache_read: 3 },
  'gpt-5.5':           { input: 5,     output: 30,  cache_create: 5,     cache_read: 0.50 },
  'gpt-5.4-pro':       { input: 30,    output: 180, cache_create: 30,    cache_read: 3 },
  'gpt-5.4-mini':      { input: 0.75,  output: 4.50, cache_create: 0.75, cache_read: 0.075 },
  'gpt-5.4':           { input: 2.50,  output: 15,  cache_create: 2.50,  cache_read: 0.25 },
  // Legacy OpenAI (prefix match for older logs)
  'gpt-5':             { input: 1.25,  output: 10,  cache_create: 1.25,  cache_read: 0.125 },
  'gpt-4.1':           { input: 2,     output: 8,   cache_create: 2,     cache_read: 0.50 },
  'gpt-4o':            { input: 2.50,  output: 10,  cache_create: 2.50,  cache_read: 1.25 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60, cache_create: 0.15, cache_read: 0.075 },
  'o3':                { input: 2,     output: 8,   cache_create: 2,     cache_read: 0.50 },
  'o3-mini':           { input: 1.10,  output: 4.40, cache_create: 1.10, cache_read: 0.55 },
  'o4-mini':           { input: 1.10,  output: 4.40, cache_create: 1.10, cache_read: 0.275 },
  // ── xAI Grok (verified against LiteLLM 2026-08-02) ─────────────────
  'grok-4.5':          { input: 2.00,  output: 6.00, cache_create: 2.00, cache_read: 0.50 },
  'grok-4.5-latest':   { input: 2.00,  output: 6.00, cache_create: 2.00, cache_read: 0.50 },
  'grok-4.5-build':    { input: 2.00,  output: 6.00, cache_create: 2.00, cache_read: 0.50 },
  'grok-4.3':          { input: 1.25,  output: 2.50, cache_create: 1.25, cache_read: 0.20 },
  'grok-4.3-latest':   { input: 1.25,  output: 2.50, cache_create: 1.25, cache_read: 0.20 },
  'grok-build':        { input: 1.00,  output: 2.00, cache_create: 1.00, cache_read: 0.20 },
  'grok-build-0.1':    { input: 1.00,  output: 2.00, cache_create: 1.00, cache_read: 0.20 },
};

/**
 * Temporary rates for models LiteLLM has not listed yet (or only under a
 * provider-prefixed key we cannot match). Lifecycle:
 *
 *  1. Add row when wire shows Unknown model: <id>
 *  2. Each fetchPricing() checks `litellmKeys` against the LiteLLM table
 *  3. If ANY litellmKey is present -> override is NOT applied (LiteLLM wins)
 *     and a yellow startup line reminds you to DELETE the row
 *  4. If none present -> apply rates under `wireIds` until LiteLLM catches up
 *
 * Search: `LITELLM_LAG_OVERRIDES` / `pricing lag override`
 * Source of truth for rates: official provider docs (see `source` field).
 */
const LITELLM_LAG_OVERRIDES = Object.freeze([
  // grok-build retired 2026-08-13: LiteLLM lists xai/grok-build-0.1 and grok-build-0.1.
  // Rates moved to DEFAULT_PRICING as stable offline fallback.
]);

/**
 * Apply lag overrides on top of a LiteLLM-derived (or default) table.
 * - If LiteLLM already has any watched key -> skip (LiteLLM wins) + flag for deletion
 * - Else -> write rates under each wireId
 *
 * Returns { table, status } — the caller manages any side effects (e.g.
 * pricing.js stores `status` in `lastLagOverrideStatus`).
 */
function applyLagOverrides(litellmTable) {
  const table = { ...litellmTable };
  const status = [];
  for (const entry of LITELLM_LAG_OVERRIDES) {
    const present = entry.litellmKeys.filter(k => litellmTable[k] != null);
    if (present.length > 0) {
      status.push({
        id: entry.id,
        active: false,
        action: 'remove-override',
        presentKeys: present,
        since: entry.since,
        removeWhen: entry.removeWhen,
      });
      continue;
    }
    for (const wireId of entry.wireIds) {
      table[wireId] = { ...entry.rates };
    }
    status.push({
      id: entry.id,
      active: true,
      action: 'using-local-override',
      wireIds: [...entry.wireIds],
      since: entry.since,
      source: entry.source,
      removeWhen: entry.removeWhen,
    });
  }
  return { table, status };
}

/**
 * Returns the fully merged per-MTok rate table (DEFAULT_PRICING + lag overrides)
 * for consumers without access to live LiteLLM data. Used internally by
 * calculateCostSimple.
 */
function getOfflineRates() {
  return applyLagOverrides({ ...DEFAULT_PRICING }).table;
}

// ── Per-token rates for calculateCostSimple ──────────────────────────
// Derived once at module load from DEFAULT_PRICING + lag overrides.
// Pure computation, no I/O. Sorted longest-key-first so prefix matching
// picks the most specific key (fixes importer.js's insertion-order bug).
//
// S-4 (issue 3): 1-hour cache-creation writes bill at 2x input, not the
// 5-minute `cache_create` rate (1.25x input). DEFAULT_PRICING rows deliberately
// carry no `cache_create_1h` value (A-4.1) — it is derived here, once, so a
// row missing the field (every current row, plus LITELLM_LAG_OVERRIDES) never
// silently falls back to the 5m rate.
const _offlinePerMTok = getOfflineRates();
const _perTokenRates = {};
for (const [key, rates] of Object.entries(_offlinePerMTok)) {
  _perTokenRates[key] = {
    input: rates.input / 1_000_000,
    output: rates.output / 1_000_000,
    cache_read: rates.cache_read / 1_000_000,
    cache_create: rates.cache_create / 1_000_000,
    cache_create_1h: (rates.cache_create_1h != null ? rates.cache_create_1h : rates.input * 2) / 1_000_000,
  };
}
const _sortedKeys = Object.keys(_perTokenRates).sort((a, b) => b.length - a.length);
const _defaultRate = _perTokenRates['claude-sonnet-4'] ||
  { input: 3e-6, output: 15e-6, cache_read: 0.3e-6, cache_create: 3.75e-6, cache_create_1h: 6e-6 };

// The 5m/1h split applies only to non-negative numeric tier counts; anything
// else (strings, negatives) falls back to the flat counter so a malformed
// usage object cannot produce a negative or NaN cost. Shared with pricing.js.
function hasCacheTierSplit(cc) {
  if (!cc || typeof cc !== 'object') return false;
  const t5 = cc.ephemeral_5m_input_tokens;
  const t1 = cc.ephemeral_1h_input_tokens;
  const ok = v => v == null || (Number.isFinite(v) && v >= 0);
  return (t5 != null || t1 != null) && ok(t5) && ok(t1);
}

/**
 * Calculate cost from a usage object and model name using offline rates.
 * Used by cost-worker.js (child process) and importer.js (startup import)
 * where the live LiteLLM pricing table is not available.
 *
 * Returns { cost, confidence } where confidence is one of:
 *   - 'exact'    — exact hit in the rate table
 *   - 'prefix'   — matched via model.startsWith(key) or date-strip
 *   - 'fallback' — fell back to claude-sonnet-4 default rates
 *
 * Model matching (longest-prefix-first):
 *   1. Exact match against the rate table
 *   2. model.startsWith(key) — covers versioned wire IDs (grok-4.5-build -> grok-4.5)
 *   3. model.startsWith(key.split('-202')[0]) — covers dated Claude IDs
 *      (claude-sonnet-4-5-20250514 -> claude-sonnet-4-5)
 *   4. Falls back to claude-sonnet-4 rates
 */
function calculateCostSimple(usage, model) {
  let r = null;
  let confidence = 'fallback';
  if (model) {
    // Fast path: exact match
    if (_perTokenRates[model]) {
      r = _perTokenRates[model];
      confidence = 'exact';
    } else {
      // Longest key first so grok-4.5-build -> grok-4.5 (not grok-build).
      for (const k of _sortedKeys) {
        const prefix = k.split('-202')[0];
        if (model.startsWith(k) || model.startsWith(prefix)) {
          r = _perTokenRates[k];
          confidence = 'prefix';
          break;
        }
      }
    }
  }
  if (!r) r = _defaultRate;
  // S-4 (A-4.2): split only when the ephemeral 5m/1h breakdown is numeric;
  // otherwise keep pricing the flat `cache_creation_input_tokens` counter as before.
  let cacheCost;
  const cc = usage.cache_creation;
  if (hasCacheTierSplit(cc)) {
    cacheCost = (cc.ephemeral_5m_input_tokens || 0) * r.cache_create
      + (cc.ephemeral_1h_input_tokens || 0) * r.cache_create_1h;
  } else {
    cacheCost = (usage.cache_creation_input_tokens || 0) * r.cache_create;
  }
  const cost = (usage.input_tokens || 0) * r.input
    + (usage.output_tokens || 0) * r.output
    + (usage.cache_read_input_tokens || 0) * r.cache_read
    + cacheCost;
  return { cost, confidence };
}

module.exports = {
  DEFAULT_PRICING,
  LITELLM_LAG_OVERRIDES,
  applyLagOverrides,
  getOfflineRates,
  calculateCostSimple,
  hasCacheTierSplit,
};
