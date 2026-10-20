'use strict';

// #723: the ONE read-time repricing rule (A-010 / H5), shared by every reader of
// stored index rows — restore, cold-load (routes/api), `ccxray usage` + agentflow
// (usage-query), export aggregates, and session-index aggregates. A row stored as
// { cost: null, confidence: 'unknown' } (or 'fallback') was priced before its
// model was in the rate table; the table is richer now, so each reader heals it
// IN MEMORY. Nothing is ever rewritten on disk. exact/prefix and legacy numeric
// costs (no .confidence) are left untouched.
//
// INVARIANT(#723): a reader that sums or counts stored `cost` without going
// through this module silently disagrees with the dashboard about the same row.
// Add new readers here, do not re-inline the rule.
const { calculateCost } = require('./pricing');
const { normalizeUsageForProvider, describeAgentModule } = require('./providers');

function isStaleCost(cost) {
  return !!cost && typeof cost === 'object'
    && (cost.confidence === 'fallback' || cost.confidence === 'unknown');
}

// Mutating form for callers that own a throwaway meta (restore / cold-load).
// Normalizes usage for the provider, then reprices a stale cost or a cost whose
// usage was just normalized.
function applyReadTimePricing(meta) {
  if (!meta.usage) return meta;
  // R-2/INV-2 (A-010 §2): an imported openai-provider line's usage is already
  // cache-exclusive — the Codex importer subtracts cached tokens manually
  // before writing (importer.js parseCodexSessionFile). New imports carry
  // _ccxrayUsageNormalized on the usage object itself; legacy imported lines
  // predate that marker, so treat ANY imported openai line as normalized here
  // rather than relying on the on-disk flag, or a second subtraction on
  // reload halves the input tokens (the double-normalization bug this
  // invariant exists to prevent).
  if (meta.imported && meta.provider === 'openai' && !meta.usage._ccxrayUsageNormalized) {
    meta.usage = { ...meta.usage, _ccxrayUsageNormalized: true };
  }
  const before = meta.usage;
  meta.usage = normalizeUsageForProvider(meta.provider, meta.usage);
  const usageNormalized = meta.usage !== before && meta.usage._ccxrayUsageNormalized;
  if (meta.model && (usageNormalized || isStaleCost(meta.cost))) {
    // #568: price by the upstream that served the turn (grok → xai), not the wire family.
    meta.cost = calculateCost(meta.usage, meta.model, describeAgentModule(meta.agent)?.upstreamKey || meta.provider);
  }
  return meta;
}

// Non-mutating form for readers that must not touch the row they were given
// (live store entries, rows shared with other passes): returns the cost to use.
// Only a stale cost is repriced; everything else comes back as the same value.
function repricedCost(meta) {
  if (!meta || !meta.model || !meta.usage || !isStaleCost(meta.cost)) return meta ? meta.cost : undefined;
  return applyReadTimePricing({
    provider: meta.provider, agent: meta.agent, model: meta.model,
    imported: meta.imported, usage: meta.usage, cost: meta.cost,
  }).cost;
}

// Non-mutating bulk form: a new array whose stale-cost rows are shallow copies
// carrying the repriced cost; every other row is passed through by reference.
// Callers' rows are never modified.
function repricedView(rows) {
  return rows.map(row => {
    if (!row || !isStaleCost(row.cost)) return row;
    const cost = repricedCost(row);
    return cost === row.cost ? row : { ...row, cost };
  });
}

module.exports = { isStaleCost, applyReadTimePricing, repricedCost, repricedView };
