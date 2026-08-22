'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { armClientShutdown, SHUTDOWN_EXIT_CODE, UNREGISTER_DEADLINE_MS } = require('../server/client-shutdown');

// A harness over the injection seams: no signals are sent to this process and
// no socket is opened, so these run alongside the e2e in
// test/hub-client-signal.e2e.test.js without touching a real hub.
function arm({ child = null, unregister, deadlineMs } = {}) {
  const handlers = new Map();
  const exits = [];
  const unregistered = [];
  const lock = { sockPath: '/tmp/ccxray-test.sock' };
  const isShuttingDown = armClientShutdown(lock, () => child, {
    hub: {
      unregisterClient: (l, pid) => {
        unregistered.push({ lock: l, pid });
        return unregister ? unregister() : Promise.resolve();
      },
    },
    exit: code => exits.push(code),
    on: (signal, fn) => handlers.set(signal, fn),
    deadlineMs,
  });
  return {
    isShuttingDown, exits, unregistered,
    setChild: next => { child = next; },
    fire: signal => handlers.get(signal)(),
    signals: [...handlers.keys()],
  };
}

const tick = () => new Promise(r => setImmediate(r));
const after = ms => new Promise(r => setTimeout(r, ms));

describe('hub-client graceful shutdown', () => {
  it('arms SIGHUP and SIGTERM, and deliberately leaves SIGINT alone', () => {
    // SIGINT is spawnAgent's no-op so the terminal reaches the foreground
    // child; arming it here would make Ctrl-C unable to abort startup.
    assert.deepEqual(arm().signals, ['SIGHUP', 'SIGTERM']);
  });

  it('forwards to a live agent instead of unregistering itself', async () => {
    const killed = [];
    const h = arm({ child: { exitCode: null, signalCode: null, kill: s => killed.push(s) } });

    h.fire('SIGHUP');
    await tick();

    // The child's exit drives spawnAgent's onExit, which owns the unregister.
    assert.deepEqual(killed, ['SIGHUP']);
    assert.deepEqual(h.unregistered, []);
    assert.deepEqual(h.exits, []);
    assert.equal(h.isShuttingDown(), false);
  });

  it('unregisters then exits when the signal lands before the agent exists', async () => {
    const h = arm();

    h.fire('SIGHUP');
    // The gate must flip synchronously: startClientMode checks it in the same
    // tick it would otherwise spawn the agent.
    assert.equal(h.isShuttingDown(), true);
    await tick();

    assert.equal(h.unregistered.length, 1);
    assert.equal(h.unregistered[0].pid, process.pid);
    assert.deepEqual(h.exits, [SHUTDOWN_EXIT_CODE]);
  });

  it('treats an agent that has already exited as no agent', async () => {
    const h = arm({ child: { exitCode: 0, signalCode: null, kill: () => { throw new Error('must not kill a dead child'); } } });

    h.fire('SIGTERM');
    await tick();

    assert.equal(h.unregistered.length, 1);
    assert.deepEqual(h.exits, [SHUTDOWN_EXIT_CODE]);
  });

  it('exits immediately on a repeat signal rather than waiting on the hub', async () => {
    let release;
    const h = arm({ unregister: () => new Promise(r => { release = r; }) });

    h.fire('SIGHUP');
    await tick();
    assert.deepEqual(h.exits, [], 'still waiting on the hub');

    h.fire('SIGHUP');
    assert.deepEqual(h.exits, [SHUTDOWN_EXIT_CODE], 'the user insisting is honoured at once');

    // The in-flight unregister must not double-exit when it finally settles.
    release();
    await tick();
    assert.deepEqual(h.exits, [SHUTDOWN_EXIT_CODE]);
    assert.equal(h.unregistered.length, 1);
  });

  it('exits on the deadline when the hub never answers', async () => {
    const h = arm({ unregister: () => new Promise(() => {}), deadlineMs: 20 });

    h.fire('SIGHUP');
    await after(60);

    // Degraded but recoverable: the hub's dead-client sweep reclaims the slot,
    // whereas a pane the user cannot close is not recoverable.
    assert.deepEqual(h.exits, [SHUTDOWN_EXIT_CODE]);
  });

  it('exits 0, matching a pane closed while the agent was running', () => {
    // The other half of this pair is in test/hub-client-signal.e2e.test.js,
    // which asserts the agent-running path also exits 0. Restating spawnAgent's
    // expression here instead would assert a hand-copy against itself and stay
    // green if that expression ever changed.
    assert.equal(SHUTDOWN_EXIT_CODE, 0);
  });

  it('bounds the wait well under the hub socket timeout', () => {
    // hubSocketRequest defaults to 3s; a deadline at or above that would never
    // fire, so this constant has to stay below it to mean anything.
    assert.ok(UNREGISTER_DEADLINE_MS > 0 && UNREGISTER_DEADLINE_MS < 3000);
  });
});
