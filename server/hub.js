'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { resolveCcxrayHome, resolveLogsDir } = require('./paths');
const { exportStatus, exportConfigHash } = require('./export-sync');
const { relativeRootComplaints } = require('./importer');
const { discoverCredentials, describeCredentials } = require('./export-credentials');
const { bindPort } = require('./listen');
const LAUNCH_TOKEN = require('crypto').randomBytes(8).toString('hex');

const HUB_DIR = resolveCcxrayHome();
const HUB_LOCK_PATH = path.join(HUB_DIR, 'hub.json');
const HUB_LOG_PATH = path.join(HUB_DIR, 'hub.log');
const SOCK_PATH = path.join(HUB_DIR, 'hub.sock');
const FORK_LOCK_PATH = path.join(HUB_DIR, 'hub.fork.lock');
const FORK_LOCK_STALE_MS = 15000;
const IDLE_TIMEOUT_MS = 5000;
const DEAD_CLIENT_CHECK_MS = 30000;
const HUB_REQUEST_TIMEOUT_MS = 3000;
const HUB_HEALTH_CHECK_MS = 5000;
const HUB_LOCK_CHECK_MS = 5000;
const HUB_RECOVERY_MAX_BACKOFF_MS = 60000;
const READINESS_POLL_MS = 200;
const READINESS_TIMEOUT_MS = 10000;
const HUB_LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const HUB_LOG_KEEP_BYTES = 100 * 1024;     // 100 KB
const HUB_REPLY_MAX_BYTES = 1 * 1024 * 1024;

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
  // Temp file + rename: a concurrent reader sees the old file or the whole new
  // one, never a truncated hub.json (#730).
  const tmp = `${HUB_LOCK_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, HUB_LOCK_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  return data;
}

// Unconditional delete — only for callers that own the file by construction
// (tests, a home nobody else writes). Anything that observed a lock earlier and
// cleans up later (hub shutdown, client recovery, `ccxray status` on a dead
// lockfile) must use deleteHubLockIfPid(observedPid), because a replacement hub
// can publish its lock in between.
function deleteHubLock() {
  try { fs.unlinkSync(HUB_LOCK_PATH); } catch {}
}

// INVARIANT (#730): hub.json is shared by every process on this home. Remove it
// only when it still names `pid` (the caller itself on shutdown, or the dead hub
// a client was monitoring) or names a dead pid. A lockfile naming a different
// LIVE pid belongs to a newer hub and must survive. The lock is re-read
// immediately before the unlink; the residual window is one syscall.
function deleteHubLockIfPid(pid) {
  const lock = readHubLock();
  if (!lock) return false;
  if (lock.pid !== pid && isPidAlive(lock.pid)) return false;
  try { fs.unlinkSync(HUB_LOCK_PATH); return true; } catch { return false; }
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

function hubHttpJson(port, route, timeoutMs, signal, onParsed, failureValue, {
  detailed = false,
  maxBytes = HUB_REPLY_MAX_BYTES,
  acceptAnyJson = false,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let req = null;
    let res = null;
    let data = '';
    let bytes = 0;

    const removeAbort = () => signal?.removeEventListener('abort', onAbort);
    const success = value => detailed ? { ok: true, value } : value;
    const failure = (reason, error = null) => detailed
      ? {
        ok: false,
        reason,
        error: error ? { code: error.code || null, message: error.message } : null,
      }
      : failureValue;
    const settle = value => {
      if (settled) return;
      settled = true;
      removeAbort();
      resolve(value);
    };
    const destroyAndSettle = (reason = 'aborted', error = null) => {
      if (settled) return;
      settled = true;
      removeAbort();
      req?.destroy();
      res?.destroy();
      resolve(failure(reason, error));
    };
    const onAbort = () => destroyAndSettle('aborted');

    if (signal?.aborted) {
      settle(failure('aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    req = http.get(`http://localhost:${port}${route}`, resArg => {
      res = resArg;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = Object.assign(new Error('hubHttpJson reply too large'), { code: 'reply-too-large' });
          destroyAndSettle('reply-too-large', error);
          return;
        }
        data += chunk.toString('utf8');
      });
      res.on('end', () => {
        if (settled) return;
        let parsed;
        try { parsed = JSON.parse(data); }
        catch {
          // The original status CLI rejected with the response body as its
          // message. Keep that detail for the status caller; discovery callers
          // retain their historic false/null result.
          const error = Object.assign(new Error(data), { code: 'parse' });
          settle(failure('parse', error));
          return;
        }
        try {
          settle(success(acceptAnyJson ? parsed : onParsed(parsed)));
        } catch (error) {
          settle(failure(error.code || 'parse', error));
        }
      });
      res.on('error', error => settle(failure('request-failed', error)));
      res.on('aborted', () => {
        const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
        settle(failure('request-failed', error));
      });
    });
    req.setTimeout(timeoutMs, () => {
      const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      destroyAndSettle('timeout', error);
    });
    req.on('error', error => settle(failure('request-failed', error)));
  });
}

