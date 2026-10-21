'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// realpath: git writes physical absolute pointers, and macOS's tmpdir is a symlink.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-git-sha-')));
process.env.CCXRAY_HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.CCXRAY_HOME, { recursive: true });

const gitSha = require('../server/git-sha');
const hub = require('../server/hub');
const auth = require('../server/auth');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1'.repeat(20);
const SHA_C = 'c2'.repeat(20);

let n = 0;
function mk() {
  const d = path.join(TMP, `case-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function repo(headText = 'ref: refs/heads/main\n') {
  const root = mk();
  w(path.join(root, '.git/HEAD'), headText);
  fs.mkdirSync(path.join(root, '.git/refs/heads'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true });
  return root;
}
// A linked worktree laid out the way `git worktree add` writes it.
function worktree({ external = false } = {}) {
  const base = mk();
  const common = path.join(base, 'main/.git');
  w(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(common, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(common, 'refs/heads'), { recursive: true });
  const wtDir = path.join(common, 'worktrees/wt');
  const pkg = path.join(base, external ? 'elsewhere/pkg' : 'pkg');
  w(path.join(wtDir, 'HEAD'), 'ref: refs/heads/feat\n');
  w(path.join(wtDir, 'commondir'), '../..\n');
  w(path.join(wtDir, 'gitdir'), path.join(pkg, '.git') + '\n');
  w(path.join(pkg, '.git'), `gitdir: ${wtDir}\n`);
  return { pkg, common, wtDir };
}
// Wraps the real fs so that opening one path fails with `code`.
function failingOpen(target, code) {
  return {
    ...fs,
    openSync(p, flags) {
      if (p === target) throw Object.assign(new Error(code), { code });
      return fs.openSync(p, flags);
    },
  };
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('resolveGitSha', () => {
  it('reads a loose ref', () => {
    const root = repo();
    w(path.join(root, '.git/refs/heads/main'), SHA_A + '\n');
    assert.equal(gitSha.resolveGitSha(root), SHA_A);
  });

  it('reads a packed ref (skips peeled and comment lines)', () => {
    const root = repo();
    w(path.join(root, '.git/packed-refs'),
      `# pack-refs with: peeled\n${SHA_C} refs/heads/other\n^${SHA_A}\n${SHA_B} refs/heads/main\n`);
    assert.equal(gitSha.resolveGitSha(root), SHA_B);
  });

  it('reads a detached HEAD', () => {
    assert.equal(gitSha.resolveGitSha(repo(SHA_A + '\n')), SHA_A);
  });

  it('follows a worktree .git file and a ../.. commondir', () => {
    const { pkg, common } = worktree();
    w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
    assert.equal(gitSha.resolveGitSha(pkg), SHA_B);
  });

  it('accepts a worktree whose package dir is outside the common repo', () => {
    const { pkg, common } = worktree({ external: true });
    w(path.join(common, 'packed-refs'), `${SHA_C} refs/heads/feat\n`);
    assert.equal(gitSha.resolveGitSha(pkg), SHA_C);
  });

  it('resolves a package root reached through a symlinked parent', () => {
    const { pkg, common } = worktree({ external: true });
    w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
    const link = path.join(mk(), 'link');
    fs.symlinkSync(path.dirname(pkg), link);
    assert.equal(gitSha.resolveGitSha(path.join(link, 'pkg')), SHA_B);
    const plain = repo(SHA_A + '\n');
    const link2 = path.join(mk(), 'link');
    fs.symlinkSync(path.dirname(plain), link2);
    assert.equal(gitSha.resolveGitSha(path.join(link2, path.basename(plain))), SHA_A);
  });

  it('resolves checkouts made by real git (clone dir + `git worktree add`)', (t) => {
    const { spawnSync } = require('child_process');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (git(TMP, '--version').status !== 0) { t.skip('git not available'); return; }
    const main = mk();
    assert.equal(git(main, 'init', '-q', '-b', 'main').status, 0);
    assert.equal(git(main, 'commit', '-q', '--allow-empty', '-m', 'x').status, 0);
    const sha = git(main, 'rev-parse', 'HEAD').stdout.trim();
    assert.equal(gitSha.resolveGitSha(main), sha);
    const wt = path.join(mk(), 'wt');
    assert.equal(git(main, 'worktree', 'add', '-q', '-b', 'feat', wt).status, 0);
    assert.equal(gitSha.resolveGitSha(wt), sha);
  });

  it('returns null without a .git in the package root', () => {
    assert.equal(gitSha.resolveGitSha(mk()), null);
  });

  it('never walks up to a parent repo', () => {
    const parent = repo(SHA_A + '\n');
    const pkg = path.join(parent, 'node_modules/ccxray');
    fs.mkdirSync(pkg, { recursive: true });
    assert.equal(gitSha.resolveGitSha(pkg), null);
  });

  describe('loose vs packed precedence', () => {
    const packed = `${SHA_C} refs/heads/main\n`;

    it('a valid loose ref wins over a conflicting packed ref', () => {
      const root = repo();
      w(path.join(root, '.git/packed-refs'), packed);
      w(path.join(root, '.git/refs/heads/main'), SHA_A + '\n');
      assert.equal(gitSha.resolveGitSha(root), SHA_A);
    });

    it('a corrupt loose ref → null, not the stale packed sha', () => {
      const root = repo();
      w(path.join(root, '.git/packed-refs'), packed);
      w(path.join(root, '.git/refs/heads/main'), 'zzz\n');
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('an unreadable (EACCES) loose ref → null, not the stale packed sha', () => {
      const root = repo();
      w(path.join(root, '.git/packed-refs'), packed);
      const loose = path.join(root, '.git/refs/heads/main');
      w(loose, SHA_A + '\n');
      assert.equal(gitSha.resolveGitSha(root, { fs: failingOpen(loose, 'EACCES') }), null);
      assert.equal(gitSha.resolveGitSha(root, { fs: failingOpen(loose, 'EIO') }), null);
    });

    it('an oversized loose ref → null, not the stale packed sha', () => {
      const root = repo();
      w(path.join(root, '.git/packed-refs'), packed);
      w(path.join(root, '.git/refs/heads/main'), SHA_A + '\n'.repeat(70 * 1024));
      assert.equal(gitSha.resolveGitSha(root), null);
    });
  });

  describe('worktree ref namespaces', () => {
    it('a shared ref comes from the common dir even if the worktree shadows it', () => {
      const { pkg, common, wtDir } = worktree();
      w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
      w(path.join(wtDir, 'refs/heads/feat'), SHA_C + '\n');
      assert.equal(gitSha.resolveGitSha(pkg), SHA_B);
    });

    it('a per-worktree ref comes from the worktree gitdir', () => {
      const { pkg, common, wtDir } = worktree();
      w(path.join(wtDir, 'HEAD'), 'ref: refs/bisect/bad\n');
      w(path.join(common, 'refs/bisect/bad'), SHA_B + '\n');
      w(path.join(wtDir, 'refs/bisect/bad'), SHA_C + '\n');
      assert.equal(gitSha.resolveGitSha(pkg), SHA_C);
    });

    it('a missing per-worktree ref does not fall back to the common dir', () => {
      const { pkg, common, wtDir } = worktree();
      w(path.join(wtDir, 'HEAD'), 'ref: refs/worktree/x\n');
      w(path.join(common, 'refs/worktree/x'), SHA_B + '\n');
      w(path.join(common, 'packed-refs'), `${SHA_B} refs/worktree/x\n`);
      assert.equal(gitSha.resolveGitSha(pkg), null);
    });
  });

  describe('symlinks and forged indirection → null', () => {
    it('symlinked HEAD', () => {
      const root = repo();
      const target = path.join(mk(), 'HEAD');
      w(target, SHA_A + '\n');
      fs.rmSync(path.join(root, '.git/HEAD'));
      fs.symlinkSync(target, path.join(root, '.git/HEAD'));
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('symlinked loose ref (and it does not fall back to packed-refs)', () => {
      const root = repo();
      const target = path.join(mk(), 'ref');
      w(target, SHA_A + '\n');
      w(path.join(root, '.git/packed-refs'), `${SHA_C} refs/heads/main\n`);
      fs.symlinkSync(target, path.join(root, '.git/refs/heads/main'));
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('symlinked ref directory', () => {
      const root = repo();
      const other = mk();
      w(path.join(other, 'main'), SHA_A + '\n');
      fs.rmSync(path.join(root, '.git/refs/heads'), { recursive: true });
      fs.symlinkSync(other, path.join(root, '.git/refs/heads'));
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('symlinked .git directory', () => {
      const real = repo(SHA_A + '\n');
      const root = mk();
      fs.symlinkSync(path.join(real, '.git'), path.join(root, '.git'));
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('a .git file pointing at an unrelated repo dir (no back-pointer)', () => {
      const other = repo(SHA_A + '\n');
      const root = mk();
      w(path.join(root, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
      // Claims to be a linked worktree (commondir) but has no back-pointer.
      w(path.join(other, '.git/commondir'), '.\n');
      assert.equal(gitSha.resolveGitSha(root), null);
    });

    it('a worktree gitdir whose back-pointer names another checkout', () => {
      const { pkg, common, wtDir } = worktree();
      w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
      const thief = mk();
      w(path.join(thief, '.git'), `gitdir: ${wtDir}\n`);
      assert.equal(gitSha.resolveGitSha(thief), null);
      assert.equal(gitSha.resolveGitSha(pkg), SHA_B, 'the real owner still resolves');
    });

    it('malformed or multiline gitdir / commondir / back-pointer', () => {
      const cases = [
        ['multiline .git', ({ pkg, wtDir }) => w(path.join(pkg, '.git'), `gitdir: ${wtDir}\ngitdir: /etc\n`)],
        ['.git without prefix', ({ pkg, wtDir }) => w(path.join(pkg, '.git'), `${wtDir}\n`)],
        ['multiline commondir', ({ wtDir }) => w(path.join(wtDir, 'commondir'), '../..\n/etc\n')],
        ['empty commondir', ({ wtDir }) => w(path.join(wtDir, 'commondir'), '\n')],
        ['missing commondir', ({ wtDir }) => fs.rmSync(path.join(wtDir, 'commondir'))],
        ['commondir to missing dir', ({ wtDir }) => w(path.join(wtDir, 'commondir'), '../../nope\n')],
        ['commondir to non-git dir', ({ wtDir }) => w(path.join(wtDir, 'commondir'), '.\n')],
        ['missing back-pointer', ({ wtDir }) => fs.rmSync(path.join(wtDir, 'gitdir'))],
        ['multiline back-pointer', ({ pkg, wtDir }) => w(path.join(wtDir, 'gitdir'), `${pkg}/.git\nx\n`)],
      ];
      for (const [name, setup] of cases) {
        const wt = worktree();
        w(path.join(wt.common, 'refs/heads/feat'), SHA_B + '\n');
        setup(wt);
        assert.equal(gitSha.resolveGitSha(wt.pkg), null, name);
      }
    });

    it('an unreadable commondir → null', () => {
      const { pkg, common, wtDir } = worktree();
      w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
      assert.equal(gitSha.resolveGitSha(pkg, { fs: failingOpen(path.join(wtDir, 'commondir'), 'EACCES') }), null);
    });

    it('a symlinked ancestor directory in the gitdir path', () => {
      const { pkg, common, wtDir } = worktree({ external: true });
      w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
      // /alias → the real worktrees dir; `wt` itself is a real directory.
      const alias = path.join(mk(), 'alias');
      fs.symlinkSync(path.dirname(wtDir), alias);
      // Absolute commondir, so `../..` from the alias path cannot be what fails.
      w(path.join(wtDir, 'commondir'), common + '\n');
      w(path.join(pkg, '.git'), `gitdir: ${path.join(alias, 'wt')}\n`);
      assert.equal(gitSha.resolveGitSha(pkg), null);
      // Control: the back-pointer is valid, so the physical path resolves.
      w(path.join(pkg, '.git'), `gitdir: ${wtDir}\n`);
      assert.equal(gitSha.resolveGitSha(pkg), SHA_B);
    });

    it('a symlinked ancestor directory in the commondir path', () => {
      const { pkg, common, wtDir } = worktree({ external: true });
      w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
      const alias = path.join(mk(), 'alias');
      fs.symlinkSync(path.dirname(common), alias);
      w(path.join(wtDir, 'commondir'), path.join(alias, '.git') + '\n');
      assert.equal(gitSha.resolveGitSha(pkg), null);
      w(path.join(wtDir, 'commondir'), '../..\n');
      assert.equal(gitSha.resolveGitSha(pkg), SHA_B);
    });
  });

  it('returns null for corrupt or unreadable metadata without throwing', () => {
    const cases = [
      ['garbage HEAD', r => w(path.join(r, '.git/HEAD'), 'not a head\n')],
      ['short sha', r => w(path.join(r, '.git/HEAD'), 'abc123\n')],
      ['uppercase sha', r => w(path.join(r, '.git/HEAD'), 'A'.repeat(40) + '\n')],
      ['missing ref', r => w(path.join(r, '.git/HEAD'), 'ref: refs/heads/gone\n')],
      ['ref traversal', r => w(path.join(r, '.git/HEAD'), 'ref: refs/../../etc/passwd\n')],
      ['oversized HEAD', r => w(path.join(r, '.git/HEAD'), SHA_A + '\n' + 'x'.repeat(70 * 1024))],
      ['reftable stub HEAD', r => { w(path.join(r, '.git/HEAD'), 'ref: refs/heads/.invalid\n'); fs.rmSync(path.join(r, '.git/refs/heads'), { recursive: true }); w(path.join(r, '.git/refs/heads'), 'this repository uses the reftable format\n'); }],
      ['HEAD is a directory', r => { fs.rmSync(path.join(r, '.git/HEAD')); fs.mkdirSync(path.join(r, '.git/HEAD')); }],
      ['.git file without gitdir', r => { fs.rmSync(path.join(r, '.git'), { recursive: true }); w(path.join(r, '.git'), 'nonsense\n'); }],
      ['.git file to missing dir', r => { fs.rmSync(path.join(r, '.git'), { recursive: true }); w(path.join(r, '.git'), 'gitdir: /nonexistent/xyz\n'); }],
    ];
    for (const [name, setup] of cases) {
      const root = repo();
      setup(root);
      assert.equal(gitSha.resolveGitSha(root), null, name);
    }
  });

  it('a non-regular file swapped in after lstat (e.g. a FIFO) → null via fstat', () => {
    const root = repo(SHA_A + '\n');
    const swapped = { ...fs, fstatSync: () => ({ isFile: () => false }) };
    assert.equal(gitSha.resolveGitSha(root, { fs: swapped }), null);
  });

  it('opens metadata with O_NOFOLLOW|O_NONBLOCK where the platform defines them', () => {
    const root = repo(SHA_A + '\n');
    const seen = [];
    const spy = { ...fs, openSync(p, flags) { seen.push(flags); return fs.openSync(p, flags); } };
    assert.equal(gitSha.resolveGitSha(root, { fs: spy }), SHA_A);
    const want = (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    assert.ok(seen.length > 0 && seen.every(f => (f & want) === want));
  });

  it('a file that grows past the cap after stat is still cut off by the descriptor read', () => {
    const root = repo(SHA_A + '\n');
    const head = path.join(root, '.git/HEAD');
    let grown = false;
    const growing = {
      ...fs,
      openSync(p, flags) {
        const fd = fs.openSync(p, flags);
        if (p === head && !grown) { grown = true; fs.appendFileSync(head, 'x'.repeat(70 * 1024)); }
        return fd;
      },
    };
    assert.equal(gitSha.resolveGitSha(root, { fs: growing }), null);
  });

  it('returns null when the fs throws mid-resolution', () => {
    const root = repo();
    w(path.join(root, '.git/refs/heads/main'), SHA_A + '\n');
    const eio = { ...fs, readSync() { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    assert.equal(gitSha.resolveGitSha(root, { fs: eio }), null);
  });
});

describe('startup snapshot and /_api/health', () => {
  it('captureGitSha snapshots once; a HEAD move before the first health read is not seen', () => {
    gitSha._setForTests(undefined);
    assert.equal(gitSha.getGitSha(), null, 'nothing captured → null, no resolution');
    const root = repo(SHA_A + '\n');
    assert.equal(gitSha.captureGitSha(root), SHA_A);
    w(path.join(root, '.git/HEAD'), SHA_B + '\n');
    assert.equal(health('127.0.0.1').gitSha, SHA_A, 'first health request after the move');
    assert.equal(gitSha.captureGitSha(root), SHA_A, 'second capture is a no-op');
    assert.equal(gitSha.resolveGitSha(root), SHA_B, 'resolver itself is uncached');
    gitSha._setForTests(undefined);
  });

  it('startServer captures the sha before it listens', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    const start = src.indexOf('async function startServer(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const capture = body.indexOf("require('./git-sha').captureGitSha()");
    assert.ok(capture > 0, 'startServer calls captureGitSha');
    assert.ok(capture < body.indexOf('tryListen('), 'before tryListen');
  });

  function health(remoteAddress, headers = {}) {
    const res = { writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
    assert.equal(hub.handleHubRoutes({ url: '/_api/health', method: 'GET', headers, socket: { remoteAddress } }, res), true);
    assert.equal(res.code, 200);
    return JSON.parse(res.body);
  }

  const ANON_KEYS = ['app', 'capabilities', 'exportReportUnavailableReason', 'gitSha', 'hub', 'ok', 'pid', 'version'];

  it('anonymous response carries exactly the public keys, gitSha included', () => {
    gitSha._setForTests(SHA_C);
    const anon = health('203.0.113.9');
    assert.deepEqual(Object.keys(anon).sort(), ANON_KEYS);
    assert.equal(anon.gitSha, SHA_C);
    assert.equal(anon.exportReportUnavailableReason, 'authentication-required');
    gitSha._setForTests(undefined);
  });

  it('with loopback auth required: unauthenticated vs authenticated both get gitSha', () => {
    const prev = process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      gitSha._setForTests(SHA_B);
      const unauth = health('127.0.0.1');
      assert.deepEqual(Object.keys(unauth).sort(), ANON_KEYS);
      assert.equal(unauth.gitSha, SHA_B);

      const cred = auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');
      const authed = health('127.0.0.1', { 'x-ccxray-auth': cred });
      assert.equal(authed.exportReportUnavailableReason, undefined);
      assert.equal(authed.gitSha, SHA_B);
    } finally {
      if (prev === undefined) delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
      else process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = prev;
      gitSha._setForTests(undefined);
    }
  });
});
