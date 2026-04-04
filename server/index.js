#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const helpers = require('./helpers');
const { fetchPricing } = require('./pricing');
const { restoreFromLogs } = require('./restore');
const { warmUp: warmUpCosts } = require('./cost-budget');
const { forwardRequest } = require('./forward');
const { broadcastSessionStatus, broadcastPendingRequest } = require('./sse-broadcast');
const { authMiddleware } = require('./auth');
const { extractAgentType, splitB2IntoBlocks } = require('./system-prompt');

// ── CLI: parse flags and detect "claude" subcommand ──
const portIdx = process.argv.indexOf('--port');
let explicitPort = false;
if (portIdx !== -1) {
  const portVal = process.argv[portIdx + 1];
  const parsed = parseInt(portVal, 10);
  if (!portVal || isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.error('\x1b[31mError: --port requires a valid port number (1-65535)\x1b[0m');
    process.exit(1);
  }
  config.PORT = parsed;
  explicitPort = true;
  process.argv.splice(portIdx, 2);
}
const hubMode = process.argv.includes('--hub-mode');
if (hubMode) process.argv.splice(process.argv.indexOf('--hub-mode'), 1);
const claudeMode = process.argv[2] === 'claude';
const claudeArgs = claudeMode ? process.argv.slice(3) : [];

// In claude/hub mode, mute startup logs so they don't pollute output.
const _origLog = console.log;
if (claudeMode || hubMode) console.log = () => {};

// Route handlers
const { handleSSERoute } = require('./routes/sse');
const { handleApiRoutes } = require('./routes/api');
const { handleInterceptRoutes } = require('./routes/intercept');
const { handleCostRoutes } = require('./routes/costs');
const hub = require('./hub');

// ── Web UI: Static files from public/ ────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

// index.html with config injection (port may shift, so rebuilt after listen)
let rawIndexHTML = '';
try { rawIndexHTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); } catch {}
let indexHTML = rawIndexHTML || '<html><body>Error loading dashboard</body></html>';

function rebuildIndexHTML(port) {
  if (!rawIndexHTML) return;
  const script = `<script>window.__PROXY_CONFIG__=${JSON.stringify({ DEFAULT_CONTEXT: config.DEFAULT_CONTEXT, PORT: port })}</script>`;
  indexHTML = rawIndexHTML.replace('<!--__PROXY_CONFIG__-->', script);
}

function serveStatic(url, clientRes) {
  const pathname = url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    clientRes.end(indexHTML);
    return true;
  }
  const ext = path.extname(pathname);
  const mime = MIME_TYPES[ext];
  if (!mime) return false;
  const filePath = path.join(PUBLIC_DIR, pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const content = fs.readFileSync(filePath);
    clientRes.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    clientRes.end(content);
    return true;
  } catch {
    return false;
  }
}

