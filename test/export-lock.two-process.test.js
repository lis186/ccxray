'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_SYNC = path.join(ROOT, 'server', 'export-sync.js');
const { withExportLock, exportLockTarget, releaseLock, startupFlushAndPrune, describeLoss } = require('../server/export-sync');
const WAIT_MS = 5000;

let home;
let savedEnv;
const children = new Set();

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', err => err.code === 'EADDRINUSE' ? resolve(false) : reject(err));
    server.listen(port, '127.0.0.1', () => server.close(err => err ? reject(err) : resolve(true)));
  });
}

async function allocatePortBeforeContenders() {
  // A listen(0) result is released before it can be pinned. Verify it is still
  // bindable and retry here, before any lock contender exists in this fixture.
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer();
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(err => err ? reject(err) : resolve(value));
      });
    });
    if (port !== 5577 && await canBind(port)) return port;
  }
  throw new Error('could not allocate an available lock fixture port before contenders started');
}

async function createHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-lock-test-'));
  const port = await allocatePortBeforeContenders();
  fs.writeFileSync(path.join(home, 'export-lock-port'), `${port}\n`);
  savedEnv = {
    CCXRAY_HOME: process.env.CCXRAY_HOME,
    CCXRAY_EXPORT_DISABLE: process.env.CCXRAY_EXPORT_DISABLE,
    CCXRAY_EXPORT_GCS_BUCKET: process.env.CCXRAY_EXPORT_GCS_BUCKET,
  };
  process.env.CCXRAY_HOME = home;
  process.env.CCXRAY_EXPORT_DISABLE = '1';
  delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
  return { home, port };
}

