'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { armClientShutdown, signalExitCode, UNREGISTER_DEADLINE_MS } = require('../server/client-shutdown');

// A harness over the injection seams: no signals are sent to this process and
// no socket is opened, so these run alongside the e2e in
// test/hub-client-signal.e2e.test.js without touching a real hub.
function arm({ child = null, unregister, deadlineMs, registration = Promise.resolve({}), lock = { sockPath: '/tmp/ccxray-test.sock' } } = {}) {
  const handlers = new Map();
  const exits = [];
  const unregistered = [];
  const api = armClientShutdown(() => lock, () => child, {
    hub: {
      unregisterClient: (l, pid) => {
        unregistered.push({ lock: l, pid });
        return unregister ? unregister() : Promise.resolve();
      },
    },
    exit: code => exits.push(code),
    on: (signal, fn) => handlers.set(signal, fn),
    getRegistration: () => registration,
    deadlineMs,
  });
  return {
    ...api, exits, unregistered,
    setChild: next => { child = next; },
    setLock: next => { lock = next; },
    setRegistration: next => { registration = next; },
    fire: signal => handlers.get(signal)(),
    signals: [...handlers.keys()],
  };
}

const tick = () => new Promise(r => setImmediate(r));
const settled = async () => { for (let i = 0; i < 8; i++) await tick(); };
const after = ms => new Promise(r => setTimeout(r, ms));

