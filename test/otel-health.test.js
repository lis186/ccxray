'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const health = require('../server/otel-health');

test.beforeEach(() => health._resetForTests());
test.afterEach(() => health._resetForTests());

// ─── Bounded queue ─────────────────────────────────────────────────────────

test('otel-health queue: enqueue buffers payloads', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.enqueue('metrics', { entry: { id: '1' } });
  health.enqueue('metrics', { entry: { id: '2' } });
  assert.equal(health.getStatus().queueDepth, 2);
});

test('otel-health queue: drainQueue empties and returns all items', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.enqueue('metrics', { entry: { id: 'a' } });
  health.enqueue('metrics', { entry: { id: 'b' } });

  const items = health.drainQueue();
  assert.equal(items.length, 2);
  assert.equal(items[0].payload.entry.id, 'a');
  assert.equal(items[1].payload.entry.id, 'b');
  assert.equal(health.getStatus().queueDepth, 0);
});

test('otel-health queue: drop-oldest when full, increments counter via setDropsCounter', () => {
  // Override queue max to 2 for this test by filling it artificially.
  // We'll use the default size but only need to verify drop-oldest semantics
  // by checking the dropsCounter is called.
  let dropCalls = [];
  health.setDropsCounter({ add: (n, attrs) => dropCalls.push({ n, attrs }) });

  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });

  // Enqueue 2049 items — the 2049th should evict the first.
  for (let i = 0; i < 2049; i++) {
    health.enqueue('metrics', { entry: { id: String(i) } });
  }

  const items = health.drainQueue();
  assert.equal(items.length, 2048, 'queue stays at max 2048');
  assert.equal(items[0].payload.entry.id, '1', 'oldest (id=0) was dropped');
  assert.equal(dropCalls.length, 1);
  assert.equal(dropCalls[0].attrs.signal, 'metrics');
});

// ─── Circuit breaker ───────────────────────────────────────────────────────

test('otel-health circuit: 5 consecutive failures trip the circuit', () => {
  health.transition('active');
  for (let i = 0; i < 4; i++) {
    health.recordFailure('err');
    assert.equal(health.getState(), 'active', `should still be active after ${i + 1} failures`);
  }
  health.recordFailure('err');
  assert.equal(health.getState(), 'circuit_open');
  assert.equal(health.getStatus().consecutiveFailures, 5);
});

test('otel-health circuit: success before threshold resets consecutive counter', () => {
  health.transition('active');
  health.recordFailure('err');
  health.recordFailure('err');
  health.recordSuccess();
  assert.equal(health.getState(), 'active');
  assert.equal(health.getStatus().consecutiveFailures, 0);
  assert.equal(health.getStatus().cooldownMs, 60_000, 'cooldown resets to initial on success');
});

test('otel-health circuit: half_open success returns to active', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.transition('half_open');
  health.recordSuccess();
  assert.equal(health.getState(), 'active');
  assert.equal(health.getStatus().consecutiveFailures, 0);
  assert.equal(health.getStatus().cooldownMs, 60_000);
});

test('otel-health circuit: half_open failure doubles cooldown and re-trips', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.transition('half_open');
  health.recordFailure('still down');
  assert.equal(health.getState(), 'circuit_open');
  assert.equal(health.getStatus().cooldownMs, 120_000, 'cooldown doubles to 120s');
});

test('otel-health circuit: cooldown is capped at 600s', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });

  // Simulate repeated half_open → failure cycles. Each doubles cooldown:
  // 60 → 120 → 240 → 480 → 600 (capped)
  const steps = [120_000, 240_000, 480_000, 600_000, 600_000];
  for (const expected of steps) {
    health.transition('half_open');
    health.recordFailure('err');
    assert.equal(health.getState(), 'circuit_open');
    assert.equal(health.getStatus().cooldownMs, expected, `expected cooldown ${expected}ms`);
  }
});

test('otel-health circuit: onCircuitClose fires with drained items when transitioning active', () => {
  let received = null;
  health.onCircuitClose(items => { received = items; });

  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.enqueue('metrics', { entry: { id: 'x' } });
  health.transition('half_open');
  health.recordSuccess(); // triggers transition to active → calls onCircuitClose

  assert.ok(received, 'onCircuitClose callback should have fired');
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.entry.id, 'x');
  assert.equal(health.getStatus().queueDepth, 0);
});

// ─── State machine ─────────────────────────────────────────────────────────

test('otel-health: half_open is a valid state with correct transitions', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'test' });
  health.transition('half_open'); // circuit_open → half_open should be valid
  assert.equal(health.getState(), 'half_open');
});

test('otel-health: disabled → circuit_open is still invalid', () => {
  assert.throws(() => health.transition('circuit_open'), /invalid transition/);
});

test('otel-health: getStatus includes circuit breaker fields', () => {
  health.transition('active');
  health.transition('circuit_open', { reason: 'trip' });
  const status = health.getStatus();
  assert.ok('queueDepth' in status);
  assert.ok('consecutiveFailures' in status);
  assert.ok('cooldownMs' in status);
  assert.ok('cooldownUntil' in status);
  assert.equal(status.reason, 'trip');
});
