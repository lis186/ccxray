'use strict';

// #690 — the ccxray home is created 0700 by every path, and an existing
// group/world-accessible home owned by the current user is tightened to 0700
// at startup with one notice line (no-op when already tight or not owned).
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

function run(base, ccxrayHome, args) {
  return spawnSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: base,
      CCXRAY_HOME: ccxrayHome,
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

  it('ensureCcxrayHome creates nested homes 0700 even under a permissive umask', () => {
    const base = tmpdir();
    const home = path.join(base, 'a', 'b');
    const prev = process.umask(0o022);
    try { paths.ensureCcxrayHome({ CCXRAY_HOME: home }); } finally { process.umask(prev); }
    assert.equal(mode(home), 0o700);
    assert.equal(mode(path.join(base, 'a')), 0o700);
  });

  it('startup tightens an existing 0755 home with one notice line, then is silent', () => {
    const base = tmpdir();
    const home = path.join(base, 'loose');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    const r = run(base, home, ['import', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(home), 0o700);
    const notices = r.stderr.split('\n').filter(l => /tightened/.test(l));
    assert.equal(notices.length, 1, r.stderr);
    assert.match(notices[0], /0700 \(was 0755\)/);

    const again = run(base, home, ['import', '--help']);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /tightened/);
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