// ── Server ──────────────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {

  // ── Hub API (health, register, unregister, status) ──
  // Placed before auth: these are local IPC endpoints, not user-facing
  if (hub.handleHubRoutes(clientReq, clientRes)) return;

  // ── Auth check (enabled via AUTH_TOKEN env var) ──
  if (!authMiddleware(clientReq, clientRes)) return;

  // ── Static files (HTML, CSS, JS) ──
  if (serveStatic(clientReq.url, clientRes)) return;

  // ── SSE ──
  if (handleSSERoute(clientReq, clientRes)) return;

  // ── API routes ──
  if (handleApiRoutes(clientReq, clientRes)) return;

  // ── Intercept API ──
  if (handleInterceptRoutes(clientReq, clientRes)) return;

  // ── Cost Budget API ──
  if (handleCostRoutes(clientReq, clientRes)) return;

  // ── Proxy logic ──
  const ts = helpers.taipeiTime();
  const id = helpers.timestamp();
  const startTime = Date.now();

  const reqChunks = [];
  clientReq.on('data', chunk => reqChunks.push(chunk));
  clientReq.on('end', () => {
    const rawBody = Buffer.concat(reqChunks);
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody.toString()); } catch {}

    // Quota-check probes: forward to Anthropic (rate limit headers still captured)
    // but skip all logging, session tracking, and entry creation
    if (parsedBody && store.isQuotaCheck(parsedBody)) {
      const fwdHeaders = { ...clientReq.headers };
      delete fwdHeaders['host'];
      delete fwdHeaders['connection'];
      delete fwdHeaders['accept-encoding'];
      fwdHeaders['host'] = config.ANTHROPIC_HOST;
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true });
      return;
    }

    let reqWritePromise = null;
    let sysHash = null;
    let toolsHash = null;
    if (parsedBody) {
      sysHash = parsedBody.system
        ? crypto.createHash('sha256').update(JSON.stringify(parsedBody.system)).digest('hex').slice(0, 12)
        : null;
      toolsHash = parsedBody.tools
        ? crypto.createHash('sha256').update(JSON.stringify(parsedBody.tools)).digest('hex').slice(0, 12)
        : null;

      if (sysHash) config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(parsedBody.system))
        .catch(e => console.error('Write sys failed:', e.message));
      if (toolsHash) config.storage.writeSharedIfAbsent(`tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
        .catch(e => console.error('Write tools failed:', e.message));

      const stripped = {
        model: parsedBody.model,
        max_tokens: parsedBody.max_tokens,
        messages: parsedBody.messages,
        sysHash,
        toolsHash,
      };
      reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(stripped))
        .catch(e => console.error('Write req.json failed:', e.message));
    }

    const { sessionId: reqSessionId, isNewSession } = parsedBody
      ? store.detectSession(parsedBody)
      : { sessionId: store.getCurrentSessionId(), isNewSession: false };

    // Extract and store cwd
    if (parsedBody && reqSessionId) {
      const cwd = store.extractCwd(parsedBody);
      if (cwd) {
        if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
        store.sessionMeta[reqSessionId].cwd = cwd;
      }
    }

    // Detect new cc_version for live requests
    if (parsedBody && Array.isArray(parsedBody.system) && parsedBody.system.length >= 3) {
      const b0 = (parsedBody.system[0].text || '');
      const b2 = (parsedBody.system[2].text || '');
      const liveM = b0.match(/cc_version=(\S+?)[; ]/);
      const liveVer = liveM ? liveM[1] : null;
      const { key: agentKey, label: agentLabel } = extractAgentType(parsedBody.system);
      if (liveVer && b2.length >= 500) {
        const idxKey = `${agentKey}::${liveVer}`;
        if (!store.versionIndex.has(idxKey)) {
          const now = new Date().toISOString().slice(0, 10);
          const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
          const coreLen = coreText.length;
          const coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
          const sharedFile = sysHash ? `sys_${sysHash}.json` : null;
          store.versionIndex.set(idxKey, { reqId: null, sharedFile, b2Len: b2.length, coreLen, coreHash, firstSeen: now, agentKey, agentLabel, version: liveVer });
          // Only notify if coreInstructions actually changed vs previous version
          const versions = [...store.versionIndex.values()].filter(v => v.agentKey === agentKey && v.version !== liveVer);
          const prev = versions.length ? versions.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))[0] : null;
          const coreChanged = !prev || prev.coreHash !== coreHash;
          if (coreChanged) {
            const vData = JSON.stringify({ _type: 'version_detected', version: liveVer, b2Len: b2.length, agentKey, agentLabel });
            for (const res of store.sseClients) res.write(`data: ${vData}\n\n`);
          }
        }
      }
    }

    // Track active requests
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = (store.activeRequests[reqSessionId] || 0) + 1;
      if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
      store.sessionMeta[reqSessionId].lastSeenAt = Date.now();
      broadcastSessionStatus(reqSessionId);
    }

    // Terminal summary
    if (isNewSession) store.printSessionBanner(reqSessionId);
    helpers.printSeparator();
    console.log(`\x1b[36m📤 REQUEST  [${ts}]  ${clientReq.method} ${clientReq.url}\x1b[0m`);
    if (parsedBody) console.log(helpers.summarizeRequest(parsedBody));

    // Build context for forwarding
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['host'];
    delete fwdHeaders['connection'];
    delete fwdHeaders['accept-encoding'];
    fwdHeaders['host'] = config.ANTHROPIC_HOST;

    const ctx = { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId, reqWritePromise, sysHash, toolsHash };

    // ── Intercept check ──
    const lastStop = store.sessionMeta[reqSessionId]?.lastStopReason;
    if (reqSessionId && store.interceptSessions.has(reqSessionId) && lastStop !== 'tool_use') {
      ctx.timer = setTimeout(() => {
        const p = store.pendingRequests.get(id);
        if (p) {
          store.pendingRequests.delete(id);
          const { broadcastInterceptRemoved } = require('./sse-broadcast');
          broadcastInterceptRemoved(id);
          console.log(`\x1b[33m⏰ INTERCEPT TIMEOUT [${helpers.taipeiTime()}] auto-forwarding ${id}\x1b[0m`);
          forwardRequest(p);
        }
      }, store.getInterceptTimeout() * 1000);
      ctx.originalBody = JSON.parse(JSON.stringify(parsedBody));
      store.pendingRequests.set(id, ctx);
      console.log(`\x1b[33m⏸ INTERCEPTED [${helpers.taipeiTime()}] ${id} — waiting for dashboard approval\x1b[0m`);
      broadcastPendingRequest(id, parsedBody, reqSessionId);
      return;
    }

    forwardRequest(ctx);
  });
});

// ── Port scanner ──
function tryListen(srv, port, maxAttempts) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function onError(err) {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        attempt++;
        srv.listen(port + attempt);
      } else {
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

// ── Spawn Claude Code with proxy env ──
function spawnClaude(port, args) {
  const { spawn } = require('child_process');
  const child = spawn('claude', args, {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://localhost:${port}` },
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('\x1b[31mError: "claude" command not found. Install Claude Code first:\x1b[0m');
      console.error('\x1b[31m  npm install -g @anthropic-ai/claude-code\x1b[0m');
    } else {
      console.error(`\x1b[31mFailed to start claude: ${err.message}\x1b[0m`);
    }
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    server.close();
    process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
  });
  // SIGINT is already sent to claude by the terminal (same process group).
  // Just prevent Node's default exit so we wait for claude's exit event.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ── "status" subcommand ──
if (process.argv[2] === 'status') {
  const lock = hub.readHubLock();
  if (!lock) {
    console.log('No hub running.');
    process.exit(0);
  }
  if (!hub.isPidAlive(lock.pid)) {
    console.log('Hub lockfile exists but process is dead. Cleaning up.');
    hub.deleteHubLock();
    process.exit(1);
  }
  hub.checkHubHealth(lock.port).then(ok => {
    if (!ok) {
      console.log(`Hub pid ${lock.pid} alive but not responding on port ${lock.port}.`);
      console.log(`Check ${hub.HUB_LOG_PATH}`);
      process.exit(1);
    }
    const http = require('http');
    http.get(`http://localhost:${lock.port}/_api/hub/status`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const s = JSON.parse(data);
          console.log(`Hub: http://localhost:${s.port} (pid ${s.pid}, uptime ${s.uptime}s, v${s.version})`);
          if (s.clients.length === 0) {
            console.log('No connected clients.');
          } else {
            console.log(`Connected clients (${s.clients.length}):`);
            s.clients.forEach((c, i) => {
              console.log(`  [${i + 1}] pid ${c.pid} — ${c.cwd} (since ${c.connectedAt})`);
            });
          }
        } catch { console.log(data); }
        process.exit(0);
      });
    }).on('error', err => {
      console.error(`Failed to query hub: ${err.message}`);
      process.exit(1);
    });
  });
  return; // prevent falling through to startup
}

