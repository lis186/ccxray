#!/usr/bin/env node
'use strict';

// ── "usage" — fast-path, no server deps ──
if (process.argv[2] === 'usage') {
  require('./usage').run(process.argv.slice(3));
  return;
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { resolveCcxrayHome } = require('./paths');
const helpers = require('./helpers');
const { fetchPricing } = require('./pricing');
const { restoreFromLogs, pruneLogs } = require('./restore');
const { warmUp: warmUpCosts } = require('./cost-budget');
const { forwardRequest, setStatusLineEnabled, getStatusLineEnabled, setSessionAnchorRecorder } = require('./forward');
const { readSettings } = require('./settings');
const { broadcastSessionStatus, broadcastPendingRequest } = require('./sse-broadcast');
const { dispatch, mintAutoOpenUrl, formatAutoOpenUrl } = require('./auth');
const { findSharedPrefix } = require('./delta-helpers');
const providers = require('./providers');
const { handleWebSocketUpgrade, drainWebSocketProxy } = require('./ws-proxy');
const { WIRE_PARSERS, getParser } = require('./wire-parsers');
const {
  getCodexRawSessionId,
  isOpenAISubagent,
} = require('./wire-parsers/openai');

// ── CLI: parse flags and detect provider launchers ──
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
let hubMode = process.argv.includes('--hub-mode');
if (hubMode) process.argv.splice(process.argv.indexOf('--hub-mode'), 1);
if (hubMode && process.platform === 'win32') {
  console.error('\x1b[31mHub mode requires Unix sockets (macOS/Linux). On Windows, use --port for standalone mode.\x1b[0m');
  process.exit(1);
}
const allowUpstreamLoop = process.argv.includes('--allow-upstream-loop') || process.env.CCXRAY_ALLOW_UPSTREAM_LOOP === '1';
if (process.argv.includes('--allow-upstream-loop')) process.argv.splice(process.argv.indexOf('--allow-upstream-loop'), 1);
const noBrowser = process.argv.includes('--no-browser');
if (noBrowser) process.argv.splice(process.argv.indexOf('--no-browser'), 1);
const cliCommand = process.argv[2];
const unknownCommand = cliCommand
  && cliCommand !== 'status'
  && cliCommand !== 'open'
  && cliCommand !== 'secret'
  && cliCommand !== 'rebuild-index'
  && cliCommand !== 'setup-statusline'
  && cliCommand !== 'usage'
  && !cliCommand.startsWith('-')
  && !providers.isAgentProvider(cliCommand);
if (unknownCommand) {
  console.error(`\x1b[31mError: unsupported provider "${cliCommand}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
  process.exit(1);
}
// ── "secret <subcommand>" — early exit, no side effects ──
if (process.argv[2] === 'secret') {
  const sub = process.argv[3];
  if (sub === 'upstream') {
    const auth = require('./auth');
    const { K_upstream } = auth.deriveSecrets(auth.getRootSecret());
    process.stdout.write(K_upstream.toString('base64url') + '\n');
    process.exit(0);
  }
  console.error(`\x1b[31mError: unknown secret subcommand "${sub || ''}". Supported: upstream\x1b[0m`);
  process.exit(1);
}

// ── "rebuild-index [--apply]" — early exit, no server/hub boot ──
// Rebuilds index.ndjson from surviving _req/_res log files. Dry-run by default;
// --apply atomically writes the merged index. Merge-only and hub-safe.
if (process.argv[2] === 'rebuild-index') {
  const { rebuildIndex } = require('./rebuild-index');
  rebuildIndex({ apply: process.argv.includes('--apply') })
    .then(r => process.exit(r && r.refused ? 1 : 0))
    .catch(err => { console.error(`rebuild-index failed: ${err.message}`); process.exit(1); });
  return;
}

const agentCommand = providers.isAgentProvider(cliCommand) ? cliCommand : null;
const agentMode = Boolean(agentCommand);
const agentArgs = agentMode ? process.argv.slice(3) : [];
const DISPLAY_NAME = providers.getDisplayName(agentCommand, process.env);

// In agent/hub mode, mute startup logs so they don't pollute output.
const _origLog = console.log;
if (agentMode || hubMode) console.log = () => {};

// ── Delta log storage ────────────────────────────────────────────────
// sessionLastReq tracks the most recent req per session for delta writes.
// Only populated for sessions with explicit session_id (main orchestrator turns).
const sessionLastReq = new Map(); // sessionId → { id, messages, deltaCount }

// Narrow recorder injected into forward.js so the intercept-edit rewrite can
// re-anchor this private map without owning it. messages == null clears the
// anchor (delete) so the next turn re-anchors FULL instead of writing a delta
// against an unrecoverable base (split-brain mitigation on rewrite failure);
// otherwise it sets the edited turn as a fresh full anchor (deltaCount 0).
function recordSessionAnchor(sessionId, anchorId, messages) {
  if (!sessionId) return;
  if (messages == null) { sessionLastReq.delete(sessionId); return; }
  sessionLastReq.set(sessionId, { id: anchorId, messages, deltaCount: 0 });
}
setSessionAnchorRecorder(recordSessionAnchor);

// Route handlers
const { handleSSERoute } = require('./routes/sse');
const { handleApiRoutes } = require('./routes/api');
const { handleInterceptRoutes } = require('./routes/intercept');
const { handleCostRoutes, startCodexRefresh, stopCodexRefresh } = require('./routes/costs');
const { handleAuthRoutes } = require('./routes/auth');
const hub = require('./hub');

// ── Web UI: Static files from public/ ────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

// Load persisted settings and apply immediately
const settings = readSettings();
setStatusLineEnabled(settings.statusLine);

// index.html with config injection — built fresh per request so dynamic values (statusLine) stay current
let rawIndexHTML = '';
try { rawIndexHTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'); } catch {}
let serverPort = 0;

function rebuildIndexHTML(port) { serverPort = port; }

function serveStatic(url, clientRes) {
  const pathname = url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    const script = `<script>window.__PROXY_CONFIG__=${JSON.stringify({ DEFAULT_CONTEXT: config.DEFAULT_CONTEXT, PORT: serverPort, statusLine: getStatusLineEnabled(), APP_NAME: DISPLAY_NAME })}</script>`;
    const html = rawIndexHTML ? rawIndexHTML.replace('<!--__PROXY_CONFIG__-->', script) : '<html><body>Error loading dashboard</body></html>';
    clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    clientRes.end(html);
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
    clientRes.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store' });
    clientRes.end(content);
    return true;
  } catch {
    return false;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CCXRAY_INTERNAL_HEADERS = ['x-ccxray-auth', 'x-ccxray-bootstrap'];

function buildForwardHeaders(clientHeaders, upstream) {
  const fwdHeaders = { ...clientHeaders };
  const connectionTokens = String(clientHeaders.connection || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  for (const header of HOP_BY_HOP_HEADERS) delete fwdHeaders[header];
  for (const header of connectionTokens) delete fwdHeaders[header];
  for (const header of CCXRAY_INTERNAL_HEADERS) delete fwdHeaders[header];
  delete fwdHeaders.host;
  delete fwdHeaders['accept-encoding'];
  fwdHeaders.host = upstream.host;
  return fwdHeaders;
}

function getCodexCwdFallback() {
  return hub.lookupClientCwd() || (agentCommand === 'codex' ? process.cwd() : null);
}

function getOpenAICwd(parsedBody) {
  return parsedBody?.metadata?.cwd || getCodexCwdFallback();
}


// ── Server ──────────────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {

  // ── Hub API (health, register, unregister, status) ──
  // Placed before auth: these are local IPC endpoints, not user-facing
  if (hub.handleHubRoutes(clientReq, clientRes)) return;

  // ── Auth bootstrap routes (Phase 1.3) ──
  // /_auth/redeem and /_auth/status run BEFORE the auth gate: redeem is
  // the entry point that creates a cookie, status answers "am I
  // authenticated?" without itself enforcing auth.
  if (handleAuthRoutes(clientReq, clientRes)) return;

  // ── Static files (HTML, CSS, JS) ──
  // Served BEFORE the auth gate (Phase 2.3): the shell + client assets carry
  // no user data, and the dashboard now enforces auth — so the HTML must stay
  // reachable without a cookie, otherwise the inline bootstrap script (redeem
  // #k= / probe /_auth/status) can never run and `ccxray open` can't mint the
  // first cookie. Conversation data lives behind the gate (/_api/*, /_events).
  if (serveStatic(clientReq.url, clientRes)) return;

  // ── Auth check (Phase 1.2 dispatcher; Phase 2.3 enforce) ──
  if (!dispatch(clientReq).verify(clientReq, clientRes)) return;

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
      const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
      const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true, upstream });
      return;
    }

    // Provider noise RPC: forward but don't create dashboard entries.
    // Each WIRE_PARSER defines its own noise patterns (e.g. codex startup
    // polls for plugins/connectors/apps/usage).
    if (Object.values(WIRE_PARSERS).some(p => p.isNoiseRequest(clientReq.url, clientReq.headers, parsedBody))) {
      const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
      const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true, upstream });
      return;
    }

    const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers);
    const provider = upstream.provider || 'anthropic';
    const parser = getParser(provider);
    if (parsedBody && parser?.preprocessBody) {
      parsedBody = parser.preprocessBody(parsedBody, clientReq.headers);
    }

    let reqWritePromise = null;
    let sysHash = null;
    let toolsHash = null;
    let coreHash = null;
    if (parsedBody) {
      sysHash = provider === 'openai'
        ? (parsedBody.instructions != null
          ? crypto.createHash('sha256').update(JSON.stringify(parsedBody.instructions)).digest('hex').slice(0, 12)
          : null)
        : (parsedBody.system
          ? crypto.createHash('sha256').update(JSON.stringify(parsedBody.system)).digest('hex').slice(0, 12)
          : null);
      toolsHash = parsedBody.tools
        ? crypto.createHash('sha256').update(JSON.stringify(parsedBody.tools)).digest('hex').slice(0, 12)
        : null;

      if (provider === 'anthropic') {
        if (sysHash) config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(parsedBody.system))
          .catch(e => console.error('Write sys failed:', e.message));
        if (toolsHash) config.storage.writeSharedIfAbsent(`tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
          .catch(e => console.error('Write tools failed:', e.message));
      } else if (provider === 'openai') {
        if (sysHash) {
          config.storage.writeSharedIfAbsent(`openai_instructions_${sysHash}.json`, JSON.stringify(parsedBody.instructions))
            .catch(e => console.error('Write OpenAI instructions failed:', e.message));
          const promptInfo = getParser('openai')?.registerPromptVersion?.({
            parsedBody, sysHash, sharedFile: `openai_instructions_${sysHash}.json`,
          }) || null;
          if (promptInfo) {
            config.storage.writeSharedIfAbsent(`openai_prompt_meta_${sysHash}.json`, JSON.stringify({
              agentKey: promptInfo.agentKey,
              agentLabel: promptInfo.agentLabel,
            })).catch(e => console.error('Write OpenAI prompt metadata failed:', e.message));
          }
          coreHash = promptInfo?.coreHash || null;
        }
        if (toolsHash) config.storage.writeSharedIfAbsent(`openai_tools_${toolsHash}.json`, JSON.stringify(parsedBody.tools))
          .catch(e => console.error('Write OpenAI tools failed:', e.message));
      }

      const currMessages = Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
      const peekSid = store.extractSessionId(parsedBody);
      let stripped;

      // Preserve request-level params (thinking, temperature, etc.) that
      // aren't stored elsewhere.  system/tools go to shared files; messages
      // are handled by the delta logic below.
      const extraParams = {};
      for (const k of Object.keys(parsedBody)) {
        if (k !== 'system' && k !== 'tools' && k !== 'messages' &&
            k !== 'model' && k !== 'max_tokens' && k !== 'metadata') {
          extraParams[k] = parsedBody[k];
        }
      }

      if (provider === 'openai') {
        stripped = parsedBody;
      } else if (peekSid && config.storage.supportsDelta) {
        const prev = sessionLastReq.get(peekSid);
        const sharedCount = prev ? findSharedPrefix(prev.messages, currMessages) : 0;
        const forceFull = !prev ||
          (config.DELTA_SNAPSHOT_N > 0 && (prev.deltaCount || 0) >= config.DELTA_SNAPSHOT_N);

        const meta = peekSid ? { session_id: peekSid } : undefined;
        if (!forceFull && sharedCount >= 2) {
          stripped = {
            model: parsedBody.model,
            max_tokens: parsedBody.max_tokens,
            ...extraParams,
            prevId: prev.id,
            msgOffset: sharedCount,
            messages: currMessages.slice(sharedCount),
            sysHash,
            toolsHash,
            ...(meta && { metadata: meta }),
          };
          sessionLastReq.set(peekSid, { id, messages: currMessages, deltaCount: (prev.deltaCount || 0) + 1 });
        } else {
          stripped = { model: parsedBody.model, max_tokens: parsedBody.max_tokens, ...extraParams, messages: currMessages, sysHash, toolsHash, ...(meta && { metadata: meta }) };
          sessionLastReq.set(peekSid, { id, messages: currMessages, deltaCount: 0 });
        }
      } else {
        const meta = peekSid ? { session_id: peekSid } : undefined;
        stripped = { model: parsedBody.model, max_tokens: parsedBody.max_tokens, ...extraParams, messages: currMessages, sysHash, toolsHash, ...(meta && { metadata: meta }) };
      }

      reqWritePromise = config.storage.write(id, '_req.json', JSON.stringify(stripped))
        .catch(e => console.error('Write req.json failed:', e.message));
    }

    const detectedSession = parsedBody
      ? parser.detectSession(clientReq, clientReq.headers, parsedBody)
      : null;
    const { sessionId: reqSessionId, isNewSession, inferred: sessionInferred } = parsedBody
      ? detectedSession
      : { sessionId: provider === 'openai' ? getCodexRawSessionId() : store.getCurrentSessionId(), isNewSession: false };

    // Extract and store cwd
    if (parsedBody && reqSessionId) {
      const cwd = provider === 'openai' ? getOpenAICwd(parsedBody) : store.extractCwd(parsedBody);
      if (cwd) {
        if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
        store.sessionMeta[reqSessionId].provider = provider;
        store.sessionMeta[reqSessionId].cwd = cwd;
      }
    }

    // Detect new cc_version for live requests; compute coreHash for all qualifying requests
    if (parsedBody && provider === 'anthropic') {
      const anthropicPromptInfo = getParser('anthropic')?.registerPromptVersion?.({ parsedBody, sysHash }) || null;
      if (anthropicPromptInfo) coreHash = anthropicPromptInfo.coreHash;
    }

    // Track active requests
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = (store.activeRequests[reqSessionId] || 0) + 1;
      if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
      store.sessionMeta[reqSessionId].provider = provider;
      store.sessionMeta[reqSessionId].lastSeenAt = Date.now();
      broadcastSessionStatus(reqSessionId);
    }

    // Session banner only here. REQUEST line + per-session counter +
    // attribution prefix are emitted from forwardRequest() at forward time
    // so intercepted-then-rejected requests do not advance the counter.
    if (isNewSession) store.printSessionBanner(reqSessionId);

    // Build context for forwarding
    const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);

    // #58: the 1M context window is enabled via the `anthropic-beta:
    // context-1m-*` request header. Unlike the system-prompt "[1m]" marker, this
    // header rides every turn (it does not lag a mid-session model switch), so it
    // is the authoritative, non-lagging signal for the context-window denominator.
    // Carried on ctx and fed into inferMaxContext downstream.
    const beta1m = /(^|,)\s*context-1m-/.test(clientReq.headers['anthropic-beta'] || '');

    const ctx = {
      id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders,
      reqSessionId, reqWritePromise, sysHash, toolsHash, coreHash, sessionInferred, upstream,
      beta1m,
      isSubagent: provider === 'openai' ? isOpenAISubagent(clientReq.headers, parsedBody) : undefined,
    };

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

server.on('upgrade', (req, socket, head) => {
  handleWebSocketUpgrade(req, socket, head);
});


// ── Spawn agent CLI with proxy routing ──
function isStatuslineInstalled(claudeHome) {
  try {
    const raw = fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8');
    return (JSON.parse(raw).statusLine?.command || '').includes('claude-adapter');
  } catch { return false; }
}

function installStatusline(claudeHome) {
  const settingsPath = path.join(claudeHome, 'settings.json');
  const adapterCmd = `node ${path.join(__dirname, 'adapters/claude-adapter.js')}`;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const existing = settings.statusLine?.command || '';
  if (existing.includes('claude-adapter')) return { status: 'already' };

  if (!settings.statusLine) settings.statusLine = {};
  settings.statusLine.command = adapterCmd;
  if (existing) settings.statusLine._ccxrayDelegate = existing;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { status: 'installed', delegated: existing || null };
}

function uninstallStatusline(claudeHome) {
  const settingsPath = path.join(claudeHome, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { status: 'not_installed' }; }

  const cmd = settings.statusLine?.command || '';
  if (!cmd.includes('claude-adapter')) return { status: 'not_installed' };

  const delegate = settings.statusLine._ccxrayDelegate;
  if (delegate) {
    settings.statusLine.command = delegate;
    delete settings.statusLine._ccxrayDelegate;
  } else {
    // ponytail: legacy fallback for old --delegate "cmd" format installs
    const legacyMatch = cmd.match(/--delegate "(.+)"/);
    if (legacyMatch) settings.statusLine.command = legacyMatch[1];
    else delete settings.statusLine;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { status: 'removed' };
}

function promptClaudeStatusline() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const ccxrayHome = resolveCcxrayHome();

  if (isStatuslineInstalled(claudeHome)) return;

  const declinedPath = path.join(ccxrayHome, '.statusline-declined');
  const hintShownPath = path.join(ccxrayHome, '.statusline-hint-shown');

  if (process.stdin.isTTY && !fs.existsSync(declinedPath)) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question('\x1b[35m📊 Track Claude rate limits on the Usage page? [y/N] \x1b[0m', answer => {
        rl.close();
        if (answer.trim().toLowerCase() === 'y') {
          const result = installStatusline(claudeHome);
          if (result.status === 'installed') _origLog('\x1b[32m✓ Done. Rate limits will appear on the Usage page after restarting this session.\x1b[0m');
        } else {
          fs.mkdirSync(ccxrayHome, { recursive: true });
          fs.writeFileSync(declinedPath, '');
        }
        resolve();
      });
    });
  }

  if (!fs.existsSync(hintShownPath)) {
    _origLog('\x1b[90m💡 Claude rate limits: ccxray setup-statusline\x1b[0m');
    fs.mkdirSync(ccxrayHome, { recursive: true });
    fs.writeFileSync(hintShownPath, '');
  }
}

