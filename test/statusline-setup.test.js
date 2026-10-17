'use strict';

// #687 — `ccxray setup-statusline` must never write on --help / unknown flags,
// must support --dry-run and a non-interactive --remove, must write
// `{ "type": "command", ... }`, and must back up + atomically rewrite the
// Claude settings.json. Also covers `ccxray import --help`.
//
// Isolation (docs/testing.md): every CLI run gets a throwaway HOME (holding a
// synthetic .claude/settings.json) and CCXRAY_HOME; stdin is /dev/null, so the
// TTY picker is never reached.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'index.js');
const setup = require('../server/statusline-setup');

const TEMP_DIRS = [];
after(() => {
  for (const d of TEMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-sls-'));
  TEMP_DIRS.push(home);
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(claudeHome);
  const settingsPath = path.join(claudeHome, 'settings.json');
  if (settings !== undefined) {
    fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n');
  }
  return { home, claudeHome, settingsPath };
}

function run(home, args) {
  return spawnSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, CCXRAY_HOME: path.join(home, 'ccxray-home'), CCXRAY_EXPORT_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000,
  });
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')]);
}

const BACKUP_RE = /^settings\.json\.bak-\d{8}T\d{6}Z(-\d+)?$/;

describe('setup-statusline CLI (#687)', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} prints usage, exits 0 and writes nothing`, () => {
      const sc = makeHome({ statusLine: { command: 'echo mine' } });
      const before = snapshot(sc.claudeHome);
      const r = run(sc.home, ['setup-statusline', flag]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Usage: ccxray setup-statusline/);
      assert.match(r.stdout, /--dry-run/);
      assert.match(r.stdout, /--remove/);
      assert.match(r.stdout, /settings\.json\.bak-<UTC timestamp>/, 'usage names the backup location');
      assert.deepEqual(snapshot(sc.claudeHome), before);
    });
  }

  it('an unknown flag exits non-zero and writes nothing', () => {
    const sc = makeHome({ statusLine: { command: 'echo mine' } });
    const before = snapshot(sc.claudeHome);
    const r = run(sc.home, ['setup-statusline', '--bogus']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown argument "--bogus"/);
    assert.deepEqual(snapshot(sc.claudeHome), before);
  });

  it('--claude-home without a value exits non-zero and writes nothing', () => {
    const sc = makeHome({});
    const before = snapshot(sc.claudeHome);
    const r = run(sc.home, ['setup-statusline', '--claude-home']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(snapshot(sc.claudeHome), before);
  });

  it('--dry-run shows the planned change without writing', () => {
    const sc = makeHome({ theme: 'dark', statusLine: { command: 'echo mine' } });
    const before = snapshot(sc.claudeHome);
    const r = run(sc.home, ['setup-statusline', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dry run — nothing written/);
    assert.match(r.stdout, /would install/);
    assert.match(r.stdout, /"type":"command"/);
    assert.match(r.stdout, /claude-adapter/);
    assert.deepEqual(snapshot(sc.claudeHome), before);
  });

  it('installs { type: "command", command } and backs up the original', () => {
    const original = { theme: 'dark', statusLine: { command: 'echo mine', padding: 1 } };
    const sc = makeHome(original);
    const originalRaw = fs.readFileSync(sc.settingsPath, 'utf8');
    const r = run(sc.home, ['setup-statusline']);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8'));
    assert.equal(written.statusLine.type, 'command');
    assert.match(written.statusLine.command, /claude-adapter/);
    assert.equal(written.statusLine._ccxrayDelegate, 'echo mine');
    assert.equal(written.statusLine.padding, 1);
    assert.equal(written.theme, 'dark');
    const backups = fs.readdirSync(sc.claudeHome).filter(n => n.startsWith('settings.json.bak-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], BACKUP_RE);
    assert.equal(fs.readFileSync(path.join(sc.claudeHome, backups[0]), 'utf8'), originalRaw);
    assert.ok(!fs.readdirSync(sc.claudeHome).some(n => n.endsWith('.tmp')), 'no tmp file left behind');
  });

  it('--remove uninstalls non-interactively (no TTY) and restores the delegate', () => {
    const sc = makeHome({ theme: 'dark', statusLine: { command: 'echo mine' } });
    assert.equal(run(sc.home, ['setup-statusline']).status, 0);
    const installedRaw = fs.readFileSync(sc.settingsPath, 'utf8');

    const dry = run(sc.home, ['setup-statusline', '--remove', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would remove/);
    assert.equal(fs.readFileSync(sc.settingsPath, 'utf8'), installedRaw);

    const r = run(sc.home, ['setup-statusline', '--remove']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed/);
    const restored = JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8'));
    assert.equal(restored.statusLine.command, 'echo mine');
    assert.equal(restored.statusLine._ccxrayDelegate, undefined);
    assert.equal(restored.theme, 'dark');
    const backups = fs.readdirSync(sc.claudeHome).filter(n => BACKUP_RE.test(n));
    assert.equal(backups.length, 2, 'install and remove each keep a backup');
    assert.ok(backups.some(b => fs.readFileSync(path.join(sc.claudeHome, b), 'utf8') === installedRaw));
  });

  it('--remove with --claude-home drops a statusline that was ours alone', () => {
    const sc = makeHome({ theme: 'dark' });
    assert.equal(run(sc.home, ['setup-statusline', '--claude-home', sc.claudeHome]).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8')).statusLine.type, 'command');
    const r = run(sc.home, ['setup-statusline', '--remove', '--claude-home', sc.claudeHome]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8')), { theme: 'dark' });
  });

  it('refuses an unparseable settings.json: exit 1, one line naming the path, nothing written', () => {
    for (const args of [['setup-statusline'], null]) {
      const sc = makeHome('{ not json');
      const before = snapshot(sc.claudeHome);
      const r = run(sc.home, args || ['setup-statusline', '--claude-home', sc.claudeHome]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, r.stderr);
      assert.ok(lines[0].includes(sc.settingsPath), lines[0]);
      assert.match(lines[0], /not valid JSON — fix or move it/);
      assert.deepEqual(snapshot(sc.claudeHome), before, 'no rewrite, backup or tmp file');
    }
  });

  it('refuses a settings.json that is valid JSON but not an object (null, [], number, string)', () => {
    for (const raw of ['null', '[]', '[1,2]', '42', '"abc"']) {
      const sc = makeHome(raw);
      const before = snapshot(sc.claudeHome);
      const r = run(sc.home, ['setup-statusline', '--claude-home', sc.claudeHome]);
      assert.equal(r.status, 1, `${raw}: ${r.stdout}${r.stderr}`);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, `${raw}: ${r.stderr}`);
      assert.match(lines[0], /not valid JSON — fix or move it/);
      assert.doesNotMatch(r.stderr, /TypeError|at .*\.js:\d+/, 'no stack trace');
      assert.deepEqual(snapshot(sc.claudeHome), before, `${raw}: no rewrite, backup or tmp file`);
    }
  });

  it('--dry-run on an unparseable settings.json says it would refuse', () => {
    const sc = makeHome('{ not json');
    const before = snapshot(sc.claudeHome);
    const r = run(sc.home, ['setup-statusline', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would refuse — .*not valid JSON; fix or move it/);
    assert.deepEqual(snapshot(sc.claudeHome), before);
  });

  it('--claude-home pointing at a missing directory is a one-line error, exit 1', () => {
    const sc = makeHome({});
    const missing = path.join(sc.home, 'nope');
    for (const extra of [[], ['--remove']]) {
      const r = run(sc.home, ['setup-statusline', '--claude-home', missing, ...extra]);
      assert.equal(r.status, 1);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, r.stderr);
      assert.match(lines[0], /--claude-home .*nope is not a directory/);
      assert.ok(!fs.existsSync(missing));
    }
  });

  it('--remove when nothing is installed changes nothing', () => {
    const sc = makeHome({ statusLine: { command: 'echo mine' } });
    const before = snapshot(sc.claudeHome);
    const r = run(sc.home, ['setup-statusline', '--remove']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(sc.claudeHome), before);
  });
});

describe('import --help (#687)', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} prints usage and exits 0`, () => {
      const sc = makeHome(undefined);
      const r = run(sc.home, ['import', flag]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Usage: ccxray import --once/);
      assert.doesNotMatch(r.stderr, /unknown import mode/);
    });
  }
});

