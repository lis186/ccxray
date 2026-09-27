'use strict';

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// #397/A-010: DEFAULT_PRICING, LITELLM_LAG_OVERRIDES, and applyLagOverrides are
// owned by default-rates.js — the single source of truth for offline rates.
// lookupRates is the single rate lookup: getModelPricingWithConfidence below
// delegates to it instead of matching against this file's own `pricingTable`,
// so calculateCost and calculateCostSimple always resolve the same (model,
// provider) to the same rates/confidence (INV-1). setRateTable pushes this
// file's live LiteLLM-derived table back into default-rates.js once
// fetchPricing() lands it — see the two call sites below. Dependency arrow is
// one-way: pricing.js -> default-rates.js (never the reverse).
//
// INVARIANT (A-010 F1): buildRateTable is default-rates.js's ONE pure table
// builder — this file's buildPricingTable() (below) is a thin wrapper around
// it, so this file's live table and default-rates.js's own lazy singleton
// (_ensureRateTable) can never diverge. mirrorProviderPrefixedKeys is also
// owned there now; this file still uses it for context tables (pricing and
// context windows mirror the same way, just with different `onlyProviders`).
const {
  LITELLM_LAG_OVERRIDES,
  applyLagOverrides: _rawApplyLagOverrides,
  mirrorProviderPrefixedKeys,
  buildRateTable: _rawBuildRateTable,
  hasCacheTierSplit,
  lookupRates,
  setRateTable,
} = require('./default-rates');

// ── Pricing ─────────────────────────────────────────────────────────
// Package-relative, so it is outside CCXRAY_HOME isolation. CCXRAY_PRICING_CACHE
// lets a test (or a read-only install) point it somewhere else or at a path that
// does not exist, keeping window resolution independent of the developer's cache.
const PRICING_CACHE_PATH = process.env.CCXRAY_PRICING_CACHE
  || path.join(__dirname, '..', 'pricing-cache.json');
const PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Model -> max_input_tokens from LiteLLM (populated by fetchPricing)
let contextTable = {};
// Last apply result (tests + diagnostics)
let lastLagOverrideStatus = [];
// Filled after applyLagOverrides is defined (see bottom init).
let pricingTable = {};

