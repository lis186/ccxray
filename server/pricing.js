'use strict';

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// #397: DEFAULT_PRICING, LITELLM_LAG_OVERRIDES, and applyLagOverrides are
// owned by default-rates.js — the single source of truth for offline rates.
// pricing.js layers live LiteLLM data on top. Dependency arrow is one-way:
// pricing.js -> default-rates.js (never the reverse).
const {
  DEFAULT_PRICING,
  LITELLM_LAG_OVERRIDES,
  applyLagOverrides: _rawApplyLagOverrides,
} = require('./default-rates');

// ── Pricing ─────────────────────────────────────────────────────────
const PRICING_CACHE_PATH = path.join(__dirname, '..', 'pricing-cache.json');
const PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Model -> max_input_tokens from LiteLLM (populated by fetchPricing)
let contextTable = {};
// Last apply result (tests + diagnostics)
let lastLagOverrideStatus = [];
// Filled after applyLagOverrides is defined (see bottom init).
let pricingTable = {};

function ratesFromLiteLLMEntry(val) {
  return {
    input: (val.input_cost_per_token || 0) * 1_000_000,
    output: (val.output_cost_per_token || 0) * 1_000_000,
    cache_create: (val.cache_creation_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
    cache_read: (val.cache_read_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
  };
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

function buildPricingTable(litellmPricing) {
  // INVARIANT(#397 defect 1): LiteLLM wins over DEFAULT_PRICING.
  // DEFAULT is the offline floor — safety nets when LiteLLM lacks a key.
  // Lag overrides run last, only when LiteLLM still lacks the model.
  // INVARIANT(#397 defect 4): only xai/ keys are mirrored for pricing.
  // Other providers (azure_ai/, oci/) can have different rates for the same model.
  const mirrored = mirrorProviderPrefixedKeys(litellmPricing || {}, ['xai']);
  const withDefaults = { ...DEFAULT_PRICING, ...mirrored };
  return applyLagOverrides(withDefaults);
}

async function fetchPricing() {
  // Check cache first
  try {
    const cached = JSON.parse(await fsp.readFile(PRICING_CACHE_PATH, 'utf8'));
    if (Date.now() - cached.fetchedAt < PRICING_TTL_MS) {
      pricingTable = buildPricingTable(cached.pricing || {});
      if (cached.context) contextTable = mirrorProviderPrefixedKeys(cached.context);
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
          contextTable = mirroredCtx;
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

function getModelPricing(model) {
  if (!model) return null;
  if (pricingTable[model]) return pricingTable[model];
  // LiteLLM provider-prefixed form (xai/grok-4.3) when wire sent bare id
  if (!model.includes('/') && pricingTable[`xai/${model}`]) return pricingTable[`xai/${model}`];
  const keys = Object.keys(pricingTable).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return pricingTable[key];
  }
  return null;
}

function calculateCost(usage, model) {
  if (!usage) return null;
  const rates = getModelPricing(model);
  if (!rates) return { cost: null, rates: null, warning: `Unknown model: ${model}` };
  const cost =
    ((usage.input_tokens || 0) / 1_000_000) * rates.input +
    ((usage.output_tokens || 0) / 1_000_000) * rates.output +
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * rates.cache_create +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * rates.cache_read;
  return { cost, rates };
}

function getModelContext(model) {
  if (!model) return null;
  if (contextTable[model]) return contextTable[model];
  if (!model.includes('/') && contextTable[`xai/${model}`]) return contextTable[`xai/${model}`];
  const keys = Object.keys(contextTable).sort((a, b) => b.length - a.length);
  for (const key of keys) {
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
  get lastLagOverrideStatus() { return lastLagOverrideStatus; },
};
