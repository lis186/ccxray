'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Append-only log of `anthropic-ratelimit-*` headers observed from upstream responses.
// Used for future calibration of plan-specific limits (Max 5x vs 20x tokens5h quota).
// File: ~/.ccxray/ratelimit-samples.jsonl (respects CCXRAY_HOME env)

const CCXRAY_HOME = process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
const SAMPLES_FILE = path.join(CCXRAY_HOME, 'ratelimit-samples.jsonl');

// Dedupe per model: skip writing if headers identical to last sample for
// the same model. Anthropic usually returns identical limits for consecutive
// requests; we only care about transitions (rolling window reset, plan change).
const _lastSigByModel = new Map();

function buildSignature(sample) {
  return [
    sample.tokensLimit,
    sample.inputLimit,
    sample.outputLimit,
    sample.requestsLimit,
  ].join('|');
}

function collectRatelimitHeaders(headers) {
  const g = (k) => headers[k];
  const num = (k) => { const v = parseInt(g(k), 10); return Number.isFinite(v) ? v : null; };

  const tokensLimit      = num('anthropic-ratelimit-tokens-limit');
  const tokensRemaining  = num('anthropic-ratelimit-tokens-remaining');
  const tokensReset      = g('anthropic-ratelimit-tokens-reset') || null;
  const inputLimit       = num('anthropic-ratelimit-input-tokens-limit');
  const inputRemaining   = num('anthropic-ratelimit-input-tokens-remaining');
  const inputReset       = g('anthropic-ratelimit-input-tokens-reset') || null;
  const outputLimit      = num('anthropic-ratelimit-output-tokens-limit');
  const outputRemaining  = num('anthropic-ratelimit-output-tokens-remaining');
  const outputReset      = g('anthropic-ratelimit-output-tokens-reset') || null;
  const requestsLimit    = num('anthropic-ratelimit-requests-limit');
  const requestsRemaining= num('anthropic-ratelimit-requests-remaining');
  const requestsReset    = g('anthropic-ratelimit-requests-reset') || null;

  // Nothing present → skip
  if (tokensLimit == null && inputLimit == null && requestsLimit == null) {
    return null;
  }

  return {
    tokensLimit, tokensRemaining, tokensReset,
    inputLimit, inputRemaining, inputReset,
    outputLimit, outputRemaining, outputReset,
    requestsLimit, requestsRemaining, requestsReset,
  };
}

// `parsed` can be passed pre-computed by the caller to avoid double-parsing
// the same headers; otherwise parsed from `headers`.
function appendSample({ headers, parsed, model, planHint }) {
  try {
    const rl = parsed || collectRatelimitHeaders(headers);
    if (!rl) return;

    const modelKey = model || '_unknown';
    const sig = buildSignature(rl);
    if (_lastSigByModel.get(modelKey) === sig) return;
    _lastSigByModel.set(modelKey, sig);

    const sample = {
      ts: new Date().toISOString(),
      model: model || null,
      planHint: planHint || null,
      ...rl,
    };

    // Fire-and-forget append; errors are silent (logging must not block proxy)
    fs.promises.appendFile(SAMPLES_FILE, JSON.stringify(sample) + '\n').catch(() => {});
  } catch {
    // never throw
  }
}

module.exports = {
  appendSample,
  SAMPLES_FILE,
  collectRatelimitHeaders, // exported for testing
};
