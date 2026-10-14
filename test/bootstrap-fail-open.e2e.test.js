'use strict';

// A synchronous throw while server/index.js loads its proxy stack happens
// before createLaunchDecision exists. The bootstrap handler must still launch
// the plain agent (fail-open) or exit 1 under CCXRAY_FAIL_CLOSED=1.
// STORAGE_BACKEND=s3 is a deterministic load-time throw (config.js →
// createStorage), so no node_modules surgery is needed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bootstrap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const capture = path.join(home, 'capture.json');
  const bin = path.join(binDir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args: process.argv.slice(2),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
}));
process.exit(7);
`);
  fs.chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CCXRAY_HOME: home, CCXRAY_EXPORT_DISABLE: '1', STORAGE_BACKEND: 's3', PROXY_PORT: '5697' };
  for (const k of ['ANTHROPIC_BASE_URL', 'CCXRAY_HUB_CLIENT_PID', 'CCXRAY_EXPORT_GCS_BUCKET', 'CCXRAY_FAIL_CLOSED']) delete env[k];
  return { home, capture, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 15000 });
}

describe('bootstrap fail-open (load-time throw before launchDecision)', { skip: process.platform === 'win32' }, () => {
  for (const args of [['claude', '-p', 'hi'], ['claude', '--bg', 'hi'], ['--port', '5698', 'claude', '-p', 'hi']]) {
    it(`runs the plain agent for: ${args.join(' ')}`, t => {
      const { home, capture, env } = setup(t);
      const r = run(args, env);
      assert.equal(r.status, 7, `agent exit code passes through; stderr=${r.stderr}`);
      const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.deepEqual(got.args, args.slice(args.indexOf('claude') + 1));
      assert.equal(got.anthropicBaseUrl, null, 'env must be unchanged (not proxied)');
      const log = fs.readFileSync(path.join(home, 'fail-open.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(log.at(-1).reason, 'bootstrap-failed');
      assert.match(r.stderr, /STORAGE_BACKEND=s3/, 'original error is still shown');
    });
  }

  it('keeps the bg-bypass exemption under CCXRAY_FAIL_CLOSED=1', t => {
    const { home, capture, env } = setup(t);
    const r = run(['claude', '--bg', 'hi'], { ...env, CCXRAY_FAIL_CLOSED: '1' });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--bg', 'hi']);
    assert.match(fs.readFileSync(path.join(home, 'fail-open.log'), 'utf8'), /bootstrap-failed/);
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

  it('knows every agent provider', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const listed = JSON.parse(src.match(/const BOOTSTRAP_AGENTS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    assert.deepEqual(listed.sort(), Object.keys(require('../server/providers').AGENT_PROVIDERS).sort());
  });

  it('does not launch anything for a non-agent command', t => {
    const { env } = setup(t);
    const r = run(['status'], env);
    assert.equal(r.status, 1);
  });
});
