'use strict';

// Launcher-shim probe (#732). Copied to <CCXRAY_HOME>/shim-probe.js by
// `ccxray setup --wrap-binaries` and run by the claude/codex shims on EVERY
// launch, so it must stay dependency-free (built-ins only), start fast, and
// never throw past its own try/catch: any failure here must degrade to
// "launch the real binary directly", never to a failed launch.
//
// Protocol (stdout, one line): the shim `exec`s the real binary itself, so this
// process only DECIDES.
//   direct                    run the real binary unchanged (a bypass line was logged)
//   passthrough               already routed through ccxray; run unchanged, no log
//   claude <baseUrl> <0|1>    set ANTHROPIC_BASE_URL (1 = print mode)
//   codex <baseUrl>           prepend -c openai_base_url="<baseUrl>/v1"
//   (<baseUrl> carries /_ccxray/client/<pid> when the hub accepted a client
//   registration for the launching pid: the shim `exec`s, so that pid IS the tool)
//   refuse <message>          strict mode: refuse the launch
// The bypass log never carries args, prompts, env values or secrets.

const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 5577;
const DEFAULT_TIMEOUT_MS = 300;
const LOG_ROTATE_BYTES = 1024 * 1024;
// Subcommands that never make a model request: no point routing or logging them.
const CODEX_NO_MODEL = new Set(['login', 'logout', 'mcp', 'completion', 'help', 'features']);
const CLAUDE_NO_MODEL = new Set(['--version', '-v', '--help', '-h', 'mcp', 'doctor', 'agents', 'plugin', 'auth', 'attach', 'respawn', 'update', 'install']);

function timeoutMs(env) {
  const n = Number(env.CCXRAY_SHIM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 50 && n <= 5000 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function ccxrayHome(env) {
  return env.CCXRAY_SHIM_HOME || env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
}

function discoverPort(env, home) {
  const explicit = Number(env.CCXRAY_SHIM_PORT);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit;
  try {
    const port = Number(JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8')).port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch { /* no hub lock: fall through to the default port */ }
  const configured = Number(env.PROXY_PORT);
  return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : DEFAULT_PORT;
}

// Resolves { ok:true } for a ccxray listener, else { ok:false, reason }.
// `reason` is a fixed vocabulary so the log carries no remote-controlled text.
function probeHealth(port, ms) {
  return new Promise(resolve => {
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), ms);
    const req = http.get({ host: '127.0.0.1', port, path: '/_api/health', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 65536) body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200 || !parsed || parsed.app !== 'ccxray' || parsed.ok !== true) return done({ ok: false, reason: 'not-ccxray' });
          // Public health says the listener, not the shim's environment, gates
          // loopback: an unauthenticated probe is told so, and model traffic
          // from this shim (which holds no proxy credential) would 401.
          done(parsed.exportReportUnavailableReason === 'authentication-required'
            ? { ok: false, reason: 'auth-required', ccxray: true } : { ok: true });
        } catch { done({ ok: false, reason: 'not-ccxray' }); }
      });
      res.on('error', () => done({ ok: false, reason: 'error' }));
    });
    req.on('error', err => done({ ok: false, reason: err && err.code === 'ECONNREFUSED' ? 'refused' : 'error' }));
  });
}

function loopbackPort(value) {
  try {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return { port, ccxrayPath: url.pathname.startsWith('/_ccxray/') };
  } catch { return null; }
}

// Codex options that take a value (kept aligned with server/providers.js
// CODEX_ROOT_OPTION_ARITY; an unknown option is treated as a flag).
const CODEX_VALUE_OPTS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval',
  '-C', '--cd', '--add-dir', '--color', '-o', '--output-last-message', '--output-schema']);
const CODEX_GREEDY_OPTS = new Set(['-i', '--image']); // also swallow following non-option tokens

// Parses real option syntax: the first positional (subcommand or prompt) and the
// `-c/--config` overrides. Positional prompt text is never read as configuration.
function parseCodexArgs(args) {
  const overrides = [];
  let positional;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { if (positional === undefined && i + 1 < args.length) positional = null; break; }
    if (!arg.startsWith('-') || arg === '-') { if (positional === undefined) positional = arg; continue; }
    if (arg === '-c' || arg === '--config') { if (i + 1 < args.length) overrides.push(args[++i]); continue; }
    if (arg.startsWith('--config=')) { overrides.push(arg.slice('--config='.length)); continue; }
    if (!arg.startsWith('--') && arg.startsWith('-c') && arg.length > 2) { overrides.push(arg.slice(2)); continue; }
    if (CODEX_GREEDY_OPTS.has(arg)) { while (i + 1 < args.length && !args[i + 1].startsWith('-')) i++; continue; }
    if (CODEX_VALUE_OPTS.has(arg)) i++;
  }
  return { subcommand: positional ?? undefined, overrides };
}