function spawnAgent(command, port, args, onExit) {
  const doSpawn = () => {
    const { spawn } = require('child_process');
    const launch = providers.getAgentLaunch(command, port, args);
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      onExit(code);
    };
    if (!launch) {
      console.error(`\x1b[31mError: unsupported provider "${command}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
      finish(1);
      return;
    }
    const child = spawn(launch.bin, launch.args, {
      stdio: 'inherit',
      env: launch.env,
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(`\x1b[31mError: "${launch.bin}" command not found. Install ${launch.label} first:\x1b[0m`);
        console.error(`\x1b[31m${launch.installHint}\x1b[0m`);
      } else {
        console.error(`\x1b[31mFailed to start ${launch.bin}: ${err.message}\x1b[0m`);
      }
      finish(1);
    });
    child.on('exit', (code, signal) => {
      finish(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  };

  if (command === 'claude') {
    const p = promptClaudeStatusline();
    if (p && typeof p.then === 'function') { p.then(doSpawn).catch(() => doSpawn()); return; }
  }
  doSpawn();
}

// Drain pending WS finalize promises and storage writes before process.exit.
// Without this, codex (or the user) killing the agent races with async
// fs.writeFile calls in ws-proxy/forward, leaving 0-byte _req.json/_res.json
// for the WS upgrade entry. Bounded by a 5s safety timeout so a stuck write
// can never block shutdown.
async function gracefulExit(code) {
  stopCodexRefresh();
  const deadline = new Promise(resolve => setTimeout(resolve, 5000));
  const drain = (async () => {
    try { await drainWebSocketProxy(); } catch (e) { console.error('WS drain failed:', e.message); }
    try { await config.storage.drain(); } catch (e) { console.error('Storage drain failed:', e.message); }
  })();
  await Promise.race([drain, deadline]);
  process.exit(code);
}

function spawnStandaloneAgent(port, command, args) {
  spawnAgent(command, port, args, (code) => {
    server.close();
    gracefulExit(code);
  });
}

// ── "open" subcommand (Phase 1.3) ──
// Mints a one-time bootstrap URL via the running hub (or standalone server
// on the default port) and prints it. The user opens that URL in a browser;
// the inline script in index.html redeems the token and mints the session
// cookie. Token is 60s TTL, single-use, only ever appears here and in the
// browser's URL bar (the fragment never reaches a server log).
if (process.argv[2] === 'open') {
  const lock = hub.readHubLock();
  const port = lock?.port || config.PORT;

  (async () => {
    try {
      let token;
      if (lock?.sockPath) {
        const res = await hub.hubSocketRequest(lock.sockPath, { cmd: 'bootstrap-token' });
        token = res?.token;
      } else {
        // Fallback to HTTP for standalone mode (no hub socket). The endpoint is
        // now auth-gated (codex R3 P1), so send X-Ccxray-Auth derived from the
        // shared root secret — the same credential the launchers inject. Only a
        // caller that can read the secret (same user) can mint a token.
        const auth = require('./auth');
        const upstreamTok = auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');
        token = await new Promise((resolve, reject) => {
          const body = JSON.stringify({});
          const req = http.request({
            hostname: 'localhost', port,
            path: '/_auth/bootstrap-token', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Ccxray-Auth': upstreamTok },
            timeout: 3000,
          }, res => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => {
              if (res.statusCode !== 200) return resolve(null);
              try { resolve(JSON.parse(buf).token); } catch { resolve(null); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end(body);
        });
      }

      if (!token) {
        console.error('\x1b[31mHub did not return a token. Run "ccxray status" to check.\x1b[0m');
        process.exit(1);
      }
      const url = `http://localhost:${port}/#k=${token}`;
      console.log(url);
      console.log('\x1b[90mOpen this URL in your browser (one-time, valid 60 seconds).\x1b[0m');
      if (!process.env.BROWSER && process.env.BROWSER !== 'none' && !process.env.CI && !process.env.SSH_TTY) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${JSON.stringify(url)}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`\x1b[31mCannot reach ccxray on port ${port}: ${err.message}\x1b[0m`);
      console.error('\x1b[90mStart ccxray first (e.g. "ccxray claude") and try again.\x1b[0m');
      process.exit(1);
    }
  })();
  return; // prevent falling through to startup
}

// ── "setup-statusline" subcommand ──
if (process.argv[2] === 'setup-statusline') {
  const explicitHome = process.argv.find((a, i) => process.argv[i - 1] === '--claude-home');

  function discoverClaudeHomes() {
    const home = os.homedir();
    const found = [];
    const defaultHome = path.join(home, '.claude');
    if (fs.existsSync(path.join(defaultHome, 'settings.json'))) {
      let email = null;
      try { email = JSON.parse(fs.readFileSync(path.join(defaultHome, '.claude.json'), 'utf8')).oauthAccount?.emailAddress; } catch {}
      found.push({ path: defaultHome, label: '.claude', email, installed: isStatuslineInstalled(defaultHome) });
    }
    for (const d of fs.readdirSync(home)) {
      if (!d.startsWith('.claude-') || !fs.existsSync(path.join(home, d, 'settings.json'))) continue;
      const p = path.join(home, d);
      let email = null;
      try { email = JSON.parse(fs.readFileSync(path.join(p, '.claude.json'), 'utf8')).oauthAccount?.emailAddress; } catch {}
      found.push({ path: p, label: d, email, installed: isStatuslineInstalled(p) });
    }
    return found;
  }

  function checkboxPicker(items) {
    const selected = items.map(it => it.installed);
    let cursor = 0;
    let firstRender = true;
    const render = () => {
      process.stdout.write('\x1b[?25l');
      if (!firstRender) process.stdout.write(`\x1b[${items.length + 1}A`);
      firstRender = false;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const box = selected[i] ? '\x1b[36m◉\x1b[0m' : '○';
        const arrow = i === cursor ? '\x1b[36m❯\x1b[0m ' : '  ';
        const emailStr = it.email ? `  \x1b[90m${it.email}\x1b[0m` : '';
        process.stdout.write(`\x1b[2K${arrow}${box} ${it.label}${emailStr}\n`);
      }
      process.stdout.write(`\x1b[2K\x1b[90m  ↑↓ move · space toggle · enter confirm\x1b[0m\n`);
    };
    return new Promise(resolve => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      render();
      process.stdin.on('data', (key) => {
        const k = key.toString();
        if (k === '\x03') { process.stdout.write('\x1b[?25h\n'); process.exit(0); }
        if (k === '\r' || k === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\x1b[?25h');
          const toInstall = items.filter((it, i) => selected[i] && !it.installed).map(it => it.path);
          const toRemove = items.filter((it, i) => !selected[i] && it.installed).map(it => it.path);
          resolve({ toInstall, toRemove });
          return;
        }
        if (k === ' ') { selected[cursor] = !selected[cursor]; }
        if (k === '\x1b[A' || k === 'k') cursor = Math.max(0, cursor - 1);
        if (k === '\x1b[B' || k === 'j') cursor = Math.min(items.length - 1, cursor + 1);
        render();
      });
    });
  }

  (async () => {
    if (explicitHome) {
      const result = installStatusline(explicitHome);
      const label = path.basename(explicitHome);
      if (result.status === 'already') console.log(`\x1b[32m✓ ${label}: already configured.\x1b[0m`);
      else { console.log(`\x1b[32m✓ ${label}: done.\x1b[0m`); console.log('\x1b[90mRestart Claude Code sessions to activate.\x1b[0m'); }
      process.exit(0);
    }

    const found = discoverClaudeHomes();
    if (!found.length) {
      console.log('\x1b[33mNo Claude homes found.\x1b[0m');
      process.exit(0);
    }

    let toInstall, toRemove = [];
    if (found.length === 1 && !found[0].installed) {
      toInstall = [found[0].path];
    } else if (process.stdin.isTTY) {
      console.log('Claude rate-limit tracking \x1b[90m(space=toggle, enter=confirm)\x1b[0m');
      ({ toInstall, toRemove } = await checkboxPicker(found));
    } else {
      toInstall = found.filter(f => !f.installed).map(f => f.path);
    }

    let changed = 0;
    for (const h of toInstall) {
      const label = path.basename(h);
      const result = installStatusline(h);
      if (result.status === 'installed') {
        changed++;
        console.log(`\x1b[32m✓ ${label}: installed.\x1b[0m`);
        if (result.delegated) console.log(`\x1b[90m  (existing statusline delegated: ${result.delegated})\x1b[0m`);
      }
    }
    for (const h of toRemove) {
      const label = path.basename(h);
      const result = uninstallStatusline(h);
      if (result.status === 'removed') {
        changed++;
        console.log(`\x1b[33m✗ ${label}: removed.\x1b[0m`);
      }
    }
    if (!changed && !toInstall.length && !toRemove.length) console.log('No changes.');
    if (changed) console.log('\x1b[90mRestart Claude Code sessions to activate.\x1b[0m');
    process.exit(0);
  })();
  return;
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

  (async () => {
    try {
      let s;
      if (lock.sockPath) {
        const health = await hub.hubSocketRequest(lock.sockPath, { cmd: 'health' }, 2000);
        if (!health || !health.ok) {
          console.log(`Hub pid ${lock.pid} alive but socket not responding.`);
          console.log(`Check ${hub.HUB_LOG_PATH}`);
          process.exit(1);
        }
        s = await hub.hubSocketRequest(lock.sockPath, { cmd: 'status' });
      } else {
        const ok = await hub.checkHubHealth(lock.port);
        if (!ok) {
          console.log(`Hub pid ${lock.pid} alive but not responding on port ${lock.port}.`);
          console.log(`Check ${hub.HUB_LOG_PATH}`);
          process.exit(1);
        }
        s = await new Promise((resolve, reject) => {
          http.get(`http://localhost:${lock.port}/_api/hub/status`, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
            });
          }).on('error', reject);
        });
      }
      console.log(`Hub: http://localhost:${s.port} (pid ${s.pid}, uptime ${s.uptime}s, v${s.version})`);
      if (s.clients.length === 0) {
        console.log('No connected clients.');
      } else {
        console.log(`Connected clients (${s.clients.length}):`);
        s.clients.forEach((c, i) => {
          console.log(`  [${i + 1}] pid ${c.pid} — ${c.cwd} (since ${c.connectedAt})`);
        });
      }
      process.exit(0);
    } catch (err) {
      console.error(`Failed to query hub: ${err.message}`);
      process.exit(1);
    }
  })();
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

  {
    const upstreamSuffix = config.ANTHROPIC_BASE_URL_SOURCE === 'ANTHROPIC_BASE_URL'
      ? `  →  ${config.ANTHROPIC_PROTOCOL}://${config.ANTHROPIC_HOST}:${config.ANTHROPIC_PORT} (from ANTHROPIC_BASE_URL)`
      : '';
    _origLog(`\x1b[90m${DISPLAY_NAME} → http://localhost:${lock.port} (hub)${upstreamSuffix}\x1b[0m`);
  }

  try {
    const reg = await hub.registerClient(lock, process.pid, process.cwd());
    if (!reg) {
      console.error('\x1b[31mHub rejected client registration.\x1b[0m');
      process.exit(1);
    }

    // Auto-open browser for the first client connecting to this hub
    if (reg.firstClient) {
      const noOpen = noBrowser
        || process.env.BROWSER === 'none'
        || process.env.CI
        || process.env.SSH_TTY;
      if (!noOpen) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        // Phase 2.4 (hub mode): the redeem endpoint runs in the HUB process,
        // so the token must be minted there too — pendingBootstraps is a
        // module-local Map in whichever process called mintBootstrapToken
        // (codex 2.4 P2). Ask the hub via the socket the same way
        // `ccxray open` does; on socket failure, warn + skip auto-open
        // (don't open an unauthenticated URL; user can `ccxray open` manually).
        let openUrl = null;
        try {
          const res = await hub.hubSocketRequest(lock.sockPath, { cmd: 'bootstrap-token' });
          if (res && res.token) openUrl = formatAutoOpenUrl(lock.port, res.token);
        } catch (e) {
          console.error(`\x1b[33m[ccxray] auto-bootstrap mint failed (${e.message}); run \`ccxray open\` manually if needed.\x1b[0m`);
        }
        if (openUrl) exec(`${cmd} ${openUrl}`);
      }
    }
  } catch (err) {
    console.error(`\x1b[31mFailed to register with hub: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // Monitor hub health and auto-recover
  hub.startHubMonitor(lock.pid, lock.port, (newLock) => {
    // Re-register with new hub (newLock has sockPath from lockfile)
    hub.registerClient(newLock, process.pid, process.cwd()).catch(() => {});
  });

  // Spawn agent pointing to hub
  spawnAgent(agentCommand, lock.port, agentArgs, (code) => {
    hub.unregisterClient(lock, process.pid).finally(() => {
      process.exit(code);
    });
  });
}

// ── Hub/Server startup ──
async function runPostListenStartupTasks() {
  if (process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH === '1') {
    console.error('\x1b[44m\x1b[97m CCXRAY_LOOPBACK_REQUIRE_AUTH=1 \x1b[0m \x1b[34mloopback requests require auth (paranoid mode).\x1b[0m');
  }
  if (process.env.CCXRAY_LOOPBACK_NO_AUTH === '1') {
    console.error('\x1b[33m CCXRAY_LOOPBACK_NO_AUTH=1 is no longer needed — loopback is trusted by default. You can unset it.\x1b[0m');
  }

  store.setRestoreState({
    phase: 'restoring',
    restoring: true,
    complete: false,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  });

  const pricingReady = fetchPricing().catch(err => {
    console.error('[ccxray] Pricing warm-up failed:', err.message);
  });

  let restoreOk = false;
  try {
    await restoreFromLogs();
    restoreOk = true;
    store.setRestoreState({
      phase: 'ready',
      restoring: false,
      complete: true,
      error: null,
      finishedAt: Date.now(),
    });
  } catch (err) {
    store.setRestoreState({
      phase: 'error',
      restoring: false,
      complete: true,
      error: err.message,
      finishedAt: Date.now(),
    });
    console.error('[ccxray] Restore failed:', err.message);
  }

  await pricingReady;
  if (restoreOk) {
    await pruneLogs();
    warmUpCosts();
  }
}

async function startServer() {
  if (!allowUpstreamLoop) {
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    const upstreamFamily = providers.getAgentProvider(agentCommand)?.upstream ?? 'anthropic';
    // Check all upstreams that could loop back: the agent's primary upstream
    // plus any user-configured ChatGPT upstream (since PR #6 promoted
    // chatgpt_base_url to first-class, a misconfigured CHATGPT_BASE_URL would
    // otherwise silently loop with only a startup warn).
    const candidates = [
      { key: upstreamFamily, upstream: config.UPSTREAMS[upstreamFamily], envVar: upstreamFamily === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL' },
    ];
    const chatgpt = config.UPSTREAMS.openaiChatGPT;
    if (chatgpt && chatgpt.source !== 'chatgpt-default') {
      candidates.push({ key: 'openaiChatGPT', upstream: chatgpt, envVar: chatgpt.source || 'CHATGPT_BASE_URL' });
    }
    for (const { upstream, envVar } of candidates) {
      if (upstream && localHosts.has(upstream.host) && upstream.port === config.PORT) {
        const url = `${upstream.protocol}://${upstream.host}:${upstream.port}`;
        throw new Error(
          `${envVar} points back to ccxray (${url}); unset it before starting ccxray.\n` +
          'Pass --allow-upstream-loop or set CCXRAY_ALLOW_UPSTREAM_LOOP=1 to allow this.'
        );
      }
    }
  }

  await config.storage.init();
  startCodexRefresh();

  // Agent mode (with --port, standalone): scan up to 10 ports.
  // Hub mode: fixed port, but retry if old hub is still releasing it (race with idle shutdown).
  // EADDRINUSE in hub mode usually means the previous hub process hasn't fully exited yet —
  // port release takes a few ms after process.exit(). Retry up to 5s before giving up.
  const maxAttempts = (agentMode && !hubMode) ? 10 : 0;
  let actualPort;
  if (hubMode) {
    const HUB_BIND_RETRIES = 5;
    const HUB_BIND_DELAY_MS = 1000;
    for (let i = 0; i <= HUB_BIND_RETRIES; i++) {
      try {
        actualPort = await hub.tryListen(server, config.PORT, 0);
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || i === HUB_BIND_RETRIES) {
          if (err.code === 'EADDRINUSE') {
            // Log the recovery hint to hub.log (console.error → stderr → hub.log).
            // Prefixed with "Error:" so the client's /error|EADDRINUSE/i filter picks it up.
            console.error(`Error: port ${config.PORT} still occupied after ${HUB_BIND_RETRIES}s — if a previous ccxray is stuck, run: kill $(lsof -t -i:${config.PORT})`);
          }
          throw err;
        }
        await new Promise(r => setTimeout(r, HUB_BIND_DELAY_MS));
      }
    }
  } else {
    actualPort = await hub.tryListen(server, config.PORT, maxAttempts);
  }
  rebuildIndexHTML(actualPort);

  runPostListenStartupTasks();

  // Hub mode only: create socket, write lockfile as readiness signal, start client lifecycle
  // Do NOT write lockfile in agent mode with --port (that's independent mode)
  if (hubMode) {
    hub.setHubPort(actualPort);
    // Ensure hub dir has correct permissions + clean up stale socket
    try { fs.chmodSync(hub.HUB_DIR, 0o700); } catch {}
    await hub.cleanupStaleSocket();
    await hub.createHubSocket();
    // Write lockfile after BOTH http + socket are ready (readiness signal)
    hub.writeHubLock(actualPort, process.pid, undefined, hub.SOCK_PATH);
    hub.startDeadClientCheck();
    hub.setOnShutdown(() => gracefulExit(0));
    const cleanup = () => hub.shutdownHub(); // closes socket + deletes lockfile + gracefulExit via onShutdown
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  } else if (!agentMode) {
    // Standalone mode (dashboard only, no agent): drain on signal so any WS
    // entries flush. Agent mode handles signals via the child exit path.
    const cleanup = () => gracefulExit(0);
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  // Banner
  if (hubMode) {
    // Hub runs silently (logs go to hub.log)
  } else if (agentMode) {
    _origLog(`\x1b[90m${DISPLAY_NAME} → http://localhost:${actualPort}\x1b[0m`);
  } else {
    console.log();
    console.log(`\x1b[35m🔌 ${DISPLAY_NAME} proxy listening on http://localhost:${actualPort}\x1b[0m`);
    console.log(`\x1b[90m   Dashboard → http://localhost:${actualPort}/`);
    const upstreamUrl = `${config.ANTHROPIC_PROTOCOL}://${config.ANTHROPIC_HOST}:${config.ANTHROPIC_PORT}`;
    const upstreamNote = config.ANTHROPIC_BASE_URL_SOURCE === 'ANTHROPIC_BASE_URL' ? ' (from ANTHROPIC_BASE_URL)' : '';
    console.log(`   Upstream → ${upstreamUrl}${upstreamNote}`);
    const openaiUrl = `${config.OPENAI_PROTOCOL}://${config.OPENAI_HOST}:${config.OPENAI_PORT}${config.OPENAI_BASE_PATH}`;
    const openaiNote = config.OPENAI_BASE_URL_SOURCE === 'OPENAI_BASE_URL' ? ' (from OPENAI_BASE_URL)' : '';
    console.log(`   OpenAI Upstream → ${openaiUrl}${openaiNote}`);
    console.log(`   Logs → ${config.storage.location || config.LOGS_DIR}`);
    console.log();
    console.log(`   Usage: ANTHROPIC_BASE_URL=http://localhost:${actualPort} claude\x1b[0m`);
    console.log('\x1b[0m');
  }

  // Auto-open dashboard in browser (not in hub mode)
  const noOpen = hubMode
    || noBrowser
    || process.env.BROWSER === 'none'
    || process.env.CI
    || process.env.SSH_TTY;
  if (!noOpen) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    // Phase 2.4: pre-bootstrap the browser so it lands authenticated.
    exec(`${cmd} ${mintAutoOpenUrl(actualPort)}`);
  }

  if (agentMode) spawnStandaloneAgent(actualPort, agentCommand, agentArgs);
}

