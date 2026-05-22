'use strict';

// OTel SDK init + emit.js subscribers.
//
// Vertical-slice scope (Phase 1): tier 0 = full no-op. tier ≥ 1 +
// packages present + endpoint configured → real MeterProvider with OTLP HTTP
// exporter and the first metric family (token usage). tier ≥ 1 with packages
// present but no endpoint → active state with no exporter.
//
// Metrics registered (aligned with otel-export/spec.md):
//   ccxray.tokens.input_total          (counter, unit=tokens)
//   ccxray.tokens.output_total         (counter, unit=tokens)
//   ccxray.tokens.cache_read_total     (counter, unit=tokens)
//   ccxray.tokens.cache_creation_total (counter, unit=tokens)
//   ccxray.otel.exports_dropped_total  (counter, {signal})
//
// Circuit breaker: entry_completed payloads are enqueued when state is
// circuit_open and replayed via otel-health.onCircuitClose when active.
// When state is active or half_open, instruments.add() is called directly.
//
// Resource attribute `ccxray.source=ccxray-proxy` is always set.
// shutdown() caps provider.shutdown() at 2s and never blocks process exit.
// init() never throws; failures → degraded state.

const emit = require('./emit');
const defaultOtelLazy = require('./otel-lazy');
const health = require('./otel-health');

let initialized = false;
let unsubscribers = [];
let sdkContext = null; // { provider, reader, instruments } | null

function init(config, deps = {}) {
  if (initialized) return health.getState();
  initialized = true;

  const tier = (config && config.otel && Number.isInteger(config.otel.tier))
    ? config.otel.tier
    : 0;

  if (tier <= 0) {
    return health.getState();
  }

  const otelLazy = deps.otelLazy || defaultOtelLazy;
  if (!otelLazy.isAvailable()) {
    health.transition('degraded', { reason: 'opentelemetry packages not installed' });
    return health.getState();
  }

  try {
    if (config.otel.endpoint) {
      sdkContext = initSdk(config, otelLazy);
    }
    health.onCircuitClose(replayQueue);
    registerHandlers();
    health.transition('active');
  } catch (err) {
    sdkContext = null;
    health.transition('degraded', { reason: `SDK init failed: ${err && err.message || err}` });
  }
  return health.getState();
}

// Wraps OTLPMetricExporter to feed success/failure results to the circuit breaker.
class HealthAwareExporter {
  constructor(inner) { this._inner = inner; }

  export(metrics, resultCallback) {
    this._inner.export(metrics, result => {
      if (result.code === 0) {
        health.recordSuccess();
      } else {
        health.recordFailure(result.error && result.error.message);
      }
      resultCallback(result);
    });
  }

  forceFlush() { return this._inner.forceFlush(); }
  shutdown()   { return this._inner.shutdown(); }
}

function initSdk(config, otelLazy) {
  const sdk = otelLazy.tryRequire('@opentelemetry/sdk-metrics');
  const exp = otelLazy.tryRequire('@opentelemetry/exporter-metrics-otlp-http');
  const res = otelLazy.tryRequire('@opentelemetry/resources');
  if (!sdk || !exp || !res) {
    throw new Error('required OTel package failed to resolve');
  }

  const rawExporter = new exp.OTLPMetricExporter({
    url: config.otel.endpoint,
    headers: config.otel.headers || {},
  });

  // Wrap with health awareness so export success/failure feeds the circuit breaker.
  const exporter = new HealthAwareExporter(rawExporter);

  // Default 60s export interval, overridable for tests via env var.
  const intervalMs = Number(process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS) || 60000;
  const reader = new sdk.PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: intervalMs,
  });

  const resource = res.resourceFromAttributes({
    'ccxray.source': 'ccxray-proxy',
    ...(config.otel.resource_attributes || {}),
  });

  const provider = new sdk.MeterProvider({ resource, readers: [reader] });

  const meter = provider.getMeter('ccxray', '1');
  const instruments = {
    inputTokens: meter.createCounter('ccxray.tokens.input_total', {
      description: 'Input tokens per completed entry',
      unit: 'tokens',
    }),
    outputTokens: meter.createCounter('ccxray.tokens.output_total', {
      description: 'Output tokens per completed entry',
      unit: 'tokens',
    }),
    cacheReadTokens: meter.createCounter('ccxray.tokens.cache_read_total', {
      description: 'Cache-read input tokens per completed entry',
      unit: 'tokens',
    }),
    cacheCreationTokens: meter.createCounter('ccxray.tokens.cache_creation_total', {
      description: 'Cache-creation input tokens per completed entry',
      unit: 'tokens',
    }),
    exportsDropped: meter.createCounter('ccxray.otel.exports_dropped_total', {
      description: 'Metric payloads dropped because the export queue was full',
    }),
  };

  health.setDropsCounter(instruments.exportsDropped);

  return { provider, reader, instruments };
}

