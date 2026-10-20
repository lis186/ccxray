'use strict';

// #690 — the ccxray home is created 0700 by every path, and an existing
// group/world-accessible home owned by the current user is tightened to 0700
// at startup with one notice line (no-op when already tight or not owned).
// Only the default ~/.ccxray is chmod'ed; a loose custom CCXRAY_HOME only
// warns, even after ccxray has written its own files into it, a symlinked
// default home only warns, and $HOME (or an ancestor) is never chmod'ed,
// including through a symlink.
//
// Isolation (docs/testing.md): throwaway HOME and CCXRAY_HOME per case;
// CCXRAY_IMPORT_HOMES / CCXRAY_IMPORT_CODEX_HOMES pinned to empty dirs so the
// `import --once` run never scans real transcripts.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'index.js');
const paths = require('../server/paths');

const POSIX = process.platform !== 'win32';
const TEMP_DIRS = [];
after(() => {
  for (const d of TEMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-perm-'));
  TEMP_DIRS.push(d);
  return d;
}

function mode(p) { return fs.statSync(p).mode & 0o777; }

// ccxrayHome === null runs with CCXRAY_HOME unset, i.e. the default <HOME>/.ccxray.
function run(base, ccxrayHome, args) {
  const env = { ...process.env };
  delete env.CCXRAY_HOME;
  if (ccxrayHome !== null) env.CCXRAY_HOME = ccxrayHome;
  return spawnSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env: {
      ...env,
      HOME: base,
      CCXRAY_IMPORT_DISABLE: '0',
      CCXRAY_IMPORT_HOMES: fs.mkdtempSync(path.join(base, 'noclaude-')),
      CCXRAY_IMPORT_CODEX_HOMES: fs.mkdtempSync(path.join(base, 'nocodex-')),
      CCXRAY_EXPORT_DISABLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000,
  });
}

function walkDirs(root) {
  const out = [root];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.isDirectory()) out.push(...walkDirs(path.join(root, ent.name)));
  }
  return out;
}

