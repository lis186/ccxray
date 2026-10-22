#!/usr/bin/env node
'use strict';

// ── CLI pre-scan: --help/-h, unknown global flags, and the "usage" fast path ──
// INVARIANT (A-003 issue 1): this block must run before every require() below
// and before any fs/network side effect (pruneLogs, hub lockfile, listen()).
// It decides "print help", "unknown flag, exit 1", or "run usage" — it must
// not require('./providers') (that would defeat the zero-require-cost point of
// living here) and does not inspect tokens after the first non-flag token (the
// command slot); those are subcommand or agent args for the code below.
{
  // Keep in sync with parseGlobalFlags in server/plain-launch.js (`--port` /
  // `--hub-mode` / `--allow-upstream-loop` / `--no-browser`) — a new global
  // flag added there must be added here too, or it will be misreported as
  // unknown.
  const KNOWN_BOOL_FLAGS = new Set(['--hub-mode', '--allow-upstream-loop', '--no-browser']);
  const KNOWN_VAL_FLAGS = new Set(['--port']);
  const HELP_TEXT = `Usage: ccxray [options] [command]

Commands:
  claude              Launch Claude Code through the proxy
  codex               Launch Codex CLI through the proxy
  grok                Launch Grok CLI through the proxy
  status              Show process, home export state, shell config and diagnostics
  open                Open dashboard in browser
  import              Import transcripts (--once or --target-transcript)
  rebuild-index       Rebuild index.ndjson from log files
  setup               Install the Claude shell wrapper (export opt-in: --export)
  setup-statusline    Configure Claude Code status line
  hud on|off|status   Turn the Context HUD on or off, or show it (off by default)
  secret              Manage shared secrets (upstream)
  usage               Show usage summary and costs
  agentflow report    Usage per Ask of an agentflow notebook

Options:
  --port <n>              Custom proxy port (1-65535)
  --no-browser            Don't auto-open browser on startup
  --allow-upstream-loop   Allow upstream URL pointing back to self
  --version, -v           Show package version
  --help, -h              Show this help

Arguments after an agent command are passed to the agent:
  ccxray claude --continue    # --continue goes to Claude Code
  ccxray codex --model o3     # --model o3 goes to Codex

Run "ccxray <command> --help" for command-specific help (where supported).
`;

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // return, not process.exit(): exiting right after a write can truncate
    // piped stdout/stderr on macOS, and nothing else is pending here.
    if (tok === '--version' || tok === '-v') {
      process.stdout.write(require('../package.json').version + '\n');
      return;
    }
    if (tok === '--help' || tok === '-h') {
      process.stdout.write(HELP_TEXT);
      return;
    }
    if (tok === '') {
      // e.g. `ccxray "$AGENT"` with AGENT unset: not a command, and falling
      // through would boot a standalone server on the default home.
      console.error('\x1b[31mError: empty argument. Run "ccxray --help" for usage.\x1b[0m');
      process.exitCode = 1;
      return;
    }
    if (KNOWN_BOOL_FLAGS.has(tok)) continue;
    if (KNOWN_VAL_FLAGS.has(tok)) {
      // Never swallow an option as the value; the --port parser below
      // reports a missing or invalid value.
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    if (tok.startsWith('-')) {
      console.error(`\x1b[31mError: unknown option "${tok}". Run "ccxray --help" for usage.\x1b[0m`);
      process.exitCode = 1;
      return;
    }
    // First non-flag token: the command slot. "usage" is a read-only report
    // that needs no server modules, so it runs here even after global flags
    // (checking only argv[2] let `ccxray --no-browser usage` boot a server).
    if (tok === 'usage') {
      // run() is async (#345: streams the index). Handle rejection so a read error
      // exits non-zero instead of becoming an unhandled promise rejection.
      require('./usage').run(argv.slice(i + 1)).catch(err => {
        console.error(err && err.message ? err.message : String(err));
        process.exit(1);
      });
      return;
    }
    // Same read-only shape as `usage`: loading the rest of server/ would only
    // add modules the report must not start (docs/agentflow-integration.md, CLI).
    if (tok === 'agentflow') {
      require('./agentflow/cli').run(argv.slice(i + 1)).catch(err => {
        console.error(err && err.message ? err.message : String(err));
        process.exitCode = 1;
      });
      return;
    }
    // Everything after the command slot belongs to the subcommand/agent.
    break;
  }
}

// ── Bootstrap fail-open ──
// INVARIANT: installed before the first proxy-stack require and removed right
// before createLaunchDecision (see "Main entry"); the early-exit subcommands
// (secret/import/rebuild-index) return before that and simply keep it, where it
// only prints and exits 1. A synchronous throw while the modules below load
// (STORAGE_BACKEND=s3, a missing/corrupt `ws`) would otherwise exit 1 before
// the fail-open decision exists, so the agent never starts. Parsing, the log
// record and the spawn come from server/plain-launch.js (load closure pinned),
// shared with the normal launcher; every other module used here is required
// inside a try, because it may be the one that failed.
// Once the agent is launched the removal below is never reached: a later
// uncaught error is printed and survived (the launcher still exits with the
// agent's code) and must not launch a second agent.
let bootstrapLaunched = false;
// Snapshot: the CLI section below rewrites process.argv in place, and a later
// require can still fail, so parsing it again would strip global flags twice.
const bootstrapArgv = process.argv.slice();
function onBootstrapFailure(err) {
  console.error(err && err.stack ? err.stack : String(err));
  if (bootstrapLaunched) return;
  let plain;
  try { plain = require('./plain-launch'); } catch { process.exit(1); }
  const flags = plain.parseGlobalFlags(bootstrapArgv);
  if (flags.hasPort && plain.parsePort(flags.portValue) == null) {
    console.error(plain.INVALID_PORT_MESSAGE);
    process.exit(1);
  }
  const agent = plain.BOOTSTRAP_AGENTS.includes(flags.argv[2]) ? flags.argv[2] : null;
  if (!agent || flags.hubMode) process.exit(1);
  const args = flags.argv.slice(3);
  // Same exemption as launchDecision's bg-bypass: an intentional background
  // session runs plain even under CCXRAY_FAIL_CLOSED=1. If claude-args is the
  // module that failed, degrade to fail-closed (the safe direction).
  let bgBypass = false;
  try { bgBypass = agent === 'claude' && require('./claude-args').hasClaudeBackgroundFlag(args); } catch {}
  if (process.env.CCXRAY_FAIL_CLOSED === '1' && !bgBypass) process.exit(1);
  let version = null;
  try { version = require('../package.json').version; } catch {}
  plain.appendFailOpen(() => require('./paths').resolveCcxrayHome(),
    { ts: new Date().toISOString(), reason: 'bootstrap-failed', version, agent });
  console.error('[ccxray] fail-open: bootstrap-failed — this session is NOT traced; run ccxray setup --check');
  let provider = null;
  try { provider = require('./providers').getAgentProvider(agent); } catch {}
  bootstrapLaunched = true;
  plain.spawnPlain(
    { bin: agent, args, env: process.env, label: provider?.label || agent, installHint: provider?.installHint || '' },
    { provider, onExit: code => process.exit(code) },
  );
}
process.on('uncaughtException', onBootstrapFailure);

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');
const { checkHttpRoute } = require('./request-routing');
const store = require('./store');
const { resolveCcxrayHome, tightenCcxrayHome } = require('./paths');
const helpers = require('./helpers');
const { fetchPricing } = require('./pricing');
const { restoreFromLogs, pruneLogs } = require('./restore');
const { warmUp: warmUpCosts } = require('./cost-budget');
const exportSync = require('./export-sync');
const { startExportSync, stopExportSync, flushExport, awaitPendingFlush } = exportSync;
const { forwardRequest, setStatusLineEnabled, getStatusLineEnabled, setSessionAnchorRecorder } = require('./forward');
const { readSettings, hudStatusText } = require('./settings');
const { broadcastSessionStatus, broadcastPendingRequest } = require('./sse-broadcast');
const { dispatch, mintAutoOpenUrl, formatAutoOpenUrl } = require('./auth');
const { findSharedPrefix } = require('./delta-helpers');
const { extractPromptAgentType } = require('./system-prompt');
const providers = require('./providers');
const { handleWebSocketUpgrade, drainWebSocketProxy } = require('./ws-proxy');
const sessionIdx = require('./session-index');
const { WIRE_PARSERS, getParser } = require('./wire-parsers');
const { renderHubClientStatus } = require('./hub-client-status');
const { renderProcessStatus, inspectHomeStatus } = require('./status');
const plainLaunch = require('./plain-launch');
// #690: a home created loose by an older version (or by hand) holds secrets;
// tighten it to 0700 once per invocation, before any subcommand writes into it.
tightenCcxrayHome(resolveCcxrayHome(), {
  log: msg => console.error(process.stderr.isTTY ? `\x1b[90m${msg}\x1b[0m` : msg),
});
// wire-parsers/openai low-level helpers no longer needed in index.js after Phase 2 migration

