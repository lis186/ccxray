'use strict';

// Lazy require for OpenTelemetry packages.
// Phase 1 of the OTel rollout: ccxray must run at tier 0 even when the
// @opentelemetry/* packages are absent (e.g. user installed via a minimal
// distribution). Callers ask for a package by name; we return null if it
// cannot be resolved instead of throwing.

const KNOWN_PACKAGES = new Set([
  '@opentelemetry/api',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/exporter-metrics-otlp-http',
]);

function tryRequire(name) {
  if (!KNOWN_PACKAGES.has(name)) {
    throw new Error(`otel-lazy: unknown package "${name}"`);
  }
  try {
    return require(name);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function isAvailable() {
  for (const name of KNOWN_PACKAGES) {
    if (tryRequire(name) == null) return false;
  }
  return true;
}

module.exports = { tryRequire, isAvailable, KNOWN_PACKAGES };
