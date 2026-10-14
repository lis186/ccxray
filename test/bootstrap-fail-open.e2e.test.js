'use strict';

// A synchronous throw while server/index.js loads its proxy stack happens
// before createLaunchDecision exists. The bootstrap handler must still launch
// the plain agent (fail-open) or exit 1 under CCXRAY_FAIL_CLOSED=1.
// STORAGE_BACKEND=s3 is a deterministic load-time throw (config.js →
// createStorage), so no node_modules surgery is needed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const PACKAGE = require('../package.json');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bootstrap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const capture = path.join(home, 'capture.json');
  const runs = path.join(home, 'runs.log');
  const bin = path.join(binDir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(runs)}, process.pid + '\\n');
require('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args: process.argv.slice(2),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  pid: process.pid,
}));
setTimeout(() => process.exit(7), Number(process.env.FAKE_AGENT_DELAY_MS || 0));
`);
  fs.chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CCXRAY_HOME: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
    STORAGE_BACKEND: 's3', PROXY_PORT: '5697' };
  for (const k of ['ANTHROPIC_BASE_URL', 'CCXRAY_HUB_CLIENT_PID', 'CCXRAY_EXPORT_GCS_BUCKET', 'CCXRAY_FAIL_CLOSED']) delete env[k];
  return { home, capture, runs, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 15000 });
}

function readLog(home) {
  return fs.readFileSync(path.join(home, 'fail-open.log'), 'utf8').trim().split('\n').map(JSON.parse);
}

async function waitFor(file, ms = 10000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('bootstrap fail-open (load-time throw before launchDecision)', { skip: process.platform === 'win32' }, () => {
  const CASES = [
    [['claude', '-p', 'hi'], ['-p', 'hi']],
    [['claude', '--bg', 'hi'], ['--bg', 'hi']],
    [['--port', '5698', 'claude', '-p', 'hi'], ['-p', 'hi']],
    // Global flags after the agent are ccxray's, exactly as on the normal path.
    [['claude', '--port', '5698', '-p', 'hi', '--no-browser'], ['-p', 'hi']],
  ];
  for (const [args, expected] of CASES) {
    it(`runs the plain agent for: ${args.join(' ')}`, t => {
      const { home, capture, env } = setup(t);
      const r = run(args, env);
      assert.equal(r.status, 7, `agent exit code passes through; stderr=${r.stderr}`);
      const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.deepEqual(got.args, expected);
      assert.equal(got.anthropicBaseUrl, null, 'env must be unchanged (not proxied)');
      const last = readLog(home).at(-1);
      assert.deepEqual(Object.keys(last), ['ts', 'reason', 'version', 'agent'], 'same record shape as launchDecision');
      assert.equal(last.reason, 'bootstrap-failed');
      assert.equal(last.version, PACKAGE.version);
      assert.match(r.stderr, /STORAGE_BACKEND=s3/, 'original error is still shown');
    });
  }

  it('leaves SIGINT to the agent', async t => {
    const { capture, env } = setup(t);
    const child = spawn(process.execPath, [SERVER, 'claude'], {
      env: { ...env, FAKE_AGENT_DELAY_MS: '1500' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(capture);
    child.kill('SIGINT');
    assert.deepEqual(await exited, { code: 7, signal: null }, 'Ctrl-C must not kill the launcher while the agent runs');
  });

  for (const sig of ['SIGTERM', 'SIGHUP']) {
    it(`forwards ${sig} to the agent`, async t => {
      const { capture, env } = setup(t);
      const child = spawn(process.execPath, [SERVER, 'claude'], {
        env: { ...env, FAKE_AGENT_DELAY_MS: '10000' }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      t.after(() => { try { child.kill('SIGKILL'); } catch {} });
      const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
      await waitFor(capture);
      const agentPid = JSON.parse(fs.readFileSync(capture, 'utf8')).pid;
      child.kill(sig);
      assert.deepEqual(await exited, { code: 1, signal: null });
      assert.throws(() => process.kill(agentPid, 0), `agent received the forwarded ${sig}`);
    });
  }

  it('rejects an invalid --port exactly as the normal path does', t => {
    const { capture, env } = setup(t);
    const r = run(['claude', '--port', 'abc'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--port requires a valid port number/);
    assert.equal(fs.existsSync(capture), false);
  });

  it('does not launch a second agent on a later uncaught error', t => {
    const { home, capture, runs, env } = setup(t);
    // Preloaded into the launcher: once the agent is running, raise another
    // uncaught error, as a stray timer from a half-loaded module would.
    const preload = path.join(home, 'late-throw.js');
    fs.writeFileSync(preload, `
const fs = require('fs');
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(capture)})) return;
  clearInterval(poll);
  throw new Error('late uncaught error');
}, 25);
poll.unref();
`);
    const r = spawnSync(process.execPath, ['--require', preload, SERVER, 'claude', '-p', 'hi'], {
      env: { ...env, FAKE_AGENT_DELAY_MS: '1500' }, encoding: 'utf8', timeout: 15000,
    });
    assert.match(r.stderr, /late uncaught error/, 'the late error was raised and reported');
    assert.equal(r.status, 7, r.stderr);
    assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, 1, 'exactly one agent ran');
    assert.equal(readLog(home).length, 1, 'exactly one fail-open record');
  });

  it('keeps the bg-bypass exemption under CCXRAY_FAIL_CLOSED=1', t => {
    const { home, capture, env } = setup(t);
    const r = run(['claude', '--bg', 'hi'], { ...env, CCXRAY_FAIL_CLOSED: '1' });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--bg', 'hi']);
    assert.equal(readLog(home).at(-1).reason, 'bootstrap-failed');
  });

  it('exits 1 without launching under CCXRAY_FAIL_CLOSED=1', t => {
    const { capture, env } = setup(t);
    const r = run(['claude', '-p', 'hi'], { ...env, CCXRAY_FAIL_CLOSED: '1' });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(capture), false);
  });

  it('fails closed for a non-bg claude command after a `--` terminator', t => {
    const { capture, env } = setup(t);
    const r = run(['claude', '--', '--bg'], { ...env, CCXRAY_FAIL_CLOSED: '1' });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(capture), false);
  });

  it('does not launch anything for a non-agent command', t => {
    const { env } = setup(t);
    const r = run(['status'], env);
    assert.equal(r.status, 1);
  });
});

// Not a bootstrap failure: the normal path's launchDecision writes the same
// record through plain-launch's appendFailOpen.
describe('normal-path fail-open record', { skip: process.platform === 'win32' }, () => {
  it('still launches the agent when resolving the home directory throws', t => {
    const { home, capture, env } = setup(t);
    delete env.STORAGE_BACKEND;
    // Throw only for the fail-open log write, so the proxy stack still loads.
    const preload = path.join(home, 'home-throws.js');
    fs.writeFileSync(preload, `
const paths = require(${JSON.stringify(path.resolve(__dirname, '..', 'server', 'paths.js'))});
const real = paths.resolveCcxrayHome;
paths.resolveCcxrayHome = (...a) => {
  if (new Error().stack.includes('logFailOpen')) throw new Error('home unavailable');
  return real(...a);
};
`);
    // --bg takes the bg-bypass fail-open path without starting a server.
    const r = spawnSync(process.execPath, ['--require', preload, SERVER, 'claude', '--bg', 'hi'], {
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--bg', 'hi']);
    assert.equal(fs.existsSync(path.join(home, 'fail-open.log')), false, 'the record write was what failed');
  });
});
