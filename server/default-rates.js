'use strict';

const fs = require('fs');
const path = require('path');

// #397/A-010: Single source of truth for offline model pricing, AND the one
// rate lookup every pricing site now calls (`lookupRates`). All rates are per
// 1M tokens (USD). Consumers:
//   1. pricing.js — imports DEFAULT_PRICING, LITELLM_LAG_OVERRIDES,
//      mirrorProviderPrefixedKeys (context tables only — see the call sites
//      there) and buildRateTable (its buildPricingTable is a thin wrapper
//      around buildRateTable — see the INVARIANT there), and delegates
//      getModelPricingWithConfidence to lookupRates. Calls setRateTable(table)
//      once fetchPricing() lands a live table, so both wrappers converge on
//      the richest table seen by either path.
//   2. cost-worker.js — imports calculateCostSimple (forked child process, no
//      live pricing; lookupRates' own lazy cache read is the only pricing
//      data this process ever sees)
//   3. importer.js — imports calculateCostSimple (runs at startup, often
//      before pricing.js's fetchPricing() resolves)
//
// INVARIANT (A-010 F1, acceptance-report.md): buildRateTable() is the ONE pure
// table builder for pricing data — _ensureRateTable() (lazy singleton) and
// pricing.js's buildPricingTable() (live fetchPricing() table) both call it,
// so a LiteLLM cache shape that only matches through provider-prefix mirroring
// (e.g. a `xai/<model>` row plus a suffixed wire id) resolves the same way on
// both paths. Before this, _ensureRateTable() merged the cache without
// mirroring while buildPricingTable() did — same cache, different tables.
//
// CONSTRAINT (ADR 0015): requiring this module installs no I/O, no event
// handlers, no process lifecycle effects. lookupRates() DOES read the price-cache
// file synchronously, but only lazily on its first CALL — never at require time —
// mirroring pricing.js's ensureContextTable (C3, spec-report-r2.md §1.1). No network.
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
 * Mirror `provider/model` -> bare `model` so wire IDs match LiteLLM rows.
 * @param {string[]} [onlyProviders] - restrict to these prefixes (e.g. ['xai']).
 *   Omit to mirror all providers (safe for context windows, not for pricing).
 */
function mirrorProviderPrefixedKeys(table, onlyProviders) {
  const out = { ...table };
  for (const [key, val] of Object.entries(table)) {
    const slash = key.indexOf('/');
    if (slash === -1) continue;
    if (onlyProviders && !onlyProviders.includes(key.slice(0, slash))) continue;
    const bare = key.slice(slash + 1);
    if (bare && out[bare] == null) out[bare] = val;
  }
  return out;
}

/**
 * The one pure rate-table builder (A-010 F1): xai/ mirror -> DEFAULT_PRICING
 * floor -> lag overrides. Both _ensureRateTable() (lazy singleton, below) and
 * pricing.js's buildPricingTable() (live fetchPricing() table) call this and
 * only this, so the same litellmPricing object always produces the same table
 * regardless of which path asks. Returns what applyLagOverrides returns
 * ({ table, status }) — the caller manages the status side effect.
 *
 * INVARIANT(#397 defect 1): LiteLLM wins over DEFAULT_PRICING — DEFAULT is the
 * offline floor, only filling keys LiteLLM lacks. Lag overrides run last, only
 * when the merged table still lacks the model.
 * INVARIANT(#397 defect 4): only xai/ keys are mirrored for pricing — other
 * providers (azure_ai/, oci/) can have different rates for the same model.
 */
function buildRateTable(litellmPricing) {
  const mirrored = mirrorProviderPrefixedKeys(litellmPricing || {}, ['xai']);
  const withDefaults = { ...DEFAULT_PRICING, ...mirrored };
  return applyLagOverrides(withDefaults);
}

/**
 * Returns the fully merged per-MTok rate table (DEFAULT_PRICING + lag overrides)
 * for consumers without access to live LiteLLM data. Used internally by
 * calculateCostSimple.
 */
function getOfflineRates() {
  return applyLagOverrides({ ...DEFAULT_PRICING }).table;
}

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

// ── lookupRates: the single rate lookup (A-010 / #397) ───────────────
// One table (DEFAULT_PRICING + LITELLM_LAG_OVERRIDES + the price-cache file),
// one match rule, shared by calculateCost (pricing.js) and calculateCostSimple
// (below) so the same (model, provider) always resolves to the same rates and
// confidence, whichever path asks.
//
// _rateTable starts unset (no I/O at require time — ADR 0015). The first
// lookupRates() call reads the price-cache file SYNCHRONOUSLY (never over the
// network) via _ensureRateTable, exactly like pricing.js's ensureContextTable —
// removing the fetchPricing()-vs-restore ordering race (spec-report-r2.md §1.1
// C3): every consumer sees a consistent table immediately, without waiting for
// the async fetch. pricing.js calls setRateTable(table) once fetchPricing()
// lands a live LiteLLM table, replacing this lazy load with the richer one —
// see the INVARIANT comment at that call site.
let _rateTable = null;