describe('ccxray home permissions (#690)', { skip: !POSIX && 'POSIX mode bits only' }, () => {
  it('import --once creates a fresh home (and its subdirectories) as 0700', () => {
    const base = tmpdir();
    const home = path.join(base, 'fresh', 'ccxray');
    const r = run(base, home, ['import', '--once']);
    assert.equal(r.status, 0, r.stderr);
    for (const dir of walkDirs(home)) assert.equal(mode(dir), 0o700, `${dir} is 0${mode(dir).toString(8)}`);
    assert.doesNotMatch(r.stderr, /tightened/, 'a fresh home needs no notice');
  });

  it('ensureCcxrayHome creates the home 0700 and leaves missing parents at the default mode', () => {
    const base = tmpdir();
    const home = path.join(base, 'a', 'b');
    const prev = process.umask(0o022);
    try { paths.ensureCcxrayHome({ CCXRAY_HOME: home }); } finally { process.umask(prev); }
    assert.equal(mode(home), 0o700);
    assert.equal(mode(path.join(base, 'a')), 0o755, 'a parent is not ccxray\'s to restrict');
    // Idempotent on an existing home.
    assert.equal(paths.ensureCcxrayHome({ CCXRAY_HOME: home }), home);
  });

  it('startup tightens an existing 0755 default home with one notice line, then is silent', () => {
    const base = tmpdir();
    const home = path.join(base, '.ccxray');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const r = run(base, null, ['import', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(home), 0o700);
    const notices = r.stderr.split('\n').filter(l => /tightened/.test(l));
    assert.equal(notices.length, 1, r.stderr);
    assert.match(notices[0], /0700 \(was 0755\)/);
    assert.ok(!r.stderr.includes('\x1b['), 'no ANSI colour when stderr is not a TTY');

    const again = run(base, null, ['import', '--help']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /tightened/);
  });

  it('startup warns about a loose custom CCXRAY_HOME and keeps its mode', () => {
    const base = tmpdir();
    const home = path.join(base, 'shared');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const r = run(base, home, ['import', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(home), 0o755);
    assert.doesNotMatch(r.stderr, /tightened/);
    const warnings = r.stderr.split('\n').filter(l => /warning: CCXRAY_HOME/.test(l));
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /0755/);
  });

  it('a loose custom CCXRAY_HOME stays warning-only after ccxray writes its own secret into it', () => {
    const base = tmpdir();
    const home = path.join(base, 'shared');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const first = run(base, home, ['import', '--help']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /warning: CCXRAY_HOME .* \(0755\)/);
    assert.equal(mode(home), 0o755);

    // Ordinary use: the auth layer creates local-secret inside the home.
    const secret = spawnSync(process.execPath, ['-e', "require('./server/auth').getRootSecret()"], {
      cwd: ROOT,
      env: { ...process.env, HOME: base, CCXRAY_HOME: home, AUTH_TOKEN: '', CCXRAY_EXPORT_DISABLE: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(secret.status, 0, secret.stderr);
    assert.ok(fs.statSync(path.join(home, 'local-secret')).isFile(), 'secret was created');
    assert.equal(mode(home), 0o755);

    const second = run(base, home, ['import', '--help']);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /tightened/);
    assert.match(second.stderr, /warning: CCXRAY_HOME .* \(0755\)/);
    assert.equal(mode(home), 0o755, 'a ccxray-written file must not make a shared dir chmod-eligible');
  });

  it('startup never chmods CCXRAY_HOME=$HOME', () => {
    const base = tmpdir();
    fs.chmodSync(base, 0o755);
    fs.writeFileSync(path.join(base, 'local-secret'), 'x'.repeat(32), { mode: 0o600 });
    const r = run(base, base, ['import', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(base), 0o755);
    assert.doesNotMatch(r.stderr, /tightened/);
  });

  it('tightenCcxrayHome warns instead of chmod for a custom home without ccxray files', () => {
    const home = tmpdir();
    fs.chmodSync(home, 0o775);
    const logs = [];
    assert.equal(paths.tightenCcxrayHome(home, { log: m => logs.push(m) }), 'warned');
    assert.equal(mode(home), 0o775);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /warning: CCXRAY_HOME .* \(0775\)/);
  });

  it('tightenCcxrayHome ignores ccxray files inside a custom home (local-secret, hub.sock)', () => {
    for (const name of ['local-secret', 'hub.sock']) {
      const home = tmpdir();
      fs.writeFileSync(path.join(home, name), 'x', { mode: 0o600 });
      fs.chmodSync(home, 0o755);
      assert.equal(paths.tightenCcxrayHome(home), 'warned', name);
      assert.equal(mode(home), 0o755);
    }
  });

  it('tightenCcxrayHome refuses $HOME and its ancestors', () => {
    const base = tmpdir();
    const fakeHome = path.join(base, 'user');
    fs.mkdirSync(fakeHome);
    fs.chmodSync(fakeHome, 0o755);
    fs.chmodSync(base, 0o755);
    assert.equal(paths.tightenCcxrayHome(fakeHome, { homedir: fakeHome }), 'warned');
    assert.equal(paths.tightenCcxrayHome(fakeHome + path.sep, { homedir: fakeHome }), 'warned');
    assert.equal(paths.tightenCcxrayHome(base, { homedir: fakeHome }), 'warned');
    assert.equal(mode(fakeHome), 0o755);
    assert.equal(mode(base), 0o755);
  });

  it('tightenCcxrayHome tightens the default home under an injected homedir', () => {
    const base = tmpdir();
    const home = path.join(base, '.ccxray');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    assert.equal(paths.tightenCcxrayHome(home, { homedir: base }), 'tightened');
    assert.equal(mode(home), 0o700);
  });

  it('tightenCcxrayHome never follows a default-home symlink to a shared directory', () => {
    const base = tmpdir();
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    const home = path.join(base, '.ccxray');
    fs.symlinkSync(shared, home);
    const logs = [];
    assert.equal(paths.tightenCcxrayHome(home, { log: m => logs.push(m), homedir: base }), 'warned');
    assert.equal(mode(shared), 0o755);
    assert.match(logs[0], /warning: CCXRAY_HOME .* \(0755\)/);
  });

  it('tightenCcxrayHome never chmods $HOME through `~/.ccxray -> .`', () => {
    const base = tmpdir();
    fs.chmodSync(base, 0o755);
    const home = path.join(base, '.ccxray');
    fs.symlinkSync('.', home);
    assert.equal(paths.tightenCcxrayHome(home, { homedir: base }), 'warned');
    assert.equal(mode(base), 0o755);
  });

  it('startup never chmods $HOME through a default-home symlink', () => {
    const base = tmpdir();
    fs.chmodSync(base, 0o755);
    fs.symlinkSync('.', path.join(base, '.ccxray'));
    const r = run(base, null, ['import', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(base), 0o755);
    assert.doesNotMatch(r.stderr, /tightened/);
  });

  it('tightenCcxrayHome preserves setgid/sticky bits', () => {
    const home = path.join(tmpdir(), '.ccxray');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o3775);
    const st = fs.statSync(home);
    if ((st.mode & 0o3000) !== 0o3000) return; // filesystem refused the special bits
    const logs = [];
    assert.equal(paths.tightenCcxrayHome(home, { log: m => logs.push(m), homedir: path.dirname(home) }), 'tightened');
    assert.equal(fs.statSync(home).mode & 0o7777, 0o3700);
    assert.match(logs[0], /to 03700 \(was 03775\)/);
  });

  it('tightenCcxrayHome is a no-op on an already-tight home', () => {
    const home = tmpdir();
    fs.chmodSync(home, 0o700);
    const logs = [];
    assert.equal(paths.tightenCcxrayHome(home, { log: m => logs.push(m) }), 'tight');
    assert.deepEqual(logs, []);
  });

  it('tightenCcxrayHome leaves a home owned by another user alone', () => {
    const home = tmpdir();
    fs.chmodSync(home, 0o755);
    const realGetuid = process.getuid;
    process.getuid = () => realGetuid() + 1;
    const logs = [];
    try {
      assert.equal(paths.tightenCcxrayHome(home, { log: m => logs.push(m) }), 'not-owned');
    } finally {
      process.getuid = realGetuid;
    }
    assert.equal(mode(home), 0o755);
    assert.deepEqual(logs, []);
  });

  it('tightenCcxrayHome reports a missing home and skips Windows', () => {
    const base = tmpdir();
    assert.equal(paths.tightenCcxrayHome(path.join(base, 'absent')), 'missing');
    fs.chmodSync(base, 0o755);
    assert.equal(paths.tightenCcxrayHome(base, { platform: 'win32' }), 'skipped');
    assert.equal(mode(base), 0o755);
  });
});
