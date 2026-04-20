'use strict';

// Central registry of Claude Code subscription plans and their observable
// parameters. Consumed by plan-detector, cache-countdown display, cost/quota
// panel fallbacks, and notification defaults.
//
// Calibration source:
// - cacheTtlMs: Anthropic docs — Max subscribers auto get 1h TTL, Pro/API 5m
// - tokens5h: approximate 5-hour rolling window quota. Current values are
//     placeholders sourced from the previous hardcoded `TOKEN_LIMIT=220_000`
//     in cost-budget.js (which corresponded to Max 20x). Real values to be
//     calibrated from `~/.ccxray/ratelimit-samples.jsonl` once accumulated;
//     see `scripts/analyze-ratelimit-samples.mjs`.
// - monthlyUSD: published subscription prices.

const PLAN_CONFIG = {
  'pro': {
    tokens5h:     50_000,     // ~1/4 of Max 5x (placeholder, calibrate later)
    monthlyUSD:       20,
    cacheTtlMs:  300_000,     // 5 min
    label:         'Pro',
  },
  'max5x': {
    tokens5h:    220_000,     // legacy hardcode value; may actually be lower
    monthlyUSD:      100,
    cacheTtlMs: 3_600_000,    // 1 h
    label:      'Max 5x',
  },
  'max20x': {
    tokens5h:    880_000,     // 4× of max5x guess
    monthlyUSD:      200,
    cacheTtlMs: 3_600_000,    // 1 h
    label:     'Max 20x',
  },
  'api-key': {
    tokens5h:          0,     // metered — no fixed 5h window
    monthlyUSD:        0,
    cacheTtlMs:  300_000,     // 5 min (API default)
    label:     'API key',
  },
};

const DEFAULT_PLAN = 'api-key';

function getPlanConfig(planId) {
  return PLAN_CONFIG[planId] || PLAN_CONFIG[DEFAULT_PLAN];
}

function isKnownPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLAN_CONFIG, planId);
}

module.exports = {
  PLAN_CONFIG,
  DEFAULT_PLAN,
  getPlanConfig,
  isKnownPlan,
};