function ratesFromLiteLLMEntry(val) {
  const input = (val.input_cost_per_token || 0) * 1_000_000;
  return {
    input,
    output: (val.output_cost_per_token || 0) * 1_000_000,
    cache_create: (val.cache_creation_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
    cache_read: (val.cache_read_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
    // S-4 (A-4.1): 1-hour cache-creation rate. LiteLLM wins when it lists the
    // field; otherwise derive 2x input (Anthropic's published 1h rate), never
    // the 5-minute `cache_create` rate.
    cache_create_1h: val.cache_creation_input_token_cost_above_1hr
      ? val.cache_creation_input_token_cost_above_1hr * 1_000_000
      : input * 2,
  };
}

/**
 * Wrapper around default-rates.js's pure applyLagOverrides — manages the
 * lastLagOverrideStatus side effect that logLagOverrideStatus reads.
 * Preserves the existing API: returns the merged table (not { table, status }).
 */
function applyLagOverrides(litellmTable) {
  const { table, status } = _rawApplyLagOverrides(litellmTable);
  lastLagOverrideStatus = status;
  return table;
}

function logLagOverrideStatus(status) {
  const active = status.filter(s => s.active);
  const retire = status.filter(s => s.action === 'remove-override');
  if (active.length) {
    const ids = active.map(s => s.id).join(', ');
    console.log(`\x1b[90m   Pricing lag overrides active: ${ids} (remove when LiteLLM lists them)\x1b[0m`);
  }
  for (const s of retire) {
    console.log(
      `\x1b[33m   ⚠ pricing lag override obsolete: ${s.id} — LiteLLM has ${s.presentKeys.join(', ')}. ` +
      `Delete the row in LITELLM_LAG_OVERRIDES (server/default-rates.js). Since ${s.since}.\x1b[0m`
    );
  }
}

// INVARIANT (A-010 F1): thin wrapper around default-rates.js's buildRateTable —
// the SAME pure builder _ensureRateTable() calls for the lazy singleton, so
// this file's live (fetchPricing()) table and that lazy table can never
// diverge on the same litellmPricing input (acceptance F1: they used to —
// this function mirrored xai/ keys, _ensureRateTable() did not). Only the
// lastLagOverrideStatus side effect is owned here.
function buildPricingTable(litellmPricing) {
  const { table, status } = _rawBuildRateTable(litellmPricing || {});
  lastLagOverrideStatus = status;
  return table;
}

async function fetchPricing() {
  // Check cache first
  try {
    const cached = JSON.parse(await fsp.readFile(PRICING_CACHE_PATH, 'utf8'));
    if (Date.now() - cached.fetchedAt < PRICING_TTL_MS) {
      pricingTable = buildPricingTable(cached.pricing || {});
      // INVARIANT(#397/A-010, INV-1): push the live table into default-rates.js's
      // shared lookupRates table so calculateCostSimple (importer/cost-worker,
      // in-process only — this call never reaches the forked cost-worker) sees
      // the same rates calculateCost does. Only on a successful load — a failure
      // branch below must NOT call this, or it would overwrite whatever
      // lookupRates already read from the cache file with a cache-less table.
      setRateTable(pricingTable);
      if (cached.context) setContextTable(mirrorProviderPrefixedKeys(cached.context));
      console.log(`\x1b[90m   Pricing loaded from cache (${new Date(cached.fetchedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })})\x1b[0m`);
      logLagOverrideStatus(lastLagOverrideStatus);
      return;
    }
  } catch {}

  // Fetch from LiteLLM
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const req = https.get(LITELLM_URL, (res) => {
      if (res.statusCode !== 200) {
        console.log(`\x1b[33m   ⚠ Pricing fetch failed (${res.statusCode}), using defaults\x1b[0m`);
        pricingTable = buildPricingTable({});
        logLagOverrideStatus(lastLagOverrideStatus);
        return done();
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const fetched = {};
          const fetchedCtx = {};
          for (const [key, val] of Object.entries(data)) {
            if (val.input_cost_per_token) {
              fetched[key] = ratesFromLiteLLMEntry(val);
            }
            if (val.max_input_tokens) {
              fetchedCtx[key] = val.max_input_tokens;
            }
          }
          const mirroredCtx = mirrorProviderPrefixedKeys(fetchedCtx);
          fsp.writeFile(PRICING_CACHE_PATH, JSON.stringify({
            fetchedAt: Date.now(),
            pricing: fetched,
            context: mirroredCtx,
          }, null, 2)).catch(e => console.error('Write pricing cache failed:', e.message));
          pricingTable = buildPricingTable(fetched);
          // INVARIANT(#397/A-010, INV-1): see the cache-hit branch above — same
          // rule, only on success.
          setRateTable(pricingTable);
          setContextTable(mirroredCtx);
          console.log(`\x1b[90m   Pricing fetched: ${Object.keys(fetched).length} models, ${Object.keys(fetchedCtx).length} context windows\x1b[0m`);
          logLagOverrideStatus(lastLagOverrideStatus);
        } catch (e) {
          console.log(`\x1b[33m   ⚠ Pricing parse error, using defaults\x1b[0m`);
          pricingTable = buildPricingTable({});
          logLagOverrideStatus(lastLagOverrideStatus);
        }
        done();
      });
    }).on('error', () => {
      console.log(`\x1b[33m   ⚠ Pricing fetch error, using defaults\x1b[0m`);
      pricingTable = buildPricingTable({});
      logLagOverrideStatus(lastLagOverrideStatus);
      resolve();
    });
    req.setTimeout(5000, () => {
      req.destroy();
      console.log(`\x1b[33m   ⚠ Pricing fetch timeout, using defaults\x1b[0m`);
      pricingTable = buildPricingTable({});
      logLagOverrideStatus(lastLagOverrideStatus);
      resolve();
    });
  });
}

/**
 * Look up pricing rates for a model. Returns { rates, confidence } where
 * confidence is 'exact', 'prefix', or null (not found).
 * The bare getModelPricing(model) call returns just the rates for backward
 * compat; getModelPricingWithConfidence returns the full object.
 *
 * #397/A-010 (INV-1): delegates to default-rates.js's lookupRates — the one
 * rate lookup every pricing site shares — instead of matching against this
 * file's own `pricingTable` directly, so calculateCost and calculateCostSimple
 * can never disagree on the same (model, provider). See the `setRateTable`
 * call sites in fetchPricing() for how this file's live table reaches it.
 *
 * #568: `provider` is the upstream key in LiteLLM's prefix vocabulary
 * (anthropic, openai, xai, fireworks_ai, together_ai …). The same model can be
 * served at different rates by different upstreams (LiteLLM lists both
 * `deepseek-v4-pro` and `fireworks_ai/deepseek-v4-pro`), so a known provider
 * checks its `provider/model` row first; a missing row falls back to the
 * model-only lookup, which is unchanged when provider is omitted.
 */
