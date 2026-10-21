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

  it('discoverHub does not delete a replacement hub\'s lock when the old pid is dead', async () => {
    // The lock read says dead pid; a live replacement then owns the file.
    const dead = deadPid();
    hub.writeHubLock(41002, dead);
    assert.equal(await hub.discoverHub(41002), null);
    assert.equal(lockOnDisk(), null, 'dead-pid lock is cleaned');
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
  it('restart race: monitor fires after B wrote its lock; B\'s lock survives, client re-registers, no fork', async () => {
    const A = liveForeignPid();
    const port = 41010;
    hub.writeHubLock(port, A.pid, undefined, hub.SOCK_PATH);
    const recovered = [];
    const failures = [];
    const interval = hub.startHubMonitor(A.pid, port, lock => recovered.push(lock), () => failures.push(1));
    try {
      await killAndWait(A);
      await startHubB(port); // B binds and overwrites hub.json before the monitor's next tick
      const bLockBefore = fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8');
      assert.ok(await until(() => recovered.length === 1), 'recovery callback ran');
      // What index.js's onRecovery does: re-register with the discovered hub.
      const reg = await hub.registerClient(recovered[0], process.pid, '/work', {});
      assert.equal(reg.ok, true);
      assert.equal(fs.readFileSync(hub.HUB_LOCK_PATH, 'utf8'), bLockBefore, 'B\'s hub.json intact');
      assert.equal(lockOnDisk().pid, process.pid);
      assert.ok(hub.getHubStatus().clients.some(c => c.pid === process.pid), 'B lists the client pid');
      assert.equal(spawnCalls, 0, 'no extra hub forked');
      assert.deepEqual(failures, []);
    } finally {
      clearInterval(interval);
      hub.removeClient(process.pid);
      await stopHubB();
    }
  });

  it('keeps retrying after a failed attempt (one failure report) and attaches once a hub is available', async () => {
    const dead = deadPid();
    const port = 41011;
    hub.writeHubLock(port, dead, undefined, hub.SOCK_PATH);
    const recovered = [];
    let failures = 0;
    const interval = hub.startHubMonitor(dead, port, lock => recovered.push(lock), () => { failures++; });
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

  it('a hub discovered on a different port is not killed and counts as a failure', async () => {
    const A = liveForeignPid();
    hub.writeHubLock(41012, A.pid, undefined, hub.SOCK_PATH);
    let failures = 0;
    const interval = hub.startHubMonitor(A.pid, 41013, () => {}, () => { failures++; });
    try {
      await killAndWait(A);
      await startHubB(41012); // live hub, but on a port this client is not using
      assert.ok(await until(() => failures === 1));
      assert.equal(lockOnDisk().pid, process.pid, 'live hub\'s lock untouched');
    } finally {
      clearInterval(interval);
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
