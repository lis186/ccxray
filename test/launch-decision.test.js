'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { armClientShutdown } = require('../server/client-shutdown');
const { createLaunchDecision } = require('../server/launch-decision');

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness({
  registration = null,
  unregister,
  deadlineMs = 30,
  requestTimeoutMs = 100,
  healthCheckMs = 20,
  now,
  setTimer,
  failClosed = () => false,
} = {}) {
  const exits = [];
  const spawnCalls = [];
  const handlers = new Map();
  const removed = [];
  const lock = { pid: process.pid, sockPath: '/tmp/ccxray-launch-decision.sock' };
  const hub = {
    HUB_REQUEST_TIMEOUT_MS: requestTimeoutMs,
    HUB_HEALTH_CHECK_MS: healthCheckMs,
    isPidAlive: () => true,
    unregisterClient: (...args) => unregister ? unregister(...args) : Promise.resolve({ ok: true }),
  };
  const decision = createLaunchDecision({
    command: 'claude',
    args: ['--fixture'],
    hub,
    deadlineMs,
    attachTimeoutMs: () => 1000,
    failClosed,
    logFailOpen: () => {},
    exit: code => exits.push(code),
    spawnFallback: (launch, onExit) => spawnCalls.push({ launch, onExit }),
    ...(now && { now }),
    ...(setTimer && { setTimer }),
  });
  decision.setRegistration(registration, lock);
  const shutdown = armClientShutdown(() => lock, () => null, {
    hub,
    exit: code => exits.push(code),
    on: (signal, handler) => handlers.set(signal, handler),
    off: (signal, handler) => {
      removed.push(signal);
      if (handlers.get(signal) === handler) handlers.delete(signal);
    },
    getRegistration: () => registration,
    onShutdownStart: () => decision.abortForShutdown(),
    deadlineMs,
  });
  decision.setClientShutdown(shutdown);
  return { decision, shutdown, exits, spawnCalls, handlers, removed, lock };
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { id: ++nextId, due: now + delay, unref() {} };
      timers.set(timer.id, { timer, fn });
      return timer;
    },
    async advanceBy(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.values()].sort((a, b) => a.timer.due - b.timer.due)[0];
        if (!next || next.timer.due > target) break;
        now = next.timer.due;
        timers.delete(next.timer.id);
        await next.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