// ── CLI: parse flags and detect provider launchers ──
// Shared with the bootstrap fail-open handler so both see the same agent args.
const globalFlags = plainLaunch.parseGlobalFlags(process.argv);
let explicitPort = false;
if (globalFlags.hasPort) {
  const parsed = plainLaunch.parsePort(globalFlags.portValue);
  if (parsed == null) {
    console.error(plainLaunch.INVALID_PORT_MESSAGE);
    process.exit(1);
  }
  config.PORT = parsed;
  explicitPort = true;
}
process.argv.splice(0, process.argv.length, ...globalFlags.argv);
let hubMode = globalFlags.hubMode;
if (hubMode && process.platform === 'win32') {
  console.error('\x1b[31mHub mode requires Unix sockets (macOS/Linux). On Windows, use --port for standalone mode.\x1b[0m');
  process.exit(1);
}
const allowUpstreamLoop = globalFlags.allowUpstreamLoop || process.env.CCXRAY_ALLOW_UPSTREAM_LOOP === '1';
const noBrowser = globalFlags.noBrowser;
const cliCommand = process.argv[2];
const unknownCommand = cliCommand
  && cliCommand !== 'status'
  && cliCommand !== 'open'
  && cliCommand !== 'secret'
  && cliCommand !== 'rebuild-index'
  && cliCommand !== 'import'
  && cliCommand !== 'setup'
  && cliCommand !== 'setup-statusline'
  && cliCommand !== 'hud'
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

