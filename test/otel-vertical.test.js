'use strict';

// Vertical-slice integration: a real OTel MeterProvider posts to an in-process
// mock OTLP HTTP collector. Proves the full chain — init → emit → record →
// PeriodicExportingMetricReader → OTLPMetricExporter → HTTP — is wired.
//
// Body content (protobuf) is not decoded here. Asserting (1) at least one POST
// arrived at `/v1/metrics`, (2) content-type is the OTLP HTTP signature, (3)
// the body is non-empty is enough to demo the rail. Decoded-content assertions
// land with §10.3 once a protobuf transformer is on the test path.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const emit = require('../server/emit');
const otel = require('../server/otel');
const health = require('../server/otel-health');

function startMockCollector() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] || '',
        contentLength: Buffer.concat(chunks).length,
      });
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/metrics`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test.beforeEach(() => otel._resetForTests());
test.afterEach(async () => {
  await otel.shutdown();
});

test('otel vertical slice: tier 1 + endpoint → exporter posts to collector', async () => {
  const prevInterval = process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS;
  // Long interval — we drain explicitly with flush() to avoid races.
  process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS = '60000';
  const collector = await startMockCollector();

  try {
    const state = otel.init({
      otel: {
        tier: 1,
        endpoint: collector.url,
        headers: {},
        resource_attributes: { 'service.name': 'ccxray-test' },
      },
    });
    assert.equal(state, 'active');
    assert.equal(health.getState(), 'active');

    emit.emit('entry_completed', {
      entry: {
        provider: 'anthropic',
        model: 'claude-test-model',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 25,
        },
      },
    });

    await otel.flush();

    // forceFlush triggers the exporter synchronously inside the reader. Give
    // the HTTP request one tick to actually deliver to our server.
    for (let i = 0; i < 50 && collector.requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.ok(collector.requests.length > 0, 'collector should have received at least one POST');
    const first = collector.requests[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/v1/metrics');
    assert.match(first.contentType, /protobuf|json/);
    assert.ok(first.contentLength > 0, 'collector POST body must be non-empty');
  } finally {
    await collector.close();
    if (prevInterval === undefined) delete process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS;
    else process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS = prevInterval;
  }
});

test('otel vertical slice: tier 1 with no endpoint → active but no exporter', async () => {
  const state = otel.init({ otel: { tier: 1 } });
  assert.equal(state, 'active');

  // No collector, no SDK context — emit must not throw, must not record.
  emit.emit('entry_completed', {
    entry: {
      provider: 'anthropic',
      model: 'claude-test-model',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  await otel.flush(); // no-op, must not throw
  assert.equal(health.getState(), 'active');
});

test('otel vertical slice: shutdown honors 2-second cap even when provider hangs', async () => {
  const prevInterval = process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS;
  process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS = '60000';

  // Mock collector that hangs — never responds. Forces provider.shutdown() to
  // block until the timeout race resolves.
  const server = http.createServer((_req, _res) => { /* hang */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/v1/metrics`;

  try {
    otel.init({ otel: { tier: 1, endpoint: url, headers: {} } });
    emit.emit('entry_completed', {
      entry: { provider: 'anthropic', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
    });

    const t0 = Date.now();
    await otel.shutdown();
    const elapsed = Date.now() - t0;

    // Hard cap is 2000ms; give 500ms scheduler slack.
    assert.ok(elapsed < 2500, `shutdown took ${elapsed}ms, must respect 2s cap`);
    assert.equal(health.getState(), 'disabled');
  } finally {
    // Forcibly close still-open sockets from the hung exporter request,
    // otherwise server.close() waits for them to drain (~8s).
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
    if (prevInterval === undefined) delete process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS;
    else process.env.CCXRAY_OTEL_EXPORT_INTERVAL_MS = prevInterval;
  }
});

test('otel vertical slice: emit with no usage is a safe no-op', async () => {
  const collector = await startMockCollector();
  try {
    otel.init({ otel: { tier: 1, endpoint: collector.url, headers: {} } });

    // Entries without usage (e.g. proxy errors) must not break the handler.
    emit.emit('entry_completed', { entry: { provider: 'anthropic', model: 'm' } });
    emit.emit('entry_completed', { entry: null });
    emit.emit('entry_completed', {});

    await otel.flush();
    assert.equal(health.getState(), 'active');
  } finally {
    await collector.close();
  }
});