function codexAlreadyRouted(overrides) {
  return overrides.some(o => /^\s*openai_base_url\s*=/.test(o) || /^\s*model_provider\s*=\s*["']?ccxray/.test(o));
}

function appendBypass(home, record) {
  try {
    const file = path.join(home, 'shim-bypass.log');
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* absent: created below */ }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch { /* logging must never fail the launch */ }
}

function safeCwd() {
  try { return process.cwd(); } catch { return ''; }
}

// One failure decision for every path (no listener, timeout, helper exception):
// strict mode refuses, otherwise the launch runs unrecorded. `reason` is a fixed
// vocabulary so the log carries no remote-controlled text.
function failureLine(tool, env, reason, cwd, now = new Date()) {
  const strict = env.CCXRAY_SHIM_STRICT === '1';
  const action = strict ? 'refused' : 'bypass';
  appendBypass(ccxrayHome(env), { t: now.toISOString(), tool, cwd, reason, action });
  return strict
    ? `refuse proxy not usable (${reason}); refusing to launch ${tool} because CCXRAY_SHIM_STRICT=1. Start ccxray, or set CCXRAY_SHIM_STRICT=0 / CCXRAY_SHIM_DISABLE=1 to run unrecorded.`
    : 'direct';
}

// Registers the launching pid (the shim `exec`s, so it becomes the tool) as a hub
// client over the hub's unix socket. That gives the requests an attributable
// route (/_ccxray/client/<pid>, never another project's cwd) and keeps the hub
// from idle-shutting-down under a live shim session; the hub's dead-client sweep
// unregisters it when the tool exits. Best effort, bounded; any failure leaves
// the plain URL (a standalone proxy has no client registry).
function registerWithHub(home, port, env, cwd, ms) {
  return new Promise(resolve => {
    const pid = Number(env.CCXRAY_SHIM_PID);
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4194304 || !cwd || cwd.length > 4096) return resolve(false);
    let sockPath;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8'));
      if (Number(lock.port) !== port || typeof lock.sockPath !== 'string') return resolve(false);
      sockPath = lock.sockPath;
    } catch { return resolve(false); }
    let settled = false;
    let sock;
    const done = ok => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } resolve(ok); };
    const timer = setTimeout(() => done(false), ms);
    try {
      sock = net.connect(sockPath);
      let buf = '';
      sock.on('connect', () => sock.write(JSON.stringify({ cmd: 'register', pid, cwd, token: crypto.randomBytes(8).toString('hex') }) + '\n'));
      sock.on('data', chunk => {
        buf += chunk;
        if (buf.length > 1048576) return done(false);
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try { done(JSON.parse(buf.slice(0, nl))?.ok === true); } catch { done(false); }
      });
      sock.on('error', () => done(false));
      sock.on('close', () => done(false));
    } catch { done(false); }
  });
}

async function decide(tool, args, env, now = new Date(), cwd = safeCwd()) {
  if (tool !== 'claude' && tool !== 'codex') return 'direct';
  const home = ccxrayHome(env);
  const ms = timeoutMs(env);
  const fail = reason => failureLine(tool, env, reason, cwd, now);

  const codex = tool === 'codex' ? parseCodexArgs(args) : null;
  if (tool === 'claude' ? CLAUDE_NO_MODEL.has(args[0]) : CODEX_NO_MODEL.has(codex.subcommand)) return 'passthrough';

  // Already routed: ccxray's own launcher, or a base URL that answers as ccxray.
  if (codex && codexAlreadyRouted(codex.overrides)) return 'passthrough';
  const existing = loopbackPort(tool === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL);
  const hasForeignUrl = Boolean(tool === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL);
  if (existing) {
    if (existing.ccxrayPath) return 'passthrough';
    const h = await probeHealth(existing.port, ms);
    if (h.ok || h.ccxray) return 'passthrough';
  }

  // A user-chosen non-ccxray base URL (a gateway): overriding it would break their setup.
  if (hasForeignUrl) return fail('custom-base-url');

  const port = discoverPort(env, home);
  const health = await probeHealth(port, ms);
  if (!health.ok) return fail(health.reason);
  let base = `http://127.0.0.1:${port}`;
  if (await registerWithHub(home, port, env, cwd, ms)) base += `/_ccxray/client/${Number(env.CCXRAY_SHIM_PID)}`;
  if (tool === 'claude') {
    const printMode = args.some((arg, i) => (arg === '-p' || arg === '--print') && !args.slice(0, i).includes('--'));
    return `claude ${base} ${printMode ? 1 : 0}`;
  }
  return `codex ${base}`;
}

// The whole decision under an inner guard: an exception or a stuck await takes
// the same strict-aware failure path. (The shell enforces the real deadline from
// outside the process; this only covers the cases Node can still observe.)
function runProbe(argv, env, { decideFn = decide, cwd = safeCwd(), hardMs } = {}) {
  const [tool, ...args] = argv;
  return new Promise(resolve => {
    const hard = setTimeout(() => resolve(failureLine(tool, env, 'timeout', cwd)), hardMs ?? timeoutMs(env) * 2 + 400);
    new Promise(ok => ok(decideFn(tool, args, env, new Date(), cwd)))
      .catch(() => failureLine(tool, env, 'helper-error', cwd))
      .then(line => { clearTimeout(hard); resolve(line); });
  });
}

if (require.main === module) {
  runProbe(process.argv.slice(2), process.env).then(line => {
    process.stdout.write(line + '\n', () => process.exit(0));
  });
}

module.exports = { decide, runProbe, safeCwd, probeHealth, discoverPort, timeoutMs, ccxrayHome, appendBypass, parseCodexArgs, codexAlreadyRouted, registerWithHub, failureLine };