function registerHandlers() {
  unsubscribers.push(emit.on('entry_completed', onEntryCompleted));
  // Other event types land as later slices wire them up.
  unsubscribers.push(emit.on('session_started', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_unknown', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_mismatch', () => { /* tier ≥ 1 stub */ }));
  unsubscribers.push(emit.on('parser_error', () => { /* tier ≥ 1 stub */ }));
}

function onEntryCompleted(payload) {
  const state = health.getState();
  if (state === 'circuit_open') {
    health.enqueue('metrics', payload);
    return;
  }
  if (state !== 'active' && state !== 'half_open') return;
  if (!sdkContext) return;
  recordMetrics(payload);
}

function recordMetrics(payload) {
  const entry = payload && payload.entry;
  const usage = entry && entry.usage;
  if (!usage) return;

  const attrs = {
    provider: entry.provider || 'unknown',
    model: entry.model || 'unknown',
  };

  sdkContext.instruments.inputTokens.add(Number(usage.input_tokens) || 0, attrs);
  sdkContext.instruments.outputTokens.add(Number(usage.output_tokens) || 0, attrs);
  sdkContext.instruments.cacheReadTokens.add(Number(usage.cache_read_input_tokens) || 0, attrs);
  sdkContext.instruments.cacheCreationTokens.add(Number(usage.cache_creation_input_tokens) || 0, attrs);
}

// Drain buffered payloads when circuit closes and replay them into the SDK.
function replayQueue(items) {
  if (!sdkContext || !items || !items.length) return;
  for (const { signal, payload } of items) {
    if (signal === 'metrics') recordMetrics(payload);
  }
}

// Returns a Promise but is safe to ignore. The synchronous portion (before the
// first await below) is enough to make `health.getState() === 'disabled'` and
// `initialized === false` visible to immediate follow-up calls — existing
// `otel.shutdown()` callers that do not await still see the new state.
async function shutdown() {
  for (const off of unsubscribers) {
    try { off(); } catch { /* ignore */ }
  }
  unsubscribers = [];

  const ctx = sdkContext;
  sdkContext = null;

  if (health.getState() !== 'disabled') {
    health.transition('disabled');
  }
  initialized = false;

  if (ctx && ctx.provider && typeof ctx.provider.shutdown === 'function') {
    try {
      await Promise.race([
        ctx.provider.shutdown(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    } catch { /* never block process exit on shutdown errors */ }
  }
}

// Force-flush exists so tests (and a future `ccxray status --otel` command)
// can drain the reader on demand. Returns a Promise that resolves even on
// failure — never throws to the caller.
async function flush() {
  if (!sdkContext || !sdkContext.provider) return;
  try {
    await sdkContext.provider.forceFlush();
  } catch { /* ignore */ }
}

function _resetForTests() {
  // Sync drop of everything for tests that do not await shutdown.
  for (const off of unsubscribers) { try { off(); } catch {} }
  unsubscribers = [];
  sdkContext = null;
  if (health.getState() !== 'disabled') health.transition('disabled');
  initialized = false;
  health._resetForTests();
}

module.exports = { init, shutdown, flush, _resetForTests };
