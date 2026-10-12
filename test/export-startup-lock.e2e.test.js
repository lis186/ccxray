'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'server', 'index.js');
const EXPORT_SYNC = path.join(ROOT, 'server', 'export-sync.js');
const WAIT_MS = 20_000;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function canBind(port) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', err => err.code === 'EADDRINUSE' ? resolve(false) : reject(err));
    server.listen(port, '127.0.0.1', () => server.close(err => err ? reject(err) : resolve(true)));
  });
}

async function freeLockPortBeforeContenders(excluded) {
  // listen(0) releases its candidate before the pin is written. Probe it again
  // and retry only here, before the holder or any startup contender is spawned.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freePort();
    if (port !== 5577 && !excluded.has(port) && await canBind(port)) return port;
  }
  throw new Error('could not allocate an available startup lock port before contenders started');
}

function isolatedEnv(home) {
  const env = {
    ...process.env,
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    BROWSER: 'none',
    LOG_RETENTION_DAYS: '14',
  };
  delete env.CCXRAY_EXPORT_GCS_BUCKET;
  delete env.CCXRAY_EXPORT_GCS_KEY_FILE;
  delete env.PROXY_PORT;
  return env;
}

function spawnServer(home, port) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
    cwd: ROOT,
    env: isolatedEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  return child;
}

function spawnHolder(home, releasePath) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const sync = require(${JSON.stringify(EXPORT_SYNC)});
    const wait = async () => { while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise(r => setTimeout(r, 10)); };
    (async () => {
      if (typeof sync.withExportLock === 'function') {
        const outcome = await sync.withExportLock(async handle => {
          process.stdout.write(JSON.stringify({ state: 'held', port: handle?.port ?? null }) + '\\n');
          await wait();
          return 'released';
        });
        process.stdout.write(JSON.stringify({ state: 'done', outcome: outcome ?? null }) + '\\n');
      } else {
        const lockPath = path.join(process.env.CCXRAY_HOME, 'export.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'e2e-holder', acquiredAt: Date.now() }), { flag: 'wx' });
        process.stdout.write(JSON.stringify({ state: 'held', port: null }) + '\\n');
        await wait();
        fs.unlinkSync(lockPath);
        process.stdout.write(JSON.stringify({ state: 'done', outcome: 'released' }) + '\\n');
      }
    })().catch(err => { console.error(err.stack); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: isolatedEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.messages = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    child.stdoutText += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { child.messages.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  return child;
}

function waitForMessage(child, state, timeoutMs = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const check = () => child.messages.find(m => m.state === state);
    const found = check();
    if (found) return resolve(found);
    const timer = setInterval(() => {
      const message = check();
      if (message) { clearInterval(timer); clearTimeout(timeout); resolve(message); }
      else if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(timer); clearTimeout(timeout);
        reject(new Error(`holder exited before ${state}: ${child.stdoutText}\n${child.stderrText}`));
      }
    }, 20);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timed out waiting for holder ${state}: ${child.stdoutText}\n${child.stderrText}`));
    }, timeoutMs);
  });
}

function eventOffset(home) {
  try { return fs.statSync(path.join(home, 'export-events.log')).size; } catch { return 0; }
}

function eventsAfter(home, offset, pid) {
  const filename = path.join(home, 'export-events.log');
  let bytes;
  try { bytes = fs.readFileSync(filename); } catch { return []; }
  return bytes.subarray(Math.min(offset, bytes.length)).toString('utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row.pid === pid ? [row] : [];
    } catch { return []; }
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForStartup(child, home, offset, { losing }) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited before startup completion: ${child.stdoutText}\n${child.stderrText}`);
    }
    const events = eventsAfter(home, offset, child.pid);
    const ownLoss = events.find(row => row.event === 'lock-lost'
      || (row.event && row.event.type === 'lock-lost' && row.event.phase === 'startup'));
    if (child.stderrText.includes('[ccxray] startup tasks complete') || ownLoss
      || /Pruned \d+ log files/.test(child.stdoutText)) {
      if (losing) assert.ok(ownLoss || /Pruned \d+ log files/.test(child.stdoutText) || child.stderrText.includes('[ccxray] startup tasks complete'));
      return { events, ownLoss };
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for startup completion: ${child.stdoutText}\n${child.stderrText}`);
}

function idsInIndex(home) {
  try {
    return fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line).id).sort();
  } catch { return []; }
}

async function waitForIndex(home, expected) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const ids = idsInIndex(home);
    if (JSON.stringify(ids) === JSON.stringify(expected)) return ids;
    await delay(25);
  }
  throw new Error(`index did not reach expected survivor set ${JSON.stringify(expected)}; got ${JSON.stringify(idsInIndex(home))}`);
}

function waitExit(child, timeoutMs = WAIT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for pid ${child.pid} to exit`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await waitExit(child); }
  catch (err) {
    child.kill('SIGKILL');
    await waitExit(child);
    throw err;
  }
}