// ── "hud on|off|status" — early exit, no server/hub boot (#692) ──
// Persists to the same settings.json the dashboard toggle writes.
if (process.argv[2] === 'hud') {
  const HUD_USAGE = `Usage: ccxray hud on|off|status

  on          Append the context-stats footer to Claude replies
  off         Do not append it (the default)
  status      Show the current setting
  --help, -h  Show this help

The setting is stored in ${path.join(resolveCcxrayHome(), 'settings.json')}, shared with the
dashboard toggle. The HUD can truncate subagent returns; keep it off for
subagent-heavy or automated sessions.
`;
  const sub = process.argv[3];
  const hudSettings = require('./settings');
  if (process.argv.length > 4 || (sub && !['on', 'off', 'status', '--help', '-h'].includes(sub))) {
    process.stderr.write(`\x1b[31mError: unknown hud argument "${process.argv.slice(3).join(' ')}".\x1b[0m\n${HUD_USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(HUD_USAGE);
    return;
  }
  if (sub === 'status') {
    let enabled;
    try { enabled = hudSettings.readStatusLineSync(); }
    catch (err) {
      console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(hudSettings.hudStatusText(enabled) + '\n');
    return;
  }
  try { hudSettings.setStatusLineSync(sub === 'on'); }
  catch (err) {
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(hudSettings.hudStatusText(sub === 'on') + '\n'
    + 'A running ccxray hub or server keeps its current setting until it restarts; the dashboard toggle changes it live.\n');
  return;
}

// ── "import --once" — early exit, no server/hub boot ──
// A throttled, lock-guarded transcript scan for a dashboard that has noticed the
// index has fallen behind. Appends index lines only; see server/import-once.js
// for why it does not refuse while a hub is running.
if (process.argv[2] === 'import') {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`Usage: ccxray import --once [--force]
       ccxray import --target-transcript <file> [--provider <id>] [--session-id <id>] [--cwd <dir>]

  --once                 Throttled, lock-guarded single scan of local transcripts
                         into the index (appends index lines only)
  --force                With --once: ignore the minimum interval
                         (CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS, default 10min)
  --target-transcript    Import one transcript file; prints a JSON result
  --help, -h             Show this help
`);
    return;
  }
  const targetAt = process.argv.indexOf('--target-transcript');
  const argValue = name => {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : null;
  };
  if (targetAt >= 0) {
    const target = {
      file: process.argv[targetAt + 1],
      provider: argValue('--provider'),
      sessionId: argValue('--session-id'),
      cwd: argValue('--cwd'),
    };
    require('./import-once').importTargeted({ target })
      // Let Node drain piped stdout. The detached repair worker consumes this
      // JSON; process.exit() can truncate it and turn a successful import into
      // an apparent failure.
      .then(r => { console.log(JSON.stringify(r)); process.exitCode = r.ok && r.ran ? 0 : 1; })
      .catch(err => { console.error(`targeted import failed: ${err.message}`); process.exitCode = 1; });
    return;
  }
  if (!process.argv.includes('--once')) {
    console.error('\x1b[31mError: unknown import mode. Supported: ccxray import --once or --target-transcript\x1b[0m');
    process.exit(1);
  }
  require('./import-once').importOnce({ force: process.argv.includes('--force') })
    .then(r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch(err => { console.error(`import --once failed: ${err.message}`); process.exit(1); });
  return;
}

// ── "rebuild-index [--apply]" — early exit, no server/hub boot ──
// Rebuilds index.ndjson from surviving _req/_res log files. Dry-run by default;
// --apply atomically writes the merged index. Merge-only and hub-safe.
if (process.argv[2] === 'rebuild-index') {
  const { rebuildIndex, reimportEntries } = require('./rebuild-index');
  if (process.argv.includes('--reimport')) {
    reimportEntries()
      .then(r => process.exit(r && r.refused ? 1 : 0))
      .catch(err => { console.error(`rebuild-index --reimport failed: ${err.message}`); process.exit(1); });
  } else {
    rebuildIndex({ apply: process.argv.includes('--apply') })
      .then(r => process.exit(r && r.refused ? 1 : 0))
      .catch(err => { console.error(`rebuild-index failed: ${err.message}`); process.exit(1); });
  }
  return;
}

const agentCommand = providers.isAgentProvider(cliCommand) ? cliCommand : null;
const agentMode = Boolean(agentCommand);
const agentArgs = agentMode ? process.argv.slice(3) : [];
const DISPLAY_NAME = providers.getDisplayName(agentCommand, process.env);

const { hasClaudeBackgroundFlag } = require('./claude-args');

// In agent/hub mode, mute startup logs so they don't pollute output.
const _origLog = console.log;
if (agentMode || hubMode) console.log = () => {};
// startServer() is the exporter in standalone, --port agent, and Windows fallback
// modes. Those paths may have console.log muted because an agent is attached, so
// keep the refusal on the same original channel as the agent startup banner. A hub
// has its own status/reporting path and must retain the existing hub-log behavior.
const localExporterMode = !hubMode
  && (explicitPort || !agentMode || process.platform === 'win32');
if (localExporterMode) {
  exportSync._setConfigDirsWarningLogger(_origLog);
  exportSync._setCredentialLogger(_origLog);
}

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
const { collectExportDiagnostics, fetchHubReport, renderExportDiagnostics } = require('./export-diagnostics');
hub.setLaunchSignals({
  hubMode,
  explicitPort,
  agentNamed: agentMode,
  platform: process.platform,
});

// ── Web UI: Static files from public/ ────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

// Security headers for dashboard static responses only.
// NOT applied to proxy-forwarded responses (those go to Anthropic unchanged).
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

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
    const configJson = JSON.stringify({ DEFAULT_CONTEXT: config.DEFAULT_CONTEXT, PORT: serverPort, statusLine: getStatusLineEnabled(), APP_NAME: DISPLAY_NAME }).replace(/</g, '\\u003c');
    const script = `<script type="application/json" id="proxy-config">${configJson}</script>`;
    const html = rawIndexHTML ? rawIndexHTML.replace('<!--__PROXY_CONFIG__-->', script) : '<html><body>Error loading dashboard</body></html>';
    clientRes.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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
    clientRes.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store' });
    clientRes.end(content);
    return true;
  } catch {
    return false;
  }
}

const { buildForwardHeaders } = require('./forward-headers');
const { armClientShutdown } = require('./client-shutdown');
const { createLaunchDecision, raceWithLaunchDecision } = require('./launch-decision');

// Cwd when the wire body has none: hub client cwd, else launcher process cwd
// for modules that declare cwdFallback (codex, grok, …).
function getAgentCwdFallback(req) {
  return hub.lookupClientCwdForRequest(req)
    || (providers.agentUsesCwdFallback(agentCommand) ? process.cwd() : null);
}
// Back-compat alias for call sites / tests
const getCodexCwdFallback = getAgentCwdFallback;


// ── Server ──────────────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {
  hub.applyClientRoute(clientReq);

  // ── Hub API (health, register, unregister, status) ──
  // Health keeps its small public identity; its optional export report uses
  // the dashboard trust predicate because the route precedes this auth gate.
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

  // Internal API paths form a closed namespace; typos must never become turns.
  if (clientReq.url.split('?')[0].startsWith('/_api/')) {
    clientRes.writeHead(404, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Unknown API route' }));
    return;
  }

  // ── Proxy logic ──
  const ts = helpers.taipeiTime();
  const id = helpers.timestamp();
  const startTime = Date.now();

  const reqChunks = [];
  let bodySize = 0;
  let rejected = false;
  clientReq.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > config.MAX_BODY_BYTES) {
      if (!rejected) {
        rejected = true;
        const mb = Math.round(config.MAX_BODY_BYTES / (1024 * 1024));
        clientRes.writeHead(413, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: `Request body exceeds CCXRAY_MAX_BODY_MB (${mb} MB)` } }));
      }
      return;
    }
    reqChunks.push(chunk);
  });
  clientReq.on('end', () => {
    if (rejected) return;
    const rawBody = Buffer.concat(reqChunks);
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody.toString()); } catch {}

    clientReq.bodySize = bodySize;
    const upstream = config.getUpstreamForRequestAndHeaders(clientReq.url, clientReq.headers, clientReq);
    if (!checkHttpRoute(clientReq, clientRes, upstream)) return;

    // Quota-check probes: forward to Anthropic (rate limit headers still captured)
    // but skip all logging, session tracking, and entry creation
    if (parsedBody && store.isQuotaCheck(parsedBody)) {
      const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true, upstream });
      return;
    }

    // Provider noise RPC: forward but don't create dashboard entries.
    // Each WIRE_PARSER defines its own noise patterns (e.g. codex startup
    // polls for plugins/connectors/apps/usage).
    if (Object.values(WIRE_PARSERS).some(p => p.isNoiseRequest(clientReq.url, clientReq.headers, parsedBody))) {
      const fwdHeaders = buildForwardHeaders(clientReq.headers, upstream);
      forwardRequest({ id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId: null, reqWritePromise: null, skipEntry: true, upstream });
      return;
    }

    const provider = upstream.provider || 'anthropic';
    const parser = getParser(provider);
    if (parsedBody && parser?.preprocessBody) {
      parsedBody = parser.preprocessBody(parsedBody, clientReq.headers);
    }

    let reqWritePromise = null;
    let sysHash = null;
    let toolsHash = null;
    let coreHash = null;
    let agentKey = null, agentLabel = null;
    if (parsedBody) {
      const sysPH = parser.systemPromptHash(parsedBody);
      sysHash = sysPH.hash;
      const toolsPH = parser.toolsHash(parsedBody);
      toolsHash = toolsPH.hash;

      if (sysHash) {
        config.storage.writeSharedIfAbsent(`${sysPH.filePrefix}${sysHash}.json`, JSON.stringify(sysPH.content))
          .catch(e => console.error('Write sys/instructions failed:', e.message));
      }
      if (toolsHash) {
        config.storage.writeSharedIfAbsent(`${toolsPH.filePrefix}${toolsHash}.json`, JSON.stringify(parsedBody.tools))
          .catch(e => console.error('Write tools failed:', e.message));
      }

      // registerPromptVersion for openai: also writes prompt metadata + extracts agent identity
      if (provider === 'openai' && sysHash) {
        const promptInfo = parser.registerPromptVersion?.({
          parsedBody, sysHash, sharedFile: `${sysPH.filePrefix}${sysHash}.json`,
        }) || null;
        if (promptInfo) {
          config.storage.writeSharedIfAbsent(`openai_prompt_meta_${sysHash}.json`, JSON.stringify({
            agentKey: promptInfo.agentKey,
            agentLabel: promptInfo.agentLabel,
          })).catch(e => console.error('Write OpenAI prompt metadata failed:', e.message));
        }
        coreHash = promptInfo?.coreHash || null;
        agentKey = promptInfo?.agentKey || null;
        agentLabel = promptInfo?.agentLabel || null;
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
      : { sessionId: parser.rawSessionId(clientReq.headers, null) || store.getCurrentSessionId(), isNewSession: false };

    // Cross-session parent linkage — MUST run before cwd assignment AND
    // activeRequests increment (#223: cwd was set first, causing
    // linkParentSession to bail on meta.cwd for subagents with their own
    // session_id on their very first turn).
    // Intentional provider branch: isSubagentHint is a wire-level override for
    // linkParentSession's heuristic. Only openai has an explicit wire signal
    // (x-openai-subagent header); anthropic uses undefined to let the heuristic decide.
    const isSubagentHint = provider === 'openai' ? parser.isSubagent(parsedBody, clientReq.headers) : undefined;
    if (reqSessionId) store.linkParentSession(reqSessionId, parsedBody, isSubagentHint);

    // Extract and store cwd (after linkParentSession — see #223)
    // openai getCwd has a runtime fallback (hub client cwd / process.cwd) that
    // depends on index.js state — applied after the adapter's wire-level extraction.
    // Grok vs Codex share openai wire; set session agent from header/model when available.
    if (parsedBody && reqSessionId) {
      const cwd = parser.getCwd(parsedBody, clientReq.headers)
        || (provider === 'openai' ? getAgentCwdFallback(clientReq) : null);
      if (!store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId] = {};
      if (provider === 'anthropic') store.cacheConfigDir(reqSessionId, parsedBody);
      store.sessionMeta[reqSessionId].provider = provider;
      if (provider === 'openai' && typeof parser.resolveOpenAIAgent === 'function') {
        store.sessionMeta[reqSessionId].agent = parser.resolveOpenAIAgent(clientReq.headers, parsedBody);
      }
      if (cwd) store.sessionMeta[reqSessionId].cwd = cwd;
    }

    // Detect new cc_version for live requests; compute coreHash for all qualifying requests
    // (openai path runs registerPromptVersion above during sysHash persistence)
    if (parsedBody && provider === 'anthropic') {
      const anthropicPromptInfo = parser.registerPromptVersion?.({ parsedBody, sysHash }) || null;
      if (anthropicPromptInfo) {
        coreHash = anthropicPromptInfo.coreHash;
        agentKey = anthropicPromptInfo.agentKey || null;
        agentLabel = anthropicPromptInfo.agentLabel || null;
      }
    }
    // Short-form prompts (subagents, title-gen) never reach registerPromptVersion
    // — fall back to direct detection so every entry carries an agent identity.
    if (!agentKey && parsedBody) {
      const at = extractPromptAgentType(provider, parsedBody);
      if (at && at.key !== 'unknown') { agentKey = at.key; agentLabel = at.label; }
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
    // The boolean above collapses the header to "is it 1M". Keep the context-*
    // entries verbatim as well: the id carries the tier the client asked for, so
    // a future `context-400k-*` is distinguishable instead of arriving as a
    // silent false. Whitelisted on purpose — request headers also carry
    // authorization / x-api-key, which must never reach the log.
    const ctxBeta = config.extractContextBeta(clientReq.headers['anthropic-beta']);

    const ctx = {
      id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders,
      reqSessionId, reqWritePromise, sysHash, toolsHash, coreHash, agentKey, agentLabel, sessionInferred, upstream,
      beta1m, ctxBeta,
      isSubagent: isSubagentHint,
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

server.headersTimeout = 60_000;    // 60s — only header phase, safe
server.keepAliveTimeout = 5_000;   // 5s — idle keep-alive connections
// ponytail: requestTimeout covers receiving the client request (headers+body), not response streaming — safe for long SSE responses
server.requestTimeout = 300_000;   // 5min — matches Node default; slow POST body = slowloris, body size cap (#152) handles OOM

server.on('upgrade', (req, socket, head) => {
  hub.applyClientRoute(req);
  handleWebSocketUpgrade(req, socket, head, { cwdFallback: getAgentCwdFallback(req) });
});


// ── Spawn agent CLI with proxy routing ──
const { isStatuslineInstalled, launchPromptState, installStatusline, uninstallStatusline, refusalMessage } = require('./statusline-setup');

function promptClaudeStatusline(args = []) {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const ccxrayHome = resolveCcxrayHome();

  if (isStatuslineInstalled(claudeHome)) return;

  const declinedPath = path.join(ccxrayHome, '.statusline-declined');
  const hintShownPath = path.join(ccxrayHome, '.statusline-hint-shown');

  // #563: a Herdr-launched pane must not block on an interactive gate — the
  // user clicked "launch claude" and expects the agent, not a question. Fall
  // through to the one-line hint; the declined marker is NOT written, so a
  // later direct TTY launch still gets to answer.
  const herdrLaunch = (process.env.CCXRAY_AGENT_ID || '').startsWith('herdr:');
  // Use the launcher's shared parser so a bare `--` ends option parsing here
  // too. --bg/--background also returns immediately (and is already a
  // plain-launch bypass elsewhere). TTY stdin alone does not make consent
  // visible when stdout is piped, so keep the stdout TTY check as well.
  const printMode = providers.isClaudePrintMode(args);
  if (printMode || hasClaudeBackgroundFlag(args) || !process.stdout.isTTY) return;

  if (process.stdin.isTTY && !herdrLaunch && !fs.existsSync(declinedPath)) {
    // #563: disclose purpose, impact, and reversibility; the default follows
    // risk — a pure addition (no statusline configured) defaults to yes, while
    // wrapping an existing statusline requires a conscious "y".
    // #687 / #695: the same reader setup uses — an unparseable or non-object
    // settings.json is never rewritten, so say so instead of asking. No
    // declined marker: once the file is fixed, a later launch still answers.
    const state = launchPromptState(claudeHome);
    if (state.status === 'refused') {
      _origLog(`\x1b[33m${refusalMessage(state.settingsPath, state.reason)}\x1b[0m`);
      return;
    }
    const hasExisting = state.status === 'existing';
    const impactNote = hasExisting
      ? 'your existing statusline keeps rendering unchanged (delegated, not replaced)'
      : 'no statusline is configured today, so this only adds one';
    const defTag = hasExisting ? '[y/N]' : '[Y/n]';
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(
        '\x1b[35m📊 Track Claude subscription limits (5h/weekly) on the Usage page?\x1b[0m\n'
        + `\x1b[90m   Installs a statusline adapter in ${path.join(claudeHome, 'settings.json')} —\n`
        + `   ${impactNote}; fully restored on removal (ccxray setup-statusline).\x1b[0m \x1b[35m${defTag}\x1b[0m `,
        answer => {
        rl.close();
        const a = String(answer ?? '').trim().toLowerCase();
        if (a === 'y' || a === 'yes' || (a === '' && !hasExisting)) {
          const result = installStatusline(claudeHome);
          if (result.status === 'installed') _origLog('\x1b[32m✓ Done. Rate limits will appear on the Usage page after restarting this session.\x1b[0m');
          if (result.status === 'refused') _origLog(`\x1b[33m${refusalMessage(result.settingsPath, result.reason)}\x1b[0m`);
        } else {
          fs.mkdirSync(ccxrayHome, { recursive: true, mode: 0o700 });
          fs.writeFileSync(declinedPath, '');
        }
        resolve();
      });
    });
  }

  if (!fs.existsSync(hintShownPath)) {
    _origLog('\x1b[90m💡 Claude rate limits: ccxray setup-statusline\x1b[0m');
    fs.mkdirSync(ccxrayHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(hintShownPath, '');
  }
}

function spawnAgent(command, port, args, onExit, opts = {}) {
  const doSpawn = () => {
    // INVARIANT: re-checked HERE, not only at the call site. On the interactive
    // path this function runs after promptClaudeStatusline()'s promise settles,
    // so a signal can have begun the caller's shutdown while the prompt was
    // waiting — spawning then orphans the agent. See server/client-shutdown.js.
    if (opts.isShuttingDown && opts.isShuttingDown()) return;
    const launch = opts.launch || providers.getAgentLaunch(command, port, args);
    if (!launch) {
      console.error(`\x1b[31mError: unsupported provider "${command}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
      onExit(1);
      return;
    }
    plainLaunch.spawnPlain(launch, {
      provider: providers.getAgentProvider(command),
      onExit,
      onChild: opts.onChild,
      signalsOwnedByCaller: opts.signalsOwnedByCaller,
    });
  };

  if (command === 'claude' && !opts.skipStatuslinePrompt) {
    const p = promptClaudeStatusline(args);
    if (p && typeof p.then === 'function') { p.then(doSpawn).catch(() => doSpawn()); return; }
  }
  doSpawn();
}

const ATTACH_TIMEOUT_DEFAULT_MS = 3000;

function attachTimeoutMs(env = process.env) {
  if (env.CCXRAY_ATTACH_TIMEOUT_MS === undefined) return ATTACH_TIMEOUT_DEFAULT_MS;
  const parsed = Number(env.CCXRAY_ATTACH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ATTACH_TIMEOUT_DEFAULT_MS;
}

// Drain pending WS finalize promises and storage writes before process.exit.
// Without this, codex (or the user) killing the agent races with async
// fs.writeFile calls in ws-proxy/forward, leaving 0-byte _req.json/_res.json
// for the WS upgrade entry. Bounded by a 5s safety timeout so a stuck write
// can never block shutdown.
async function gracefulExit(code) {
  stopCodexRefresh();
  stopExportSync();
  const deadline = new Promise(resolve => setTimeout(resolve, 5000));
  const drain = (async () => {
    try { await drainWebSocketProxy(); } catch (e) { console.error('WS drain failed:', e.message); }
    // drain() before flush(): in-flight appendIndex .then(updateFromEntry) callbacks
    // must fire before flush persists the session Map to disk (#309)
    try { await config.storage.drain(); } catch (e) { console.error('Storage drain failed:', e.message); }
    try { await sessionIdx.flush(); } catch (e) { console.error('Session index flush failed:', e.message); }
    // #5: await in-flight export AFTER critical drains so a 30s GCS timeout
    // doesn't block WS/storage under the 5s shutdown deadline
    try { await awaitPendingFlush(); } catch (e) { console.error('Pending export flush failed:', e.message); }
    try { await flushExport({ phase: 'shutdown' }); } catch (e) { console.error('Export flush failed:', e.message); }
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
  const requestedSession = process.argv.find((arg, index) => process.argv[index - 1] === '--session') || null;

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
      const url = formatAutoOpenUrl(port, token, { sid: requestedSession });
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

// ── "setup" subcommand ──
if (process.argv[2] === 'setup') {
  require('./setup').runSetup(process.argv.slice(3)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`\x1b[31mSetup failed: ${error.message}\x1b[0m`);
    process.exitCode = 1;
  });
  return;
}

// ── "setup-statusline" subcommand ──
if (process.argv[2] === 'setup-statusline') {
  // #687: parse before anything can write — --help and unknown flags used to
  // fall through to an install.
  const statuslineSetup = require('./statusline-setup');
  const opts = statuslineSetup.parseSetupStatuslineArgs(process.argv.slice(3));
  if (opts.help) {
    process.stdout.write(statuslineSetup.USAGE);
    return;
  }
  if (opts.error) {
    console.error(`\x1b[31mError: ${opts.error}. Run "ccxray setup-statusline --help" for usage.\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  const explicitHome = opts.claudeHome;

  function discoverClaudeHomes() {
    const home = os.homedir();
    const found = [];
    const defaultHome = path.join(home, '.claude');
    if (fs.existsSync(path.join(defaultHome, 'settings.json'))) {
      let email = null;
      try { email = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).oauthAccount?.emailAddress; } catch {}
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
    let toInstall, toRemove = [];
    if (explicitHome) {
      let isDir = false;
      try { isDir = fs.statSync(explicitHome).isDirectory(); } catch {}
      if (!isDir) {
        console.error(`\x1b[31mError: --claude-home ${explicitHome} is not a directory.\x1b[0m`);
        process.exitCode = 1;
        return;
      }
      if (opts.remove) { toInstall = []; toRemove = [explicitHome]; }
      else toInstall = [explicitHome];
    } else {
      const found = discoverClaudeHomes();
      if (!found.length) {
        console.log('\x1b[33mNo Claude homes found.\x1b[0m');
        process.exit(0);
      }
      if (opts.remove) {
        toInstall = [];
        toRemove = found.filter(f => f.installed).map(f => f.path);
      } else if (found.length === 1 && !found[0].installed) {
        toInstall = [found[0].path];
      } else if (process.stdin.isTTY && !opts.dryRun) {
        console.log('Claude rate-limit tracking \x1b[90m(space=toggle, enter=confirm)\x1b[0m');
        ({ toInstall, toRemove } = await checkboxPicker(found));
      } else {
        toInstall = found.filter(f => !f.installed).map(f => f.path);
      }
    }

    if (opts.dryRun) {
      console.log('Dry run — nothing written.');
      for (const h of toInstall) console.log(statuslineSetup.describePlan(statuslineSetup.planInstall(h), path.basename(h)));
      for (const h of toRemove) console.log(statuslineSetup.describePlan(statuslineSetup.planUninstall(h), path.basename(h)));
      if (!toInstall.length && !toRemove.length) console.log('No changes.');
      return; // let piped stdout drain; nothing else is pending
    }

    let changed = 0;
    let refused = 0;
    const printBackup = result => {
      if (result.backup) console.log(`\x1b[90m  (backup: ${result.backup})\x1b[0m`);
    };
    for (const h of toInstall) {
      const label = path.basename(h);
      const result = installStatusline(h);
      if (result.status === 'already') console.log(`\x1b[32m✓ ${label}: already configured.\x1b[0m`);
      if (result.status === 'refused') {
        refused++;
        console.error(`\x1b[31m${statuslineSetup.refusalMessage(result.settingsPath, result.reason)}\x1b[0m`);
      }
      if (result.status === 'installed' || result.status === 'updated') {
        changed++;
        console.log(`\x1b[32m✓ ${label}: ${result.status}.\x1b[0m`);
        if (result.delegated) console.log(`\x1b[90m  (existing statusline delegated: ${result.delegated})\x1b[0m`);
        printBackup(result);
      }
    }
    for (const h of toRemove) {
      const label = path.basename(h);
      const result = uninstallStatusline(h);
      if (result.status === 'not_installed') console.log(`${label}: not installed.`);
      if (result.status === 'removed') {
        changed++;
        console.log(`\x1b[33m✗ ${label}: removed.\x1b[0m`);
        printBackup(result);
      }
    }
    if (!changed && !toInstall.length && !toRemove.length) console.log('No changes.');
    if (changed) console.log('\x1b[90mRestart Claude Code sessions to activate.\x1b[0m');
    process.exit(refused ? 1 : 0);
  })();
  return;
}

// ── "status" subcommand ──
if (process.argv[2] === 'status') {
  (async () => {
    // #732: shown only once shims exist or have logged a bypass, so a plain home prints nothing new.
    try {
      const shimHome = require('./paths').resolveCcxrayHome();
      const { summarizeBypasses, renderBypassLine } = require('./shim-bypass');
      const shimSummary = summarizeBypasses(shimHome);
      if (fs.existsSync(path.join(shimHome, 'shims.json')) || shimSummary.total > 0) {
        console.log(`Launcher shims: ${fs.existsSync(path.join(shimHome, 'shims.json')) ? 'installed (ccxray setup --wrap-binaries --check for details)' : 'not installed'}`);
        console.log(renderBypassLine(shimSummary));
      }
    } catch { /* status must never fail on the shim line */ }
    const result = await fetchHubReport({ statusCommand: true });
    const printDiagnostics = report => {
      const diagnostics = collectExportDiagnostics({
        env: process.env,
        report,
        reportReason: result.reason,
      });
      for (const line of renderExportDiagnostics(diagnostics)) console.log(line);
    };

    if (result.kind === 'none') {
      // #555: "No hub running" alone is misleading when the hub's default port
      // is held by something else (e.g. a standalone `ccxray --port 5577`, which
      // writes no lockfile) — a subsequent hub launch will fail on that port.
      const occ = await hub.probePortOccupant(config.PORT, 1000);
      const probed = occ.report || null;
      const probedIsCcxray = occ.kind === 'ccxray-standalone' || occ.kind === 'ccxray-hub';
      const unavailableReason = probedIsCcxray && !probed
        ? occ.reportUnavailableReason === 'authentication-required'
          ? 'loopback authentication is required (CCXRAY_LOOPBACK_REQUIRE_AUTH=1); status could not read the export report'
          : `no discoverable hub; the ccxray holding port ${config.PORT} is older than export reporting`
        : 'no discoverable hub';
      console.log('No hub running.');
      console.log(renderProcessStatus(probed, unavailableReason));
      console.log(inspectHomeStatus(probed, {
        env: process.env,
        unavailableReason: occ.reportUnavailableReason === 'authentication-required'
          ? `${unavailableReason}; cannot tell whether export is configured for this home`
          : undefined,
      }).line);
      if (occ.kind !== 'free') {
        hub.describePortOccupant(occ, config.PORT, { homeSocketReachable: await hub.probeHomeHub(occ) }).forEach(l => console.log(`Note: ${l}`));
      }
      // One machine-readable line so a consumer does not have to scrape the
      // English above. `proxy` answers whether this process can trace traffic.
      console.log(`Machine: ${JSON.stringify({
        proxy: occ.kind === 'ccxray-standalone' || occ.kind === 'ccxray-hub',
        hub: false,
        pid: occ.pid || null,
        port: config.PORT,
        occupant: occ.kind,
      })}`);
      printDiagnostics(null);
      process.exit(0);
      return;
    }

    if (result.kind === 'dead-lockfile') {
      console.log('Hub lockfile exists but process is dead. Cleaning up.');
      // A replacement hub may have published its lock since we observed this one.
      hub.deleteHubLockIfPid(result.lock.pid);
      console.log(renderProcessStatus(null, 'no discoverable hub (the lockfile process is dead)'));
      console.log(inspectHomeStatus(null, { env: process.env }).line);
      printDiagnostics(null);
      process.exit(1);
      return;
    }

    if (result.kind === 'unresponsive') {
      const lock = result.lock || {};
      const pid = lock.pid ?? 'unknown';
      const port = lock.port ?? 'unknown';
      const httpHealthTimeout = !lock.sockPath
        && result.phase === 'health'
        && result.reason === 'timeout';
      if (result.reason === 'health-failed' || httpHealthTimeout) {
        if (lock.sockPath) {
          console.log(`Hub pid ${pid} alive but socket not responding.`);
        } else {
          console.log(`Hub pid ${pid} alive but not responding on port ${port}.`);
        }
        console.log(`Check ${hub.HUB_LOG_PATH}`);
      } else {
        const detail = result.error ? result.error.message : result.reason;
        console.error(`Failed to query hub: ${detail}`);
      }
      console.log(renderProcessStatus(null,
        `hub detected (pid ${pid}, port ${port}) — exporter state unavailable`));
      console.log(inspectHomeStatus(null, { env: process.env }).line);
      printDiagnostics(null);
      process.exit(1);
      return;
    }

    try {
      const s = result.report;
      console.log(`Hub: http://localhost:${s.port} (pid ${s.pid}, uptime ${s.uptime}s, v${s.version})`);
      console.log(renderProcessStatus(
        s.exportState === undefined ? null : s,
        `hub detected (pid ${s.pid}, port ${s.port}) — exporter state unavailable`,
      ));
      console.log(inspectHomeStatus(s, { env: process.env }).line);
      console.log(`Machine: ${JSON.stringify({
        proxy: true, hub: true, pid: s.pid, port: s.port, occupant: 'ccxray-hub',
      })}`);
      const clients = Array.isArray(s.clients) ? s.clients : [];
      if (clients.length === 0) {
        console.log('No connected clients.');
      } else {
        console.log(`Connected clients (${clients.length}):`);
        clients.forEach((c, i) => {
          console.log(`  [${i + 1}] pid ${c.pid} — ${c.cwd} (since ${c.connectedAt})`);
        });
      }
      printDiagnostics(s);
      process.exit(0);
    } catch (err) {
      console.error(`Failed to query hub: ${err.message}`);
      const lock = result.lock || {};
      console.log(renderProcessStatus(null,
        `hub detected (pid ${lock.pid ?? 'unknown'}, port ${lock.port ?? 'unknown'}) — exporter state unavailable`));
      console.log(inspectHomeStatus(null, { env: process.env }).line);
      printDiagnostics(null);
      process.exit(1);
    }
  })();
  return; // prevent falling through to startup
}

// Read the setup preference once per process. Its absence preserves the current
// auto-open behaviour; `off` is an additional suppression at both startup gates.
const autoOpenBrowserOff = (() => {
  try {
    const preference = require('fs').readFileSync(
      require('path').join(resolveCcxrayHome(process.env), 'auto-open-browser'),
      'utf8',
    ).trim();
    return preference === 'off';
  } catch {
    return false;
  }
})();

// ── Client mode: connect to existing hub ──
function reportHubRegistrationStatus(reply, lifecycle) {
  const rendered = renderHubClientStatus(
    reply?.identity || null,
    lifecycle,
    reply && {
      exportState: reply.exportState,
      exportReason: reply.exportReason,
      configWarnings: reply.configWarnings,
      credential: reply.credential,
      exportConfigHash: reply.exportConfigHash,
    },
  );
  if (rendered) _origLog(rendered);
  if (typeof reply?.exportConfigHash === 'string'
    && reply.exportConfigHash !== exportSync.exportConfigHash(process.env)) {
    const pid = reply.identity?.pid ?? 'unknown';
    _origLog(`\x1b[33m[ccxray] export settings differ from the running hub (pid ${pid}) — close every ccxray session and start again\x1b[0m`);
  }
}

async function startClientMode(lock, decision) {
  const compat = hub.checkVersionCompat(lock.version);
  if (compat.fatal) {
    decision.decide('original', 'version-mismatch', compat.message);
    return;
  }
  if (decision.isDecided()) return;
  if (compat.warning) {
    _origLog(`\x1b[33m${compat.warning}\x1b[0m`);
  }

  {
    const upstreamSuffix = config.ANTHROPIC_BASE_URL_SOURCE === 'ANTHROPIC_BASE_URL'
      ? `  →  ${config.ANTHROPIC_PROTOCOL}://${config.ANTHROPIC_HOST}:${config.ANTHROPIC_PORT} (from ANTHROPIC_BASE_URL)`
      : '';
    _origLog(`\x1b[90m${DISPLAY_NAME} → http://localhost:${lock.port} (hub)${upstreamSuffix}\x1b[0m`);
  }

  const clientIdentity = {
    agentId: process.env.CCXRAY_AGENT_ID || '',
    userEmail: process.env.CCXRAY_USER_EMAIL || '',
    team: process.env.CCXRAY_TEAM || '',
    agentType: process.env.CCXRAY_AGENT_TYPE || agentCommand || '',
  };

  // INVARIANT: armed before registerClient so no signal can land on a
  // registered-but-unarmed process — see server/client-shutdown.js for why
  // reordering these lines silently reintroduces the phantom-client window.
  // `registration` is handed to the shutdown path so it waits for an in-flight
  // register before unregistering; the two are unordered socket round trips.
  let agentChild = null;
  let registration = null;
  let currentLock = lock;
  const clientShutdown = armClientShutdown(() => currentLock, () => agentChild, {
    getRegistration: () => registration,
    onShutdownStart: () => decision.abortForShutdown(),
  });
  decision.setClientShutdown(clientShutdown);

  try {
    if (decision.isDecided()) return;
    registration = hub.registerClient(lock, process.pid, process.cwd(), clientIdentity);
    decision.setRegistration(registration, lock);
    const result = await raceWithLaunchDecision(registration, decision);
    if (result.kind === 'decision') return;
    if (result.kind === 'error') {
      decision.decide('original', 'hub-registration-failed', `Failed to register with hub: ${result.error.message}`);
      return;
    }
    const reg = result.value;
    if (decision.isDecided()) return;
    if (!reg) {
      decision.decide('original', 'hub-registration-rejected', 'Hub rejected client registration.');
      return;
    }

    // Registration is the hub-client attach decision point. Everything after
    // this—including browser bootstrap and agent startup—belongs to the normal
    // proxied launch lifecycle.
    if (!decision.decide('proxied')) return;

    reportHubRegistrationStatus(reg, 'attached');

    // Auto-open browser for the first client connecting to this hub
    if (reg.firstClient) {
      const noOpen = noBrowser
        || autoOpenBrowserOff
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
    if (decision.getOutcome() === 'proxied') throw err;
    decision.decide('original', 'hub-registration-failed', `Failed to register with hub: ${err.message}`);
    return;
  }

  if (decision.getOutcome() !== 'proxied') return;

  // Monitor hub health and auto-recover
  hub.startHubMonitor(lock.pid, lock.port, async (newLock) => {
    // Re-register with new hub (newLock has sockPath from lockfile).
    // Both are published to the shutdown path: unregistering from the DEAD hub
    // releases nothing, and a shutdown racing this re-registration would let the
    // new hub apply the register after the unregister — a phantom on the new
    // hub. See server/client-shutdown.js.
    // A shutdown that already captured the previous registration will never see
    // a promise created after it, so re-registering now would hand the new hub a
    // pid that is on its way out.
    if (clientShutdown.isShuttingDown()) return true;
    currentLock = newLock;
    try {
      registration = hub.registerClient(newLock, process.pid, process.cwd(), clientIdentity);
      const reg = await registration;
      if (!reg) return false; // the monitor retries and reports the failure once
      // This is best-effort notification: recovery happens while the agent's TUI
      // owns the terminal, so the banner may not be read.
      reportHubRegistrationStatus(reg, 'recovered');
      return true;
    } catch {
      return false;
    }
  }, () => reportHubRegistrationStatus(null, 'recovery-failed'));

  // A signal that landed in the register→spawn window already began the
  // unregister-and-exit path — spawning now orphans the agent. spawnAgent
  // re-checks this immediately before spawn() as well, because the interactive
  // path defers the spawn behind a prompt. See server/client-shutdown.js.
  if (clientShutdown.isShuttingDown()) return;

  // Spawn agent pointing to hub
  process.env.CCXRAY_HUB_CLIENT_PID = String(process.pid);
  // The agent's exit routes through the SAME shutdown path as a signal, so a
  // signal arriving while this unregister is in flight cannot replace the
  // agent's exit code with its own.
  spawnAgent(agentCommand, lock.port, agentArgs, (code) => {
    clientShutdown.shutdown(code);
  }, {
    onChild: (child) => { agentChild = child; },
    isShuttingDown: clientShutdown.isShuttingDown,
    signalsOwnedByCaller: true,
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
  let startupOutcome;
  if (restoreOk) {
    startupOutcome = await exportSync.startupFlushAndPrune({ pruneLogs, log: _origLog });
    warmUpCosts();
  }
  startExportSync({ startupOutcome });
  if (process.env.NODE_TEST_CONTEXT) process.stderr.write('[ccxray] startup tasks complete\n');

  // #438/#486: hint when legacy entries lack per-turn tool evidence.
  // turnToolResults is always set on new entries ([] for no-tools, [{...}] for
  // tools); undefined means truly legacy (pre-#486). turnToolFail alone cannot
  // distinguish legacy from no-tools after #486's tri-state change.
  if (restoreOk) {
    let legacyCount = 0;
    for (const e of store.entries) {
      if (e.turnToolResults === undefined && e.provider !== 'openai' && !e.imported) { legacyCount++; if (legacyCount >= 10) break; }
    }
    if (legacyCount >= 10) {
      process.stderr.write('\x1b[33m   ⚠ legacy entries lack per-turn tool evidence — run `ccxray rebuild-index --apply` to backfill\x1b[0m\n');
    }
  }

  // Automatic transcript scans require explicit opt-in, including on upgrade.
  if (restoreOk && process.env.CCXRAY_IMPORT_DISABLE === '0') {
    const { scanAndImport } = require('./importer');
    scanAndImport().catch(err => console.error('[importer] Scan failed:', err.message));
  }
}

async function startServer({ onListen } = {}) {
  // Snapshot the running commit before listen() so health never resolves it
  // and a later checkout cannot change it (#728).
  require('./git-sha').captureGitSha();
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
    // Grok/xAI upstream is independent of OPENAI_BASE_URL so hub multi-agent
    // routing can keep Codex on api.openai.com. Only guard user-configured
    // XAI_BASE_URL/GROK_BASE_URL — default cli-chat-proxy.grok.com can never
    // self-loop (review fix from experiment/grok-wire-capture).
    const xai = config.UPSTREAMS.xai;
    if (xai && xai.source !== 'xai-default') {
      candidates.push({ key: 'xai', upstream: xai, envVar: xai.source || 'XAI_BASE_URL' });
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
            // #555: identify the occupant before advising — the old unconditional
            // `kill $(lsof …)` hint would have killed a deliberate listener.
            const occ = await hub.probePortOccupant(config.PORT);
            const advice = hub.describePortOccupant(occ, config.PORT, { homeSocketReachable: await hub.probeHomeHub(occ) });
            if (advice.length) advice.forEach(l => console.error(`Error: ${l}`));
            else console.error(`Error: port ${config.PORT} still occupied after ${HUB_BIND_RETRIES}s but nothing answered a probe — it may have been released; retry.`);
          }
          throw err;
        }
        await new Promise(r => setTimeout(r, HUB_BIND_DELAY_MS));
      }
    }
  } else {
    actualPort = await hub.tryListen(server, config.PORT, maxAttempts);
  }
  if (onListen) onListen(actualPort);
  hub.setIdentityPort(actualPort);
  {
    // Loopback is the default bind; say so when PROXY_HOST opted in to more.
    const listen = require('./listen');
    const host = listen.resolveListenHosts().primary;
    if (!listen.isLoopbackHost(host)) {
      const bound = listen.listenAddresses(server).map(listen.formatAddress).join(', ');
      console.error(`${DISPLAY_NAME} listening on ${bound} (PROXY_HOST=${host}); non-loopback clients need a ccxray credential`);
      if (listen.isSingleInterfaceHost(host)) {
        console.error(`${DISPLAY_NAME}: PROXY_HOST=${host} is not reachable as localhost, so local agent launches and hub checks cannot use it; set PROXY_HOST=0.0.0.0 to keep them working`);
      }
    }
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
    // A detached hub can become ready just as its client gives up attaching.
    // Start the same idle timer used after the last unregister so an empty hub
    // does not live forever waiting for a client that will never arrive.
    hub.startIdleTimer();
    hub.startDeadClientCheck();
    hub.startLockSelfHeal(actualPort, hub.SOCK_PATH);
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
    _origLog(`\x1b[90m   ${hudStatusText(getStatusLineEnabled())}\x1b[0m`);
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
    const xai = config.UPSTREAMS.xai;
    if (xai) {
      const xaiUrl = `${xai.protocol}://${xai.host}:${xai.port}${xai.basePath || ''}`;
      const xaiNote = xai.source && xai.source !== 'xai-default' ? ` (from ${xai.source})` : '';
      console.log(`   xAI Upstream → ${xaiUrl}${xaiNote}`);
    }
    console.log(`   Logs → ${config.storage.location || config.LOGS_DIR}`);
    console.log(`   ${hudStatusText(getStatusLineEnabled())}`);
    console.log();
    console.log(`   Usage: ANTHROPIC_BASE_URL=http://localhost:${actualPort} claude`);
    console.log(`          ccxray codex | ccxray grok\x1b[0m`);
    console.log('\x1b[0m');
  }

  // Auto-open dashboard in browser (not in hub mode)
  const noOpen = hubMode
    || noBrowser
    || autoOpenBrowserOff
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
process.removeListener('uncaughtException', onBootstrapFailure);
const launchDecision = agentMode ? createLaunchDecision({
  command: agentCommand,
  args: agentArgs,
  attachTimeoutMs: () => attachTimeoutMs(),
  logFailOpen: record => plainLaunch.appendFailOpen(resolveCcxrayHome, record),
  spawnFallback: (launch, onExit) => {
    const provider = providers.getAgentProvider(agentCommand);
    spawnAgent(agentCommand, null, agentArgs, onExit, {
      launch: { ...launch, label: provider?.label || agentCommand, installHint: provider?.installHint || '' },
      skipStatuslinePrompt: true,
    });
  },
}) : null;

(async () => {
  // Background Claude sessions can outlive their launcher process. Keep the
  // session usable, but run it directly so the hub does not lose its client.
  if (agentCommand === 'claude' && hasClaudeBackgroundFlag(agentArgs)) {
    launchDecision.decide('original', 'bg-bypass');
    return;
  }

  // Hub mode or explicit port or standalone: start server directly
  if (hubMode || explicitPort || !agentMode) {
    try {
      await startServer(agentMode && !hubMode
        ? { onListen: () => launchDecision.decide('proxied') }
        : undefined);
    } catch (err) {
      if (agentMode && !hubMode && !launchDecision.isDecided()) {
        const message = err.code === 'EADDRINUSE'
          ? `Error: port ${config.PORT} is already in use`
          : `Startup failed: ${err.message}`;
        launchDecision.decide('original', 'server-start-failed', message);
        return;
      }
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
    try {
      await startServer({ onListen: () => launchDecision.decide('proxied') });
    } catch (err) {
      if (!launchDecision.isDecided()) {
        launchDecision.decide('original', 'server-start-failed', `Startup failed: ${err.message}`);
        return;
      }
      console.error(`\x1b[31mStartup failed: ${err.message}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // Agent mode without explicit port: try hub discovery
  launchDecision.startBudget();
  let discovery;
  try {
    discovery = await raceWithLaunchDecision(hub.discoverHub(config.PORT), launchDecision);
  } catch (err) {
    launchDecision.decide('original', 'hub-discovery-failed', err.message);
    return;
  }
  if (discovery.kind === 'decision') return;
  if (discovery.kind === 'error') {
    launchDecision.decide('original', 'hub-discovery-failed', discovery.error.message);
    return;
  }
  const existingHub = discovery.value;
  if (existingHub) {
    try {
      await startClientMode(existingHub, launchDecision);
    } catch (err) {
      if (!launchDecision.isDecided()) launchDecision.decide('original', 'hub-attach-failed', err.message);
      else if (launchDecision.getOutcome() === 'proxied') {
        console.error(`\x1b[31m${err.message}\x1b[0m`);
        process.exit(1);
      }
    }
    return;
  }

  // No hub found: acquire fork lock to prevent duplicate hub forks. A spawn
  // failure is asynchronous, so race it against readiness instead of relying
  // on the detached child to make the failure observable by itself.
  let acquired = false;
  let forkLockReleased = false;
  const releaseForkLock = () => {
    if (!acquired || forkLockReleased) return;
    forkLockReleased = true;
    hub.releaseForkLock();
  };
  launchDecision.setForkLockRelease(releaseForkLock);
  try {
    acquired = hub.tryAcquireForkLock();
    if (launchDecision.isDecided()) return;
    let readiness;
    if (acquired) {
      let rejectLaunch;
      const launchFailure = new Promise((_, reject) => { rejectLaunch = reject; });
      hub.forkHub(config.PORT, { onError: rejectLaunch });
      readiness = Promise.race([
        hub.waitForHubReady().then(lock => ({ kind: 'ready', lock }), error => ({ kind: 'readiness-error', error })),
        launchFailure.then(() => ({ kind: 'ready' }), error => ({ kind: 'fork-error', error })),
      ]);
    } else {
      readiness = hub.waitForHubReady().then(
        lock => ({ kind: 'ready', lock }),
        error => ({ kind: 'readiness-error', error }),
      );
    }
    const result = await raceWithLaunchDecision(readiness, launchDecision);
    if (result.kind === 'decision') return;
    if (result.kind === 'error') {
      launchDecision.decide('original', 'hub-readiness-failed', result.error.message);
      return;
    }
    if (result.value.kind !== 'ready') {
      const reason = result.value.kind === 'fork-error' ? 'hub-fork-failed' : 'hub-readiness-failed';
      launchDecision.decide('original', reason, result.value.error.message);
      return;
    }
    const lock = result.value.lock || hub.readHubLock();
    releaseForkLock();
    if (!lock) {
      launchDecision.decide('original', 'hub-readiness-failed');
      return;
    }
    await startClientMode(lock, launchDecision);
  } catch (err) {
    releaseForkLock();
    if (!launchDecision.isDecided()) launchDecision.decide('original', 'hub-attach-failed', err.message);
    else if (launchDecision.getOutcome() === 'proxied') {
      console.error(`\x1b[31m${err.message}\x1b[0m`);
      process.exit(1);
    }
  } finally {
    releaseForkLock();
  }
})();
