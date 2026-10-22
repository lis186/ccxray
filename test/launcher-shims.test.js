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
      if (ent.isSymbolicLink()) result[rel] = `link->${fs.readlinkSync(full)}`;
      else if (ent.isDirectory()) { result[rel] = 'dir'; walk(full); }
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
    assert.match(text, /2 in the last 24h .*refused×1.*timeout×1.*3 retained/);
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

// ── Review round 1 (#734): ownership, rollback, reinstall, plain --remove ──

const envConf = () => path.join(root, '.config', 'environment.d', '50-ccxray-shims.conf');
const install = (extra = [], o = overrides()) => setup.runSetup(['--wrap-binaries', '--yes', ...extra], o);

// A throwaway fs wrapper that fails one operation on demand.
function failingFs(failWhen) {
  return new Proxy(fs, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => { failWhen(String(prop), args); return value.apply(target, args); };
    },
  });
}

describe('pre-existing auxiliary files are never destroyed (finding 1)', () => {
  it('refuses an existing probe helper and changes nothing else', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'shim-probe.js'), 'USER PROBE', { mode: 0o640 });
    const before = snapshot(root);
    const o = overrides();
    assert.equal(await install([], o), 1);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.statSync(path.join(home, 'shim-probe.js')).mode & 0o777, 0o640);
    assert.match(err.join('\n'), /shim-probe\.js already exists and was not installed by ccxray.*Nothing was changed/s);
  });

  it('refuses an existing environment.d file (its PATH config survives install and remove)', async () => {
    fs.mkdirSync(path.dirname(envConf()), { recursive: true });
    fs.writeFileSync(envConf(), 'PATH=/opt/mine:$PATH\n');
    const before = snapshot(root);
    assert.equal(await install(), 1);
    assert.deepEqual(snapshot(root), before);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 0);
    assert.equal(fs.readFileSync(envConf(), 'utf8'), 'PATH=/opt/mine:$PATH\n');
    assert.equal(await install(['--no-session-env']), 0, '--no-session-env is the documented way around it');
    assert.equal(fs.readFileSync(envConf(), 'utf8'), 'PATH=/opt/mine:$PATH\n');
  });

  it('refuses a symlink at the probe or environment.d path and never writes through it', async () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'shim-probe.js'));
    assert.equal(await install(), 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
    assert.ok(fs.lstatSync(path.join(home, 'shim-probe.js')).isSymbolicLink());
    fs.rmSync(path.join(home, 'shim-probe.js'));
    fs.mkdirSync(path.dirname(envConf()), { recursive: true });
    fs.symlinkSync(outside, envConf());
    assert.equal(await install(), 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
    assert.ok(!fs.existsSync(path.join(home, 'shims')), 'preflight failed before any write');
  });

  it('--dry-run reports the refusal instead of promising a write', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'shim-probe.js'), 'USER PROBE');
    assert.equal(await setup.runSetup(['--wrap-binaries', '--dry-run'], overrides()), 1);
    assert.match(err.join('\n'), /would REFUSE: .*shim-probe\.js/);
  });

  it('a failure half way through leaves the tree exactly as it was', async () => {
    fs.writeFileSync(path.join(root, '.bashrc'), 'export A=1');
    fs.writeFileSync(path.join(root, '.profile'), '# profile\n');
    const before = snapshot(root);
    // Fail while the session PATH file is written: probe, shims and both profiles already changed by then.
    const broken = failingFs((op, args) => {
      if (op === 'writeFileSync' && String(args[0]).includes('environment.d')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const o = overrides();
    o.shims.fs = broken;
    assert.equal(await install([], o), 1);
    assert.match(err.join('\n'), /Setup failed \(disk full\); rolling back/);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('reinstall validates ownership first (finding 2)', () => {
  it('a clean reinstall succeeds and is byte-stable', async () => {
    assert.equal(await install(), 0);
    const first = snapshot(root);
    assert.equal(await install(), 0);
    assert.deepEqual(snapshot(root), first);
  });

  it('never overwrites a shim the user edited, and keeps the recovery record', async () => {
    await install();
    const shim = path.join(home, 'shims', 'claude');
    fs.writeFileSync(shim, '#!/bin/sh\n# my own edit\n');
    const manifest = fs.readFileSync(path.join(home, 'shims.json'), 'utf8');
    assert.equal(await install(), 1);
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\n# my own edit\n');
    assert.equal(fs.readFileSync(path.join(home, 'shims.json'), 'utf8'), manifest);
    assert.match(err.join('\n'), /claude was modified since setup/);
    // remove preserves it too, and a later install still refuses it
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 1);
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\n# my own edit\n');
    assert.equal(await install(), 1);
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\n# my own edit\n');
  });

  it('never writes through a symlink planted at a shim path', async () => {
    await install();
    const outside = path.join(root, 'victim.txt');
    fs.writeFileSync(outside, 'VICTIM');
    const shim = path.join(home, 'shims', 'codex');
    fs.rmSync(shim);
    fs.symlinkSync(outside, shim);
    assert.equal(await install(), 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'VICTIM');
    assert.ok(fs.lstatSync(shim).isSymbolicLink());
    assert.match(err.join('\n'), /codex is a symlink/);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'VICTIM', 'remove does not follow it either');
    assert.ok(fs.lstatSync(shim).isSymbolicLink());
  });

  it('keeps the manifest when the previous install cannot be undone, and writes nothing new', async () => {
    await install();
    const manifest = fs.readFileSync(path.join(home, 'shims.json'), 'utf8');
    const o = overrides();
    o.shims.fs = failingFs((op, args) => { if (op === 'unlinkSync' && String(args[0]) === path.join(root, '.profile')) throw Object.assign(new Error('read-only'), { code: 'EROFS' }); });
    assert.equal(await install([], o), 1);
    assert.match(err.join('\n'), /Could not undo the previous install; nothing new was written/);
    assert.equal(fs.readFileSync(path.join(home, 'shims.json'), 'utf8'), manifest, 'the recovery record is kept');
    assert.doesNotMatch(err.join('\n'), /rolling back/);
  });
});

describe('plain `ccxray setup --remove` shares one preview, consent and failure model (finding 7)', () => {
  const plain = (args, o = overrides()) => setup.runSetup(['--remove', ...args], { ...o, env: o.shims.env, homedir: () => root, logger: o.shims.logger });

  it('--dry-run lists the shim changes and changes nothing', async () => {
    await install();
    const before = snapshot(root);
    assert.equal(await plain(['--dry-run']), 0);
    assert.deepEqual(snapshot(root), before);
    assert.match(out.join('\n'), /would delete .*shims\/claude/);
    assert.match(out.join('\n'), /would remove the PATH block from .*\.bashrc/);
  });

  it('shows the shim changes at the consent step, and a refusal removes nothing', async () => {
    await install();
    const before = snapshot(root);
    const code = await plain([]); // not a TTY and no --yes
    assert.equal(code, 2);
    assert.deepEqual(snapshot(root), before);
    assert.match(out.join('\n'), /launcher shims: would delete/);
  });

  it('removes the shims together with setup when consent is given', async () => {
    await install();
    assert.equal(await plain(['--yes']), 0);
    assert.ok(!fs.existsSync(path.join(home, 'shims.json')));
    assert.ok(!fs.existsSync(path.join(home, 'shims')));
    assert.ok(!fs.existsSync(envConf()));
  });

  it('leaves the shims alone when setup removal itself fails', async () => {
    await install();
    // A setup block with no end marker is a malformed target: removal reports failure.
    fs.appendFileSync(path.join(root, '.zshrc'), `${setup.START_MARKER}\nexport FOO=1\n`);
    const o = overrides({ env: { SHELL: '/bin/zsh' } });
    const code = await plain(['--yes'], o);
    assert.notEqual(code, 0);
    assert.ok(fs.existsSync(path.join(home, 'shims.json')), 'shims must stay installed');
    assert.ok(fs.existsSync(path.join(home, 'shims', 'claude')));
    assert.match(err.join('\n'), /Launcher shims were left installed/);
  });

  it('propagates a shim-removal failure to the exit code', async () => {
    await install();
    const o = overrides();
    o.shims.fs = failingFs((op, args) => { if (op === 'unlinkSync' && String(args[0]).endsWith(`${path.sep}claude`)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
    const code = await plain(['--yes'], o);
    assert.equal(code, 1);
    assert.match(err.join('\n'), /permission denied/);
    assert.ok(fs.existsSync(path.join(home, 'shims.json')), 'the recovery record is kept for a retry');
  });
});

// ── Review round 2 (#734): manifest conflicts and profile rollback ──

describe('an unrecognized shims.json is never replaced or deleted (round 2, must-fix 2)', () => {
  const manifestPath = () => path.join(home, 'shims.json');
  const fixtures = {
    'malformed JSON': () => fs.writeFileSync(manifestPath(), '{ not json'),
    'an unsupported (future) version': () => fs.writeFileSync(manifestPath(), JSON.stringify({ version: 2, shimDir: '/x', files: [] })),
    'a wrong shape': () => fs.writeFileSync(manifestPath(), JSON.stringify({ version: 1, shimDir: '/x', files: 'nope' })),
    'a symlink': () => { fs.writeFileSync(path.join(root, 'elsewhere.json'), '{"version":1}'); fs.symlinkSync(path.join(root, 'elsewhere.json'), manifestPath()); },
    'a directory': () => fs.mkdirSync(manifestPath()),
  };

  for (const [name, plant] of Object.entries(fixtures)) {
    it(`refuses install, shows it in dry-run, and removes nothing for ${name}`, async () => {
      fs.mkdirSync(home, { recursive: true });
      plant();
      const before = fs.lstatSync(manifestPath());
      const target = fs.lstatSync(manifestPath()).isSymbolicLink() ? fs.readlinkSync(manifestPath()) : null;
      const tree = snapshot(root);
      assert.equal(await install([], overrides()), 1);
      assert.match(err.join('\n'), /shims\.json .*(not readable JSON|unsupported version|expected shape|symlink|not a regular file).*|Nothing was changed/s);
      assert.match(err.join('\n'), /Nothing was changed/);
      assert.deepEqual(snapshot(root), tree);
      assert.equal(fs.lstatSync(manifestPath()).ino, before.ino);
      if (target) assert.equal(fs.readlinkSync(manifestPath()), target);

      assert.equal(await setup.runSetup(['--wrap-binaries', '--dry-run'], overrides()), 1);
      assert.match(err.join('\n'), /would REFUSE: .*shims\.json/);

      assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 1);
      assert.match(err.join('\n'), /Refusing to remove: .*shims\.json/);
      assert.equal(await setup.runSetup(['--wrap-binaries', '--check'], overrides()), 1);
      assert.match(err.join('\n'), /FAIL .*shims\.json/);
      assert.deepEqual(snapshot(root), tree, 'remove/check left everything in place');
      assert.equal(fs.lstatSync(manifestPath()).ino, before.ino);
    });
  }

  it('an absent manifest still installs, and plain `setup --remove` leaves an unreadable one alone', async () => {
    assert.equal(await install([], overrides()), 0);
    fs.writeFileSync(manifestPath(), 'garbage');
    const o = overrides();
    assert.equal(await shims.removeIfInstalled({}, o.shims), 0);
    assert.match(err.join('\n'), /warning: .*shims\.json/);
    assert.equal(fs.readFileSync(manifestPath(), 'utf8'), 'garbage');
  });
});

describe('robust profile reads and raw-byte fidelity (review round 3)', () => {
  // Fails readFileSync for one profile (optionally only from its Nth read on).
  function failingReadFs(match, code, { fromRead = 1 } = {}) {
    let reads = 0;
    return new Proxy(fs, {
      get(target, prop) {
        const value = target[prop];
        if (prop !== 'readFileSync') return typeof value === 'function' ? value.bind(target) : value;
        return (file, ...rest) => {
          if (match(String(file)) && ++reads >= fromRead) throw Object.assign(new Error(`injected ${code}`), { code });
          return target.readFileSync(file, ...rest);
        };
      },
    });
  }
  const RAW = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x4b, 0x3d, 0xc3, 0x28, 0x0a, 0x80]);

  for (const code of ['EACCES', 'EIO']) {
    for (const fromRead of [1, 2]) {
      it(`${code} reading an existing profile (read #${fromRead}) refuses the install and changes nothing`, async () => {
        fs.writeFileSync(path.join(root, '.bashrc'), RAW);
        fs.writeFileSync(path.join(root, '.profile'), '# sibling\n');
        const tree = snapshot(root);
        const o = overrides();
        o.shims.fs = failingReadFs(file => path.basename(file) === '.bashrc', code, { fromRead });
        assert.equal(await install([], o), 1);
        assert.match(err.join('\n'), new RegExp(`(cannot be resolved or read|cannot be read) \\(${code}\\)|\\(${code}\\)`));
        assert.deepEqual(snapshot(root), tree, 'profiles and siblings untouched, no stray files');
        assert.ok(Buffer.from(fs.readFileSync(path.join(root, '.bashrc'))).equals(RAW));
        assert.ok(!fs.existsSync(home), 'nothing was created');
      });
    }
  }

  it('a profile with invalid UTF-8 bytes survives install then remove byte for byte', async () => {
    const bashrc = path.join(root, '.bashrc');
    fs.writeFileSync(bashrc, RAW, { mode: 0o600 });
    fs.writeFileSync(path.join(root, '.profile'), RAW);
    assert.equal(await install([], overrides()), 0);
    const installed = fs.readFileSync(bashrc);
    assert.ok(installed.subarray(0, RAW.length).equals(RAW), 'original bytes kept in place');
    assert.match(installed.toString('latin1'), /# >>> ccxray shims >>>/);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides()), 0);
    assert.ok(fs.readFileSync(bashrc).equals(RAW), 'removal restores the raw bytes');
    assert.ok(fs.readFileSync(path.join(root, '.profile')).equals(RAW));
  });

  it('an install that fails part way restores raw-byte profiles byte for byte', async () => {
    const bashrc = path.join(root, '.bashrc');
    const login = path.join(root, '.profile');
    fs.writeFileSync(bashrc, RAW);
    fs.writeFileSync(login, RAW);
    const o = overrides();
    o.shims.fs = new Proxy(fs, {
      get(target, prop) {
        const value = target[prop];
        if (prop !== 'renameSync') return typeof value === 'function' ? value.bind(target) : value;
        // Let the first profile replacement land, fail the second.
        let profileRenames = 0;
        return (from, to) => {
          if (/\.(bashrc|profile)$/.test(String(to)) && ++profileRenames > 0 && String(to).endsWith('.bashrc')) {
            throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
          }
          return target.renameSync(from, to);
        };
      },
    });
    assert.equal(await install([], o), 1);
    assert.ok(fs.readFileSync(bashrc).equals(RAW));
    assert.ok(fs.readFileSync(login).equals(RAW));
    assert.deepEqual(fs.readdirSync(root).filter(n => n.includes('.tmp')), []);
  });
});

describe('profile writes are atomic and roll back exactly (round 2, must-fix 3)', () => {
  // Writes a prefix of the data and then fails: what a short write / ENOSPC does.
  function shortWriteFs(match) {
    return new Proxy(fs, {
      get(target, prop) {
        const value = target[prop];
        if (prop !== 'writeFileSync') return typeof value === 'function' ? value.bind(target) : value;
        return (file, data, opts) => {
          if (match(String(file))) {
            target.writeFileSync(file, String(data).slice(0, 7), opts);
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          }
          return target.writeFileSync(file, data, opts);
        };
      },
    });
  }

  it('a profile write that stores a prefix then fails restores every byte, mode and link', async () => {
    fs.mkdirSync(path.join(root, 'dotfiles'));
    const real = path.join(root, 'dotfiles', 'profile');
    fs.writeFileSync(real, '# my login profile\nexport KEEP=1\n', { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, path.join(root, '.profile'));
    fs.writeFileSync(path.join(root, '.bashrc'), 'alias ll="ls -l"', { mode: 0o600 });
    fs.chmodSync(path.join(root, '.bashrc'), 0o600);
    const tree = snapshot(root);
    const o = overrides();
    // The second profile's write dies half way (the first one is already replaced).
    o.shims.fs = shortWriteFs(file => path.basename(file).startsWith('.bashrc'));
    assert.equal(await install([], o), 1);
    assert.match(err.join('\n'), /Setup failed \(disk full\); rolling back/);
    assert.deepEqual(snapshot(root), tree, 'no stray temp file, no changed byte');
    assert.equal(fs.readFileSync(real, 'utf8'), '# my login profile\nexport KEEP=1\n');
    assert.equal(fs.readFileSync(path.join(root, '.bashrc'), 'utf8'), 'alias ll="ls -l"');
    assert.equal(fs.statSync(real).mode & 0o777, 0o640);
    assert.equal(fs.statSync(path.join(root, '.bashrc')).mode & 0o777, 0o600);
    assert.ok(fs.lstatSync(path.join(root, '.profile')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(root, '.profile')), real);
    assert.deepEqual(fs.readdirSync(path.join(root, 'dotfiles')), ['profile']);
  });

  it('install and remove keep a symlinked profile a symlink and keep its mode', async () => {
    fs.mkdirSync(path.join(root, 'dotfiles'));
    const real = path.join(root, 'dotfiles', 'zshenv');
    fs.writeFileSync(real, 'export A=1', { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, path.join(root, '.zshenv'));
    assert.equal(await install(['--shell', 'zsh'], overrides({ env: { SHELL: '/bin/zsh' } })), 0);
    assert.ok(fs.lstatSync(path.join(root, '.zshenv')).isSymbolicLink());
    assert.match(fs.readFileSync(real, 'utf8'), /^export A=1\n# >>> ccxray shims >>>/);
    assert.equal(fs.statSync(real).mode & 0o777, 0o640);
    assert.equal(await setup.runSetup(['--wrap-binaries', '--remove'], overrides({ env: { SHELL: '/bin/zsh' } })), 0);
    assert.equal(fs.readFileSync(real, 'utf8'), 'export A=1');
    assert.ok(fs.lstatSync(path.join(root, '.zshenv')).isSymbolicLink());
    assert.equal(fs.statSync(real).mode & 0o777, 0o640);
  });

  it('refuses (before any write) a profile that is a dangling link or a directory', async () => {
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, '.bashrc'));
    fs.writeFileSync(path.join(root, '.profile'), '# p\n');
    const tree = snapshot(root);
    assert.equal(await install([], overrides()), 1);
    assert.match(err.join('\n'), /\.bashrc cannot be resolved or read/);
    assert.deepEqual(snapshot(root), tree);
    assert.ok(fs.lstatSync(path.join(root, '.bashrc')).isSymbolicLink());
    assert.ok(!fs.existsSync(home));
  });
});
