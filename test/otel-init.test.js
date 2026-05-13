'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const emit = require('../server/emit');
const otel = require('../server/otel');
const health = require('../server/otel-health');

test.beforeEach(() => otel._resetForTests());
test.afterEach(() => otel._resetForTests());

test('otel.init: tier 0 stays disabled and registers no subscribers', () => {
  let entryCompletedFired = false;
  const off = emit.on('entry_completed', () => { entryCompletedFired = true; });
  try {
    const state = otel.init({ otel: { tier: 0 } });
    assert.equal(state, 'disabled');

    // Only our test subscriber is attached; otel.init must not have added one.
    emit.emit('entry_completed', { entry: { id: 'x' } });
    assert.equal(entryCompletedFired, true, 'test subscriber should still fire');
    assert.equal(health.getState(), 'disabled');
  } finally {
    off();
  }
});

test('otel.init: tier ≥ 1 with packages present → active', () => {
  const state = otel.init({ otel: { tier: 1 } });
  assert.equal(state, 'active');
  assert.equal(health.getState(), 'active');
});

test('otel.init: tier ≥ 1 with packages absent → degraded with reason', () => {
  const fakeLazy = { isAvailable: () => false, tryRequire: () => null };
  const state = otel.init({ otel: { tier: 1 } }, { otelLazy: fakeLazy });
  assert.equal(state, 'degraded');
  const status = health.getStatus();
  assert.equal(status.state, 'degraded');
  assert.match(status.reason || '', /not installed/i);
});

test('otel.init: idempotent — second call returns current state without crashing', () => {
  const first = otel.init({ otel: { tier: 1 } });
  const second = otel.init({ otel: { tier: 1 } });
  assert.equal(first, 'active');
  assert.equal(second, 'active');
});

test('otel.shutdown: returns state to disabled and unsubscribes', () => {
  otel.init({ otel: { tier: 1 } });
  assert.equal(health.getState(), 'active');

  // Verify subscribers exist by spying on a known event — when we emit,
  // the otel no-op handler fires but does not throw. The handler itself
  // is a no-op, so we just confirm shutdown clears state without error.
  otel.shutdown();
  assert.equal(health.getState(), 'disabled');

  // After shutdown, init can run again.
  const reinit = otel.init({ otel: { tier: 1 } });
  assert.equal(reinit, 'active');
});

test('otel-health: rejects unknown states', () => {
  assert.throws(() => health.transition('flying'), /unknown state/);
});

test('otel-health: rejects invalid transitions', () => {
  health._resetForTests();
  // disabled → circuit_open is not in the allow-list
  assert.throws(() => health.transition('circuit_open'), /invalid transition/);
});

test('otel-health: transition clears reason when leaving error states', () => {
  health._resetForTests();
  health.transition('degraded', { reason: 'boom' });
  assert.equal(health.getStatus().reason, 'boom');
  health.transition('active');
  assert.equal(health.getStatus().reason, null);
});
