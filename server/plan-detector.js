'use strict';

// Auto-detect Claude Code subscription plan from response usage data.
//
// Signal: `usage.cache_creation.ephemeral_5m_input_tokens` vs
//         `usage.cache_creation.ephemeral_1h_input_tokens`
//
// Claude Code chooses cache TTL based on the user's subscription plan:
// - Max (5x / 20x): 1h TTL → ephemeral_1h_input_tokens > 0
// - Pro / API key : 5m TTL → ephemeral_5m_input_tokens > 0
//
// 5x vs 20x cannot be distinguished from cache data (same TTL). That
// distinction requires `anthropic-ratelimit-tokens-limit` headers; see
// `ratelimit-log.js` for future calibration.

const { isKnownPlan } = require('./plans');

const MIN_SAMPLES_FOR_HIGH_CONFIDENCE = 5;
const WINDOW_SIZE = 20;

// detectPlan
// @param recentUsages: Array<{ cache_creation?: { ephemeral_5m_input_tokens?: number, ephemeral_1h_input_tokens?: number } }>
// @returns { plan: 'max5x'|'pro'|null, confidence: 'high'|'low'|'insufficient', source: 'auto' }
function detectPlan(recentUsages) {
  const withCacheWrites = (recentUsages || [])
    .map(u => u && u.cache_creation)
    .filter(c => {
      if (!c) return false;
      const e5 = c.ephemeral_5m_input_tokens || 0;
      const e1 = c.ephemeral_1h_input_tokens || 0;
      return e5 > 0 || e1 > 0;
    })
    .slice(-WINDOW_SIZE);

  if (withCacheWrites.length < MIN_SAMPLES_FOR_HIGH_CONFIDENCE) {
    return { plan: null, confidence: 'insufficient', source: 'auto' };
  }

  const has1h = withCacheWrites.some(c => (c.ephemeral_1h_input_tokens || 0) > 0);
  const all5m = withCacheWrites.every(c =>
    (c.ephemeral_1h_input_tokens || 0) === 0 &&
    (c.ephemeral_5m_input_tokens || 0) > 0
  );

  if (has1h) {
    // Max plan confirmed. Default to max5x (conservative); 20x distinction
    // needs rate-limit header calibration (Phase 3.2).
    return { plan: 'max5x', confidence: 'high', source: 'auto' };
  }
  if (all5m) {
    return { plan: 'pro', confidence: 'high', source: 'auto' };
  }
  // Mixed (possible silent regression) — caller should fallback
  return { plan: null, confidence: 'low', source: 'auto' };
}

// getEffectivePlan — layered resolution:
//   1. CCXRAY_PLAN env (overrides detection)
//   2. auto-detect from recent usages
//   3. default 'api-key' (most conservative)
//
// @returns { plan, source: 'env'|'auto'|'default', confidence }
function getEffectivePlan({ envValue, recentUsages } = {}) {
  const envRaw = (envValue !== undefined ? envValue : process.env.CCXRAY_PLAN) || '';
  const envPlan = envRaw.toLowerCase().trim();
  if (envPlan && isKnownPlan(envPlan)) {
    return { plan: envPlan, source: 'env', confidence: 'high' };
  }

  const detected = detectPlan(recentUsages);
  if (detected.plan && detected.confidence === 'high') {
    return { plan: detected.plan, source: 'auto', confidence: 'high' };
  }

  // Fallback: insufficient data or ambiguous → api-key (most conservative)
  return { plan: 'api-key', source: 'default', confidence: detected.confidence };
}

module.exports = {
  detectPlan,
  getEffectivePlan,
  MIN_SAMPLES_FOR_HIGH_CONFIDENCE,
  WINDOW_SIZE,
};
