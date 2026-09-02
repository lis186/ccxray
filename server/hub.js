'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { resolveCcxrayHome, resolveLogsDir } = require('./paths');
const { exportStatus } = require('./export-sync');
const { relativeRootComplaints } = require('./importer');

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

// These are the same launch signals that server/index.js already derives before
// it starts a server. A client-side `ccxray <agent>` launch receives its report
// from the detached hub; the hub process itself is launched with --hub-mode.
let launchSignals = {
  hubMode: false,
  explicitPort: false,
  agentNamed: false,
  platform: process.platform,
};

function setLaunchSignals({ hubMode = false, explicitPort = false, agentNamed = false, platform = process.platform } = {}) {
  launchSignals = { hubMode, explicitPort, agentNamed, platform };
}

function kindFromLaunchSignals({ hubMode = false, explicitPort = false, agentNamed = false, platform = process.platform } = {}) {
  if (hubMode) return 'hub';
  if (explicitPort && agentNamed) return 'agent-port';
  if (!explicitPort && agentNamed && platform !== 'win32') return 'client';
  return 'standalone';
}

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

  const fd = fs.openSync(HUB_LOG_PATH, 'a', 0o600);
  const hubScript = path.resolve(__dirname, 'index.js');
  const args = ['--port', String(port), '--hub-mode'];
  const env = { ...process.env };
  if (opts.displayName && !env.CCXRAY_DISPLAY_NAME) env.CCXRAY_DISPLAY_NAME = opts.displayName;

  try {
    const child = spawn(process.execPath, [hubScript, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env,
    });
    child.once('error', opts.onError || (err => {
      console.error(`\x1b[31mHub launch failed: ${err.message}\x1b[0m`);
    }));
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
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
      addClient(msg.pid, msg.cwd, clientIdentityFromMessage(msg));
      socket.write(JSON.stringify({ ...assembleExportReport(), ok: true, firstClient: wasEmpty }) + '\n');
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

function registerClient(lockInfoOrPort, pid, cwd, identity = {}) {
  const sockPath = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.sockPath : null;
  const payload = { pid, cwd, ...clientIdentityFromMessage(identity) };
  if (sockPath) {
    return hubSocketRequest(sockPath, { cmd: 'register', ...payload });
  }
  const port = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.port : lockInfoOrPort;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
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

const clients = new Map(); // pid → { cwd, connectedAt, agentId?, userEmail?, team?, agentType? }
let idleTimer = null;
let deadCheckInterval = null;
let hubListenPort = null; // set once at startup, survives lockfile deletion
let identityPort = null; // this process's own listener, never read from the hub lockfile
let onShutdown = null; // injectable shutdown handler (default: process.exit)

function clientIdentityFromMessage(msg) {
  const out = {};
  for (const key of ['agentId', 'userEmail', 'team', 'agentType']) {
    if (typeof msg?.[key] === 'string') {
      const value = msg[key].trim();
      if (value && value.length <= 512) out[key] = value;
    }
  }
  return out;
}

function addClient(pid, cwd, identity = {}) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clients.set(pid, { cwd, connectedAt: new Date().toISOString(), ...clientIdentityFromMessage(identity) });
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

function hasClients() {
  return clients.size > 0;
}

function applyClientRoute(req) {
  const match = /^\/_ccxray\/client\/([1-9]\d*)(\/[^?]*)?(\?.*)?$/.exec(String(req?.url || ''));
  if (!match) return false;
  req.ccxrayClientPid = Number(match[1]);
  req.url = `${match[2] || '/'}${match[3] || ''}`;
  return true;
}

function lookupClientIdentityForRequest(req) {
  if (Number.isSafeInteger(req?.ccxrayClientPid)) {
    const client = clients.get(req.ccxrayClientPid);
    return client ? clientIdentityFromMessage(client) : null;
  }
  return null;
}

function lookupClientCwdForRequest(req) {
  if (Number.isSafeInteger(req?.ccxrayClientPid)) {
    return clients.get(req.ccxrayClientPid)?.cwd || null;
  }
  return lookupClientCwd();
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

function setIdentityPort(port) { identityPort = port; }

function currentHubPort() {
  return hubListenPort || readHubLock()?.port;
}

function assembleExportReport(env = process.env) {
  const kind = kindFromLaunchSignals(launchSignals);
  const { exportState, exportReason } = kind === 'client'
    ? { exportState: null, exportReason: null }
    : exportStatus(env);
  return {
    exportState,
    exportReason,
    configWarnings: kind === 'client' ? [] : relativeRootComplaints(env),
    identity: {
      kind,
      pid: process.pid,
      port: kind === 'client' ? null : identityPort,
      home: resolveCcxrayHome(env),
      logsDir: resolveLogsDir(env),
    },
  };
}

function getHubStatus() {
  // `port` is the HUB's listener (what `ccxray status` means by "the hub is on port N");
  // `identity.port` is the REPORTING process's own listener. They coincide in the hub and
  // can diverge in any other process that calls this helper; later surfaces must choose deliberately
  // (see docs/solutions/hub-owned-config-status.md §2.3).
  return {
    app: 'ccxray',
    port: currentHubPort(),
    pid: process.pid,
    version: require('../package.json').version,
    uptime: Math.floor(process.uptime()),
    ...assembleExportReport(),
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
    // app/pid/hub identify the listener to probePortOccupant (#555) so a
    // port-conflict message can tell a standalone ccxray from a foreign
    // process. `hub` is true only after setHubPort — i.e. real hub mode.
    clientRes.end(JSON.stringify({
      ok: true,
      app: 'ccxray',
      pid: process.pid,
      hub: hubListenPort != null,
      version: require('../package.json').version,
    }));
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

// ── Port-occupant probe (#555) ──────────────────────────────────────
// When the hub port is taken, identify WHO holds it before giving advice.
// The old message unconditionally suggested `kill $(lsof -t -i:PORT)`, which
// is destructive when the occupant is a deliberate long-running listener
// (e.g. a standalone `ccxray --port 5577`). Kinds:
//   'ccxray-hub'        — answers /_api/health with app:'ccxray', hub:true
//   'ccxray-standalone' — answers with app:'ccxray', hub:false
//   'health-ok'         — answers { ok: true } without the app tag (older ccxray)
//   'foreign-http'      — an HTTP server that is not ccxray
//   'silent'            — something is bound but does not answer HTTP
//   'free'              — connection refused (nothing listening)

function probePortOccupant(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/_api/health`, { timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', c => { data += c; if (data.length > 4096) req.destroy(); });
      res.on('end', () => {
        // Only a 200 counts as a health answer — a foreign service that
        // happens to echo { ok: true } on an error page must not be
        // classified as ccxray (grok review P3, 2026-08-18).
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.ok === true && parsed.app === 'ccxray') {
              resolve({ kind: parsed.hub ? 'ccxray-hub' : 'ccxray-standalone', pid: parsed.pid || null, version: parsed.version || null });
              return;
            }
            if (parsed && parsed.ok === true) { resolve({ kind: 'health-ok', pid: null }); return; }
          } catch {}
        }
        resolve({ kind: 'foreign-http', pid: null });
      });
      res.on('error', () => resolve({ kind: 'silent', pid: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'silent', pid: null }); });
    req.on('error', err => {
      resolve({ kind: err && err.code === 'ECONNREFUSED' ? 'free' : 'silent', pid: null });
    });
  });
}

// Message lines for a probed occupant, shared by the hub's bind-failure log,
// the client's post-mortem suggestion, and `ccxray status` — one composer so
// the three surfaces cannot drift apart. Never suggests an unconditional kill:
// only the 'silent' kind (nothing answers HTTP — possibly a genuinely stuck
// process) mentions kill at all, and only after the user identifies the pid
// themselves. PROXY_PORT is the escape hatch every branch offers because it
// moves the hub (discovery + fork) rather than opting out of hub mode the way
// --port does.
function describePortOccupant(occ, port) {
  // Copy-pasteable form: bash/zsh `set X=Y` does not export, so the hint
  // shows the prefix form a user can actually run (grok review P2).
  const escape = `relaunch with PROXY_PORT=<other-port> (e.g. PROXY_PORT=5600 ccxray claude) to run the hub on a different port`;
  switch (occ && occ.kind) {
    case 'ccxray-standalone':
      // hub:false covers both `--port` standalones and dashboard-only
      // servers — do not over-claim how it was started (grok review P2).
      return [
        `port ${port} is held by a standalone (non-hub) ccxray${occ.pid ? ` (pid ${occ.pid})` : ''}, so it cannot be shared as a hub.`,
        `Leave it running; ${escape}.`,
        `Both will record into ${resolveLogsDir()} — that is supported. To record separately, set CCXRAY_HOME=<dir>.`,
      ];
    case 'ccxray-hub':
      // The hub may be healthy under a different CCXRAY_HOME — only its
      // lockfile is unreachable from here; do not prescribe a restart as
      // the sole fix (grok review P2).
      return [
        `port ${port} answers as a ccxray hub${occ.pid ? ` (pid ${occ.pid})` : ''} that this launch cannot discover (no matching lockfile under this CCXRAY_HOME).`,
        `If it is yours, restart it so it rewrites its lockfile; otherwise ${escape}.`,
      ];
    case 'health-ok':
      return [
        `port ${port} is held by a server that answers ccxray's health check (likely an older ccxray).`,
        `Leave it running; ${escape}.`,
      ];
    case 'foreign-http':
      return [
        `port ${port} is held by another HTTP service that is not ccxray.`,
        `Do not kill it — ${escape}.`,
      ];
    case 'silent':
      return [
        `port ${port} is occupied by a process that does not answer HTTP — possibly a stuck ccxray.`,
        `Inspect it with: lsof -i :${port} — kill it only if you recognise it, or ${escape}.`,
      ];
    default:
      return [];
  }
}

// ── Hub pid monitoring (client-side recovery) ───────────────────────

function startHubMonitor(hubPid, hubPort, onRecovery, onRecoveryFailure) {
  // Recovery failure is a separate required channel so a caller cannot omit
  // the failure path and mistake a failed recovery for a successful one.
  if (typeof onRecovery !== 'function' || typeof onRecoveryFailure !== 'function') {
    throw new TypeError('startHubMonitor requires success and failure callbacks');
  }

  const interval = setInterval(async () => {
    if (isPidAlive(hubPid)) return;

    clearInterval(interval);
    console.error('\x1b[33mHub process died. Attempting recovery...\x1b[0m');
    deleteHubLock();

    let acquired = false;
    try {
      acquired = tryAcquireForkLock();
      let launchFailure = null;
      if (acquired) {
        let rejectLaunch;
        launchFailure = new Promise((_, reject) => { rejectLaunch = reject; });
        forkHub(hubPort, { onError: rejectLaunch });
      }
      const readiness = waitForHubReady();
      const lock = acquired ? await Promise.race([readiness, launchFailure]) : await readiness;
      if (acquired) releaseForkLock();
      if (lock.port !== hubPort) {
        if (acquired) releaseForkLock();
        console.error(`\x1b[31mHub recovered on port ${lock.port} but Claude is using port ${hubPort}. Cannot recover.\x1b[0m`);
        try { process.kill(lock.pid, 'SIGTERM'); } catch {}
        onRecoveryFailure();
        return;
      }
      console.error(`\x1b[32mHub recovered (pid ${lock.pid}, port ${lock.port})\x1b[0m`);
      if (onRecovery) onRecovery(lock);
      startHubMonitor(lock.pid, lock.port, onRecovery, onRecoveryFailure);
    } catch (err) {
      if (acquired) releaseForkLock();
      console.error(`\x1b[31mHub recovery failed: ${err.message}\x1b[0m`);
      onRecoveryFailure();
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
  clientIdentityFromMessage,
  kindFromLaunchSignals,
  setLaunchSignals,
  assembleExportReport,
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
  hasClients,
  applyClientRoute,
  lookupClientIdentityForRequest,
  lookupClientCwd,
  lookupClientCwdForRequest,
  startIdleTimer,
  setOnShutdown,
  shutdownHub,
  startDeadClientCheck,
  setHubPort,
  setIdentityPort,
  getHubStatus,
  handleHubRoutes,
  probePortOccupant,
  describePortOccupant,
  startHubMonitor,
  tryListen,
};