function childEnv(childHome) {
  const env = { ...process.env, CCXRAY_HOME: childHome, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1' };
  delete env.CCXRAY_EXPORT_GCS_BUCKET;
  delete env.CCXRAY_EXPORT_GCS_KEY_FILE;
  return env;
}

function spawnJson(script, childHome) {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: childEnv(childHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.messages = [];
  child.waiters = [];
  child.stdoutText = '';
  child.stderrText = '';
  let buffer = '';
  child.stdout.on('data', chunk => {
    child.stdoutText += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { child.messages.push(JSON.parse(line)); } catch {}
      for (const waiter of [...child.waiters]) {
        const found = child.messages.find(waiter.predicate);
        if (found) {
          child.waiters.splice(child.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(found);
        }
      }
    }
  });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  child.on('exit', (code, signal) => {
    children.delete(child);
    for (const waiter of child.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`child exited before ${waiter.label} (code=${code}, signal=${signal}): ${child.stderrText}`));
    }
  });
  child.waitFor = (predicate, label = 'message', timeoutMs = WAIT_MS) => {
    const found = child.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, resolve, reject };
      waiter.timer = setTimeout(() => {
        child.waiters.splice(child.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${label}: ${child.stdoutText}\n${child.stderrText}`));
      }, timeoutMs);
      child.waiters.push(waiter);
    });
  };
  return child;
}

function holdScript(releasePath) {
  return `
    const fs = require('fs');
    const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
    (async () => {
      const outcome = await withExportLock(async handle => {
        process.stdout.write(JSON.stringify({ state: 'held', pid: process.pid, port: handle?.port ?? null }) + '\\n');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 10));
        return 'released';
      });
      process.stdout.write(JSON.stringify({ state: 'done', outcome }) + '\\n');
    })().catch(err => { console.error(err.stack); process.exitCode = 1; });
  `;
}

function contendScript() {
  return `
    const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
    withExportLock(() => 'acquired').then(outcome => {
      process.stdout.write(JSON.stringify({ state: outcome === undefined ? 'lost' : 'acquired', pid: process.pid, outcome: outcome ?? null }) + '\\n');
    }).catch(err => { console.error(err.stack); process.exitCode = 1; });
  `;
}

function startHolder(childHome) {
  const releasePath = path.join(childHome, `release-${Date.now()}-${Math.random()}`);
  const child = spawnJson(holdScript(releasePath), childHome);
  return child.waitFor(m => m.state === 'held').then(message => ({ child, releasePath, message }));
}

async function releaseHolder(holder) {
  fs.writeFileSync(holder.releasePath, 'release');
  await holder.child.waitFor(m => m.state === 'done', 'holder completion');
  await waitExit(holder.child);
}

function waitExit(child, timeoutMs = WAIT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for child ${child.pid} to exit`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function killOwned(child, signal = 'SIGKILL') {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  await waitExit(child);
}

afterEach(async () => {
  for (const child of [...children]) {
    try { await killOwned(child); } catch {}
  }
  if (savedEnv) {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  savedEnv = null;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe('per-home exporter socket lock', () => {
  it('T-neutral: a lock held by another process is lost here', async () => {
    const { home: h } = await createHome();
    const holder = await startHolder(h);
    try {
      const contender = spawnJson(contendScript(), h);
      assert.equal((await contender.waitFor(m => m.state === 'lost' || m.state === 'acquired')).state, 'lost');
      await waitExit(contender);
    } finally { await releaseHolder(holder); }
  });

  it('T-kill: SIGKILL of a holder releases the port immediately', async () => {
    const { home: h } = await createHome();
    const holder = await startHolder(h);
    await killOwned(holder.child);
    const contender = spawnJson(contendScript(), h);
    assert.equal((await contender.waitFor(m => m.state === 'lost' || m.state === 'acquired')).state, 'acquired');
    await waitExit(contender);
  });

  it('T-pause: a stopped holder keeps the lock until resumed and released', { skip: process.platform === 'win32' }, async () => {
    const { home: h } = await createHome();
    const holder = await startHolder(h);
    try {
      process.kill(holder.child.pid, 'SIGSTOP');
      const contender = spawnJson(contendScript(), h);
      assert.equal((await contender.waitFor(m => m.state === 'lost' || m.state === 'acquired')).state, 'lost');
      await waitExit(contender);
    } finally {
      if (holder.child.exitCode === null && holder.child.signalCode === null) process.kill(holder.child.pid, 'SIGCONT');
      await releaseHolder(holder);
    }
  });

  it('T-inherit: a holder child does not keep the listening socket after its parent dies', async () => {
    const { home: h } = await createHome();
    const releasePath = path.join(h, `release-${Date.now()}`);
    const grandchildPath = path.join(h, 'grandchild.pid');
    const script = `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
      (async () => {
        await withExportLock(async () => {
          const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          fs.writeFileSync(${JSON.stringify(grandchildPath)}, String(grandchild.pid));
          process.stdout.write(JSON.stringify({ state: 'held', pid: process.pid, grandchild: grandchild.pid }) + '\\n');
          while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 10));
        });
      })().catch(err => { console.error(err.stack); process.exitCode = 1; });
    `;
    const parent = spawnJson(script, h);
    let held;
    try {
      held = await parent.waitFor(m => m.state === 'held');
      await killOwned(parent);
      const contender = spawnJson(contendScript(), h);
      assert.equal((await contender.waitFor(m => m.state === 'lost' || m.state === 'acquired')).state, 'acquired');
      await waitExit(contender);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        try { await killOwned(parent); } catch {}
      }
      const pidFile = path.join(h, 'grandchild.pid');
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
      if (held) assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), held.grandchild);
    }
  });

  it('T-simultaneous and T-eventual: no more than one winner, then acquisition succeeds', async () => {
    const { home: h } = await createHome();
    const goPath = path.join(h, 'go');
    const releasePath = path.join(h, 'release');
    const script = `
      const fs = require('fs');
      const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
      (async () => {
        process.stdout.write(JSON.stringify({ state: 'ready', pid: process.pid }) + '\\n');
        while (!fs.existsSync(${JSON.stringify(goPath)})) await new Promise(r => setTimeout(r, 5));
        const outcome = await withExportLock(async handle => {
          process.stdout.write(JSON.stringify({ state: 'acquired', pid: process.pid, port: handle?.port ?? null }) + '\\n');
          while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 5));
          return 'held';
        });
        if (outcome === undefined) process.stdout.write(JSON.stringify({ state: 'lost', pid: process.pid }) + '\\n');
        else process.stdout.write(JSON.stringify({ state: 'done', pid: process.pid }) + '\\n');
      })().catch(err => { console.error(err.stack); process.exitCode = 1; });
    `;
    const contenders = Array.from({ length: 5 }, () => spawnJson(script, h));
    await Promise.all(contenders.map(c => c.waitFor(m => m.state === 'ready', 'ready barrier')));
    fs.writeFileSync(goPath, 'go');
    const outcomes = await Promise.all(contenders.map(c => c.waitFor(m => m.state === 'acquired' || m.state === 'lost', 'acquisition barrier')));
    assert.equal(outcomes.filter(m => m.state === 'acquired').length, 1, 'exactly one contender holds the lock');
    fs.writeFileSync(releasePath, 'release');
    await Promise.all(contenders.map(c => waitExit(c)));
    const eventual = spawnJson(contendScript(), h);
    assert.equal((await eventual.waitFor(m => m.state === 'lost' || m.state === 'acquired')).state, 'acquired');
    await waitExit(eventual);
  });

  it('T-lifecycle: sync/async throws release, late server errors are handled, and release is idempotent', async () => {
    const { home: h } = await createHome();
    let syncHandle;
    await assert.rejects(withExportLock(handle => {
      syncHandle = handle;
      throw new Error('sync boom');
    }), /sync boom/);
    syncHandle.srv.emit('error', Object.assign(new Error('late'), { code: 'EADDRINUSE' }));
    await releaseLock(syncHandle);
    await releaseLock(syncHandle);
    assert.equal(await withExportLock(() => 'reacquired'), 'reacquired');

    await assert.rejects(withExportLock(async () => { throw new Error('async boom'); }), /async boom/);
    assert.equal(await withExportLock(() => 'reacquired'), 'reacquired');
  });

  it('T-accepted: accepted peers close before the isolated process resource baseline is checked', async () => {
    const { home: h } = await createHome();
    const script = `
      const assert = require('assert');
      const net = require('net');
      const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
      const timeout = (promise, label) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + ' timed out')), 4000);
        promise.then(value => { clearTimeout(timer); resolve(value); }, err => { clearTimeout(timer); reject(err); });
      });
      const waitFor = async (fn, label) => timeout(new Promise((resolve, reject) => {
        const poll = () => fn() ? resolve() : setTimeout(poll, 5);
        poll();
      }), label);
      const snapshot = () => process.getActiveResourcesInfo().sort().join(',');
      (async () => {
        const baseline = snapshot();
        await withExportLock(async handle => {
          let accepted = 0, closed = 0, clientClosed = 0;
          handle.srv.on('connection', sock => { accepted++; sock.once('close', () => { closed++; }); });
          const clients = ['silent', 'peer-close', 'peer-rst'].map(mode => new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port: handle.port });
            socket.once('close', () => { clientClosed++; resolve(); });
            socket.once('error', err => { if (!socket.connecting) return; reject(err); });
            socket.once('connect', () => {
              if (mode === 'peer-close') socket.end();
              if (mode === 'peer-rst') (socket.resetAndDestroy || socket.destroy).call(socket);
            });
          }));
          await waitFor(() => accepted === clients.length, 'server acceptance barrier');
          await waitFor(() => closed === clients.length, 'server socket close barrier');
          await timeout(Promise.all(clients), 'client socket close barrier');
          assert.equal(clientClosed, clients.length);
        });
        const after = snapshot();
        assert.equal(after, baseline, 'active resources return to the isolated child baseline');
        assert.equal(await withExportLock(() => 'acquired'), 'acquired', 'contender acquires immediately after release');
        process.stdout.write(JSON.stringify({ state: 'done', baseline, after }) + '\\n');
      })().catch(err => { console.error(err.stack); process.exitCode = 1; });
    `;
    const child = spawnJson(script, h);
    const done = await child.waitFor(m => m.state === 'done', 'accepted connection cleanup');
    assert.equal(done.after, done.baseline);
    await waitExit(child);
  });

  it('T-EPERM: an inaccessible holder is not reclaimed', async () => {
    const { home: h } = await createHome();
    const holder = await startHolder(h);
    const originalKill = process.kill;
    process.kill = function (pid, signal) {
      if (Number(pid) === holder.child.pid && signal === 0) {
        const err = new Error('permission denied');
        err.code = 'EPERM';
        throw err;
      }
      return originalKill.call(process, pid, signal);
    };
    let outcome;
    try { outcome = await withExportLock(() => 'acquired'); }
    finally {
      process.kill = originalKill;
      await releaseHolder(holder);
    }
    assert.equal(outcome, undefined, 'the existing holder must remain exclusive');
  });

  it('T-pidreuse: a live unrelated PID in leftover export.lock does not block acquisition', async () => {
    const { home: h } = await createHome();
    fs.writeFileSync(path.join(h, 'export.lock'), JSON.stringify({ pid: process.pid, token: 'legacy', acquiredAt: Date.now() }));
    assert.equal(await withExportLock(() => 'acquired'), 'acquired');
  });

  it('T-events: a lock loss writes a structured event with phase, port, and cause', async () => {
    const { home: h, port } = await createHome();
    await withExportLock(async () => {
      assert.equal(await withExportLock(() => 'should not enter'), undefined);
    });
    const event = JSON.parse(fs.readFileSync(path.join(h, 'export-events.log'), 'utf8').trim()).event;
    assert.deepEqual(event, { type: 'lock-lost', phase: 'startup', port, code: 'EADDRINUSE' });
  });

  it('T-head-schedule: callback-count barrier exposes HEAD zero-byte reclaim, while socket lock admits one holder', async () => {
    const { home: h } = await createHome();
    const allowFirstWrite = path.join(h, 'allow-first-write');
    const releaseFirst = path.join(h, 'release-first');
    const releaseSecond = path.join(h, 'release-second');
    const childScript = role => `
      const fs = require('fs');
      const path = require('path');
      const { withExportLock } = require(${JSON.stringify(EXPORT_SYNC)});
      const lockPath = path.join(process.env.CCXRAY_HOME, 'export.lock');
      const originalWrite = fs.writeFileSync;
      let lockWriteCallbacks = 0;
      if (${JSON.stringify(role)} === 'first') {
        fs.writeFileSync = function (filename, data, options) {
          if (path.resolve(String(filename)) === lockPath && options?.flag === 'wx' && lockWriteCallbacks++ === 0) {
            originalWrite.call(fs, filename, '', options);
            process.stdout.write(JSON.stringify({ state: 'published-empty', callbackCount: lockWriteCallbacks }) + '\\n');
            const waitCell = new Int32Array(new SharedArrayBuffer(4));
            const deadline = Date.now() + 4000;
            while (!fs.existsSync(${JSON.stringify(allowFirstWrite)})) {
              if (Date.now() >= deadline) throw new Error('first write barrier timed out');
              Atomics.wait(waitCell, 0, 0, 10);
            }
            originalWrite.call(fs, filename, data);
            process.stdout.write(JSON.stringify({ state: 'write-resumed', callbackCount: lockWriteCallbacks }) + '\\n');
            return;
          }
          return originalWrite.call(fs, filename, data, options);
        };
      }
      const releasePath = ${JSON.stringify(role)} === 'first' ? ${JSON.stringify(releaseFirst)} : ${JSON.stringify(releaseSecond)};
      withExportLock(async () => {
        process.stdout.write(JSON.stringify({ state: 'held', role: ${JSON.stringify(role)}, pid: process.pid }) + '\\n');
        while (!fs.existsSync(releasePath)) await new Promise(resolve => setTimeout(resolve, 10));
        return 'released';
      }).then(outcome => process.stdout.write(JSON.stringify({
        state: outcome === undefined ? 'lost' : 'done', role: ${JSON.stringify(role)}, outcome: outcome ?? null,
      }) + '\\n'))
        .catch(error => { console.error(error.stack); process.exitCode = 1; });
    `;

    const first = spawnJson(childScript('first'), h);
    const firstStart = await first.waitFor(message => message.state === 'published-empty' || message.state === 'held', 'first lock callback');
    const second = spawnJson(childScript('second'), h);
    const secondStart = await second.waitFor(message => message.state === 'held' || message.state === 'lost', 'second lock callback');

    if (firstStart.state === 'published-empty') {
      assert.equal(firstStart.callbackCount, 1, 'the legacy first write reached the controlled publish window');
      assert.equal(secondStart.state, 'held', 'HEAD reclaims the zero-byte file while the first writer is paused');
      fs.writeFileSync(allowFirstWrite, 'continue');
      await first.waitFor(message => message.state === 'held', 'first holder after the publish window');
    } else {
      assert.equal(firstStart.state, 'held', 'the socket lock is held before any legacy file write');
      assert.equal(secondStart.state, 'lost', 'a second process cannot enter the held critical section');
      assert.equal(first.messages.some(message => message.state === 'published-empty'), false,
        'the socket lock never opens export.lock');
      fs.writeFileSync(releaseFirst, 'release');
      await first.waitFor(message => message.state === 'done', 'first holder release');
      await waitExit(first);
      await waitExit(second);
      return;
    }

    const simultaneousCallbacks = [first, second]
      .filter(child => child.messages.some(message => message.state === 'held')).length;
    assert.equal(simultaneousCallbacks, 1,
      'only one callback may hold the exporter critical section (HEAD lets both through)');
  });

  it('T-identity and T-pin: filesystem aliases share identity-derived ports and a valid pin', async t => {
    const { home: h } = await createHome();
    fs.unlinkSync(path.join(h, 'export-lock-port'));
    const identity = p => {
      const st = fs.statSync(p, { bigint: true });
      return `${st.dev}:${st.ino}`;
    };
    const checkAlias = (a, b) => {
      assert.equal(identity(a), identity(b), 'fixture aliases must resolve to one filesystem identity');
      assert.equal(exportLockTarget(a).port, exportLockTarget(b).port);
    };
    checkAlias(h, `${h}/`);

    const link = path.join(path.dirname(h), `ccxray-lock-link-${path.basename(h)}`);
    fs.symlinkSync(h, link);
    t.after(() => { try { fs.unlinkSync(link); } catch {} });
    checkAlias(h, link);

    const parent = path.join(h, 'rename-parent');
    const before = path.join(parent, 'nested-home');
    fs.mkdirSync(before, { recursive: true });
    const beforeIdentity = identity(before);
    const beforePort = exportLockTarget(before).port;
    const moved = `${parent}.moved`;
    fs.renameSync(parent, moved);
    const after = path.join(moved, 'nested-home');
    assert.equal(identity(after), beforeIdentity);
    assert.equal(exportLockTarget(after).port, beforePort);

    const caseAlias = [...h].map(ch => ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()).join('');
    if (fs.existsSync(caseAlias)) checkAlias(h, caseAlias);
    else t.diagnostic('case alias fixture skipped on a case-sensitive volume');

    const unicodeName = `identity-${Date.now()}-é`;
    const unicodeNfc = path.join(h, unicodeName);
    const unicodeNfd = path.join(h, unicodeName.normalize('NFD'));
    fs.mkdirSync(unicodeNfc);
    if (fs.existsSync(unicodeNfd) && identity(unicodeNfc) === identity(unicodeNfd)) checkAlias(unicodeNfc, unicodeNfd);
    else t.diagnostic('Unicode normalization alias fixture skipped on this volume');

    const separate = path.join(h, 'separate');
    fs.mkdirSync(separate);
    assert.notEqual(identity(h), identity(separate));

    fs.writeFileSync(path.join(h, 'export-lock-port'), '23456\n');
    assert.equal(exportLockTarget(link).port, 23456);
    assert.equal(exportLockTarget(h).port, 23456);
  });

  it('T-pin fails closed before reading a valid pin if directory identity is unavailable', async () => {
    const { home: h } = await createHome();
    const originalStat = fs.statSync;
    fs.statSync = function (filename, options) {
      if (path.resolve(String(filename)) === h && options?.bigint) {
        return { isDirectory: () => true, dev: 1n, ino: 0n };
      }
      return originalStat.call(this, filename, options);
    };
    try { assert.deepEqual(exportLockTarget(h), { reason: 'identity', detail: 'directory=true ino=0' }); }
    finally { fs.statSync = originalStat; }
  });

  it('T-closed: mkdir, stat, and invalid-pin failures remain structured and do not suggest holder commands', async () => {
    const { home: h } = await createHome();
    const logs = [];
    const run = async () => startupFlushAndPrune({ pruneLogs: async () => assert.fail('must not prune'), log: line => logs.push(line) });

    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = function (filename, ...args) {
      if (path.resolve(String(filename)) === h) {
        const err = new Error('mkdir denied'); err.code = 'EACCES'; throw err;
      }
      return originalMkdir.call(this, filename, ...args);
    };
    try { assert.equal(await run(), 'lock-lost'); }
    finally { fs.mkdirSync = originalMkdir; }

    const originalStat = fs.statSync;
    fs.statSync = function (filename, ...args) {
      if (path.resolve(String(filename)) === h) {
        const err = new Error('stat denied'); err.code = 'EIO'; throw err;
      }
      return originalStat.call(this, filename, ...args);
    };
    try { assert.equal(await run(), 'lock-lost'); }
    finally { fs.statSync = originalStat; }

    fs.writeFileSync(path.join(h, 'export-lock-port'), 'abc\n');
    assert.equal(await run(), 'lock-lost');
    const events = fs.readFileSync(path.join(h, 'export-events.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(line => line.event.reason), ['mkdir', 'stat', 'pin-invalid']);
    assert.ok(events.every(line => line.event.phase === 'startup' && line.event.port === null));
    assert.ok(logs.every(line => !line.includes('lsof') && !line.includes('netstat')));
  });

  it('T-diagnostics preserve structured codes and state uncertainty truthfully', async () => {
    const { home: h, port } = await createHome();
    const logs = [];
    const occupied = net.createServer();
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(port, '127.0.0.1', resolve);
    });
    try {
      assert.equal(await require('../server/export-sync').startupFlushAndPrune({ pruneLogs: async () => assert.fail('must not prune'), log: line => logs.push(line) }), 'lock-lost');
      const events = fs.readFileSync(path.join(h, 'export-events.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(events.at(-1).event, { type: 'lock-lost', phase: 'startup', port, code: 'EADDRINUSE' });
      assert.match(logs.at(-1), /lsof .*netstat/);

      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        assert.match(describeLoss(h, { port, code: 'EACCES' }), /permission denied or exclusive binding/);
      } finally { Object.defineProperty(process, 'platform', platform); }
      assert.match(describeLoss(h, { reason: 'stat', detail: 'EIO' }), /port identity unavailable; occupancy unknown/);

      const originalListen = net.Server.prototype.listen;
      try {
        for (const [code, phrase] of [['EADDRNOTAVAIL', 'loopback is unavailable'], ['EMFILE', 'no file descriptor']]) {
          net.Server.prototype.listen = function () {
            const err = new Error(`mock ${code}`); err.code = code;
            process.nextTick(() => this.emit('error', err));
            return this;
          };
          logs.length = 0;
          assert.equal(await startupFlushAndPrune({ pruneLogs: async () => assert.fail('must not prune'), log: line => logs.push(line) }), 'lock-lost');
          assert.match(logs.at(-1), new RegExp(phrase));
          assert.ok(!logs.at(-1).includes('lsof') && !logs.at(-1).includes('netstat'));
          const rows = fs.readFileSync(path.join(h, 'export-events.log'), 'utf8').trim().split('\n').map(JSON.parse);
          assert.equal(rows.at(-1).event.code, code);
        }
      } finally { net.Server.prototype.listen = originalListen; }
    } finally {
      await new Promise(resolve => occupied.close(resolve));
    }
  });
});