describe('statusline-setup helpers (#687)', () => {
  it('a legacy install without "type" is repaired in place', () => {
    const sc = makeHome({ statusLine: { command: setup.adapterCommand() } });
    assert.equal(setup.installStatusline(sc.claudeHome).status, 'updated');
    assert.equal(JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8')).statusLine.type, 'command');
    assert.equal(setup.installStatusline(sc.claudeHome).status, 'already');
  });

  it('refuses an unparseable settings.json in the helper too', () => {
    const sc = makeHome('{ not json');
    assert.equal(setup.installStatusline(sc.claudeHome).status, 'refused');
    assert.equal(fs.readFileSync(sc.settingsPath, 'utf8'), '{ not json');
    assert.deepEqual(fs.readdirSync(sc.claudeHome), ['settings.json']);
  });

  it('non-object JSON is refused on install and left alone on uninstall', () => {
    for (const raw of ['null', '[]', '7', '"s"']) {
      const sc = makeHome(raw);
      assert.equal(setup.planInstall(sc.claudeHome).status, 'refused', raw);
      assert.equal(setup.installStatusline(sc.claudeHome).status, 'refused', raw);
      assert.equal(setup.planUninstall(sc.claudeHome).status, 'not_installed', raw);
      assert.equal(setup.uninstallStatusline(sc.claudeHome).status, 'not_installed', raw);
      assert.equal(setup.isStatuslineInstalled(sc.claudeHome), false, raw);
      assert.equal(fs.readFileSync(sc.settingsPath, 'utf8'), raw);
      assert.deepEqual(fs.readdirSync(sc.claudeHome), ['settings.json']);
    }
  });

  it('a non-object statusLine value is not spread into character keys', () => {
    const sc = makeHome({ theme: 'dark', statusLine: 'abc' });
    const plan = setup.planInstall(sc.claudeHome);
    assert.equal(plan.status, 'installed');
    assert.deepEqual(plan.after, { type: 'command', command: setup.adapterCommand() });
    setup.installStatusline(sc.claudeHome);
    const written = JSON.parse(fs.readFileSync(sc.settingsPath, 'utf8'));
    assert.deepEqual(written.statusLine, { type: 'command', command: setup.adapterCommand() });
    assert.equal(written.theme, 'dark');
  });

  it('backups are owner-only (0600) even when the original is 0644; the rewrite keeps 0644', { skip: process.platform === 'win32' }, () => {
    const sc = makeHome({ theme: 'dark' });
    fs.chmodSync(sc.settingsPath, 0o644);
    const { backup } = setup.installStatusline(sc.claudeHome);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sc.settingsPath).mode & 0o777, 0o644);
  });

  it('never follows a pre-planted symlink at the tmp path', { skip: process.platform === 'win32' }, () => {
    const sc = makeHome({ theme: 'dark' });
    const originalRaw = fs.readFileSync(sc.settingsPath, 'utf8');
    const victim = path.join(sc.home, 'victim');
    fs.writeFileSync(victim, 'precious');
    const tmp = `${fs.realpathSync(sc.settingsPath)}.ccxray-${process.pid}.tmp`;
    fs.symlinkSync(victim, tmp);
    assert.throws(() => setup.installStatusline(sc.claudeHome), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(victim, 'utf8'), 'precious', 'symlink target not written');
    assert.ok(fs.lstatSync(tmp).isSymbolicLink(), 'a file we did not create is not unlinked');
    assert.ok(fs.lstatSync(sc.settingsPath).isFile(), 'settings.json not replaced by the link');
    assert.equal(fs.readFileSync(sc.settingsPath, 'utf8'), originalRaw);
  });

  it('a new settings.json is written without a backup', () => {
    const sc = makeHome(undefined);
    const result = setup.installStatusline(sc.claudeHome);
    assert.equal(result.status, 'installed');
    assert.equal(result.backup, null);
    assert.deepEqual(fs.readdirSync(sc.claudeHome), ['settings.json']);
  });

  it('writes atomically: a failed rename leaves the original intact and no tmp file', () => {
    const sc = makeHome({ theme: 'dark' });
    const originalRaw = fs.readFileSync(sc.settingsPath, 'utf8');
    const realRename = fs.renameSync;
    const renames = [];
    fs.renameSync = (from, to) => { renames.push([from, to]); throw Object.assign(new Error('boom'), { code: 'EIO' }); };
    try {
      assert.throws(() => setup.installStatusline(sc.claudeHome), /boom/);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(renames.length, 1);
    assert.equal(path.dirname(renames[0][0]), sc.claudeHome, 'tmp file lives beside the target');
    assert.equal(renames[0][1], sc.settingsPath);
    assert.equal(fs.readFileSync(sc.settingsPath, 'utf8'), originalRaw);
    assert.ok(!fs.readdirSync(sc.claudeHome).some(n => n.endsWith('.tmp')));
  });

  it('writes through a symlinked settings.json instead of replacing the link', () => {
    const sc = makeHome(undefined);
    const real = path.join(sc.home, 'dotfiles-settings.json');
    fs.writeFileSync(real, JSON.stringify({ theme: 'dark' }));
    fs.symlinkSync(real, sc.settingsPath);
    assert.equal(setup.installStatusline(sc.claudeHome).status, 'installed');
    assert.ok(fs.lstatSync(sc.settingsPath).isSymbolicLink());
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).statusLine.type, 'command');
  });

  it('two backups in the same second do not overwrite each other', () => {
    const sc = makeHome({ a: 1 });
    const now = new Date('2026-10-17T00:00:00Z');
    const b1 = setup.writeSettingsFile(sc.settingsPath, { a: 2 }, { now });
    const b2 = setup.writeSettingsFile(sc.settingsPath, { a: 3 }, { now });
    assert.notEqual(b1, b2);
    assert.deepEqual(JSON.parse(fs.readFileSync(b1, 'utf8')), { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(b2, 'utf8')), { a: 2 });
  });

  it('parses arguments', () => {
    assert.deepEqual(setup.parseSetupStatuslineArgs([]), { claudeHome: null, remove: false, dryRun: false });
    assert.deepEqual(setup.parseSetupStatuslineArgs(['--remove', '--dry-run', '--claude-home', '/x']),
      { claudeHome: '/x', remove: true, dryRun: true });
    assert.deepEqual(setup.parseSetupStatuslineArgs(['--remove', '-h']), { help: true });
    assert.ok(setup.parseSetupStatuslineArgs(['extra']).error);
  });
});
