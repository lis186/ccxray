'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { resolveCcxrayHome } = require('./paths');

const HUB_DIR = resolveCcxrayHome();
const HUB_LOCK_PATH = path.join(HUB_DIR, 'hub.json');
const HUB_LOG_PATH = path.join(HUB_DIR, 'hub.log');
const SOCK_PATH = path.join(HUB_DIR, 'hub.sock');
const FORK_LOCK_PATH = path.join(HUB_DIR, 'hub.fork.lock');
const FORK_LOCK_STALE_MS = 15000;
const IDLE_TIMEOUT_MS = 5000;
const DEAD_CLIENT_CHECK_MS = 30000;
const HUB_HEALTH_CHECK_MS = 5000;
const READINESS_POLL_MS = 200;
const READINESS_TIMEOUT_MS = 10000;
const HUB_LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const HUB_LOG_KEEP_BYTES = 100 * 1024;     // 100 KB

// ── Lockfile operations ─────────────────────────────────────────────

function ensureHubDir() {
  if (!fs.existsSync(HUB_DIR)) fs.mkdirSync(HUB_DIR, { recursive: true, mode: 0o700 });
}

function readHubLock() {
  try {
    return JSON.parse(fs.readFileSync(HUB_LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeHubLock(port, pid, versionOverride, sockPath) {
  ensureHubDir();
  const version = versionOverride || require('../package.json').version;
  const data = { port, pid, version, startedAt: new Date().toISOString() };
  if (sockPath) data.sockPath = sockPath;
  fs.writeFileSync(HUB_LOCK_PATH, JSON.stringify(data), { mode: 0o600 });
  return data;
}

function deleteHubLock() {
  try { fs.unlinkSync(HUB_LOCK_PATH); } catch {}
}

// ── PID check ───────────────────────────────────────────────────────

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Health check (HTTP probe) ───────────────────────────────────────

function checkHubHealth(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/_api/health`, { timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.ok === true);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Orphan hub probe (port-level fallback when lockfile missing) ────

function probeHubStatus(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/_api/hub/status`, { timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.app === 'ccxray' && parsed.pid && parsed.version && parsed.port) resolve(parsed);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Hub discovery (dual verification: pid + health) ─────────────────

async function discoverHub(defaultPort) {
  const lock = readHubLock();
  if (lock) {
    if (!isPidAlive(lock.pid)) {
      deleteHubLock();
      return null;
    }
    // Prefer socket probe when sockPath is available
    let healthy;
    if (lock.sockPath) {
      try {
        const res = await hubSocketRequest(lock.sockPath, { cmd: 'health' }, 2000);
        healthy = res && res.ok === true;
      } catch {
        healthy = false;
      }
    } else {
      healthy = await checkHubHealth(lock.port);
    }
    if (!healthy) {
      deleteHubLock();
      // Do NOT kill lock.pid here: hub.json may be stale from a crash, and the pid
      // may have been reused by an unrelated process. Sending SIGTERM to an arbitrary
      // pid is unsafe. The hub startup retry loop (5 × 1s) handles the shutdown-race
      // case where the port hasn't been released yet.
      return null;
    }
    return lock;
  }

  // Lockfile missing — probe for orphan hub
  // Try socket first (deterministic path), then HTTP health as fallback
  if (fs.existsSync(SOCK_PATH)) {
    try {
      const res = await hubSocketRequest(SOCK_PATH, { cmd: 'status' }, 2000);
      if (res && res.app === 'ccxray' && res.pid && isPidAlive(res.pid)) {
        const recovered = writeHubLock(res.port, res.pid, res.version, SOCK_PATH);
        return recovered;
      }
    } catch {}
  }

  // HTTP fallback for orphan detection (probes arbitrary ports)
  if (!defaultPort) return null;
  const status = await probeHubStatus(defaultPort);
  if (!status) return null;
  if (status.port !== defaultPort) return null; // reject port mismatch (non-ccxray service)
  if (!isPidAlive(status.pid)) return null;

  // Reconstruct lockfile from live hub (use hub's version, not client's)
  const recovered = writeHubLock(status.port, status.pid, status.version);
  return recovered;
}

// ── Version compatibility (semver major check) ──────────────────────

function checkVersionCompat(hubVersion) {
  const clientVersion = require('../package.json').version;
  if (hubVersion === clientVersion) return { ok: true };

  const hubMajor = parseInt(hubVersion.split('.')[0], 10);
  const clientMajor = parseInt(clientVersion.split('.')[0], 10);

  if (hubMajor !== clientMajor) {
    return {
      ok: false,
      fatal: true,
      message: `Hub (v${hubVersion}) is incompatible with this client (v${clientVersion}). Close all ccxray instances and restart.`,
    };
  }

  const hubMinor = parseInt(hubVersion.split('.')[1], 10);
  const clientMinor = parseInt(clientVersion.split('.')[1], 10);
  if (hubMinor !== clientMinor) {
    return {
      ok: true,
      warning: `Hub is v${hubVersion}, client is v${clientVersion} (minor version mismatch)`,
    };
  }

  return { ok: true };
}

// ── Fork lock (prevents multiple clients from forking hubs simultaneously) ──

function tryAcquireForkLock() {
  ensureHubDir();
  try {
    fs.writeFileSync(FORK_LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Check if the existing lock is stale
      try {
        const lock = JSON.parse(fs.readFileSync(FORK_LOCK_PATH, 'utf8'));
        if (Date.now() - lock.at > FORK_LOCK_STALE_MS || !isPidAlive(lock.pid)) {
          // Atomic rename to avoid TOCTOU: move stale lock aside, then try wx create.
          // If another client races us, only one rename succeeds (the other gets ENOENT).
          const staleTarget = FORK_LOCK_PATH + `.stale.${process.pid}`;
          try {
            fs.renameSync(FORK_LOCK_PATH, staleTarget);
            fs.unlinkSync(staleTarget);
          } catch {}
          // Now attempt exclusive create — may fail if another client won the race
          try {
            fs.writeFileSync(FORK_LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return true;
          } catch {
            return false;
          }
        }
      } catch {}
      return false;
    }
    return false;
  }
}

function releaseForkLock() {
  try { fs.unlinkSync(FORK_LOCK_PATH); } catch {}
}

// ── Fork detached hub process ───────────────────────────────────────

function forkHub(port, opts = {}) {
  const { spawn } = require('child_process');
  ensureHubDir();
  truncateHubLog();

  const fd = fs.openSync(HUB_LOG_PATH, 'a');
  const hubScript = path.resolve(__dirname, 'index.js');
  const args = ['--port', String(port), '--hub-mode'];
  const env = { ...process.env };
  if (opts.displayName && !env.CCXRAY_DISPLAY_NAME) env.CCXRAY_DISPLAY_NAME = opts.displayName;

  const child = spawn(process.execPath, [hubScript, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// ── Wait for hub readiness (poll lockfile) ──────────────────────────

function waitForHubReady(timeoutMs = READINESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const lock = readHubLock();
      if (lock) return resolve(lock);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Hub did not become ready within ${timeoutMs / 1000}s. Check ${HUB_LOG_PATH}`));
      }
      setTimeout(check, READINESS_POLL_MS);
    };
    check();
  });
}

// ── Unix socket IPC ────────────────────────────────────────────────

let hubSocket = null; // socket server instance, set by createHubSocket

function cleanupStaleSocket() {
  return new Promise(resolve => {
    if (!fs.existsSync(SOCK_PATH)) return resolve();

    const lock = readHubLock();
    // No lockfile or lockfile pid is dead → orphan socket file, unlink directly
    if (!lock || !isPidAlive(lock.pid)) {
      try { fs.unlinkSync(SOCK_PATH); } catch {}
      return resolve();
    }

    // Pid alive — probe socket to confirm it's actually responding
    const probe = net.connect(SOCK_PATH);
    const timer = setTimeout(() => {
      probe.destroy();
      try { fs.unlinkSync(SOCK_PATH); } catch {}
      resolve();
    }, 1000);
    probe.on('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(); // live socket, don't remove
    });
    probe.on('error', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(SOCK_PATH); } catch {}
      resolve();
    });
  });
}

function createHubSocket() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(socket => {
      let buf = '';
      socket.on('data', chunk => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch {
            socket.write(JSON.stringify({ error: 'parse_error' }) + '\n');
            continue;
          }
          handleSocketCommand(msg, socket);
        }
      });
      socket.on('error', () => {}); // ignore client disconnect errors
    });

    srv.on('error', reject);
    srv.listen(SOCK_PATH, () => {
      try { fs.chmodSync(SOCK_PATH, 0o600); } catch {}
      hubSocket = srv;
      resolve(srv);
    });
  });
}

function handleSocketCommand(msg, socket) {
  const { cmd } = msg;
  switch (cmd) {
    case 'health':
      socket.write(JSON.stringify({ ok: true }) + '\n');
      break;
    case 'register': {
      if (typeof msg.pid !== 'number' || msg.pid <= 0 || msg.pid > 4194304 || !Number.isInteger(msg.pid)) return;
      if (typeof msg.cwd !== 'string' || msg.cwd.length > 4096) return;
      const wasEmpty = clients.size === 0;
      addClient(msg.pid, msg.cwd);
      socket.write(JSON.stringify({ ok: true, firstClient: wasEmpty }) + '\n');
      break;
    }
    case 'unregister':
      removeClient(msg.pid);
      socket.write(JSON.stringify({ ok: true }) + '\n');
      break;
    case 'bootstrap-token': {
      const auth = require('./auth');
      const token = auth.mintBootstrapToken();
      socket.write(JSON.stringify({ token }) + '\n');
      break;
    }
    case 'status':
      socket.write(JSON.stringify(getHubStatus()) + '\n');
      break;
    default:
      socket.write(JSON.stringify({ error: 'unknown_command' }) + '\n');
  }
}

function hubSocketRequest(sockPath, msg, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const client = net.connect(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('hubSocketRequest timeout'));
    }, timeoutMs);

    client.on('connect', () => {
      client.write(JSON.stringify(msg) + '\n');
    });
    client.on('data', chunk => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const parsed = JSON.parse(buf.slice(0, nl));
        client.destroy();
        resolve(parsed);
      }
    });
    client.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Client registration (socket-preferred, HTTP fallback) ──────────

function registerClient(lockInfoOrPort, pid, cwd) {
  const sockPath = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.sockPath : null;
  if (sockPath) {
    return hubSocketRequest(sockPath, { cmd: 'register', pid, cwd });
  }
  const port = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.port : lockInfoOrPort;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pid, cwd });
    const req = http.request(`http://localhost:${port}/_api/hub/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('register timeout')); });
    req.end(body);
  });
}

function unregisterClient(lockInfoOrPort, pid) {
  const sockPath = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.sockPath : null;
  if (sockPath) {
    return hubSocketRequest(sockPath, { cmd: 'unregister', pid }).catch(() => {});
  }
  const port = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.port : lockInfoOrPort;
  return new Promise(resolve => {
    const body = JSON.stringify({ pid });
    const req = http.request(`http://localhost:${port}/_api/hub/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, res => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

// ── Hub log truncation ──────────────────────────────────────────────

function truncateHubLog() {
  try {
    const stat = fs.statSync(HUB_LOG_PATH);
    if (stat.size > HUB_LOG_MAX_BYTES) {
      const buf = Buffer.alloc(HUB_LOG_KEEP_BYTES);
      const fd = fs.openSync(HUB_LOG_PATH, 'r');
      fs.readSync(fd, buf, 0, HUB_LOG_KEEP_BYTES, stat.size - HUB_LOG_KEEP_BYTES);
      fs.closeSync(fd);
      // Find first newline to avoid partial line
      const nl = buf.indexOf(0x0a);
      const clean = nl >= 0 ? buf.subarray(nl + 1) : buf;
      fs.writeFileSync(HUB_LOG_PATH, clean, { mode: 0o600 });
    }
  } catch {}
}

// ── Client lifecycle (hub-side state) ───────────────────────────────

const clients = new Map(); // pid → { cwd, connectedAt }
let idleTimer = null;
let deadCheckInterval = null;
let hubListenPort = null; // set once at startup, survives lockfile deletion
let onShutdown = null; // injectable shutdown handler (default: process.exit)

function addClient(pid, cwd) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clients.set(pid, { cwd, connectedAt: new Date().toISOString() });
}

function removeClient(pid) {
  clients.delete(pid);
  if (clients.size === 0) startIdleTimer();
}

// Returns the cwd of the unique registered client, or null when zero or
// more than one client is connected (ambiguous in multi-project hub mode).
// Used by the request log path as a fallback when sessionMeta has no cwd
// for a session (e.g. the very first request of a session that lacked
// the system prompt block carrying "Primary working directory").
function lookupClientCwd() {
  if (clients.size !== 1) return null;
  const only = clients.values().next().value;
  return only && only.cwd ? only.cwd : null;
}

function startIdleTimer() {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    console.log('All clients disconnected. Shutting down hub.');
    shutdownHub();
  }, IDLE_TIMEOUT_MS);
}

function setOnShutdown(fn) { onShutdown = fn; }

function shutdownHub() {
  if (deadCheckInterval) clearInterval(deadCheckInterval);
  if (hubSocket) {
    try { hubSocket.close(); } catch {}
    try { fs.unlinkSync(SOCK_PATH); } catch {}
    hubSocket = null;
  }
  deleteHubLock();
  if (onShutdown) onShutdown();
  else process.exit(0);
}

function startDeadClientCheck() {
  deadCheckInterval = setInterval(() => {
    for (const [pid] of clients) {
      if (!isPidAlive(pid)) {
        console.log(`Dead client detected: pid ${pid}, removing.`);
        removeClient(pid);
      }
    }
  }, DEAD_CLIENT_CHECK_MS);
  deadCheckInterval.unref();
}

function setHubPort(port) { hubListenPort = port; }

function getHubStatus() {
  return {
    app: 'ccxray',
    port: hubListenPort || readHubLock()?.port,
    pid: process.pid,
    version: require('../package.json').version,
    uptime: Math.floor(process.uptime()),
    clients: [...clients.entries()].map(([pid, info]) => ({ pid, ...info })),
  };
}

// ── Hub route handler (mounted in server) ───────────────────────────

function _isLoopbackPeer(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function handleHubRoutes(clientReq, clientRes) {
  const pathname = clientReq.url.split('?')[0];

  if (pathname === '/_api/health' && clientReq.method === 'GET') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Phase 2.1: hub IPC moved to Unix socket. HTTP hub routes return 410.
  if (pathname.startsWith('/_api/hub/')) {
    clientReq.resume(); // drain any request body
    clientRes.writeHead(410, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'gone', message: 'Upgrade ccxray to use socket-based hub IPC' }));
    return true;
  }

  return false;
}

// ── Hub pid monitoring (client-side recovery) ───────────────────────

function startHubMonitor(hubPid, hubPort, onRecovery) {
  const interval = setInterval(async () => {
    if (isPidAlive(hubPid)) return;

    clearInterval(interval);
    console.error('\x1b[33mHub process died. Attempting recovery...\x1b[0m');
    deleteHubLock();

    let acquired = false;
    try {
      acquired = tryAcquireForkLock();
      if (acquired) forkHub(hubPort);
      const lock = await waitForHubReady();
      if (acquired) releaseForkLock();
      if (lock.port !== hubPort) {
        if (acquired) releaseForkLock();
        console.error(`\x1b[31mHub recovered on port ${lock.port} but Claude is using port ${hubPort}. Cannot recover.\x1b[0m`);
        try { process.kill(lock.pid, 'SIGTERM'); } catch {}
        return;
      }
      console.error(`\x1b[32mHub recovered (pid ${lock.pid}, port ${lock.port})\x1b[0m`);
      if (onRecovery) onRecovery(lock);
      startHubMonitor(lock.pid, lock.port, onRecovery);
    } catch (err) {
      if (acquired) releaseForkLock();
      console.error(`\x1b[31mHub recovery failed: ${err.message}\x1b[0m`);
    }
  }, HUB_HEALTH_CHECK_MS);
  interval.unref();
  return interval;
}

// ── Port scanner (used by hub and Claude-mode startup) ──────────────

function tryListen(srv, port, maxAttempts) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function onError(err) {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        attempt++;
        srv.listen(port + attempt);
      } else {
        srv.removeListener('error', onError);
        srv.removeListener('listening', onListening);
        reject(err);
      }
    }
    function onListening() {
      srv.removeListener('error', onError);
      resolve(srv.address().port);
    }
    srv.on('error', onError);
    srv.once('listening', onListening);
    srv.listen(port);
  });
}

module.exports = {
  HUB_DIR,
  HUB_LOCK_PATH,
  HUB_LOG_PATH,
  SOCK_PATH,
  readHubLock,
  writeHubLock,
  deleteHubLock,
  isPidAlive,
  checkHubHealth,
  probeHubStatus,
  discoverHub,
  checkVersionCompat,
  tryAcquireForkLock,
  releaseForkLock,
  forkHub,
  waitForHubReady,
  cleanupStaleSocket,
  createHubSocket,
  hubSocketRequest,
  registerClient,
  unregisterClient,
  truncateHubLog,
  addClient,
  removeClient,
  lookupClientCwd,
  startIdleTimer,
  setOnShutdown,
  shutdownHub,
  startDeadClientCheck,
  setHubPort,
  getHubStatus,
  handleHubRoutes,
  startHubMonitor,
  tryListen,
};
