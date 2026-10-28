'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCcxrayHome, HOME_DIR_MODE } = require('./paths');

// Append-only log of `anthropic-ratelimit-*` headers observed from upstream responses.
// Used for future calibration of plan-specific limits (Max 5x vs 20x tokens5h quota).
// File: ~/.ccxray/ratelimit-samples.jsonl (respects CCXRAY_HOME env)

const CCXRAY_HOME = resolveCcxrayHome();
const SAMPLES_FILE = path.join(CCXRAY_HOME, 'ratelimit-samples.jsonl');

// Dedupe per model: preserve legacy limit transitions and changes in any
// unified value, including subscription utilization and rolling-window resets.
const _lastSigByModel = new Map();
let _writeFailureReported = false;

function reportWriteFailure(err) {
  if (_writeFailureReported) return;
  _writeFailureReported = true;
  // Error messages can contain local paths; report only the filesystem code.
  try { console.warn(`[ccxray] ratelimit sample write failed (${err?.code || 'unknown'}); further warnings suppressed`); } catch {}
}

function buildSignature(sample) {
  return [
    sample.tokensLimit,
    sample.inputLimit,
    sample.outputLimit,
    sample.requestsLimit,
    JSON.stringify(sample.unified || null),
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

  // Subscription windows are a different header family from API token limits.
  // Preserve their raw values (including fractional utilization) for calibration;
  // sorted keys keep deduplication independent of HTTP header ordering.
  const unified = Object.fromEntries(Object.entries(headers)
    .filter(([key, value]) => key.startsWith('anthropic-ratelimit-unified-') && typeof value === 'string')
    .sort(([a], [b]) => a.localeCompare(b)));

  // Nothing present → skip
  if (tokensLimit == null && inputLimit == null && outputLimit == null && requestsLimit == null && !Object.keys(unified).length) {
    return null;
  }

  return {
    tokensLimit, tokensRemaining, tokensReset,
    inputLimit, inputRemaining, inputReset,
    outputLimit, outputRemaining, outputReset,
    requestsLimit, requestsRemaining, requestsReset,
    ...(Object.keys(unified).length ? { unified } : {}),
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

    // Fire-and-forget: filesystem work never delays or rejects the proxy response.
    Promise.resolve()
      .then(() => fs.promises.mkdir(CCXRAY_HOME, { recursive: true, mode: HOME_DIR_MODE }))
      .then(() => fs.promises.appendFile(SAMPLES_FILE, JSON.stringify(sample) + '\n', { mode: 0o600 }))
      .catch(err => {
        // A failed append must not suppress an identical future retry.
        if (_lastSigByModel.get(modelKey) === sig) _lastSigByModel.delete(modelKey);
        reportWriteFailure(err);
      });
  } catch (err) {
    reportWriteFailure(err);
  }
}

module.exports = {
  appendSample,
  SAMPLES_FILE,
  collectRatelimitHeaders, // exported for testing
};