describe('launch decision and client shutdown', () => {
  it('lets a signal win the shared outcome and aborts the fallback', async () => {
    const h = harness({ registration: Promise.resolve({ ok: true }) });
    h.handlers.get('SIGTERM')();
    await settle();
    assert.equal(h.decision.getOutcome(), 'aborted');
    assert.deepEqual(h.spawnCalls, []);
    assert.deepEqual(h.exits, [1]);
  });

  it('lets fallback win and removes all three client signal handlers', async () => {
    const h = harness();
    assert.equal(h.decision.decide('original', 'fixture-failure'), true);
    assert.deepEqual(h.removed.sort(), ['SIGHUP', 'SIGINT', 'SIGTERM']);
    h.handlers.get('SIGTERM')?.();
    assert.equal(h.spawnCalls.length, 1);
    h.spawnCalls[0].onExit(7);
    await settle();
    assert.deepEqual(h.exits, [7]);
  });

  it('falls back even when the ambient env sets CCXRAY_FAIL_CLOSED=1 (#721)', () => {
    const prev = process.env.CCXRAY_FAIL_CLOSED;
    process.env.CCXRAY_FAIL_CLOSED = '1';
    try {
      const h = harness();
      assert.equal(h.decision.decide('original', 'fixture-failure'), true);
      assert.equal(h.spawnCalls.length, 1);
      assert.deepEqual(h.exits, []);
    } finally {
      if (prev === undefined) delete process.env.CCXRAY_FAIL_CLOSED;
      else process.env.CCXRAY_FAIL_CLOSED = prev;
    }
  });

  it('exits 1 instead of spawning when failClosed is injected as true', () => {
    const h = harness({ failClosed: () => true });
    assert.equal(h.decision.decide('original', 'fixture-failure'), true);
    assert.deepEqual(h.spawnCalls, []);
    assert.deepEqual(h.exits, [1]);
  });

  it('uses one cleanup promise for all observers', () => {
    const h = harness({ registration: new Promise(() => {}) });
    h.decision.decide('original', 'fixture-failure');
    assert.strictEqual(h.decision.waitForCleanup(), h.decision.waitForCleanup());
  });

  it('does not exit or unregister before registration settles', async () => {
    let resolveRegistration;
    let unregisterCalls = 0;
    const registration = new Promise(resolve => { resolveRegistration = resolve; });
    const h = harness({
      registration,
      deadlineMs: 20,
      requestTimeoutMs: 100,
      unregister: () => { unregisterCalls++; return Promise.resolve({ ok: true }); },
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await sleep(200);
    assert.deepEqual(h.exits, []);
    assert.equal(unregisterCalls, 0);
    resolveRegistration({ ok: true });
    await h.decision.waitForCleanup();
    await settle();
    assert.deepEqual(h.exits, [5]);
  });

  it('exits after an acknowledged unregister', async () => {
    let unregisterCalls = 0;
    const h = harness({
      registration: Promise.resolve({ ok: true }),
      unregister: () => { unregisterCalls++; return Promise.resolve({ ok: true }); },
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await settle();
    assert.equal(unregisterCalls, 1);
    assert.deepEqual(h.exits, [5]);
  });

  it('starts the unregister deadline when the first request is sent', async () => {
    let unregisterCalls = 0;
    const h = harness({
      registration: Promise.resolve({ ok: true }),
      deadlineMs: 30,
      unregister: () => { unregisterCalls++; return new Promise(() => {}); },
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await sleep(80);
    assert.equal(unregisterCalls, 1);
    assert.deepEqual(h.exits, [5]);
  });

  it('does not retry after a delayed acknowledgement', async () => {
    let resolveUnregister;
    let unregisterCalls = 0;
    const h = harness({
      registration: Promise.resolve({ ok: true }),
      deadlineMs: 20,
      healthCheckMs: 20,
      unregister: () => {
        unregisterCalls++;
        return new Promise(resolve => { resolveUnregister = resolve; });
      },
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await sleep(30);
    await h.decision.waitForCleanup();
    resolveUnregister({ ok: true });
    await sleep(60);
    assert.equal(unregisterCalls, 1);
  });

  it('waits for the first failed unregister to settle, then retries one health interval later', async () => {
    const clock = fakeClock();
    const attempts = [];
    let activeAttempts = 0;
    let maxActiveAttempts = 0;
    let settleFirst;
    const h = harness({
      registration: Promise.resolve({ ok: true }),
      deadlineMs: 1000,
      healthCheckMs: 30,
      unregister: () => {
        const attempt = { sentAt: clock.now() };
        attempts.push(attempt);
        activeAttempts++;
        maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
        if (attempts.length === 1) {
          return new Promise(resolve => {
            settleFirst = reply => {
              attempt.settledAt = clock.now();
              activeAttempts--;
              resolve(reply);
            };
          });
        }
        activeAttempts--;
        return Promise.resolve({ ok: true });
      },
      now: clock.now,
      setTimer: clock.setTimer,
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await settle();
    assert.equal(attempts.length, 1);

    // Keep request one pending for three health intervals. A retry must not
    // overlap it, and its interval must begin only after this request settles.
    await clock.advanceBy(90);
    assert.equal(attempts.length, 1);
    assert.equal(maxActiveAttempts, 1);
    settleFirst({ ok: false });
    await settle();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].settledAt, 90);

    await clock.advanceBy(29);
    assert.equal(attempts.length, 1);
    await clock.advanceBy(1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].sentAt, attempts[0].settledAt + 30);
    assert.equal(maxActiveAttempts, 1);
    await h.decision.waitForCleanup();
    await settle();
    assert.deepEqual(h.exits, [5]);
  });

  it('stops future retries when a retry receives an acknowledgement', async () => {
    let resolveRetry;
    let unregisterCalls = 0;
    const h = harness({
      registration: Promise.resolve({ ok: true }),
      deadlineMs: 10,
      healthCheckMs: 20,
      unregister: () => {
        unregisterCalls++;
        if (unregisterCalls === 1) return Promise.resolve({ ok: false });
        return new Promise(resolve => { resolveRetry = resolve; });
      },
    });
    h.decision.decide('original', 'fixture-failure');
    h.spawnCalls[0].onExit(5);
    await h.decision.waitForCleanup();
    await sleep(35);
    assert.equal(unregisterCalls, 2);
    resolveRetry({ ok: true });
    await sleep(60);
    assert.equal(unregisterCalls, 2);
  });
});
