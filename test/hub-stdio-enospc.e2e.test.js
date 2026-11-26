'use strict';

// A detached hub's stdout/stderr are a file on the data disk (hub.js forkHub
// opens hub.log and passes the fd). When that disk fills, a console write fails
// and Node emits 'error' on the stdio stream AFTER Console's own swallow
// listener is gone, so an unlistened 'error' became an uncaughtException that
// killed the proxy (observed 2026-11-25: hub.log ended in three ENOSPC lines
// and a bare "Node.js v22" trailer, the stack itself lost to the same full disk).
//
// This test uses REAL failing I/O, not a monkeypatch: an fs.writeSync patch
// does not reach Node's internal SyncWriteStream binding, and a patched
// _write callback does not reproduce the crash. Linux: /dev/full. macOS: a
// tiny disk image filled to 0 bytes free, with the log created empty beforehand
// so its first write needs a fresh block.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const INDEX = path.resolve(__dirname, '..', 'server', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, timeout: 15000,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

async function waitForHealth(port, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`hub exited during startup (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const res = await request(port, 'GET', '/_api/health');
      if (res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('hub did not become healthy');
}

// Returns { path, cleanup } for a writable file whose writes fail with ENOSPC,
// or null when this platform offers no real full device.
function openFullLogTarget(tmp) {
  if (process.platform === 'linux' && fs.existsSync('/dev/full')) {
    return { path: '/dev/full', cleanup() {} };
  }
  if (process.platform !== 'darwin') return null;
  const img = path.join(tmp, 'full.dmg');
  const mnt = path.join(tmp, 'mnt');
  fs.mkdirSync(mnt);
  try {
    execFileSync('hdiutil', ['create', '-size', '4m', '-fs', 'HFS+', '-volname', 'ccxfull', '-o', img, '-quiet']);
    execFileSync('hdiutil', ['attach', img, '-mountpoint', mnt, '-nobrowse', '-quiet']);
  } catch {
    return null;
  }
  const detach = () => { try { execFileSync('hdiutil', ['detach', mnt, '-force', '-quiet']); } catch {} };
  // Create the (empty, zero-block) log BEFORE filling: a full HFS volume
  // refuses new files, but the log's first write still needs a fresh block.
  const logPath = path.join(mnt, 'hub.log');
  fs.closeSync(fs.openSync(logPath, 'a'));
  // Fill to exactly 0 bytes free: big blocks, then 512-byte tail.
  for (const bs of [65536, 512]) {
    const buf = Buffer.alloc(bs);
    const fd = fs.openSync(path.join(mnt, `fill-${bs}`), 'w');
    try { for (;;) fs.writeSync(fd, buf); } catch (e) { if (e.code !== 'ENOSPC') { fs.closeSync(fd); detach(); throw e; } }
    fs.closeSync(fd);
  }
  // Sanity: the target must really fail, or the test proves nothing.
  try {
    fs.appendFileSync(logPath, 'x'.repeat(8192));
    detach();
    return null;
  } catch (e) {
    if (e.code !== 'ENOSPC') { detach(); throw e; }
  }
  return { path: logPath, cleanup: detach };
}

describe('hub survives a full log disk (ENOSPC on stdout/stderr)', () => {
  let tmp, home, target, child, port, upstreamPort;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-enospc-'));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    target = openFullLogTarget(tmp);
  });

  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(r => child.once('exit', r));
    }
    if (target) target.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps proxying after a console write fails with ENOSPC', async (t) => {
    if (!target) { t.skip('no real full device on this platform'); return; }
    port = await freePort();
    upstreamPort = await freePort(); // closed: forward fails and logs via console.error

    const fd = fs.openSync(target.path, 'a');
    child = spawn(process.execPath, [INDEX, '--port', String(port), '--hub-mode'], {
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        CCXRAY_EXPORT_DISABLE: '1',
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
      },
    });
    fs.closeSync(fd);

    await waitForHealth(port, child);

    // Each failed forward writes several error lines to stderr (the full disk).
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    for (let i = 0; i < 3; i++) {
      const res = await request(port, 'POST', '/v1/messages', body).catch(e => ({ error: e }));
      assert.ok(!res.error, `proxy request ${i} failed at transport level: ${res.error && res.error.message}`);
    }
    // The 'error' event is emitted on a later tick; give it time to kill an unguarded hub.
    await new Promise(r => setTimeout(r, 500));

    assert.equal(child.exitCode, null, `hub exited (code=${child.exitCode}) after a stdio ENOSPC`);
    assert.equal(child.signalCode, null);
    const health = await request(port, 'GET', '/_api/health');
    assert.equal(health.status, 200);
  });
});