// ── Client mode: connect to existing hub ──
async function startClientMode(lock) {
  const compat = hub.checkVersionCompat(lock.version);
  if (compat.fatal) {
    console.error(`\x1b[31m${compat.message}\x1b[0m`);
    process.exit(1);
  }
  if (compat.warning) {
    _origLog(`\x1b[33m${compat.warning}\x1b[0m`);
  }

  _origLog(`\x1b[90mccxray → http://localhost:${lock.port} (hub)\x1b[0m`);

  try {
    const registered = await hub.registerClient(lock.port, process.pid, process.cwd());
    if (!registered) {
      console.error('\x1b[31mHub rejected client registration.\x1b[0m');
      process.exit(1);
    }
  } catch (err) {
    console.error(`\x1b[31mFailed to register with hub: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // Monitor hub health and auto-recover
  hub.startHubMonitor(lock.pid, lock.port, (newLock) => {
    // Re-register with new hub
    hub.registerClient(newLock.port, process.pid, process.cwd()).catch(() => {});
  });

  // Spawn claude pointing to hub
  const { spawn } = require('child_process');
  const child = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://localhost:${lock.port}` },
  });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('\x1b[31mError: "claude" command not found. Install Claude Code first:\x1b[0m');
      console.error('\x1b[31m  npm install -g @anthropic-ai/claude-code\x1b[0m');
    } else {
      console.error(`\x1b[31mFailed to start claude: ${err.message}\x1b[0m`);
    }
    hub.unregisterClient(lock.port, process.pid).finally(() => process.exit(1));
  });
  child.on('exit', (code, signal) => {
    hub.unregisterClient(lock.port, process.pid).finally(() => {
      process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ── Hub/Server startup ──
async function startServer() {
  await config.storage.init();
  await fetchPricing();
  await restoreFromLogs();
  warmUpCosts();

  // Hub mode: no port retry — EADDRINUSE means another hub won the race.
  // Claude mode (with --port, standalone): retry up to 10 ports.
  const maxAttempts = (claudeMode && !hubMode) ? 10 : 0;
  const actualPort = await tryListen(server, config.PORT, maxAttempts);
  rebuildIndexHTML(actualPort);

  // Hub mode only: write lockfile as readiness signal, start client lifecycle
  // Do NOT write lockfile in claudeMode with --port (that's independent mode)
  if (hubMode) {
    hub.writeHubLock(actualPort, process.pid);
    hub.startDeadClientCheck();
    const cleanup = () => { hub.deleteHubLock(); process.exit(0); };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  // Banner
  if (hubMode) {
    // Hub runs silently (logs go to hub.log)
  } else if (claudeMode) {
    _origLog(`\x1b[90mccxray → http://localhost:${actualPort}\x1b[0m`);
  } else {
    console.log();
    console.log(`\x1b[35m🔌 Claude API Proxy listening on http://localhost:${actualPort}\x1b[0m`);
    console.log(`\x1b[90m   Dashboard → http://localhost:${actualPort}/`);
    console.log(`   Forwarding to ${config.ANTHROPIC_HOST}`);
    console.log(`   Logs → ${config.LOGS_DIR}`);
    console.log();
    console.log(`   Usage: ANTHROPIC_BASE_URL=http://localhost:${actualPort} claude\x1b[0m`);
    console.log('\x1b[0m');
  }

  // Auto-open dashboard in browser (not in hub mode)
  const noOpen = hubMode
    || process.argv.includes('--no-browser')
    || process.env.BROWSER === 'none'
    || process.env.CI
    || process.env.SSH_TTY;
  if (!noOpen) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} http://localhost:${actualPort}`);
  }

  if (claudeMode) spawnClaude(actualPort, claudeArgs);
}

// ── Main entry ──
(async () => {
  // Hub mode or explicit port or standalone: start server directly
  if (hubMode || explicitPort || !claudeMode) {
    try {
      await startServer();
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`\x1b[31mError: port ${config.PORT} is already in use\x1b[0m`);
      } else {
        console.error(`\x1b[31mStartup failed: ${err.message}\x1b[0m`);
      }
      process.exit(1);
    }
    return;
  }

  // Claude mode without explicit port: try hub discovery
  const existingHub = await hub.discoverHub();
  if (existingHub) {
    await startClientMode(existingHub);
    return;
  }

  // No hub found: fork a hub, then connect as client
  hub.forkHub(config.PORT);
  try {
    const lock = await hub.waitForHubReady();
    await startClientMode(lock);
  } catch (err) {
    console.error(`\x1b[31m${err.message}\x1b[0m`);
    process.exit(1);
  }
})();
