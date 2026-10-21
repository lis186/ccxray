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

function run(tool, args, { env = {}, stdin, pathDirs, timeout = 10000 } = {}) {
  const dirs = pathDirs || [shimDir, realBin];
  const started = Date.now();
  return new Promise(resolve => {
    // Plain spawn by bare name with only the PATH below: no shell, no profile.
    const child = spawn(tool, args, {
      cwd: root,
      env: { PATH: [...dirs, SYSTEM_PATH].join(':'), HOME: root, CCXRAY_SHIM_PORT: String(proxyPort), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started, child }); });
    child.spawned = true;
    run.last = child;
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
    const result = run('claude', ['x'], { env: { FAKE_HANG: '1' } });
    await new Promise(resolve => setTimeout(resolve, 600));
    run.last.kill('SIGTERM');
    const r = await result;
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
    assert.match(r.stderr, /ccxray shim: proxy not reachable \(refused\); refusing to launch claude because CCXRAY_SHIM_STRICT=1/);
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
    assert.match(r.stdout, /Launcher bypasses: 1 in the last 24h \(refused×1\), 1 total/);
    const clean = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-clean-')));
    try {
      const out = await new Promise(resolve => execFile(process.execPath, [path.join(repo, 'server/index.js'), 'status'],
        { env: { PATH: process.env.PATH, HOME: clean, CCXRAY_HOME: path.join(clean, '.ccxray'), CCXRAY_EXPORT_DISABLE: '1', PROXY_PORT: String(closedPort) }, timeout: 20000 },
        (e, stdout) => resolve(stdout)));
      assert.doesNotMatch(out, /Launcher/);
    } finally { fs.rmSync(clean, { recursive: true, force: true }); }
  });
});
