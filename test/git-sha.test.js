'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-git-sha-'));
process.env.CCXRAY_HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.CCXRAY_HOME, { recursive: true });

const gitSha = require('../server/git-sha');
const hub = require('../server/hub');

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

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('resolveGitSha', () => {
  it('reads a loose ref', () => {
    const root = mk();
    w(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    w(path.join(root, '.git/refs/heads/main'), SHA_A + '\n');
    assert.equal(gitSha.resolveGitSha(root), SHA_A);
  });

  it('reads a packed ref (skips peeled and comment lines)', () => {
    const root = mk();
    w(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    w(path.join(root, '.git/packed-refs'),
      `# pack-refs with: peeled\n${SHA_C} refs/heads/other\n^${SHA_A}\n${SHA_B} refs/heads/main\n`);
    assert.equal(gitSha.resolveGitSha(root), SHA_B);
  });

  it('reads a detached HEAD', () => {
    const root = mk();
    w(path.join(root, '.git/HEAD'), SHA_A + '\n');
    assert.equal(gitSha.resolveGitSha(root), SHA_A);
  });

  it('follows a worktree .git file and commondir', () => {
    const root = mk();
    const common = path.join(root, 'main.git');
    const wt = path.join(common, 'worktrees/wt');
    w(path.join(common, 'refs/heads/feat'), SHA_B + '\n');
    w(path.join(wt, 'HEAD'), 'ref: refs/heads/feat\n');
    w(path.join(wt, 'commondir'), '../..\n');
    const pkg = path.join(root, 'pkg');
    w(path.join(pkg, '.git'), `gitdir: ${wt}\n`);
    assert.equal(gitSha.resolveGitSha(pkg), SHA_B);
  });

  it('returns null without a .git in the package root', () => {
    assert.equal(gitSha.resolveGitSha(mk()), null);
  });

  it('never walks up to a parent repo', () => {
    const parent = mk();
    w(path.join(parent, '.git/HEAD'), SHA_A + '\n');
    const pkg = path.join(parent, 'node_modules/ccxray');
    fs.mkdirSync(pkg, { recursive: true });
    assert.equal(gitSha.resolveGitSha(pkg), null);
  });

  it('returns null for corrupt or unreadable metadata without throwing', () => {
    const cases = [
      ['garbage HEAD', r => w(path.join(r, '.git/HEAD'), 'not a head\n')],
      ['short sha', r => w(path.join(r, '.git/HEAD'), 'abc123\n')],
      ['uppercase sha', r => w(path.join(r, '.git/HEAD'), 'A'.repeat(40) + '\n')],
      ['missing ref', r => w(path.join(r, '.git/HEAD'), 'ref: refs/heads/gone\n')],
      ['bad loose ref', r => { w(path.join(r, '.git/HEAD'), 'ref: refs/heads/x\n'); w(path.join(r, '.git/refs/heads/x'), 'zzz\n'); }],
      ['ref traversal', r => w(path.join(r, '.git/HEAD'), 'ref: refs/../../etc/passwd\n')],
      ['HEAD is a directory', r => fs.mkdirSync(path.join(r, '.git/HEAD'), { recursive: true })],
      ['.git file without gitdir', r => w(path.join(r, '.git'), 'nonsense\n')],
      ['.git file to missing dir', r => w(path.join(r, '.git'), 'gitdir: /nonexistent/xyz\n')],
    ];
    for (const [name, setup] of cases) {
      const root = mk();
      setup(root);
      assert.equal(gitSha.resolveGitSha(root), null, name);
    }
  });

  it('returns null when the fs throws', () => {
    const boom = () => { throw new Error('EIO'); };
    assert.equal(gitSha.resolveGitSha('/x', { fs: { lstatSync: boom, statSync: boom, readFileSync: boom } }), null);
  });
});

describe('getGitSha caching and /_api/health', () => {
  it('caches the first value across a HEAD change', () => {
    gitSha._resetForTests();
    const root = mk();
    w(path.join(root, '.git/HEAD'), SHA_A + '\n');
    assert.equal(gitSha.getGitSha(root), SHA_A);
    w(path.join(root, '.git/HEAD'), SHA_B + '\n');
    assert.equal(gitSha.resolveGitSha(root), SHA_B, 'resolver itself is uncached');
    assert.equal(gitSha.getGitSha(root), SHA_A);
    assert.equal(gitSha.getGitSha(), SHA_A);
    gitSha._resetForTests();
  });

  function health(remoteAddress, headers = {}) {
    const res = { writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
    assert.equal(hub.handleHubRoutes({ url: '/_api/health', method: 'GET', headers, socket: { remoteAddress } }, res), true);
    return JSON.parse(res.body);
  }

  it('includes gitSha without and with dashboard auth, and adds no paths', () => {
    const anon = health('203.0.113.9');
    assert.equal(anon.exportReportUnavailableReason, 'authentication-required');
    assert.ok('gitSha' in anon);
    assert.equal(anon.gitSha, gitSha.getGitSha());

    const trusted = health('127.0.0.1');
    assert.equal(trusted.exportReportUnavailableReason, undefined);
    assert.equal(trusted.gitSha, gitSha.getGitSha());
    assert.ok(trusted.gitSha === null || /^[0-9a-f]{40}$/.test(trusted.gitSha));
  });
});
