'use strict';

// #732: setup-side behaviour of `ccxray setup --wrap-binaries`: dry-run, install,
// check, and --remove restoring the previous state byte for byte. All paths are
// under a temp HOME; nothing reads or writes a real profile, PATH config or home.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const setup = require('../server/setup');
const shims = require('../server/launcher-shims');
const { summarizeBypasses, renderBypassLine } = require('../server/shim-bypass');

let root; let home; let out; let err;

function logger() {
  out = []; err = [];
  return { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) };
}

function overrides({ env, ...extra } = {}) {
  return {
    shims: {
      env: { HOME: root, CCXRAY_HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', CCXRAY_SHIM_PORT: '1', ...(env || {}) },
      homedir: () => root, platform: 'linux', logger: logger(), isTty: () => false, ...extra,
    },
  };
}

// Full tree snapshot: path -> bytes (or 'dir'), so "restore exactly" is literal.
function snapshot(dir) {
  const result = {};
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) { result[rel] = 'dir'; walk(full); }
      else result[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return result;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-unit-')));
  home = path.join(root, '.ccxray');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('argument parsing', () => {
  it('accepts --wrap-binaries with its own flags', () => {
    const { options } = setup.parseArgs(['--wrap-binaries', '--shim-dir', '/x/bin', '--strict', '--no-session-env', '--yes']);
    assert.equal(options.wrapBinaries, true);
    assert.equal(options.shimDir, '/x/bin');
    assert.equal(options.strict, true);
    assert.equal(options.noSessionEnv, true);
  });
  it('rejects shim flags without --wrap-binaries and mixes with export/browser', () => {
    for (const argv of [['--strict'], ['--shim-dir', '/x'], ['--no-session-env'],
      ['--wrap-binaries', '--export', '--bucket', 'b', '--domains', 'd.com'], ['--wrap-binaries', '--browser', 'on'],
      ['--wrap-binaries', '--retention-days', '3'], ['--wrap-binaries', '--check', '--strict']]) {
      assert.ok(setup.parseArgs(argv).error, argv.join(' '));
    }
  });
  it('allows --check, --remove and --dry-run with --wrap-binaries', () => {
    for (const flag of ['--check', '--remove', '--dry-run']) assert.ok(setup.parseArgs(['--wrap-binaries', flag]).options.wrapBinaries);
  });
});

describe('--dry-run (criterion 5)', () => {
  it('lists every file and PATH change and writes nothing', async () => {
    fs.writeFileSync(path.join(root, '.bashrc'), 'export A=1\n');
    const before = snapshot(root);
    const o = overrides();
    const code = await setup.runSetup(['--wrap-binaries', '--dry-run'], o);
    assert.equal(code, 0);
    assert.deepEqual(snapshot(root), before);
    const text = out.join('\n');
    for (const needle of [path.join(home, 'shims'), path.join(home, 'shims', 'claude'), path.join(home, 'shims', 'codex'),
      path.join(home, 'shim-probe.js'), path.join(root, '.profile'), path.join(root, '.bashrc'),
      path.join(root, '.config', 'environment.d', '50-ccxray-shims.conf'), path.join(home, 'shims.json'), 'PATH block']) {
      assert.ok(text.includes(needle), `dry-run should mention ${needle}\n${text}`);
    }
  });
  it('--remove --dry-run lists the planned deletions and changes nothing', async () => {
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    const before = snapshot(root);
    const code = await setup.runSetup(['--wrap-binaries', '--remove', '--dry-run'], overrides());
    assert.equal(code, 0);
    assert.deepEqual(snapshot(root), before);
    assert.match(out.join('\n'), /would delete .*claude/);
    assert.match(out.join('\n'), /would remove the PATH block/);
  });
});

describe('install', () => {
  it('requires --yes when not on a TTY, and writes nothing', async () => {
    const before = snapshot(root);
    assert.equal(await setup.runSetup(['--wrap-binaries'], overrides()), 2);
    assert.deepEqual(snapshot(root), before);
    assert.match(err.join('\n'), /--yes/);
  });

  it('writes executable shims, the probe, the PATH blocks and a manifest', async () => {
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes'], overrides()), 0);
    for (const tool of ['claude', 'codex']) {
      const file = path.join(home, 'shims', tool);
      assert.ok(fs.statSync(file).mode & 0o111, `${tool} is executable`);
      assert.match(fs.readFileSync(file, 'utf8'), /ccxray-launcher-shim-v1/);
    }
    assert.ok(fs.existsSync(path.join(home, 'shim-probe.js')));
    const profile = fs.readFileSync(path.join(root, '.profile'), 'utf8');
    assert.ok(profile.includes(shims.BLOCK_START) && profile.includes(path.join(home, 'shims')));
    assert.ok(fs.readFileSync(path.join(root, '.bashrc'), 'utf8').includes(shims.BLOCK_START));
    assert.equal(fs.readFileSync(path.join(root, '.config/environment.d/50-ccxray-shims.conf'), 'utf8'), `PATH=${path.join(home, 'shims')}:$PATH\n`);
    assert.equal(shims.readManifest({ manifestPath: path.join(home, 'shims.json') }, { fs }).version, 1);
  });

  it('is idempotent: a second install leaves one block per profile', async () => {
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    const text = fs.readFileSync(path.join(root, '.bashrc'), 'utf8');
    assert.equal(text.split(shims.BLOCK_START).length - 1, 1);
  });

  it('uses .zshenv for zsh and skips environment.d with --no-session-env', async () => {
    const o = overrides({ env: { SHELL: '/bin/zsh' } });
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes', '--no-session-env'], o), 0);
    assert.ok(fs.readFileSync(path.join(root, '.zshenv'), 'utf8').includes(shims.BLOCK_START));
    assert.ok(!fs.existsSync(path.join(root, '.config')));
    assert.ok(!fs.existsSync(path.join(root, '.bashrc')));
  });

  it('--shim-dir installs into an existing PATH directory without touching other files', async () => {
    const bin = path.join(root, 'local-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'other-tool'), 'x');
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes', '--shim-dir', bin], overrides()), 0);
    assert.deepEqual(fs.readdirSync(bin).sort(), ['claude', 'codex', 'other-tool']);
    await setup.runSetup(['--wrap-binaries', '--remove'], overrides());
    assert.deepEqual(fs.readdirSync(bin), ['other-tool']);
  });

  it('refuses to overwrite a claude/codex it does not own', async () => {
    const bin = path.join(root, 'local-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), 'REAL BINARY');
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes', '--shim-dir', bin], overrides()), 1);
    assert.equal(fs.readFileSync(path.join(bin, 'claude'), 'utf8'), 'REAL BINARY');
    assert.ok(!fs.existsSync(path.join(home, 'shims.json')));
    assert.ok(!fs.existsSync(path.join(root, '.bashrc')));
  });

  it('is unsupported on Windows and with PowerShell', async () => {
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes'], overrides({ platform: 'win32' })), 2);
    assert.match(err.join('\n'), /not supported on Windows/);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--yes', '--shell', 'pwsh'], overrides()), 2);
  });
});

describe('--remove restores the previous state exactly (criterion 5)', () => {
  it('from a clean home', async () => {
    const before = snapshot(root);
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    assert.notDeepEqual(snapshot(root), before);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 0);
    assert.deepEqual(snapshot(root), before);
  });

  it('with existing profiles, with and without a trailing newline, and a symlinked profile', async () => {
    fs.writeFileSync(path.join(root, '.bash_profile'), 'export B=2'); // no trailing newline
    fs.writeFileSync(path.join(root, 'dotfiles-bashrc'), '# mine\nalias ll="ls -l"\n');
    fs.symlinkSync(path.join(root, 'dotfiles-bashrc'), path.join(root, '.bashrc'));
    fs.mkdirSync(path.join(root, '.config'));
    const before = snapshot(root);
    const linkTarget = fs.readlinkSync(path.join(root, '.bashrc'));
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    assert.ok(fs.lstatSync(path.join(root, '.bashrc')).isSymbolicLink(), 'symlinked profile stays a symlink');
    assert.ok(fs.readFileSync(path.join(root, 'dotfiles-bashrc'), 'utf8').includes(shims.BLOCK_START));
    await setup.runSetup(['--wrap-binaries', '--remove'], overrides());
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.readlinkSync(path.join(root, '.bashrc')), linkTarget);
  });

  it('after a re-install the original state is still what comes back', async () => {
    fs.writeFileSync(path.join(root, '.bashrc'), 'keep me');
    const before = snapshot(root);
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    await setup.runSetup(['--wrap-binaries', '--yes', '--strict'], overrides());
    await setup.runSetup(['--wrap-binaries', '--remove'], overrides());
    assert.deepEqual(snapshot(root), before);
  });

  it('keeps edits the user made after setup and says so, and keeps the bypass log', async () => {
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    fs.appendFileSync(path.join(root, '.bashrc'), 'export LATER=1\n');
    const shim = path.join(home, 'shims', 'claude');
    fs.appendFileSync(shim, '# user edit\n');
    fs.writeFileSync(path.join(home, 'shim-bypass.log'), '{"t":"2026-01-01T00:00:00.000Z","tool":"claude","cwd":"/x","reason":"refused","action":"bypass"}\n');
    const code = await setup.runSetup(['--wrap-binaries', '--remove'], overrides());
    assert.equal(code, 1);
    assert.match(err.join('\n'), /modified since setup/);
    assert.ok(fs.existsSync(shim));
    assert.equal(fs.readFileSync(path.join(root, '.bashrc'), 'utf8'), 'export LATER=1\n');
    assert.ok(fs.existsSync(path.join(home, 'shim-bypass.log')));
  });

  it('is a no-op when nothing is installed', async () => {
    const before = snapshot(root);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 0);
    assert.deepEqual(snapshot(root), before);
    assert.match(out.join('\n'), /nothing to remove/);
  });
});

describe('--check', () => {
  it('reports not installed', async () => {
    assert.equal(await setup.runSetup(['--wrap-binaries', '--check'], overrides()), 0);
    assert.match(out.join('\n'), /not installed/);
  });

  it('reports shims active, the proxy state and recent bypass counts', async () => {
    const o = overrides({ env: { PATH: `${path.join(home, 'shims')}:/usr/bin:/bin`, CCXRAY_SHIM_PORT: '1' } });
    await setup.runSetup(['--wrap-binaries', '--yes'], o);
    const now = Date.now();
    const line = (t, reason) => JSON.stringify({ t: new Date(t).toISOString(), tool: 'codex', cwd: '/x', reason, action: 'bypass' });
    fs.writeFileSync(path.join(home, 'shim-bypass.log'),
      [line(now - 1000, 'refused'), line(now - 2000, 'timeout'), line(now - 3 * 86400000, 'refused'), 'not json'].join('\n') + '\n');
    const code = await setup.runSetup(['--wrap-binaries', '--check'], overrides({ env: { PATH: `${path.join(home, 'shims')}:/usr/bin:/bin`, CCXRAY_SHIM_PORT: '1' } }));
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /installed in .*shims/);
    assert.match(text, /claude: shim is first on this process's PATH/);
    assert.match(text, /proxy on 127\.0\.0\.1:1: not reachable/);
    assert.match(text, /2 in the last 24h .*refused×1.*timeout×1.*3 total/);
  });

  it('warns when the shim is shadowed on PATH and fails when a shim file was deleted', async () => {
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    await setup.runSetup(['--wrap-binaries', '--check'], overrides());
    assert.match(out.join('\n'), /warn claude: this process's PATH resolves it to nothing/);
    fs.rmSync(path.join(home, 'shims', 'codex'));
    assert.equal(await setup.runSetup(['--wrap-binaries', '--check'], overrides()), 1);
    assert.match(out.join('\n'), /FAIL codex missing or modified/);
  });
});

describe('plain `ccxray setup --remove` also removes shims', () => {
  it('removes them when installed (their state is part of setup)', async () => {
    await setup.runSetup(['--wrap-binaries', '--yes'], overrides());
    assert.ok(fs.existsSync(path.join(home, 'shims.json')));
    const o = overrides();
    await setup.runSetup(['--remove', '--dry-run'], { ...o, env: o.shims.env, homedir: () => root });
    assert.ok(fs.existsSync(path.join(home, 'shims.json')), '--dry-run must not remove');
    await shims.removeIfInstalled({ remove: true }, overrides().shims);
    assert.ok(!fs.existsSync(path.join(home, 'shims.json')));
    assert.ok(!fs.existsSync(path.join(home, 'shims')));
  });
});

describe('bypass summary', () => {
  it('counts recent, total and refused lines without exposing cwd', () => {
    fs.mkdirSync(home, { recursive: true });
    const now = Date.parse('2026-10-22T12:00:00Z');
    fs.writeFileSync(path.join(home, 'shim-bypass.log'), [
      { t: '2026-10-22T11:00:00.000Z', tool: 'claude', cwd: '/secret', reason: 'refused', action: 'bypass' },
      { t: '2026-10-20T11:00:00.000Z', tool: 'codex', cwd: '/secret', reason: 'timeout', action: 'bypass' },
      { t: '2026-10-22T11:30:00.000Z', tool: 'claude', cwd: '/secret', reason: 'refused', action: 'refused' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const s = summarizeBypasses(home, { now });
    assert.deepEqual({ recent: s.recent, total: s.total, refused: s.refused }, { recent: 1, total: 2, refused: 1 });
    assert.equal(s.lastAt, '2026-10-22T11:00:00.000Z');
    assert.ok(!JSON.stringify(s).includes('/secret'));
    assert.match(renderBypassLine(s), /NOT recorded/);
    assert.equal(summarizeBypasses(path.join(root, 'nowhere')).total, 0);
  });
});