describe('hub-client graceful shutdown', () => {
  it('arms every signal that would otherwise kill the process unregistered', () => {
    assert.deepEqual(arm().signals, ['SIGINT', 'SIGHUP', 'SIGTERM']);
  });

  it('forwards to a live agent instead of unregistering itself', async () => {
    const killed = [];
    const h = arm({ child: { exitCode: null, signalCode: null, kill: s => killed.push(s) } });

    h.fire('SIGHUP');
    await settled();

    // The agent's exit drives spawnAgent's onExit, which calls shutdown().
    assert.deepEqual(killed, ['SIGHUP']);
    assert.deepEqual(h.unregistered, []);
    assert.deepEqual(h.exits, []);
    assert.equal(h.isShuttingDown(), false);
  });

  it('does not forward SIGINT to a live agent, which already has its own', async () => {
    const killed = [];
    const h = arm({ child: { exitCode: null, signalCode: null, kill: s => killed.push(s) } });

    h.fire('SIGINT');
    await settled();

    // The terminal delivers SIGINT to the whole foreground process group, so
    // forwarding would deliver it twice. This is spawnAgent's no-op, relocated.
    assert.deepEqual(killed, []);
    assert.deepEqual(h.exits, []);
  });

  it('unregisters then exits when the signal lands before the agent exists', async () => {
    const h = arm();

    h.fire('SIGHUP');
    // The gate must flip synchronously: startClientMode checks it in the same
    // tick it would otherwise spawn the agent.
    assert.equal(h.isShuttingDown(), true);
    await settled();

    assert.equal(h.unregistered.length, 1);
    assert.equal(h.unregistered[0].pid, process.pid);
    assert.deepEqual(h.exits, [1]);
  });

  it('waits for an in-flight registration before unregistering', async () => {
    let admit;
    const registration = new Promise(r => { admit = r; });
    const h = arm({ registration, deadlineMs: 5000 });

    h.fire('SIGHUP');
    await settled();
    // Unregistering first would let the hub apply the register afterwards and
    // hold a pid that has already exited — the phantom, through the back door.
    assert.deepEqual(h.unregistered, [], 'must not race the register round trip');

    admit({});
    await settled();
    assert.equal(h.unregistered.length, 1);
    assert.deepEqual(h.exits, [1]);
  });

  it('releases the hub it is currently registered with, not the crashed one', async () => {
    let admit;
    const recovered = { sockPath: '/tmp/ccxray-recovered.sock' };
    const h = arm({ deadlineMs: 5000 });

    // Crash recovery hands the client a different hub and re-registers.
    h.setLock(recovered);
    h.setRegistration(new Promise(r => { admit = r; }));

    h.fire('SIGHUP');
    await settled();
    assert.deepEqual(h.unregistered, [], 'the recovery register is still in flight');

    admit({});
    await settled();
    assert.equal(h.unregistered.length, 1);
    assert.equal(h.unregistered[0].lock, recovered, 'unregistering the dead hub releases nothing');
  });

  it('skips the unregister when registration was never started', async () => {
    const h = arm({ registration: null });

    h.fire('SIGTERM');
    await settled();

    assert.deepEqual(h.unregistered, [], 'nothing was registered, nothing to release');
    assert.deepEqual(h.exits, [1]);
  });

  it('treats an agent that has already exited as no agent', async () => {
    const h = arm({ child: { exitCode: 0, signalCode: null, kill: () => { throw new Error('must not kill a dead child'); } } });

    h.fire('SIGTERM');
    await settled();

    assert.equal(h.unregistered.length, 1);
    assert.deepEqual(h.exits, [1]);
  });

  it('keeps the agent exit code, and still unregisters, when the same Ctrl-C reaches both', async () => {
    let release;
    const h = arm({ unregister: () => new Promise(r => { release = r; }), deadlineMs: 5000 });

    // A terminal delivers SIGINT to the client AND the agent. The agent exits
    // first, so spawnAgent's onExit opens the shutdown.
    h.shutdown(42);
    await settled();
    assert.deepEqual(h.exits, []);

    h.setChild({ exitCode: 42, signalCode: null, kill: () => {} });
    h.fire('SIGINT');

    // That SIGINT is the same user action, not a second one: cutting the
    // unregister short here would leave a phantom client behind.
    assert.deepEqual(h.exits, [], 'the first signal must not abandon the unregister');

    release();
    await settled();
    // Reporting 130 would mask a real failure as an interrupted launch.
    assert.deepEqual(h.exits, [42]);
    assert.equal(h.unregistered.length, 1);
  });

  it('counts a signal that was forwarded to a live agent', async () => {
    let release;
    const child = { exitCode: null, signalCode: null, kill: () => {} };
    const h = arm({ child, unregister: () => new Promise(r => { release = r; }), deadlineMs: 5000 });

    // Ctrl-C reaches the client while the agent is still up: forwarded, and the
    // agent starts shutting down on its own.
    h.fire('SIGINT');
    child.exitCode = 0;
    h.shutdown(0);
    await settled();
    assert.deepEqual(h.exits, []);

    // The user presses again. Not counting the forwarded one would read this as
    // the first press and make a THIRD necessary to get out.
    h.fire('SIGINT');
    assert.deepEqual(h.exits, [0], 'the second press must be enough');

    release();
    await settled();
    assert.deepEqual(h.exits, [0]);
  });

  it('exits immediately on a second signal rather than waiting on the hub', async () => {
    let release;
    const h = arm({ unregister: () => new Promise(r => { release = r; }), deadlineMs: 5000 });

    h.fire('SIGHUP');
    await settled();
    assert.deepEqual(h.exits, [], 'still waiting on the hub');

    h.fire('SIGHUP');
    assert.deepEqual(h.exits, [1], 'the user insisting is honoured at once');

    // The in-flight unregister must not double-exit when it finally settles.
    release();
    await settled();
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.unregistered.length, 1);
  });

  it('still sends the unregister when the registration reply never arrives', async () => {
    // The hub added the client and lost only the reply. A single deadline
    // spanning both waits would be spent here — registerClient has 3s of its own
    // — and the slot would be stranded in the one case that needs releasing.
    const h = arm({ registration: new Promise(() => {}), deadlineMs: 20 });

    h.fire('SIGHUP');
    await after(120);

    assert.equal(h.unregistered.length, 1, 'the wait timed out, the unregister must go anyway');
    assert.deepEqual(h.exits, [1]);
  });

  it('exits on the deadline when the hub never answers', async () => {
    const h = arm({ unregister: () => new Promise(() => {}), deadlineMs: 20 });

    h.fire('SIGHUP');
    await after(60);

    // Degraded but recoverable: the hub's dead-client sweep reclaims the slot,
    // whereas a pane the user cannot close is not recoverable.
    assert.deepEqual(h.exits, [1]);
  });

  it('maps signals the way the child-exit handler does', () => {
    assert.equal(signalExitCode('SIGINT'), 130);
    assert.equal(signalExitCode('SIGHUP'), 1);
    assert.equal(signalExitCode('SIGTERM'), 1);
  });

  it('bounds the wait well under the hub socket timeout', () => {
    // hubSocketRequest defaults to 3s; a deadline at or above that would never
    // fire, so this constant has to stay below it to mean anything.
    assert.ok(UNREGISTER_DEADLINE_MS > 0 && UNREGISTER_DEADLINE_MS < 3000);
  });
});

