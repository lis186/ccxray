'use strict';

// OTel SDK init + emit.js subscribers.
//
// Phase 2b scope: wire the subscriber frame. tier 0 = full no-op (no
// require of @opentelemetry/*, no subscribers, no SDK). tier ≥ 1
// resolves the lazy packages; if any are missing, transitions to
// degraded and keeps the proxy running. If packages are present,
// registers no-op subscribers and transitions to active. Metric
// registry, View API setup, and the actual MeterProvider land in
// Phase 2c+ — keeping this file small until the cardinality budget
// design is wired in.
//
// Never throws into the caller. init() returns the resulting health state.

const emit = require('./emit');
const defaultOtelLazy = require('./otel-lazy');
const health = require('./otel-health');

let initialized = false;
let unsubscribers = [];

function init(config, deps = {}) {
  if (initialized) return health.getState();
  initialized = true;

  const tier = (config && config.otel && Number.isInteger(config.otel.tier))
    ? config.otel.tier
    : 0;

  if (tier <= 0) {
    // tier 0 pays nothing: do not load OTel, do not subscribe.
    return health.getState();
  }

  const otelLazy = deps.otelLazy || defaultOtelLazy;
  if (!otelLazy.isAvailable()) {
    health.transition('degraded', { reason: 'opentelemetry packages not installed' });
    return health.getState();
  }

  // Phase 2b: register stub subscribers so the bus wiring is exercised
  // without committing to a metric registry shape. Each handler stays a
  // no-op until Phase 2c attaches actual instruments.
  unsubscribers.push(emit.on('entry_completed', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('session_started', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_unknown', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_mismatch', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_error', () => { /* tier ≥ 1 stub */ }));

  health.transition('active');
  return health.getState();
}

function shutdown() {
  for (const off of unsubscribers) {
    try { off(); } catch { /* ignore */ }
  }
  unsubscribers = [];
  if (health.getState() !== 'disabled') {
    health.transition('disabled');
  }
  initialized = false;
}

function _resetForTests() {
  shutdown();
  health._resetForTests();
}

module.exports = { init, shutdown, _resetForTests };
