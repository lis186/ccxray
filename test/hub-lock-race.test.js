'use strict';

// #730: hub restart race. Hermetic: temp CCXRAY_HOME, localhost unix socket only,
// shortened timers via source substitution (same technique as
// hub-recovery-outcomes.test.js), no long sleeps.

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// Unix socket paths are length-limited; a long TMPDIR would break the socket.
const BASE = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const HOME = fs.mkdtempSync(path.join(BASE, 'ccx-lockrace-'));
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), '');
process.env.CCXRAY_HOME = HOME;
process.env.CCXRAY_EXPORT_DISABLE = '1';
process.env.CCXRAY_IMPORT_DISABLE = '1';

let spawnCalls = 0;
function stubSpawn() {
  spawnCalls++;
  const child = new EventEmitter();
  child.pid = 1;
  child.unref = () => {};
  return child;
}

function loadHub() {
  let source = fs.readFileSync(path.join(SERVER_DIR, 'hub.js'), 'utf8');
  for (const [from, to] of [
    ['const HUB_HEALTH_CHECK_MS = 5000;', 'const HUB_HEALTH_CHECK_MS = 20;'],
    ['const HUB_LOCK_CHECK_MS = 5000;', 'const HUB_LOCK_CHECK_MS = 20;'],
    ['const READINESS_TIMEOUT_MS = 10000;', 'const READINESS_TIMEOUT_MS = 120;'],
    // Barrier: lets a test act exactly when readiness waiting begins.
    ['function waitForHubReady(timeoutMs = READINESS_TIMEOUT_MS) {',
     'function waitForHubReady(timeoutMs = READINESS_TIMEOUT_MS) {\n  if (process.__ccxReadinessHook) process.__ccxReadinessHook();'],
  ]) {
    assert.ok(source.includes(from), `${from} must be declared for harness timing`);
    source = source.replace(from, to);
  }
  const module = { exports: {} };
  const localRequire = request => {
    if (request === 'child_process') return { spawn: stubSpawn };
    if (request.startsWith('.')) return require(path.resolve(SERVER_DIR, request));
    return require(request);
  };
  const factory = vm.runInNewContext(
    `(function (require, module, exports, __dirname, __filename) {\n${source}\n})`,
    { Buffer, clearInterval, clearTimeout, console: { error() {}, log() {}, warn() {} }, Date, process, setInterval, setTimeout },
  );
  factory(localRequire, module, module.exports, SERVER_DIR, path.join(SERVER_DIR, 'hub.js'));
  return module.exports;
}

const hub = loadHub();
hub.setOnShutdown(() => {});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(5);
  }
  return false;
}