function getModelPricingWithConfidence(model, provider) {
  if (!model) return { rates: null, confidence: null };
  return lookupRates(model, provider);
}

function getModelPricing(model, provider) {
  return getModelPricingWithConfidence(model, provider).rates;
}

// #568: provider is optional; see getModelPricingWithConfidence.
function calculateCost(usage, model, provider) {
  if (!usage) return null;
  const { rates, confidence: rateConfidence } = getModelPricingWithConfidence(model, provider);
  if (!rates) return { cost: null, rates: null, confidence: 'unknown', warning: `Unknown model: ${model}` };
  // S-4 (A-4.1/A-4.2): split 5m/1h cache-creation tokens at their own rates when
  // the ephemeral breakdown is numeric; otherwise price the flat counter as
  // before. `rates` may come from DEFAULT_PRICING or an old pricing-cache.json
  // row with no `cache_create_1h` field — derive 2x input, never `cache_create`.
  const cacheCreate1h = rates.cache_create_1h != null ? rates.cache_create_1h : rates.input * 2;
  let cacheCost;
  const cc = usage.cache_creation;
  if (hasCacheTierSplit(cc)) {
    cacheCost = ((cc.ephemeral_5m_input_tokens || 0) / 1_000_000) * rates.cache_create
      + ((cc.ephemeral_1h_input_tokens || 0) / 1_000_000) * cacheCreate1h;
  } else {
    cacheCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * rates.cache_create;
  }
  const cost =
    ((usage.input_tokens || 0) / 1_000_000) * rates.input +
    ((usage.output_tokens || 0) / 1_000_000) * rates.output +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * rates.cache_read +
    cacheCost;
  return { cost, rates, confidence: rateConfidence };
}

// fetchPricing() is async and is awaited AFTER listen() and AFTER
// restoreFromLogs() (server/index.js), so live turns and the restore heal pass
// both ask for context windows while contextTable is still empty. Reading the
// cache synchronously on first use removes that ordering dependency: without
// it, the same model resolves to a different window before and after the fetch
// resolves — the intra-session sawtooth ADR 0013 exists to prevent. TTL is
// deliberately ignored: a model's *capability* does not expire, and the async
// fetch overwrites this table when it lands.
let contextTableLoadAttempted = false;
function ensureContextTable() {
  if (contextTableLoadAttempted || Object.keys(contextTable).length) return;
  contextTableLoadAttempted = true;
  try {
    const cached = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (cached.context) setContextTable(mirrorProviderPrefixedKeys(cached.context));
  } catch {}
}

// The prefix scan sorts ~4,200 keys. It used to run only for models missing
// from MODEL_CONTEXT_FALLBACK; the 1M capability gate now consults this table
// for every Claude turn, so the sort is memoized per table instead of per call.
let contextKeysByLength = null;
function setContextTable(next) {
  contextTable = next;
  contextKeysByLength = null;
}
function contextKeys() {
  if (!contextKeysByLength) contextKeysByLength = Object.keys(contextTable).sort((a, b) => b.length - a.length);
  return contextKeysByLength;
}

function getModelContext(model) {
  if (!model) return null;
  ensureContextTable();
  if (contextTable[model]) return contextTable[model];
  if (!model.includes('/') && contextTable[`xai/${model}`]) return contextTable[`xai/${model}`];
  for (const key of contextKeys()) {
    if (model.startsWith(key)) return contextTable[key];
  }
  return null;
}

// Cold start: defaults + lag overrides (no LiteLLM yet). fetchPricing() rebuilds.
pricingTable = buildPricingTable({});

module.exports = {
  fetchPricing,
  getModelPricing,
  getModelContext,
  calculateCost,
  get pricingTable() { return pricingTable; },
  // Exported for tests + maintenance tooling
  LITELLM_LAG_OVERRIDES,
  applyLagOverrides,
  buildPricingTable,
  ratesFromLiteLLMEntry,
  // Tests inject a table instead of reading the developer's pricing-cache.json,
  // which is package-relative and therefore outside CCXRAY_HOME isolation.
  __setContextTableForTests(table) {
    setContextTable(table ? mirrorProviderPrefixedKeys(table) : {});
    contextTableLoadAttempted = true;
  },
  get lastLagOverrideStatus() { return lastLagOverrideStatus; },
};
