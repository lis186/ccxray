'use strict';

const { UNREGISTER_DEADLINE_MS } = require('./client-shutdown');

function bounded(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, timeoutMs);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).catch(() => {}).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function raceWithLaunchDecision(promise, decision) {
  return Promise.race([
    Promise.resolve(promise).then(
      value => ({ kind: 'value', value }),
      error => ({ kind: 'error', error }),
    ),
    decision.done.then(outcome => ({ kind: 'decision', outcome })),
  ]);
}

function createLaunchDecision({
  command,
  args,
  spawnFallback,
  exit = code => process.exit(code),
  hub = require('./hub'),
  attachTimeoutMs,
  deadlineMs = UNREGISTER_DEADLINE_MS,
  failClosed = () => process.env.CCXRAY_FAIL_CLOSED === '1',
  logFailOpen,
  now = Date.now,
  setTimer = setTimeout,
}) {
  let outcome = null;
  let timer = null;
  let pendingRegistration = null;
  let registrationLock = null;
  let clientShutdown = null;
  let releaseForkLock = null;
  let cleanup = Promise.resolve();
  let retryTimer = null;
  let ackSeen = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const acked = reply => Boolean(reply && reply.ok === true);
  const attempt = () => {
    const request = Promise.resolve(hub.unregisterClient(registrationLock, process.pid))
      .catch(() => undefined);
    request.then(reply => {
      if (acked(reply)) {
        ackSeen = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      }
    });
    return request;
  };
  const scheduleRetry = () => {
    if (ackSeen) return;
    retryTimer = setTimer(async () => {
      retryTimer = null;
      if (ackSeen || !registrationLock.sockPath || !hub.isPidAlive(registrationLock.pid)) return;
      if (!acked(await attempt())) scheduleRetry();
    }, hub.HUB_HEALTH_CHECK_MS);
    if (retryTimer.unref) retryTimer.unref();
  };
  const cleanupLateRegistration = () => {
    if (!pendingRegistration || !registrationLock) return;
    const settled = bounded(
      Promise.resolve(pendingRegistration).then(() => {}, () => {}),
      hub.HUB_REQUEST_TIMEOUT_MS + 500,
    );
    cleanup = settled.then(() => {
      const first = attempt();
      first.then(reply => {
        if (!acked(reply)) scheduleRetry();
      });
      return bounded(first, deadlineMs);
    }).then(() => {}, () => {});
  };
  const waitForCleanup = () => cleanup;

  const decide = (next, reason, failClosedMessage) => {
    if (outcome !== null) return false;
    if (!['proxied', 'original', 'aborted'].includes(next)) {
      throw new Error(`invalid launch outcome: ${next}`);
    }
    outcome = next;
    if (timer) clearTimeout(timer);
    resolveDone(next);
    if (next !== 'original') return true;

    if (releaseForkLock) releaseForkLock();

    if (failClosed() && reason !== 'bg-bypass') {
      if (failClosedMessage) console.error(failClosedMessage);
      if (pendingRegistration && clientShutdown) clientShutdown.shutdown(1);
      else exit(1);
      return true;
    }

    if (clientShutdown) clientShutdown.abandon();
    cleanupLateRegistration();
    logFailOpen({
      ts: new Date(now()).toISOString(),
      reason,
      version: require('../package.json').version,
      agent: command,
    });
    console.error(`[ccxray] fail-open: ${reason} — this session is NOT traced; run ccxray setup --check`);
    spawnFallback({ bin: command, args: [...args], env: process.env }, code => {
      waitForCleanup().then(() => exit(code));
    });
    return true;
  };

  return {
    done,
    decide,
    waitForCleanup,
    isDecided: () => outcome !== null,
    getOutcome: () => outcome,
    startBudget() {
      if (outcome !== null) return;
      timer = setTimer(() => decide('original', 'attach-timeout'), attachTimeoutMs());
    },
    abortForShutdown: () => decide('aborted'),
    setRegistration(registration, lock) {
      pendingRegistration = registration;
      registrationLock = lock;
    },
    setClientShutdown(shutdown) {
      clientShutdown = shutdown;
    },
    setForkLockRelease(release) {
      releaseForkLock = release;
      if (outcome === 'original' && release) release();
    },
  };
}

module.exports = { createLaunchDecision, bounded, raceWithLaunchDecision };
