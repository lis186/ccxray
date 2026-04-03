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

// Route handlers
const { handleSSERoute } = require('./routes/sse');
const { handleApiRoutes } = require('./routes/api');
const { handleInterceptRoutes } = require('./routes/intercept');
const { handleCostRoutes } = require('./routes/costs');

// ── Web UI: Static files from public/ ────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

// Pre-build index.html with config injection at startup
const configScript = `<script>window.__PROXY_CONFIG__=${JSON.stringify({ DEFAULT_CONTEXT: config.DEFAULT_CONTEXT, PORT: config.PORT })}</script>`;
let indexHTML = '';
try {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  indexHTML = raw.replace('<!--__PROXY_CONFIG__-->', configScript);
} catch (e) {
  console.error('Failed to load public/index.html:', e.message);
  indexHTML = '<html><body>Error loading dashboard</body></html>';
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
          store.versionIndex.set(idxKey, { reqId: null, b2Len: b2.length, coreLen, coreHash, firstSeen: now, agentKey, agentLabel, version: liveVer });
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

// ── Startup ──
config.storage.init().then(() => fetchPricing()).then(async () => {
  await restoreFromLogs();
  warmUpCosts(); // Start JSONL parsing in background (child process)
  server.listen(config.PORT, () => {
    console.log();
    console.log(`\x1b[35m🔌 Claude API Proxy listening on http://localhost:${config.PORT}\x1b[0m`);
    console.log(`\x1b[90m   Dashboard → http://localhost:${config.PORT}/`);
    console.log(`   Forwarding to ${config.ANTHROPIC_HOST}`);
    console.log(`   Logs → ${config.LOGS_DIR}`);
    console.log();
    console.log(`   Usage: ANTHROPIC_BASE_URL=http://localhost:${config.PORT} claude\x1b[0m`);
    console.log();
  });
});
