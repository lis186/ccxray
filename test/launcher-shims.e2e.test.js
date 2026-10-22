'use strict';

// #732: the installed claude/codex shims, exercised as real processes. Every
// path lives under a temp HOME; the "real" binaries are fakes and the proxy is a
// loopback fake on an ephemeral port (or a closed one). Nothing here touches the
// real shell profiles, PATH configuration, ~/.claude, ~/.codex or ~/.ccxray.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { runWrapBinaries } = require('../server/launcher-shims');

const SYSTEM_PATH = '/usr/bin:/bin';
let root;
let shimDir;
let realBin;
let ccxrayHome;
let proxy;
let proxyPort;
let proxyDelayMs = 0;
let proxyApp = 'ccxray';

function quiet() { return { log() {}, error() {} }; }

function makeFake(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

const FAKE = [
  'echo "ARGS:$*"',
  'echo "BASE:$ANTHROPIC_BASE_URL"',
  'echo "HDR:$ANTHROPIC_CUSTOM_HEADERS"',
  'echo "WHO:$(basename "$0")"',
  '[ -n "$FAKE_HANG" ] && exec sleep 30',
  '[ -n "$FAKE_STDIN" ] && echo "STDIN:$(cat)"',
  'echo "ERR" >&2',
  'exit "${FAKE_EXIT:-0}"',
].join('\n');

async function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function run(tool, args, { env = {}, stdin, pathDirs, timeout = 10000, cwd = root, exe, umask, onStdout } = {}) {
  const dirs = pathDirs || [shimDir, realBin];
  const started = Date.now();
  return new Promise(resolve => {
    // Plain spawn by bare name with only the PATH below: no shell, no profile.
    const target = exe || tool;
    const [file, argv] = umask === undefined ? [target, args]
      : ['/bin/sh', ['-c', `umask ${umask}; exec "$@"`, 'sh', target, ...args]];
    const child = spawn(file, argv, {
      cwd,
      env: { PATH: [...dirs, SYSTEM_PATH].join(':'), HOME: root, CCXRAY_SHIM_PORT: String(proxyPort), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; onStdout?.(stdout, child); });
    child.stderr.on('data', d => { stderr += d; });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started, child }); });
  });
}

const bypassLines = () => {
  try { return fs.readFileSync(path.join(ccxrayHome, 'shim-bypass.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-e2e-')));
  ccxrayHome = path.join(root, '.ccxray');
  realBin = path.join(root, 'real-bin');
  makeFake(path.join(realBin, 'claude'), FAKE);
  makeFake(path.join(realBin, 'codex'), FAKE);
  const code = await runWrapBinaries({ yes: true, shell: 'bash' }, {
    env: { HOME: root, CCXRAY_HOME: ccxrayHome, SHELL: '/bin/bash', PATH: SYSTEM_PATH },
    homedir: () => root, platform: 'linux', logger: quiet(),
  });
  assert.equal(code, 0);
  shimDir = path.join(ccxrayHome, 'shims');
  proxy = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: proxyApp }));
    }, proxyDelayMs);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = proxy.address().port;
});

after(async () => {
  await new Promise(resolve => { proxy.closeAllConnections?.(); proxy.close(resolve); });
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  proxyDelayMs = 0;
  proxyApp = 'ccxray';
  fs.rmSync(path.join(ccxrayHome, 'shim-bypass.log'), { force: true });
});