function _pricingCachePath() {
  return process.env.CCXRAY_PRICING_CACHE || path.join(__dirname, '..', 'pricing-cache.json');
}

function _ensureRateTable() {
  if (_rateTable) return;
  let cachedPricing = {};
  try {
    const cached = JSON.parse(fs.readFileSync(_pricingCachePath(), 'utf8'));
    if (cached && cached.pricing && typeof cached.pricing === 'object') cachedPricing = cached.pricing;
  } catch { /* missing/unreadable cache → offline rates only */ }
  // INVARIANT(A-010 F1): buildRateTable is the ONE table builder — see the
  // INVARIANT comment at its definition. Do not re-merge/mirror inline here;
  // that duplication is exactly what let this table diverge from
  // pricing.js's buildPricingTable() (acceptance F1).
  _rateTable = buildRateTable(cachedPricing).table;
}

/**
 * Replace the shared rate table (called by pricing.js once fetchPricing()
 * lands a live LiteLLM-derived table). Test-only reset: __resetRateTableForTests.
 */
function setRateTable(table) {
  _rateTable = (table && typeof table === 'object') ? table : null;
}

/**
 * The one rate lookup (H2/INV-1/INV-3, A-010 design). Returns
 * { rates, confidence } — confidence is 'exact' or 'prefix'; on no match
 * returns { rates: null, confidence: null } and the caller decides the
 * cost/confidence shape for its own return type (H2: every wrapper maps a
 * miss to `unknown` — no path substitutes another model's rates).
 *
 * Match rule (longest-prefix-first; mirrors the retired
 * getModelPricingWithConfidence four layers — verified pricing.js:190-210):
 *   1. `${provider}/${model}` exact match (a wire id already carrying this
 *      provider's own prefix is looked up as-is; see H7/#568)
 *   2. `model` exact match
 *   3. `xai/${model}` — LiteLLM lists some Grok rows only under the xai/ prefix
 *   4. Longest-key-first prefix match, with `-202` date-strip for dated wire IDs
 *      (grok-4.5-build -> grok-4.5; claude-sonnet-4-5-20250514 -> claude-sonnet-4-5)
 */
function lookupRates(model, provider) {
  _ensureRateTable();
  if (!model) return { rates: null, confidence: null };
  const table = _rateTable;
  if (provider) {
    const key = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
    if (table[key]) return { rates: table[key], confidence: 'exact' };
  }
  if (table[model]) return { rates: table[model], confidence: 'exact' };
  if (!model.includes('/') && table[`xai/${model}`]) return { rates: table[`xai/${model}`], confidence: 'exact' };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const prefix = key.split('-202')[0];
    if (model.startsWith(key) || model.startsWith(prefix)) return { rates: table[key], confidence: 'prefix' };
  }
  return { rates: null, confidence: null };
}

/**
 * Calculate cost from a usage object, model name and (optional) upstream
 * provider key via lookupRates — the same table and match rule calculateCost
 * (pricing.js) uses. Used by cost-worker.js (child process) and importer.js
 * (startup import), where the live in-process LiteLLM table is not available.
 *
 * Returns { cost, confidence } where confidence is one of:
 *   - 'exact'   — exact hit in the rate table
 *   - 'prefix'  — matched via model.startsWith(key) or date-strip
 *   - 'unknown' — no match; cost is null (H2, A-010: no path substitutes
 *     another model's rates — the retired 'fallback' confidence/estimate).
 */
function calculateCostSimple(usage, model, provider) {
  const { rates, confidence } = lookupRates(model, provider);
  if (!rates) return { cost: null, confidence: 'unknown' };
  // H3: lookupRates returns per-million rates (like calculateCost); convert to
  // per-token here. S-4 (A-4.1): 1-hour cache-creation writes bill at 2x input,
  // not the 5-minute `cache_create` rate — derive when the row (DEFAULT_PRICING,
  // LITELLM_LAG_OVERRIDES, or an older cache file) carries no `cache_create_1h`.
  const r = {
    input: rates.input / 1_000_000,
    output: rates.output / 1_000_000,
    cache_read: rates.cache_read / 1_000_000,
    cache_create: rates.cache_create / 1_000_000,
    cache_create_1h: (rates.cache_create_1h != null ? rates.cache_create_1h : rates.input * 2) / 1_000_000,
  };
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
  mirrorProviderPrefixedKeys,
  buildRateTable,
  getOfflineRates,
  calculateCostSimple,
  hasCacheTierSplit,
  lookupRates,
  setRateTable,
  // Test-only: reset the lazily-loaded singleton without a require.cache dance.
  __resetRateTableForTests() { _rateTable = null; },
  // Test-only (A-010 F1 regression): inspect the lazily-built table itself,
  // so a test can assert it deep-equals pricing.buildPricingTable()'s output
  // for the same cache content, not just that one lookup happens to agree.
  __getRateTableForTests() { _ensureRateTable(); return _rateTable; },
};
