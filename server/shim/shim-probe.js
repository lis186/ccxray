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
//   refuse <message>          strict mode: refuse the launch
// The bypass log never carries args, prompts, env values or secrets.

const fs = require('fs');
const http = require('http');
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
          done(res.statusCode === 200 && parsed && parsed.app === 'ccxray' && parsed.ok === true
            ? { ok: true } : { ok: false, reason: 'not-ccxray' });
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

function firstNonOption(args) {
  return args.find(arg => !arg.startsWith('-'));
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

async function decide(tool, args, env, now = new Date(), cwd = process.cwd()) {
  if (tool !== 'claude' && tool !== 'codex') return 'direct';
  const home = ccxrayHome(env);
  const strict = env.CCXRAY_SHIM_STRICT === '1';
  const ms = timeoutMs(env);

  if (tool === 'claude' ? CLAUDE_NO_MODEL.has(args[0]) : CODEX_NO_MODEL.has(firstNonOption(args))) return 'passthrough';

  // Already routed: ccxray's own launcher, or a base URL that answers as ccxray.
  const routedByArgs = tool === 'codex' && args.some(arg => /openai_base_url|model_provider\s*=\s*"?ccxray/.test(arg));
  if (routedByArgs) return 'passthrough';
  const existing = loopbackPort(tool === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL);
  const hasForeignUrl = Boolean(tool === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL);
  if (existing) {
    if (existing.ccxrayPath) return 'passthrough';
    if ((await probeHealth(existing.port, ms)).ok) return 'passthrough';
  }

  const fail = (reason, action = strict ? 'refused' : 'bypass') => {
    appendBypass(home, { t: now.toISOString(), tool, cwd, reason, action });
    return action === 'refused'
      ? `refuse proxy not reachable (${reason}); refusing to launch ${tool} because CCXRAY_SHIM_STRICT=1. Start ccxray, or set CCXRAY_SHIM_STRICT=0 / CCXRAY_SHIM_DISABLE=1 to run unrecorded.`
      : 'direct';
  };

  // A user-chosen non-ccxray base URL (a gateway): overriding it would break their setup.
  if (hasForeignUrl) return fail('custom-base-url');
  if (env.CCXRAY_LOOPBACK_REQUIRE_AUTH === '1') return fail('auth-required');

  const port = discoverPort(env, home);
  const health = await probeHealth(port, ms);
  if (!health.ok) return fail(health.reason);
  const base = `http://127.0.0.1:${port}`;
  if (tool === 'claude') {
    const printMode = args.some((arg, i) => (arg === '-p' || arg === '--print') && !args.slice(0, i).includes('--'));
    return `claude ${base} ${printMode ? 1 : 0}`;
  }
  return `codex ${base}`;
}

if (require.main === module) {
  const hard = setTimeout(() => { process.stdout.write('direct\n'); process.exit(0); }, timeoutMs(process.env) + 400);
  hard.unref();
  const [tool, ...args] = process.argv.slice(2);
  decide(tool, args, process.env)
    .catch(() => 'direct')
    .then(line => { process.stdout.write(line + '\n'); });
}

module.exports = { decide, probeHealth, discoverPort, timeoutMs, ccxrayHome, appendBypass };