describe('startup flush and prune share the cross-process exporter lock', () => {
  it('a losing startup preserves old files, then a later successful startup prunes and syncs the index', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-startup-e2e-'));
    const logs = path.join(home, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const proxyPort = await freePort();
    const lockPort = await freeLockPortBeforeContenders(new Set([proxyPort]));
    fs.writeFileSync(path.join(home, 'export-lock-port'), `${lockPort}\n`);

    const oldIds = ['2020-01-01T00-00-00-000', '2020-01-02T00-00-00-000'];
    const survivor = `${new Date().toISOString().slice(0, 10)}T12-00-00-000`;
    const entries = [
      ...oldIds.map((id, i) => ({ id, sessionId: `old-${i}`, cwd: '/tmp/old-fixture', receivedAt: Date.parse(`${id.slice(0, 10)}T00:00:00Z`) })),
      { id: survivor, sessionId: 'survivor', cwd: '/tmp/recent-fixture', receivedAt: Date.now() },
    ];
    fs.writeFileSync(path.join(logs, 'index.ndjson'), entries.map(JSON.stringify).join('\n') + '\n');
    for (const id of [...oldIds, survivor]) {
      fs.writeFileSync(path.join(logs, `${id}_req.json`), '{}');
      fs.writeFileSync(path.join(logs, `${id}_res.json`), '{}');
    }

    const releasePath = path.join(home, 'release-holder');
    const holder = spawnHolder(home, releasePath);
    let boot1, boot2;
    try {
      await waitForMessage(holder, 'held');
      const boot1Offset = eventOffset(home);
      boot1 = spawnServer(home, proxyPort);
      await waitForStartup(boot1, home, boot1Offset, { losing: true });
      assert.deepEqual(oldIds.flatMap(id => [`${id}_req.json`, `${id}_res.json`]).map(name => fs.existsSync(path.join(logs, name))), [true, true, true, true]);

      const boot1Loss = eventsAfter(home, boot1Offset, boot1.pid).find(row => row.event === 'lock-lost'
        || (row.event && row.event.type === 'lock-lost'));
      assert.ok(boot1Loss, 'the losing boot must write its own loss event after the pre-spawn offset');
      if (boot1Loss.event && typeof boot1Loss.event === 'object') {
        assert.equal(boot1Loss.event.phase, 'startup');
        assert.equal(boot1Loss.event.port, lockPort);
        assert.equal(boot1Loss.event.code, 'EADDRINUSE');
      }

      fs.writeFileSync(releasePath, 'release');
      await waitForMessage(holder, 'done');
      await waitExit(holder);
      await stopOwned(boot1);

      const boot2Offset = eventOffset(home);
      boot2 = spawnServer(home, proxyPort);
      await waitForStartup(boot2, home, boot2Offset, { losing: false });
      await waitForIndex(home, [survivor]);
      assert.ok(oldIds.every(id => !fs.existsSync(path.join(logs, `${id}_req.json`)) && !fs.existsSync(path.join(logs, `${id}_res.json`))));
      assert.ok(fs.existsSync(path.join(logs, `${survivor}_req.json`)));
      assert.deepEqual(idsInIndex(home), [survivor]);
    } finally {
      if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, 'release');
      for (const child of [holder, boot1, boot2]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { await stopOwned(child); } catch {}
        }
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