function checkHubHealth(port, timeoutMs = 2000, signal, options = {}) {
  return hubHttpJson(port, '/_api/health', timeoutMs, signal,
    parsed => parsed?.ok === true, false, options);
}

// ── Orphan hub probe (port-level fallback when lockfile missing) ────

function probeHubStatus(port, timeoutMs = 2000, signal, options = {}) {
  return hubHttpJson(port, '/_api/hub/status', timeoutMs, signal, parsed => {
    if (parsed?.app === 'ccxray' && parsed.pid && parsed.version && parsed.port) return parsed;
    return null;
  }, null, options);
}

// ── Hub discovery (dual verification: pid + health) ─────────────────

// Thrown by discoverHub when hub.json names a live pid that fails its health or
// socket probe. Distinct from a null result ("no hub"), which callers answer by
// forking: a live-but-unresponsive owner must never get a second hub.
class HubUnresponsiveError extends Error {
  constructor(lock) {
    super(`hub pid ${lock.pid} (port ${lock.port}) is alive but not responding; its lockfile was kept and no second hub was started`);
    this.name = 'HubUnresponsiveError';
    this.code = 'HUB_UNRESPONSIVE';
    this.lock = lock;
  }
}

async function discoverHub(defaultPort) {
  const lock = readHubLock();
  if (lock) {
    if (!isPidAlive(lock.pid)) {
      deleteHubLockIfPid(lock.pid);
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
      // #730: the owner is ALIVE, merely slow or wedged. Keep hub.json: deleting
      // it lets cleanupStaleSocket() unlink the live hub's socket and lets the
      // caller fork a competitor. Do NOT kill lock.pid either (it may be a reused
      // pid). Callers retry discovery with backoff or fall back; none forks.
      throw new HubUnresponsiveError(lock);
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
      const token = tokenOf(msg);
      if (!validClientPid(msg.pid) || token === null) return;
      if (typeof msg.cwd !== 'string' || msg.cwd.length > 4096) return;
      const wasEmpty = clients.size === 0;
      if (!addClient(msg.pid, msg.cwd, clientIdentityFromMessage(msg), token)) {
        socket.write('null\n');
        break;
      }
      socket.write(JSON.stringify({ ...assembleExportReport(), ok: true, firstClient: wasEmpty }) + '\n');
      break;
    }
    case 'unregister': {
      const token = tokenOf(msg);
      if (!validClientPid(msg.pid) || token === null) return;
      removeClient(msg.pid, token);
      socket.write(JSON.stringify({ ok: true }) + '\n');
      break;
    }
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

function hubSocketRequest(sockPath, msg, timeoutMs = HUB_REQUEST_TIMEOUT_MS, signal, {
  maxReplyBytes = HUB_REPLY_MAX_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const client = net.connect(sockPath);
    let buf = '';
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const rejectAndDestroy = err => {
      if (settled) return;
      settled = true;
      cleanup();
      client.destroy();
      reject(err);
    };
    const resolveAndDestroy = value => {
      if (settled) return;
      settled = true;
      cleanup();
      client.destroy();
      resolve(value);
    };
    const onAbort = () => {
      const err = new Error('hubSocketRequest aborted');
      err.code = 'ABORT_ERR';
      rejectAndDestroy(err);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const err = new Error('hubSocketRequest timeout');
      err.code = 'ETIMEDOUT';
      rejectAndDestroy(err);
    }, timeoutMs);

    client.on('connect', () => {
      client.write(JSON.stringify(msg) + '\n');
    });
    client.on('data', chunk => {
      if (settled) return;
      buf += chunk.toString();
      if (Buffer.byteLength(buf) > maxReplyBytes) {
        const err = new Error('hubSocketRequest reply too large');
        err.code = 'reply-too-large';
        rejectAndDestroy(err);
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try {
          resolveAndDestroy(JSON.parse(buf.slice(0, nl)));
        } catch {
          const err = new Error('hubSocketRequest malformed reply');
          err.code = 'malformed-reply';
          rejectAndDestroy(err);
        }
      }
    });
    client.on('error', err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

// ── Client registration (socket-preferred, HTTP fallback) ──────────

function registerClient(lockInfoOrPort, pid, cwd, identity = {}) {
  const sockPath = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.sockPath : null;
  const payload = { pid, cwd, token: LAUNCH_TOKEN, ...clientIdentityFromMessage(identity) };
  if (sockPath) {
    return hubSocketRequest(sockPath, { cmd: 'register', ...payload });
  }
  const port = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.port : lockInfoOrPort;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(`http://localhost:${port}/_api/hub/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: HUB_REQUEST_TIMEOUT_MS,
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
  const payload = { pid, token: LAUNCH_TOKEN };
  if (sockPath) {
    return hubSocketRequest(sockPath, { cmd: 'unregister', ...payload }).catch(() => {});
  }
  const port = typeof lockInfoOrPort === 'object' ? lockInfoOrPort.port : lockInfoOrPort;
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req = http.request(`http://localhost:${port}/_api/hub/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: HUB_REQUEST_TIMEOUT_MS,
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
const clientTokens = new Map(); // pid → token of held registration; excluded from status output
const cancelledRegistrations = new Map(); // token → pid for unmatched unregister-before-register
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

function validClientPid(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= 4194304;
}

function tokenOf(msg) {
  if (msg.token === undefined) return undefined;
  return typeof msg.token === 'string' && /^[0-9a-f]{16}$/.test(msg.token) ? msg.token : null;
}

function addClient(pid, cwd, identity = {}, token) {
  if (token && cancelledRegistrations.has(token)) return false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  clients.set(pid, { cwd, connectedAt: new Date().toISOString(), ...clientIdentityFromMessage(identity) });
  if (token) clientTokens.set(pid, token);
  else clientTokens.delete(pid);
  return true;
}

function removeClient(pid, token) {
  const held = clientTokens.get(pid);
  if (clients.has(pid) && (!token || !held || held === token)) {
    clients.delete(pid);
    clientTokens.delete(pid);
    if (clients.size === 0) startIdleTimer();
    return;
  }
  if (token) cancelledRegistrations.set(token, pid);
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
  // Native Herdr launches do not register as hub clients. Carry their pane
  // stamp in the URL, stripped here for both HTTP and WebSocket dispatch.
  // This is attribution metadata, not authentication (same as the Claude header).
  const pane = /^\/_ccxray\/agent\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(String(req?.url || ''));
  if (pane) {
    let agentId;
    try { agentId = decodeURIComponent(pane[1]); } catch { return false; }
    const identity = clientIdentityFromMessage({ agentId });
    if (!identity.agentId?.startsWith('herdr:')) return false;
    req.ccxrayAgentId = identity.agentId;
    req.url = `${pane[2] || '/'}${pane[3] || ''}`;
    return true;
  }
  const match = /^\/_ccxray\/client\/([1-9]\d*)(\/[^?]*)?(\?.*)?$/.exec(String(req?.url || ''));
  if (!match) return false;
  req.ccxrayClientPid = Number(match[1]);
  req.url = `${match[2] || '/'}${match[3] || ''}`;
  return true;
}

function lookupClientIdentityForRequest(req) {
  if (req?.ccxrayAgentId) return clientIdentityFromMessage({ agentId: req.ccxrayAgentId });
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
  stopLockSelfHeal();
  if (hubSocket) {
    try { hubSocket.close(); } catch {}
    try { fs.unlinkSync(SOCK_PATH); } catch {}
    hubSocket = null;
  }
  deleteHubLockIfPid(process.pid);
  if (onShutdown) onShutdown();
  else process.exit(0);
}

// ── Hub lockfile self-heal (#730) ───────────────────────────────────

// A hub whose hub.json was deleted by another process would otherwise be
// invisible to every supervisor until some launch happened to rebuild it. Check
// cheaply and restore; never overwrite a lock naming a different live hub.
let lockHealTimer = null;

function selfHealHubLock(port, sockPath = SOCK_PATH) {
  const lock = readHubLock();
  if (lock) {
    if (lock.pid !== process.pid && isPidAlive(lock.pid)) return false;
    if (lock.pid === process.pid && lock.port === port && lock.sockPath === sockPath) return false;
  }
  try { writeHubLock(port, process.pid, undefined, sockPath); return true; } catch { return false; }
}

function startLockSelfHeal(port, sockPath = SOCK_PATH, intervalMs = HUB_LOCK_CHECK_MS) {
  stopLockSelfHeal();
  lockHealTimer = setInterval(() => selfHealHubLock(port, sockPath), intervalMs);
  lockHealTimer.unref();
  return lockHealTimer;
}

function stopLockSelfHeal() {
  if (lockHealTimer) clearInterval(lockHealTimer);
  lockHealTimer = null;
}

function startDeadClientCheck() {
  deadCheckInterval = setInterval(sweepDeadClients, DEAD_CLIENT_CHECK_MS);
  deadCheckInterval.unref();
}

function sweepDeadClients() {
  for (const [pid] of clients) {
    if (!isPidAlive(pid)) {
      console.log(`Dead client detected: pid ${pid}, removing.`);
      removeClient(pid);
    }
  }
  for (const [token, pid] of cancelledRegistrations) {
    if (!isPidAlive(pid)) cancelledRegistrations.delete(token);
  }
}

function setHubPort(port) { hubListenPort = port; }

function setIdentityPort(port) { identityPort = port; }

function currentHubPort() {
  return hubListenPort || readHubLock()?.port;
}

// Shared by the hub socket and authenticated /_api/health responses so
// standalone status probes use the same display-safe report as hub status.
function assembleExportReport(env = process.env) {
  const kind = kindFromLaunchSignals(launchSignals);
  const { exportState, exportReason } = kind === 'client'
    ? { exportState: null, exportReason: null }
    : exportStatus(env);
  return {
    exportState,
    exportReason,
    configWarnings: kind === 'client' ? [] : relativeRootComplaints(env),
    exportConfigHash: kind === 'client' ? null : exportConfigHash(env),
    // #633 M0: offline discovery + parse of the writer credential, display view
    // only (no path, no contents). Reported for an ENABLED exporter only — for a
    // suppressed/unconfigured/refused process a credential verdict would invite
    // the reader to infer an exporter that does not exist. Same client rule as
    // exportState: a client has no authority over its own environment.
    credential: exportState === 'enabled' ? describeCredentials(discoverCredentials({ env })) : null,
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
    // Health stays public for port discovery, but the export report contains
    // local paths and config diagnostics. Reuse the dashboard's exact trust
    // predicate here because this route runs before the normal auth gate.
    const reportTrusted = require('./auth').isDashboardAuthenticated(clientReq);
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    // app/pid/hub identify the listener to probePortOccupant (#555) so a
    // port-conflict message can tell a standalone ccxray from a foreign
    // process. `hub` is true only after setHubPort — i.e. real hub mode.
    clientRes.end(JSON.stringify({
      ...(reportTrusted ? assembleExportReport() : {}),
      ok: true,
      app: 'ccxray',
      pid: process.pid,
      hub: hubListenPort != null,
      version: require('../package.json').version,
      gitSha: require('./git-sha').getGitSha(),
      ...(!reportTrusted ? { exportReportUnavailableReason: 'authentication-required' } : {}),
      capabilities: [],
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

// Trusted health responses include the bounded export report and warnings;
// leave room for it while keeping the port probe's response size capped.
const PROBE_MAX_BYTES = 64 * 1024;

function exportReportFromHealth(parsed) {
  if (!parsed || typeof parsed.exportState !== 'string' || parsed.exportState.length === 0) return null;
  return {
    exportState: parsed.exportState,
    exportReason: typeof parsed.exportReason === 'string' ? parsed.exportReason : null,
    configWarnings: Array.isArray(parsed.configWarnings) ? parsed.configWarnings : [],
    exportConfigHash: typeof parsed.exportConfigHash === 'string' ? parsed.exportConfigHash : null,
    credential: parsed.credential && typeof parsed.credential === 'object' ? parsed.credential : null,
    identity: parsed.identity && typeof parsed.identity === 'object' ? parsed.identity : null,
  };
}

function probePortOccupant(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/_api/health`, { timeout: timeoutMs }, res => {
      let data = '';
      let bytes = 0;
      res.on('data', c => {
        bytes += c.length;
        data += c;
        if (bytes > PROBE_MAX_BYTES) req.destroy();
      });
      res.on('end', () => {
        // Only a 200 counts as a health answer — a foreign service that
        // happens to echo { ok: true } on an error page must not be
        // classified as ccxray (grok review P3, 2026-08-18).
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.ok === true && parsed.app === 'ccxray') {
              resolve({
                kind: parsed.hub ? 'ccxray-hub' : 'ccxray-standalone',
                pid: parsed.pid || null,
                version: parsed.version || null,
                report: exportReportFromHealth(parsed),
                reportUnavailableReason: parsed.exportReportUnavailableReason === 'authentication-required'
                  ? 'authentication-required'
                  : null,
              });
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

// True when the hub holding the port also answers on THIS home's socket, i.e.
// the home matches and only hub.json is missing (#730).
async function probeHomeHub(occ) {
  if (!occ || occ.kind !== 'ccxray-hub' || !fs.existsSync(SOCK_PATH)) return false;
  try {
    const res = await hubSocketRequest(SOCK_PATH, { cmd: 'status' }, 2000);
    return !!(res && res.app === 'ccxray' && (!occ.pid || res.pid === occ.pid));
  } catch { return false; }
}

// Message lines for a probed occupant, shared by the hub's bind-failure log,
// the client's post-mortem suggestion, and `ccxray status` — one composer so
// the three surfaces cannot drift apart. Never suggests an unconditional kill:
// only the 'silent' kind (nothing answers HTTP — possibly a genuinely stuck
// process) mentions kill at all, and only after the user identifies the pid
// themselves. PROXY_PORT is the escape hatch every branch offers because it
// moves the hub (discovery + fork) rather than opting out of hub mode the way
// --port does.
function describePortOccupant(occ, port, { homeSocketReachable = false } = {}) {
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
        `This process records into ${resolveLogsDir()}. To record separately, set CCXRAY_HOME=<dir>.`,
      ];
    case 'ccxray-hub':
      // #730: the same hub answers on THIS home's socket, so the home is right
      // and only hub.json is gone — do not point the user at CCXRAY_HOME.
      if (homeSocketReachable) {
        return [
          `port ${port} is held by a live ccxray hub${occ.pid ? ` (pid ${occ.pid})` : ''} reachable on this CCXRAY_HOME's socket, but its lockfile (hub.json) is missing.`,
          `The hub restores the lockfile on its own within a few seconds, and the next launch re-discovers it through the socket; retry shortly.`,
        ];
      }
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

function createHubMonitor(hubPid, hubPort, onRecovery, onRecoveryFailure) {
  // Recovery failure is a separate required channel so a caller cannot omit
  // the failure path and mistake a failed recovery for a successful one.
  if (typeof onRecovery !== 'function' || typeof onRecoveryFailure !== 'function') {
    throw new TypeError('startHubMonitor requires success and failure callbacks');
  }

  let monitoredPid = hubPid;
  let pendingLock = null; // hub found, registration not yet acknowledged
  let busy = false;
  let failures = 0;
  let failureReported = false;
  let nextAttemptAt = 0;

  const fail = () => {
    failures++;
    nextAttemptAt = Date.now() + Math.min(HUB_HEALTH_CHECK_MS * 2 ** failures, HUB_RECOVERY_MAX_BACKOFF_MS);
    // Report once per outage; the monitor keeps retrying quietly (#730).
    if (!failureReported) { failureReported = true; onRecoveryFailure(); }
  };

  // Recovery is complete only once the callback reports that registration with
  // the replacement hub succeeded (#730). A failed registration keeps the lock
  // pending and is retried with backoff even while that hub is alive.
  const register = async lock => {
    let ok = false;
    try { ok = (await onRecovery(lock)) !== false; } catch { ok = false; }
    if (!ok) { pendingLock = lock; fail(); return; }
    pendingLock = null;
    failures = 0;
    failureReported = false;
    nextAttemptAt = 0;
  };

  const recover = async () => {
    // #730: the lockfile may already belong to a replacement hub. Drop it only
    // if it still names the dead hub (or another dead pid), then discover
    // before forking so a live hub on this port is re-used, not raced.
    deleteHubLockIfPid(monitoredPid);
    let lock = null;
    try { lock = await discoverHub(hubPort); } catch (err) {
      if (err && err.code === 'HUB_UNRESPONSIVE') {
        // A live owner exists: never fork against it. Retry with backoff.
        console.error(`\x1b[31mHub recovery waiting: ${err.message}\x1b[0m`);
        fail();
        return;
      }
      lock = null;
    }

    if (!lock) {
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
        lock = acquired ? await Promise.race([readiness, launchFailure]) : await readiness;
      } catch (err) {
        console.error(`\x1b[31mHub recovery failed: ${err.message}\x1b[0m`);
        fail();
        return;
      } finally {
        if (acquired) releaseForkLock();
      }
    }

    if (lock.port !== hubPort) {
      // A hub-mode child binds the requested port, so a hub on another port is
      // never this client's own child. It belongs to someone else: leave it
      // alone, report failure, and keep retrying.
      console.error(`\x1b[31mHub found on port ${lock.port} but Claude is using port ${hubPort}. Cannot recover.\x1b[0m`);
      fail();
      return;
    }
    console.error(`\x1b[32mHub recovered (pid ${lock.pid}, port ${lock.port})\x1b[0m`);
    monitoredPid = lock.pid;
    await register(lock);
  };

  const tick = async () => {
    if (busy || Date.now() < nextAttemptAt) return;
    if (pendingLock && !isPidAlive(pendingLock.pid)) pendingLock = null;
    if (!pendingLock && isPidAlive(monitoredPid)) return;
    busy = true;
    try {
      if (pendingLock) await register(pendingLock);
      else {
        if (failures === 0) console.error('\x1b[33mHub process died. Attempting recovery...\x1b[0m');
        await recover();
      }
    } catch (err) {
      console.error(`\x1b[31mHub recovery failed: ${err.message}\x1b[0m`);
      fail();
    } finally { busy = false; }
  };
  return { tick };
}

function startHubMonitor(hubPid, hubPort, onRecovery, onRecoveryFailure) {
  const { tick } = createHubMonitor(hubPid, hubPort, onRecovery, onRecoveryFailure);
  const interval = setInterval(tick, HUB_HEALTH_CHECK_MS);
  interval.unref();
  return interval;
}

// ── Port scanner (used by hub and Claude-mode startup) ──────────────

function tryListen(srv, port, maxAttempts) {
  // bindPort selects the listen hosts (loopback by default, PROXY_HOST opt-in)
  // and reports EADDRINUSE for the port as a whole.
  return (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bindPort(srv, port === 0 ? 0 : port + attempt);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || attempt >= maxAttempts) throw err;
      }
    }
  })();
}

module.exports = {
  clientIdentityFromMessage,
  kindFromLaunchSignals,
  exportReportFromHealth,
  setLaunchSignals,
  assembleExportReport,
  HUB_DIR,
  HUB_LOCK_PATH,
  HUB_LOG_PATH,
  HUB_REQUEST_TIMEOUT_MS,
  HUB_HEALTH_CHECK_MS,
  SOCK_PATH,
  readHubLock,
  writeHubLock,
  deleteHubLock,
  deleteHubLockIfPid,
  selfHealHubLock,
  startLockSelfHeal,
  stopLockSelfHeal,
  probeHomeHub,
  isPidAlive,
  sweepDeadClients,
  checkHubHealth,
  probeHubStatus,
  discoverHub,
  HubUnresponsiveError,
  createHubMonitor,
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
  handleSocketCommand,
};