describe('proxy healthy (criterion 1)', () => {
  it('routes claude -p through ccxray via a plain spawn, with print mode marked', async () => {
    const r = await run('claude', ['-p', 'hello world'], { env: { FAKE_EXIT: '0' } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
    assert.match(r.stdout, /HDR:X-Ccxray-Print-Mode: true/);
    assert.match(r.stdout, /ARGS:-p hello world/);
    assert.deepEqual(bypassLines(), []);
  });

  it('routes codex exec through ccxray with openai_base_url, args preserved after it', async () => {
    const r = await run('codex', ['exec', '--json', 'do it']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`ARGS:-c openai_base_url="http://127.0.0.1:${proxyPort}/v1" exec --json do it`));
    assert.deepEqual(bypassLines(), []);
  });

  it('does not double-wrap a launch already routed through ccxray', async () => {
    const claude = await run('claude', ['hi'], { env: { ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}/_ccxray/client/42` } });
    assert.match(claude.stdout, new RegExp(`BASE:http://localhost:${proxyPort}/_ccxray/client/42\\n`));
    const other = await run('claude', ['hi'], { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}` } });
    assert.match(other.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
    const codex = await run('codex', ['-c', 'openai_base_url="http://localhost:9/v1"', 'exec', 'x']);
    assert.equal((codex.stdout.match(/openai_base_url/g) || []).length, 1);
    assert.deepEqual(bypassLines(), []);
  });

  it('leaves non-model subcommands alone', async () => {
    const r = await run('claude', ['--version']);
    assert.match(r.stdout, /BASE:\n/);
    const c = await run('codex', ['login']);
    assert.match(c.stdout, /ARGS:login\n/);
    assert.deepEqual(bypassLines(), []);
  });

  it('preserves stdin, stdout, stderr and the exit code', async () => {
    const r = await run('claude', ['-p', 'x'], { env: { FAKE_STDIN: '1', FAKE_EXIT: '7' }, stdin: 'piped input' });
    assert.equal(r.code, 7);
    assert.match(r.stdout, /STDIN:piped input/);
    assert.match(r.stderr, /ERR/);
  });

  it('is exec-based: a signal reaches the real binary', async () => {
    // The fake prints WHO: just before it execs into a long sleep: that line is the readiness barrier.
    const r = await run('claude', ['x'], { env: { FAKE_HANG: '1' }, onStdout: (out, child) => { if (/WHO:claude\n/.test(out)) child.kill('SIGTERM'); } });
    assert.equal(r.signal, 'SIGTERM');
  });
});

describe('proxy down (criterion 2)', () => {
  let closedPort;
  before(async () => { closedPort = await freePort(); });

  it('runs claude directly, unchanged, with the same exit code and one bypass line', async () => {
    const r = await run('claude', ['-p', 'secret prompt text'], { env: { CCXRAY_SHIM_PORT: String(closedPort), FAKE_EXIT: '3' } });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /BASE:\n/);
    assert.match(r.stdout, /ARGS:-p secret prompt text/);
    const lines = bypassLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tool, 'claude');
    assert.equal(lines[0].reason, 'refused');
    assert.equal(lines[0].cwd, root);
    assert.ok(Date.parse(lines[0].t));
    assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'cwd', 'reason', 't', 'tool']);
    assert.ok(!JSON.stringify(lines[0]).includes('secret prompt text'));
  });

  it('runs codex directly with no injected -c and one bypass line per launch', async () => {
    const env = { CCXRAY_SHIM_PORT: String(closedPort) };
    const a = await run('codex', ['exec', 'a'], { env });
    const b = await run('codex', ['exec', 'b'], { env: { ...env, FAKE_EXIT: '9' } });
    assert.match(a.stdout, /ARGS:exec a\n/);
    assert.equal(b.code, 9);
    assert.equal(bypassLines().length, 2);
  });

  it('is fast when the port is closed', async () => {
    const r = await run('claude', ['x'], { env: { CCXRAY_SHIM_PORT: String(closedPort) } });
    assert.ok(r.ms < 1500, `took ${r.ms}ms`);
  });

  it('does not record a custom (non-ccxray) gateway as routed, and leaves it untouched', async () => {
    const r = await run('claude', ['x'], { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' } });
    assert.match(r.stdout, /BASE:https:\/\/gateway.example.test\n/);
    assert.equal(bypassLines()[0].reason, 'custom-base-url');
  });

  it('treats a non-ccxray listener on the port as down', async () => {
    proxyApp = 'something-else';
    const r = await run('claude', ['x']);
    assert.match(r.stdout, /BASE:\n/);
    assert.equal(bypassLines()[0].reason, 'not-ccxray');
  });

  it('CCXRAY_SHIM_DISABLE skips the probe and the log', async () => {
    const r = await run('claude', ['x'], { env: { CCXRAY_SHIM_DISABLE: '1' } });
    assert.match(r.stdout, /BASE:\n/);
    assert.deepEqual(bypassLines(), []);
  });

  it('falls open (and logs) when the probe helper is unavailable', async () => {
    const probe = path.join(ccxrayHome, 'shim-probe.js');
    const saved = fs.readFileSync(probe);
    fs.rmSync(probe);
    try {
      const r = await run('claude', ['x'], { env: { FAKE_EXIT: '5' } });
      assert.equal(r.code, 5);
      assert.match(r.stdout, /BASE:\n/);
      assert.equal(bypassLines()[0].reason, 'helper-unavailable');
    } finally { fs.writeFileSync(probe, saved); }
  });
});

describe('slow proxy (timeout)', () => {
  it('gives up after the short timeout, runs directly and logs a timeout', async () => {
    proxyDelayMs = 3000;
    const r = await run('claude', ['x'], { env: { FAKE_EXIT: '2' } });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /BASE:\n/);
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    assert.equal(bypassLines()[0].reason, 'timeout');
  });

  it('honours CCXRAY_SHIM_TIMEOUT_MS for a proxy slower than the default but within the override', async () => {
    proxyDelayMs = 600;
    const r = await run('claude', ['x'], { env: { CCXRAY_SHIM_TIMEOUT_MS: '3000' } });
    assert.match(r.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
  });
});

describe('strict mode (criterion 3)', () => {
  it('refuses with a clear error and does not run the real binary', async () => {
    const closedPort = await freePort();
    const r = await run('claude', ['x'], { env: { CCXRAY_SHIM_PORT: String(closedPort), CCXRAY_SHIM_STRICT: '1' } });
    assert.equal(r.code, 111);
    assert.doesNotMatch(r.stdout, /ARGS:/);
    assert.match(r.stderr, /ccxray shim: proxy not usable \(refused\); refusing to launch claude because CCXRAY_SHIM_STRICT=1/);
    const lines = bypassLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, 'refused');
  });

  it('still routes through a healthy proxy', async () => {
    const r = await run('codex', ['exec', 'x'], { env: { CCXRAY_SHIM_STRICT: '1' } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /openai_base_url/);
  });

  it('CCXRAY_SHIM_STRICT=0 overrides a strict-by-default install', async () => {
    const strictRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-strict-')));
    try {
      const home = path.join(strictRoot, '.ccxray');
      await runWrapBinaries({ yes: true, shell: 'bash', strict: true }, {
        env: { HOME: strictRoot, CCXRAY_HOME: home, SHELL: '/bin/bash' }, homedir: () => strictRoot, platform: 'linux', logger: quiet(),
      });
      const closedPort = await freePort();
      const env = { CCXRAY_SHIM_PORT: String(closedPort), CCXRAY_SHIM_HOME: home };
      const strict = await run('claude', ['x'], { pathDirs: [path.join(home, 'shims'), realBin], env });
      assert.equal(strict.code, 111);
      const open = await run('claude', ['x'], { pathDirs: [path.join(home, 'shims'), realBin], env: { ...env, CCXRAY_SHIM_STRICT: '0' } });
      assert.equal(open.code, 0);
    } finally { fs.rmSync(strictRoot, { recursive: true, force: true }); }
  });
});

describe('no recursion (criterion 4)', () => {
  it('works with the shim directory on PATH twice and via a symlinked alias', async () => {
    const alias = path.join(root, 'shim-alias');
    fs.symlinkSync(shimDir, alias);
    const r = await run('claude', ['x'], { pathDirs: [shimDir, alias, shimDir, realBin, shimDir], timeout: 8000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /WHO:claude/);
    assert.match(r.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
    fs.rmSync(alias);
  });

  it('exits 127 with a clear message when no real binary exists', async () => {
    const r = await run('claude', ['x'], { pathDirs: [shimDir] });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /cannot find the real 'claude'/);
  });

  it('works when the real binary is a symlink', async () => {
    const store = path.join(root, 'store');
    makeFake(path.join(store, 'claude-real'), FAKE);
    const linkBin = path.join(root, 'link-bin');
    fs.mkdirSync(linkBin);
    fs.symlinkSync(path.join(store, 'claude-real'), path.join(linkBin, 'claude'));
    const r = await run('claude', ['x'], { pathDirs: [shimDir, linkBin] });
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
  });

  it('works when the real binary is a version-manager shim that re-dispatches', async () => {
    const managerBin = path.join(root, 'mgr-bin');
    const versions = path.join(root, 'versions');
    makeFake(path.join(versions, '1.2.3', 'claude'), FAKE);
    makeFake(path.join(managerBin, 'claude'), `exec "${path.join(versions, '1.2.3', 'claude')}" "$@"`);
    const r = await run('claude', ['y'], { pathDirs: [shimDir, managerBin] });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ARGS:y/);
    assert.match(r.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
  });

  it('skips a second ccxray shim directory instead of ping-ponging between them', async () => {
    const otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-two-')));
    try {
      const home = path.join(otherRoot, '.ccxray');
      await runWrapBinaries({ yes: true, shell: 'bash' }, {
        env: { HOME: otherRoot, CCXRAY_HOME: home, SHELL: '/bin/bash' }, homedir: () => otherRoot, platform: 'linux', logger: quiet(),
      });
      const r = await run('claude', ['x'], { pathDirs: [shimDir, path.join(home, 'shims'), realBin], timeout: 8000 });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /WHO:claude/);
    } finally { fs.rmSync(otherRoot, { recursive: true, force: true }); }
  });
});

describe('dashboard / status surfaces bypass counts', () => {
  const { execFile } = require('child_process');
  const repo = path.resolve(__dirname, '..');
  const cli = (args, env) => new Promise(resolve => execFile(process.execPath, [path.join(repo, 'server/index.js'), ...args],
    { env: { PATH: process.env.PATH, HOME: root, CCXRAY_HOME: ccxrayHome, CCXRAY_EXPORT_DISABLE: '1', PROXY_PORT: String(env.port) }, timeout: 20000 },
    (error, stdout, stderr) => resolve({ stdout, stderr })));

  it('`ccxray status` reports installed shims and recent bypasses (and nothing for a clean home)', async () => {
    const closedPort = await freePort();
    await run('claude', ['x'], { env: { CCXRAY_SHIM_PORT: String(closedPort) } });
    const r = await cli(['status'], { port: closedPort });
    assert.match(r.stdout, /Launcher shims: installed/);
    assert.match(r.stdout, /Launcher bypasses: 1 in the last 24h \(refused×1\), 1 retained/);
    const clean = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-clean-')));
    try {
      const out = await new Promise(resolve => execFile(process.execPath, [path.join(repo, 'server/index.js'), 'status'],
        { env: { PATH: process.env.PATH, HOME: clean, CCXRAY_HOME: path.join(clean, '.ccxray'), CCXRAY_EXPORT_DISABLE: '1', PROXY_PORT: String(closedPort) }, timeout: 20000 },
        (e, stdout) => resolve(stdout)));
      assert.doesNotMatch(out, /Launcher/);
    } finally { fs.rmSync(clean, { recursive: true, force: true }); }
  });
});

// ── Review round 1 (#734): shell-level hardening ────────────────────────────

const { spawnSync } = require('child_process');

function installInto(dir, extra = {}, deps = {}) {
  const home = path.join(dir, '.ccxray');
  return runWrapBinaries({ yes: true, shell: 'bash', ...extra }, {
    env: { HOME: dir, CCXRAY_HOME: home, SHELL: '/bin/bash', PATH: SYSTEM_PATH },
    homedir: () => dir, platform: 'linux', logger: quiet(), ...deps,
  }).then(code => { assert.equal(code, 0); return { home, shims: path.join(home, 'shims') }; });
}

function tmp(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

describe('PATH walking keeps empty components (finding 8)', () => {
  let cwdBin; let proxyDown;
  before(async () => {
    cwdBin = path.join(root, 'cwd-bin');
    makeFake(path.join(cwdBin, 'claude'), FAKE);
    proxyDown = String(await freePort());
  });
  const viaPath = pathValue => run('claude', ['x'], {
    exe: path.join(shimDir, 'claude'), cwd: cwdBin, pathDirs: [], env: { PATH: pathValue, CCXRAY_SHIM_PORT: proxyDown },
  });

  for (const [name, value] of [
    ['trailing', `${shimDir}:/usr/bin:`], ['leading', `:${shimDir}:/usr/bin`], ['interior', `${shimDir}::/usr/bin`],
    ['entirely empty (colon)', ':'], ['entirely empty (unset-like)', ''],
  ]) {
    it(`finds the real binary in the working directory for a ${name} empty entry`, async () => {
      const r = await viaPath(value);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /ARGS:x\n/); // (WHO is blank: the fake's basename is not on this bare PATH)
    });
  }

  it('resolves relative entries against the working directory', async () => {
    const r = await run('claude', ['x'], { exe: path.join(shimDir, 'claude'), cwd: root, pathDirs: [], env: { PATH: 'cwd-bin', CCXRAY_SHIM_PORT: proxyDown } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ARGS:x\n/);
  });

  it('does not expand glob characters in PATH entries', async () => {
    const star = path.join(root, 'gl*b');
    makeFake(path.join(star, 'claude'), FAKE);
    makeFake(path.join(root, 'globx', 'claude'), 'echo WRONG; exit 9');
    const r = await run('claude', ['x'], { exe: path.join(shimDir, 'claude'), pathDirs: [], env: { PATH: star, CCXRAY_SHIM_PORT: proxyDown } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /WRONG/);
  });

  it('still exits 127 when an empty entry has no binary', async () => {
    const r = await run('claude', ['x'], { exe: path.join(shimDir, 'claude'), cwd: root, pathDirs: [], env: { PATH: `${shimDir}:` } });
    assert.equal(r.code, 127);
  });
});

describe('invocation name and override are never evaluated (should-fix 2)', () => {
  it('refuses an unexpected invocation name without running its command substitution', async () => {
    const evil = path.join(root, 'evil');
    fs.mkdirSync(evil, { recursive: true });
    const name = 'claude$($CCXRAY_TEST_COMMAND)';
    fs.symlinkSync(path.join(shimDir, 'claude'), path.join(evil, name));
    const marker = path.join(root, 'pwned-marker');
    const r = await run(name, ['x'], { exe: path.join(evil, name), pathDirs: [realBin], env: { CCXRAY_TEST_COMMAND: `touch ${marker}` } });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /unsupported invocation name/);
    assert.equal(fs.existsSync(marker), false);
  });

  it('honours a valid override but ignores one that points back at a shim', async () => {
    const other = path.join(root, 'override-bin', 'claude');
    makeFake(other, FAKE.replace('echo "WHO:$(basename "$0")"', 'echo "WHO:override"'));
    const used = await run('claude', ['x'], { env: { CCXRAY_SHIM_REAL_CLAUDE: other } });
    assert.match(used.stdout, /WHO:override/);
    for (const loop of [path.join(shimDir, 'claude'), path.join(shimDir, 'codex')]) {
      const r = await run('claude', ['x'], { env: { CCXRAY_SHIM_REAL_CLAUDE: loop }, timeout: 8000 });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /WHO:claude/);
    }
    const alias = path.join(root, 'shim-alias2');
    fs.symlinkSync(shimDir, alias);
    const viaAlias = await run('claude', ['x'], { env: { CCXRAY_SHIM_REAL_CLAUDE: path.join(alias, 'claude') }, timeout: 8000 });
    assert.match(viaAlias.stdout, /WHO:claude/);
    fs.rmSync(alias);
  });
});

describe('hard launch deadline (finding 3) and strict mode on every failure path (finding 4)', () => {
  let dir; let paths; let fakeNodeLog;
  before(async () => {
    dir = tmp('ccxray-shim-deadline-');
    fakeNodeLog = path.join(dir, 'fake-node.pid');
    const fakeNode = path.join(dir, 'fake-node');
    // Records its pid, then hangs: stands for a Node start stuck in a preload.
    makeFake(fakeNode, `echo $$ > "${fakeNodeLog}"\nexec sleep 30`);
    paths = await installInto(dir, {}, { nodePath: fakeNode });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const launch = (extraEnv = {}) => run('claude', ['x'], {
    pathDirs: [paths.shims, realBin],
    env: { CCXRAY_SHIM_HOME: paths.home, CCXRAY_SHIM_DEADLINE_SECS: '1', FAKE_EXIT: '4', ...extraEnv },
    timeout: 15000,
  });
  const logIn = home => { try { return fs.readFileSync(path.join(home, 'shim-bypass.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const pidGone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

  it('execs the real binary after the deadline and kills the hung helper', async () => {
    const r = await launch();
    assert.equal(r.code, 4);
    assert.match(r.stdout, /ARGS:x\n/);
    assert.match(r.stdout, /BASE:\n/);
    assert.ok(r.ms < 6000, `took ${r.ms}ms`);
    assert.equal(logIn(paths.home).at(-1).reason, 'timeout');
    const helperPid = Number(fs.readFileSync(fakeNodeLog, 'utf8'));
    const until = Date.now() + 5000;
    while (!pidGone(helperPid) && Date.now() < until) await new Promise(resolve => setImmediate(resolve));
    assert.ok(pidGone(helperPid), 'the hung helper must be killed and reaped');
  });

  it('strict mode refuses on the deadline and never starts the real binary', async () => {
    const r = await launch({ CCXRAY_SHIM_STRICT: '1' });
    assert.equal(r.code, 111);
    assert.doesNotMatch(r.stdout, /ARGS:/);
    assert.equal(logIn(paths.home).at(-1).action, 'refused');
  });

  it('fails open on a Node binary that crashes immediately, and refuses in strict mode', async () => {
    const crashDir = tmp('ccxray-shim-crash-');
    try {
      const fakeNode = path.join(crashDir, 'fake-node');
      makeFake(fakeNode, 'exit 70');
      const p = await installInto(crashDir, {}, { nodePath: fakeNode });
      const env = { CCXRAY_SHIM_HOME: p.home, FAKE_EXIT: '6' };
      const open = await run('claude', ['x'], { pathDirs: [p.shims, realBin], env });
      assert.equal(open.code, 6);
      assert.ok(open.ms < 4000, `a crashed helper must not wait for the deadline (${open.ms}ms)`);
      assert.equal(logIn(p.home).at(-1).reason, 'helper-unavailable');
      const strict = await run('claude', ['x'], { pathDirs: [p.shims, realBin], env: { ...env, CCXRAY_SHIM_STRICT: '1' } });
      assert.equal(strict.code, 111);
      assert.doesNotMatch(strict.stdout, /ARGS:/);
    } finally { fs.rmSync(crashDir, { recursive: true, force: true }); }
  });

  it('fails open when the Node binary is missing', async () => {
    const missingDir = tmp('ccxray-shim-nonode-');
    try {
      const p = await installInto(missingDir, {}, { nodePath: path.join(missingDir, 'no-such-node') });
      const r = await run('claude', ['x'], { pathDirs: [p.shims, realBin], env: { CCXRAY_SHIM_HOME: p.home } });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /BASE:\n/);
    } finally { fs.rmSync(missingDir, { recursive: true, force: true }); }
  });

  it('survives a stalled synchronous read (hub.json is a FIFO)', async () => {
    const fifoDir = tmp('ccxray-shim-fifo-');
    try {
      const p = await installInto(fifoDir);
      const made = spawnSync('mkfifo', [path.join(p.home, 'hub.json')]);
      if (made.status !== 0) return; // no mkfifo on this machine
      const env = { CCXRAY_SHIM_HOME: p.home, CCXRAY_SHIM_DEADLINE_SECS: '1', FAKE_EXIT: '5' };
      const open = await run('claude', ['x'], { pathDirs: [p.shims, realBin], env: { ...env, CCXRAY_SHIM_PORT: '' }, timeout: 15000 });
      assert.equal(open.code, 5);
      assert.match(open.stdout, /BASE:\n/);
      assert.equal(logIn(p.home).at(-1).reason, 'timeout');
      const strict = await run('claude', ['x'], { pathDirs: [p.shims, realBin], env: { ...env, CCXRAY_SHIM_PORT: '', CCXRAY_SHIM_STRICT: '1' }, timeout: 15000 });
      assert.equal(strict.code, 111);
    } finally { fs.rmSync(fifoDir, { recursive: true, force: true }); }
  });

  it('still routes when the working directory was removed (process.cwd() throws)', async () => {
    const gone = path.join(root, 'gone-cwd');
    fs.mkdirSync(gone);
    const script = `cd "${gone}" && rmdir "${gone}" && exec claude x`;
    // Async spawn: the fake proxy lives in this process, so a blocking spawn would starve it.
    const out = await run('sh', ['-c', script], { exe: '/bin/sh', env: { CCXRAY_SHIM_STRICT: '1' } });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`BASE:http://127.0.0.1:${proxyPort}\\n`));
  });
});

describe('bypass log written by the shim (should-fix 3)', () => {
  let dir; let paths; let logFile;
  before(async () => { dir = tmp('ccxray-shim-log-'); paths = await installInto(dir); logFile = path.join(paths.home, 'shim-bypass.log'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { fs.rmSync(logFile, { force: true }); fs.rmSync(`${logFile}.1`, { force: true }); });
  const noHelper = (extra = {}) => {
    const probe = path.join(paths.home, 'shim-probe.js');
    const saved = fs.readFileSync(probe);
    fs.rmSync(probe);
    const restore = () => fs.writeFileSync(probe, saved);
    return run('claude', ['x'], { pathDirs: [paths.shims, realBin], env: { CCXRAY_SHIM_HOME: paths.home, ...extra.env }, ...extra }).finally(restore);
  };

  it('creates a private directory and file whatever the umask', async () => {
    const fresh = path.join(dir, 'fresh-home');
    const r = await noHelper({ umask: '000', env: { CCXRAY_SHIM_HOME: fresh } });
    assert.equal(r.code, 0);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(fresh, 'shim-bypass.log')).mode & 0o777, 0o600);
  });

  it('writes valid single-line JSON for a hostile working directory', async () => {
    const weird = path.join(dir, 'we"ird\\back\nline\ttab\u0001dir');
    fs.mkdirSync(weird);
    const r = await noHelper({ cwd: weird });
    assert.equal(r.code, 0);
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.reason, 'helper-unavailable');
    assert.match(rec.cwd, /^[ -~]*$/);
    assert.ok(rec.cwd.includes('we\\"ird') === false && rec.cwd.includes('we"ird'));
  });

  it('rotates past 1 MiB so the log stays bounded', async () => {
    fs.writeFileSync(logFile, `${'x'.repeat(1100000)}\n`);
    await noHelper();
    assert.ok(fs.existsSync(`${logFile}.1`));
    assert.equal(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length, 1);
  });

  it('stays silent and launches when the log cannot be written', async () => {
    fs.mkdirSync(logFile); // a directory where the file should be
    const r = await noHelper();
    assert.equal(r.code, 0);
    assert.equal(r.stderr, 'ERR\n');
    fs.rmdirSync(logFile);
  });

  it('never blocks on a FIFO planted at the log path', async () => {
    if (spawnSync('mkfifo', [logFile]).status !== 0) return;
    const r = await noHelper({ timeout: 8000 });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 3000, `took ${r.ms}ms`);
    assert.equal(r.stderr, 'ERR\n');
    fs.rmSync(logFile);
  });

  it('stays silent when the home is unreadable', async function () {
    if (process.getuid && process.getuid() === 0) return;
    const locked = path.join(dir, 'locked-home');
    fs.mkdirSync(locked, { mode: 0o500 });
    try {
      const r = await noHelper({ env: { CCXRAY_SHIM_HOME: locked } });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, 'ERR\n');
    } finally { fs.chmodSync(locked, 0o700); }
  });
});