// ── Main entry ──
(async () => {
  // Hub mode or explicit port or standalone: start server directly
  if (hubMode || explicitPort || !agentMode) {
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

  // Windows: hub mode requires Unix sockets; fall back to standalone
  if (process.platform === 'win32') {
    try { await startServer(); } catch (err) {
      console.error(`\x1b[31mStartup failed: ${err.message}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // Agent mode without explicit port: try hub discovery
  const existingHub = await hub.discoverHub(config.PORT);
  if (existingHub) {
    await startClientMode(existingHub);
    return;
  }

  // No hub found: acquire fork lock to prevent duplicate hub forks
  const acquired = hub.tryAcquireForkLock();
  if (acquired) {
    hub.forkHub(config.PORT);
  }
  try {
    const lock = await hub.waitForHubReady();
    if (acquired) hub.releaseForkLock();
    await startClientMode(lock);
  } catch (err) {
    if (acquired) hub.releaseForkLock();
    console.error(`\x1b[31m${err.message}\x1b[0m`);
    // Show last hub log lines so user doesn't have to open the file
    const fs = require('fs');
    try {
      const log = fs.readFileSync(hub.HUB_LOG_PATH, 'utf8');
      const lines = log.trim().split('\n');
      const lastErrors = lines.filter(l => /error|EADDRINUSE/i.test(l)).slice(-3);
      if (lastErrors.length) {
        console.error('\x1b[33mHub log:\x1b[0m');
        lastErrors.forEach(l => console.error(`  ${l.replace(/\x1b\[[0-9;]*m/g, '')}`));
      }
      if (lines.some(l => /EADDRINUSE|already in use/i.test(l))) {
        console.error(`\x1b[33mSuggestion: another process is using port ${config.PORT}. Use --port <other> or kill the process.\x1b[0m`);
      }
    } catch {}
    process.exit(1);
  }
})();
