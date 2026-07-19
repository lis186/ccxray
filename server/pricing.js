'use strict';

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ── Pricing ─────────────────────────────────────────────────────────
const PRICING_CACHE_PATH = path.join(__dirname, '..', 'pricing-cache.json');
const PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Stable offline fallback (per 1M tokens, USD). These are long-lived safety nets
// for Claude/OpenAI when LiteLLM fetch fails — not temporary lag patches.
const DEFAULT_PRICING = {
  'claude-opus-4-6':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-opus-4-5':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4-1':   { input: 5,  output: 25, cache_create: 6.25,  cache_read: 0.50 },
  'claude-opus-4':     { input: 15, output: 75, cache_create: 18.75, cache_read: 1.50 },
  'claude-sonnet-4':   { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-haiku-4':    { input: 0.80, output: 4, cache_create: 1,    cache_read: 0.08 },
  'claude-3-5-sonnet': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
  'claude-3-5-haiku':  { input: 0.80, output: 4, cache_create: 1,    cache_read: 0.08 },
  'claude-3-opus':     { input: 15, output: 75, cache_create: 18.75, cache_read: 1.50 },
  // OpenAI models (per 1M tokens, USD — 2026-05 rates)
  'gpt-5.5':           { input: 2,    output: 10,   cache_create: 0, cache_read: 1 },
  'gpt-5':             { input: 2,    output: 10,   cache_create: 0, cache_read: 1 },
  'gpt-4.1':           { input: 2,    output: 8,    cache_create: 0, cache_read: 0.50 },
  'gpt-4o':            { input: 2.50, output: 10,   cache_create: 0, cache_read: 1.25 },
  'gpt-4o-mini':       { input: 0.15, output: 0.60, cache_create: 0, cache_read: 0.075 },
  'o3':                { input: 2,    output: 8,    cache_create: 0, cache_read: 0.50 },
  'o3-mini':           { input: 1.10, output: 4.40, cache_create: 0, cache_read: 0.55 },
  'o4-mini':           { input: 1.10, output: 4.40, cache_create: 0, cache_read: 0.55 },
  // xAI Grok (wire bare names; LiteLLM also lists xai/… — offline safety net).
  // Prefix match covers grok-4.5-build / grok-4.5-latest variants.
  'grok-4.5':          { input: 2.00, output: 6.00, cache_create: 0, cache_read: 0.50 },
  'grok-4.5-latest':   { input: 2.00, output: 6.00, cache_create: 0, cache_read: 0.50 },
  'grok-4.5-build':    { input: 2.00, output: 6.00, cache_create: 0, cache_read: 0.50 },
  'grok-4.3':          { input: 1.25, output: 2.50, cache_create: 0, cache_read: 0.20 },
  'grok-4.3-latest':   { input: 1.25, output: 2.50, cache_create: 0, cache_read: 0.20 },
};

/**
 * Temporary rates for models LiteLLM has not listed yet (or only under a
 * provider-prefixed key we cannot match). Lifecycle:
 *
 *  1. Add row when wire shows Unknown model: <id>
 *  2. Each fetchPricing() checks `litellmKeys` against the LiteLLM table
 *  3. If ANY litellmKey is present → override is NOT applied (LiteLLM wins)
 *     and a yellow startup line reminds you to DELETE the row
 *  4. If none present → apply rates under `wireIds` until LiteLLM catches up
 *
 * Search: `LITELLM_LAG_OVERRIDES` / `pricing lag override`
 * Source of truth for rates: official provider docs (see `source` field).
 */
const LITELLM_LAG_OVERRIDES = Object.freeze([
  // grok-4.5 / grok-4.3 retired 2026-07-19: LiteLLM lists xai/grok-4.5 and xai/grok-4.3
  // (bare names come from mirrorProviderPrefixedKeys). grok-build still missing.
  Object.freeze({
    id: 'grok-build',
    wireIds: Object.freeze(['grok-build', 'grok-build-0.1']),
    litellmKeys: Object.freeze(['xai/grok-build', 'xai/grok-build-0.1', 'grok-build', 'grok-build-0.1']),
    rates: Object.freeze({ input: 1.00, output: 2.00, cache_create: 0, cache_read: 0.20 }),
    source: 'https://docs.x.ai/developers/pricing (Code API grok-build-0.1)',
    since: '2026-07-09',
    removeWhen: 'LiteLLM lists xai/grok-build or xai/grok-build-0.1',
  }),
]);

// Model → max_input_tokens from LiteLLM (populated by fetchPricing)
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

/** Mirror `provider/model` → bare `model` so wire IDs match LiteLLM rows. */
function mirrorProviderPrefixedKeys(table) {
  const out = { ...table };
  for (const [key, val] of Object.entries(table)) {
    const slash = key.indexOf('/');
    if (slash === -1) continue;
    const bare = key.slice(slash + 1);
    if (bare && out[bare] == null) out[bare] = val;
  }
  return out;
}

/**
 * Apply lag overrides on top of a LiteLLM-derived table.
 * - If LiteLLM already has any watched key → skip (LiteLLM wins) + flag for deletion
 * - Else → write rates under each wireId
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
      `Delete the row in LITELLM_LAG_OVERRIDES (server/pricing.js). Since ${s.since}.\x1b[0m`
    );
  }
}

function buildPricingTable(litellmPricing) {
  // Order: LiteLLM (+ bare mirrors) → stable DEFAULT → lag overrides only if missing.
  // Lag overrides intentionally run AFTER DEFAULT so temporary rates apply only
  // when LiteLLM lacks the model; when LiteLLM catches up they no-op.
  const mirrored = mirrorProviderPrefixedKeys(litellmPricing || {});
  const withDefaults = { ...mirrored, ...DEFAULT_PRICING };
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
