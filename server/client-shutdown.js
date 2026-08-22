'use strict';

// Graceful shutdown for a ccxray process running in HUB CLIENT mode.
//
// INVARIANT: armClientShutdown must be called BEFORE hub.registerClient()
// resolves. Until a SIGHUP/SIGTERM listener exists those signals keep their OS
// default disposition and kill the process outright, skipping
// hub.unregisterClient() — and the hub only prunes by pid liveness every
// DEAD_CLIENT_CHECK_MS (30s, server/hub.js), so a pane closed inside the
// register→spawnAgent window left a phantom client blocking hub idle shutdown
// for half a minute. That window is the statusline check plus the spawn itself,
// ~1ms wide, which made test/hub-client-signal.e2e.test.js fail ~20% of runs
// locally and twice on CI in two days (runs 32361079591, 32473160514).
//
// SIGINT is deliberately NOT armed: spawnAgent installs a no-op so the terminal
// delivers Ctrl-C to the foreground child, and a no-op installed before a child
// exists would leave Ctrl-C unable to abort startup at all.

// A localhost unix-socket round trip, so anything approaching this bound is a
// wedged hub rather than a slow one. Exiting without the unregister is degraded
// but recoverable (the hub's dead-client sweep reclaims the slot); a pane the
// user cannot close is not.
const UNREGISTER_DEADLINE_MS = 1000;

// The exit code is part of what an observer sees, so the two sides of the
// register→spawn window should agree — but they can only agree in the common
// case, not by construction: with an agent running, spawnAgent PASSES THROUGH
// the agent's own exit code (`finish(code ?? …)`), and here there is no agent
// to pass through. An agent that handles SIGHUP exits 0, so the client exits 0
// (measured, and asserted by test/hub-client-signal.e2e.test.js); 0 here keeps
// the window invisible for that case and is the honest report anyway — nothing
// failed, we were asked to stop. The `: 1` in that expression is the
// agent-killed-by-an-unhandled-signal branch, which has no analogue on a path
// where no agent ever started.
const SHUTDOWN_EXIT_CODE = 0;

function armClientShutdown(lock, getChild, deps = {}) {
  const hub = deps.hub || require('./hub');
  const exit = deps.exit || (code => process.exit(code));
  const on = deps.on || ((signal, fn) => process.on(signal, fn));
  const deadlineMs = deps.deadlineMs ?? UNREGISTER_DEADLINE_MS;
  let shuttingDown = false;
  // Once-only, and shared by every exit path below. The repeat-signal branch
  // must go through it too: exit() is injectable, so it is not guaranteed to be
  // terminal, and without the shared guard a later-settling unregister exits a
  // second time.
  let exited = false;
  const finish = (code) => { if (exited) return; exited = true; exit(code); };

  const onSignal = (signal) => {
    const child = getChild();
    // Child alive: forwarding is enough — its exit drives spawnAgent's onExit,
    // which unregisters and exits. Nothing to do here.
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill(signal);
      return;
    }
    // A repeat signal while the unregister is still in flight is the user
    // insisting. Leave now rather than keep waiting on the hub.
    if (shuttingDown) { finish(SHUTDOWN_EXIT_CODE); return; }
    shuttingDown = true;
    const deadline = setTimeout(() => finish(SHUTDOWN_EXIT_CODE), deadlineMs);
    if (deadline.unref) deadline.unref();
    hub.unregisterClient(lock, process.pid).finally(() => {
      clearTimeout(deadline);
      finish(SHUTDOWN_EXIT_CODE);
    });
  };

  on('SIGHUP', () => onSignal('SIGHUP'));
  on('SIGTERM', () => onSignal('SIGTERM'));

  // The caller MUST gate the agent spawn on this. exit() fires on a hub socket
  // round trip, so a spawn racing it leaves the agent running with its parent
  // gone — measured before this existed: the client exited 129 while the agent
  // it had just spawned stayed alive.
  return () => shuttingDown;
}

module.exports = { armClientShutdown, SHUTDOWN_EXIT_CODE, UNREGISTER_DEADLINE_MS };
