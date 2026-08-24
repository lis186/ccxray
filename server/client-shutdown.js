'use strict';

// Graceful shutdown for a ccxray process running in HUB CLIENT mode.
//
// INVARIANT: armClientShutdown must be called BEFORE hub.registerClient() is
// invoked. Until a listener exists, SIGHUP/SIGTERM/SIGINT keep their OS default
// disposition and kill the process outright, skipping hub.unregisterClient() —
// and the hub only prunes by pid liveness every DEAD_CLIENT_CHECK_MS (30s,
// server/hub.js), so a pane closed inside the register→spawnAgent window left a
// phantom client blocking hub idle shutdown for half a minute. That window is
// the statusline check plus the spawn itself, ~1ms wide, which made
// test/hub-client-signal.e2e.test.js fail ~20% of runs locally and twice on CI
// in two days (runs 32361079591, 32473160514).
//
// test/hub-client-signal.e2e.test.js drives this end to end by standing up a
// FAKE hub socket and simply not answering `register` until it chooses to, which
// makes that window as wide as the test wants with no test-only branch in the
// server. test/client-shutdown.test.js covers the interleavings even that cannot
// reach, plus the source-order facts, the way
// test/invariant-encapsulation.test.js pins the store push sites.

// PER PHASE, not for the shutdown as a whole. Each is a localhost unix-socket
// round trip, so anything approaching this bound is a wedged hub rather than a
// slow one. Exiting without the unregister is degraded but recoverable (the
// hub's dead-client sweep reclaims the slot); a pane the user cannot close is
// not, which is why the worst case stays at 2× this rather than growing with
// however long the hub takes.
const UNREGISTER_DEADLINE_MS = 1000;

// ONE mapping, shared with spawnAgent's child-exit handler, which uses it as
// `finish(code ?? signalExitCode(signal))`. Two separate constants would let the
// same interrupted launch report different codes depending on which side of the
// spawn the signal landed on — the very window this module exists to hide.
//
// With an agent running the client passes through the AGENT's own code, so an
// agent that traps SIGHUP still reports its own 0. This mapping covers the case
// where no agent handled the signal, which is exactly the no-agent path's
// situation, and 130-for-SIGINT is the shell convention the child-exit handler
// already used.
function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 1;
}

// getLock              — the CURRENT hub lock. A getter, not a value: hub crash
//                        recovery hands the client a different hub, and
//                        unregistering from the dead one releases nothing.
// getChild             — the spawned agent, or null before spawnAgent runs.
// deps.getRegistration — the LATEST in-flight hub.registerClient() promise
//                        (recovery re-registration included), or null while no
//                        registration has been started.
function armClientShutdown(getLock, getChild, deps = {}) {
  const hub = deps.hub || require('./hub');
  const exit = deps.exit || (code => process.exit(code));
  const on = deps.on || ((signal, fn) => process.on(signal, fn));
  const deadlineMs = deps.deadlineMs ?? UNREGISTER_DEADLINE_MS;
  const getRegistration = deps.getRegistration || (() => null);

  let shuttingDown = false;
  let chosenCode = null;
  let exited = false;
  // Counts USER signals — every one that arrives, including those forwarded to a
  // live agent. A shutdown started by the agent's own exit leaves this at 0, so
  // the SIGINT the terminal delivered to both of us — arriving after the agent
  // has already exited — reads as the first signal and waits for the unregister,
  // instead of being mistaken for the user insisting.
  let signalsSeen = 0;
  // Once-only, and shared by every exit path. exit() is injectable, so it is not
  // guaranteed to be terminal; without one guard a later-settling unregister
  // exits a second time.
  const finish = (code) => { if (exited) return; exited = true; exit(code); };

  // The ONE exit path for a hub client — the agent's own exit routes through it
  // too. That is what stops a signal arriving while the agent's unregister is
  // still in flight from overwriting the agent's exit code with its own: a child
  // that failed with 42 must not be reported as an interrupted launch.
  const shutdown = (code) => {
    // Already leaving: keep the first code and let the in-flight unregister
    // finish. Only a SECOND user signal cuts that short — see onSignal.
    if (shuttingDown) return;
    shuttingDown = true;
    chosenCode = code;

    // Wait for an in-flight registration before unregistering. The two are
    // separate socket round trips with no ordering guarantee, so unregistering
    // first lets the hub apply the register afterwards and hold a pid that has
    // already exited — this module's own bug, reintroduced through the back
    // door. A null registration means nothing was ever registered, so there is
    // nothing to release.
    //
    // The two waits are bounded SEPARATELY. One deadline spanning both would be
    // spent by the register alone — hubSocketRequest gives it 3s — and expire
    // before the unregister was ever sent, in exactly the case that needs it
    // most: the hub applied the registration and lost only the reply. When the
    // wait times out the unregister goes anyway. If the register really is still
    // in flight, the hub may apply it after and hold the slot — but that is the
    // same outcome as not trying, and if it was merely the reply that went
    // missing, this releases it.
    const registration = getRegistration();
    const bounded = (promise) => Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise(resolve => {
        const timer = setTimeout(resolve, deadlineMs);
        if (timer.unref) timer.unref();
      }),
    ]);

    bounded(registration)
      .then(() => (registration ? bounded(hub.unregisterClient(getLock(), process.pid)) : null))
      .then(() => finish(chosenCode), () => finish(chosenCode));
  };

  const onSignal = (signal) => {
    // Counted before the live-child branch returns. Counting only the signals
    // that reach the shutdown below would mean a Ctrl-C delivered while the
    // agent was still alive did not count, so the user's SECOND press would read
    // as the first and a third would be needed to force the exit.
    signalsSeen += 1;
    const child = getChild();
    if (child && child.exitCode == null && child.signalCode == null) {
      // The terminal delivers SIGINT to the whole foreground process group, so
      // the agent already has its own copy and forwarding would deliver it
      // twice. For the others, forwarding is enough: the agent's exit drives
      // spawnAgent's onExit, which calls shutdown() above.
      if (signal !== 'SIGINT') child.kill(signal);
      return;
    }
    // The second signal is the user insisting. Leave now rather than keep
    // waiting on the hub — the dead-client sweep reclaims the slot, and a pane
    // that will not close is the worse failure. The FIRST signal never does
    // this, even when a shutdown is already running, because that shutdown may
    // have been started by the agent's exit rather than by the user.
    if (shuttingDown) {
      if (signalsSeen >= 2) finish(chosenCode);
      return;
    }
    shutdown(signalExitCode(signal));
  };

  // SIGINT is armed for the same reason as the other two. spawnAgent installs a
  // no-op for it once a child exists, and a no-op is the right behaviour THEN —
  // but before the child exists, a no-op would leave Ctrl-C unable to abort
  // startup, and no handler at all leaves the phantom-client hole this module
  // closes. Routing it through onSignal gives both: nothing while the agent
  // owns the terminal, unregister-and-exit before that.
  on('SIGINT', () => onSignal('SIGINT'));
  on('SIGHUP', () => onSignal('SIGHUP'));
  on('SIGTERM', () => onSignal('SIGTERM'));

  return {
    // The caller MUST gate the agent spawn on this, and must re-check it
    // IMMEDIATELY BEFORE spawn(): on the interactive path spawnAgent defers
    // doSpawn behind promptClaudeStatusline()'s promise, so a signal can begin
    // the shutdown and the user can answer the prompt before it settles.
    // Spawning then leaves the agent running with its parent gone.
    isShuttingDown: () => shuttingDown,
    shutdown,
  };
}

module.exports = { armClientShutdown, signalExitCode, UNREGISTER_DEADLINE_MS };