const liveChildren = [];
function liveForeignPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  liveChildren.push(child);
  return child;
}
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}
function killAndWait(child) {
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}
function lockOnDisk() {
  try { return JSON.parse(fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8')); } catch { return null; }
}

let socketServer = null;
async function startHubB(port) {
  await hub.cleanupStaleSocket();
  socketServer = await hub.createHubSocket();
  hub.writeHubLock(port, process.pid, undefined, hub.SOCK_PATH);
}
async function stopHubB() {
  if (socketServer) await new Promise(r => socketServer.close(r));
  socketServer = null;
  try { fs.unlinkSync(hub.SOCK_PATH); } catch {}
}

beforeEach(() => {
  hub.deleteHubLock();
  hub.stopLockSelfHeal();
  spawnCalls = 0;
});
after(async () => {
  hub.stopLockSelfHeal();
  await stopHubB();
  for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch {} }
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('lockfile ownership (#730)', () => {
  it('writeHubLock is atomic: mode 0600 and no temp file left behind', () => {
    hub.writeHubLock(41000, process.pid, undefined, hub.SOCK_PATH);
    assert.equal(fs.statSync(hub.HUB_LOCK_PATH).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(HOME).filter(f => f.endsWith('.tmp')), []);
    assert.equal(lockOnDisk().pid, process.pid);
  });

  it('deleteHubLockIfPid removes a lock naming the given pid', () => {
    hub.writeHubLock(41000, process.pid);
    assert.equal(hub.deleteHubLockIfPid(process.pid), true);
    assert.equal(lockOnDisk(), null);
  });

  it('deleteHubLockIfPid removes a lock naming a dead pid', () => {
    hub.writeHubLock(41000, deadPid());
    assert.equal(hub.deleteHubLockIfPid(process.pid), true);
    assert.equal(lockOnDisk(), null);
  });

  it('deleteHubLockIfPid leaves a lock naming a different live pid', () => {
    const other = liveForeignPid();
    hub.writeHubLock(41000, other.pid);
    assert.equal(hub.deleteHubLockIfPid(deadPid()), false);
    assert.equal(lockOnDisk().pid, other.pid);
  });

  it('deleteHubLockIfPid on a missing lock is a no-op', () => {
    assert.equal(hub.deleteHubLockIfPid(process.pid), false);
  });

  it('shutdownHub removes its own lock', () => {
    hub.writeHubLock(41000, process.pid);
    hub.shutdownHub();
    assert.equal(lockOnDisk(), null);
  });

  it('shutdownHub leaves another live hub\'s lock alone', () => {
    const other = liveForeignPid();
    hub.writeHubLock(41001, other.pid);
    hub.shutdownHub();
    assert.equal(lockOnDisk().pid, other.pid);
  });

  it('discoverHub removes a lock whose pid is observed dead', async () => {
    hub.writeHubLock(41002, deadPid());
    assert.equal(await hub.discoverHub(41002), null);
    assert.equal(lockOnDisk(), null, 'dead-pid lock is cleaned');
  });

  it('cleanup of an observed-dead lock leaves a replacement lock installed afterwards (status path)', () => {
    const dead = deadPid();
    hub.writeHubLock(41002, dead);
    const observed = hub.readHubLock();
    assert.equal(observed.pid, dead);
    // A replacement hub publishes its lock between observation and cleanup.
    const replacement = liveForeignPid();
    hub.writeHubLock(41002, replacement.pid, undefined, hub.SOCK_PATH);
    assert.equal(hub.deleteHubLockIfPid(observed.pid), false);
    assert.equal(lockOnDisk().pid, replacement.pid, 'replacement lock survives');
  });

  it('discoverHub keeps the lock and socket of a live but unresponsive owner and throws', async () => {
    const owner = liveForeignPid();
    await hub.cleanupStaleSocket();
    socketServer = await hub.createHubSocket();
    hub.writeHubLock(41021, owner.pid); // no sockPath, nothing on 41021 -> health probe fails
    const before = fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8');
    await assert.rejects(hub.discoverHub(41021), err => err instanceof hub.HubUnresponsiveError && err.code === 'HUB_UNRESPONSIVE');
    assert.equal(fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8'), before, 'lock untouched');
    assert.ok(fs.existsSync(hub.SOCK_PATH), 'socket untouched');
    await hub.cleanupStaleSocket(); // a later hub start must not unlink it either
    assert.ok(fs.existsSync(hub.SOCK_PATH), 'cleanupStaleSocket still sees a live owner lock');
    assert.equal(spawnCalls, 0);
    await stopHubB();
  });
});

describe('hub lockfile self-heal (#730)', () => {
  it('rewrites a deleted hub.json with the same fields and mode 0600', () => {
    assert.equal(hub.selfHealHubLock(41003, hub.SOCK_PATH), true);
    const lock = lockOnDisk();
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.port, 41003);
    assert.equal(lock.sockPath, hub.SOCK_PATH);
    assert.ok(lock.version && lock.startedAt);
    assert.equal(fs.statSync(hub.HUB_LOCK_PATH).mode & 0o777, 0o600);
  });

  it('does not rewrite a correct lock', () => {
    hub.selfHealHubLock(41003, hub.SOCK_PATH);
    const before = fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8');
    assert.equal(hub.selfHealHubLock(41003, hub.SOCK_PATH), false);
    assert.equal(fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8'), before);
  });

  it('does not overwrite a lock naming another live hub', () => {
    const other = liveForeignPid();
    hub.writeHubLock(41004, other.pid);
    assert.equal(hub.selfHealHubLock(41003, hub.SOCK_PATH), false);
    assert.equal(lockOnDisk().pid, other.pid);
    assert.equal(lockOnDisk().port, 41004);
  });

  it('replaces a lock naming a dead pid', () => {
    hub.writeHubLock(41004, deadPid());
    assert.equal(hub.selfHealHubLock(41003, hub.SOCK_PATH), true);
    assert.equal(lockOnDisk().pid, process.pid);
  });

  it('the periodic timer restores a deleted lock and is unref\'d', async () => {
    hub.selfHealHubLock(41003, hub.SOCK_PATH);
    const timer = hub.startLockSelfHeal(41003, hub.SOCK_PATH, 20);
    assert.equal(timer.hasRef(), false);
    hub.deleteHubLock();
    assert.ok(await until(() => lockOnDisk() !== null), 'lock was restored');
    assert.equal(lockOnDisk().port, 41003);
    hub.stopLockSelfHeal();
  });
});

describe('client recovery (#730)', () => {
  it('restart race: B is published first, then one explicit tick registers inside the callback; B\'s lock survives, no fork', async () => {
    const A = liveForeignPid();
    const port = 41010;
    hub.writeHubLock(port, A.pid, undefined, hub.SOCK_PATH);
    const failures = [];
    let registered = null;
    const monitor = hub.createHubMonitor(A.pid, port, async lock => {
      registered = await hub.registerClient(lock, process.pid, '/work', {});
      return registered && registered.ok === true;
    }, () => failures.push(1));
    try {
      await killAndWait(A);
      await startHubB(port); // socket + lock exist BEFORE the first tick
      const bLockBefore = fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8');
      await monitor.tick();
      assert.equal(registered && registered.ok, true, 'registration happened inside the awaited callback');
      assert.equal(fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8'), bLockBefore, 'B\'s hub.json intact');
      assert.ok(hub.getHubStatus().clients.some(c => c.pid === process.pid), 'B lists the client pid');
      assert.equal(spawnCalls, 0, 'no extra hub forked');
      assert.deepEqual(failures, []);
    } finally {
      hub.removeClient(process.pid);
      await stopHubB();
    }
  });

  it('registration fails once, then succeeds against the same live hub (retried despite a live candidate)', async () => {
    const dead = deadPid();
    const port = 41015;
    hub.writeHubLock(port, dead, undefined, hub.SOCK_PATH);
    await startHubB(port);
    let calls = 0;
    let failures = 0;
    const monitor = hub.createHubMonitor(dead, port, async () => { calls++; return calls >= 2; }, () => { failures++; });
    try {
      await monitor.tick();
      assert.equal(calls, 1);
      assert.equal(failures, 1, 'failed registration is a reported failure');
      assert.ok(await until(async () => { await monitor.tick(); return calls === 2; }, 3000), 'retried while the hub stayed alive');
      const before = calls;
      await sleep(80);
      await monitor.tick();
      await monitor.tick();
      assert.equal(calls, before, 'no further callbacks once registration succeeded');
      assert.equal(spawnCalls, 0);
      assert.equal(failures, 1);
    } finally {
      await stopHubB();
    }
  });

  it('keeps retrying after a failed attempt (one failure report) and attaches once a hub is available', async () => {
    const dead = deadPid();
    const port = 41011;
    hub.writeHubLock(port, dead, undefined, hub.SOCK_PATH);
    const recovered = [];
    let failures = 0;
    const interval = hub.startHubMonitor(dead, port, lock => { recovered.push(lock); return true; }, () => { failures++; });
    try {
      assert.ok(await until(() => failures === 1), 'first attempt fails (stub fork never becomes ready)');
      assert.ok(await until(() => spawnCalls >= 2, 3000), 'monitor retried after the failure');
      assert.equal(recovered.length, 0);
      const forksBefore = spawnCalls;
      await startHubB(port);
      assert.ok(await until(() => recovered.length === 1, 3000), 'attached once a hub appeared');
      assert.equal(recovered[0].pid, process.pid);
      assert.equal(failures, 1, 'failure reported once per outage');
      assert.ok(spawnCalls - forksBefore <= 1, 'discovery attached without further forks');
    } finally {
      clearInterval(interval);
      await stopHubB();
    }
  });

  it('a non-acquiring waiter that observes a hub on a different port never signals it', async () => {
    const other = liveForeignPid();
    const kills = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig !== 0 && sig !== undefined) kills.push([pid, sig]);
      return realKill.call(process, pid, sig);
    };
    let failures = 0;
    try {
      await startHubB(41012); // answers health on this home's socket
      // The lock names a live foreign pid on a port this client is not using.
      hub.writeHubLock(41012, other.pid, undefined, hub.SOCK_PATH);
      assert.ok(hub.tryAcquireForkLock(), 'take the fork lock so the monitor is a non-acquiring waiter');
      const dead = deadPid();
      const monitor = hub.createHubMonitor(dead, 41013, () => true, () => { failures++; });
      await monitor.tick();
      assert.equal(failures, 1, 'reported as a failure');
      assert.deepEqual(kills, [], 'no signal sent to the other hub');
      assert.equal(other.exitCode, null);
      assert.equal(lockOnDisk().pid, other.pid, 'its lock untouched');
    } finally {
      process.kill = realKill;
      hub.releaseForkLock();
      await stopHubB();
    }
  });

  it('a true non-acquiring waiter (discovery null, fork lock held elsewhere) never signals a hub that appears on another port', async () => {
    const other = liveForeignPid();
    const holder = liveForeignPid();
    const reserve = () => new Promise(resolve => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
    const ownPort = await reserve(); // closed: discovery's HTTP fallback finds nothing
    const otherPort = await reserve();
    const kills = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig !== 0 && sig !== undefined) kills.push([pid, sig]);
      return realKill.call(process, pid, sig);
    };
    let failures = 0;
    let waiting = false;
    let published = null;
    try {
      assert.equal(lockOnDisk(), null, 'no hub.json: discovery returns null');
      // Another party holds a fresh fork lock, so this monitor cannot acquire it.
      fs.writeFileSync(path.join(HOME, 'hub.fork.lock'), JSON.stringify({ pid: holder.pid, at: Date.now() }));
      process.__ccxReadinessHook = () => {
        waiting = true;
        // Publish only now that readiness waiting has started.
        published = startHubB(otherPort).then(() => hub.writeHubLock(otherPort, other.pid, undefined, hub.SOCK_PATH));
      };
      const monitor = hub.createHubMonitor(deadPid(), ownPort, () => true, () => { failures++; });
      await monitor.tick();
      await published;
      assert.equal(waiting, true, 'the readiness-wait branch ran');
      assert.equal(failures, 1, 'foreign-port hub reported as a failure');
      assert.equal(spawnCalls, 0, 'non-acquirer never forks');
      assert.deepEqual(kills, [], 'no signal sent to the other hub');
      assert.equal(other.exitCode, null);
      assert.equal(lockOnDisk().pid, other.pid, 'its lock untouched');
    } finally {
      delete process.__ccxReadinessHook;
      process.kill = realKill;
      try { fs.unlinkSync(path.join(HOME, 'hub.fork.lock')); } catch {}
      await stopHubB();
    }
  });

  it('a live but unresponsive owner keeps its lock and socket, and no hub is forked, until it dies', async () => {
    const owner = liveForeignPid();
    const port = 41022;
    await hub.cleanupStaleSocket();
    socketServer = await hub.createHubSocket();
    hub.writeHubLock(port, owner.pid); // no sockPath; nothing listens on the port
    let failures = 0;
    const monitor = hub.createHubMonitor(deadPid(), port, () => true, () => { failures++; });
    try {
      await monitor.tick();
      assert.equal(failures, 1);
      assert.equal(spawnCalls, 0, 'no competitor forked');
      assert.equal(lockOnDisk().pid, owner.pid, 'lock kept');
      assert.ok(fs.existsSync(hub.SOCK_PATH), 'socket kept');
      await stopHubB(); // the fixture socket would otherwise be discovered as a live hub
      await killAndWait(owner);
      assert.ok(await until(async () => { await monitor.tick(); return spawnCalls >= 1; }, 3000), 'forks once the owner is dead');
    } finally {
      await stopHubB();
    }
  });
});

describe('bind-failure message (#730)', () => {
  const occ = { kind: 'ccxray-hub', pid: 4242 };

  it('says the lockfile is missing when the hub is reachable on this home\'s socket', () => {
    const text = hub.describePortOccupant(occ, 5577, { homeSocketReachable: true }).join('\n');
    assert.match(text, /lockfile \(hub\.json\) is missing/);
    assert.match(text, /live ccxray hub \(pid 4242\)/);
    assert.doesNotMatch(text, /cannot discover|no matching lockfile/);
  });

  it('keeps the different-home wording otherwise', () => {
    const text = hub.describePortOccupant(occ, 5577).join('\n');
    assert.match(text, /cannot discover \(no matching lockfile under this CCXRAY_HOME\)/);
  });

  it('probeHomeHub is true only when this home\'s socket answers with the same pid', async () => {
    assert.equal(await hub.probeHomeHub({ kind: 'ccxray-hub', pid: process.pid }), false, 'no socket');
    await startHubB(41014);
    try {
      assert.equal(await hub.probeHomeHub({ kind: 'ccxray-hub', pid: process.pid }), true);
      assert.equal(await hub.probeHomeHub({ kind: 'ccxray-hub', pid: process.pid + 1 }), false, 'different hub');
      assert.equal(await hub.probeHomeHub({ kind: 'ccxray-standalone', pid: process.pid }), false);
    } finally {
      await stopHubB();
    }
  });
});