// Behaviour above is only worth anything if startClientMode wires it correctly.
// The e2e in test/hub-client-signal.e2e.test.js drives the real binary through a
// fake hub for the registration window and the spawn gate; these pin the source
// facts that no runtime path reaches — the same approach
// test/invariant-encapsulation.test.js takes for the store push sites.
describe('hub-client shutdown wiring (structural)', () => {
  // Full-line comments are stripped so these assertions read CODE. Prose that
  // mentions `process.exit` while explaining why it is not used would otherwise
  // match — the first draft of the registration-failure check did exactly that.
  // Only whole-line comments go, so a URL in a string literal is untouched.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('arms the shutdown before the client registers with the hub', () => {
    const armed = source.indexOf('armClientShutdown(');
    const registered = source.indexOf('hub.registerClient(');
    assert.ok(armed > 0, 'armClientShutdown call not found');
    assert.ok(registered > 0, 'registerClient call not found');
    assert.ok(
      armed < registered,
      'armClientShutdown must be called before hub.registerClient — a signal in '
      + 'between kills the process without unregistering',
    );
  });

  it('re-checks the gate inside doSpawn, not only at the call site', () => {
    // The interactive path runs doSpawn after promptClaudeStatusline()'s promise
    // settles, so a call-site-only check can be answered by a stale reading.
    const doSpawn = source.slice(source.indexOf('const doSpawn = () => {'));
    const guard = doSpawn.indexOf('opts.isShuttingDown');
    const spawnCall = doSpawn.indexOf('spawn(launch.bin');
    assert.ok(guard > 0, 'doSpawn does not consult opts.isShuttingDown');
    assert.ok(guard < spawnCall, 'the gate must be checked before spawn()');
  });

  it('routes the agent exit through the shared shutdown path', () => {
    // A direct process.exit here would let a signal racing the agent's
    // unregister replace the agent's exit code with its own.
    assert.match(source, /clientShutdown\.shutdown\(code\)/);
    assert.doesNotMatch(source, /hub\.unregisterClient\(lock, process\.pid\)\.finally/);
  });

  it('publishes the crash-recovery re-registration to the shutdown path', () => {
    // Recovery registers with a DIFFERENT hub. Leaving that promise untracked
    // lets a shutdown unregister the dead hub and race the new register.
    const monitor = source.slice(source.indexOf('hub.startHubMonitor('));
    const body = monitor.slice(0, monitor.indexOf('\n  });'));
    assert.match(body, /currentLock = newLock/);
    assert.match(body, /registration = hub\.registerClient\(newLock/);
    // A shutdown captures the registration promise once, so it can never see one
    // created after it. Recovery must therefore decline to make a new one.
    assert.match(body, /if \(clientShutdown\.isShuttingDown\(\)\) return;/);
  });

  it('releases the slot when registration itself fails', () => {
    // The hub can apply a registration and lose only the reply. These
    // continuations were attached before any shutdown's, so a bare process.exit
    // here wins the race and strands that slot until the 30s sweep.
    const clientMode = source.slice(source.indexOf('async function startClientMode'));
    const body = clientMode.slice(0, clientMode.indexOf('\n}\n'));
    assert.doesNotMatch(body, /Hub rejected client registration[\s\S]{0,80}process\.exit/);
    assert.doesNotMatch(body, /Failed to register with hub[\s\S]{0,80}process\.exit/);
    assert.match(body, /Hub rejected client registration[\s\S]{0,80}clientShutdown\.shutdown\(1\)/);
    assert.match(body, /Failed to register with hub[\s\S]{0,80}clientShutdown\.shutdown\(1\)/);
  });
});
