'use strict';

// Git branch resolution for per-session/per-entry branch recording. Synthetic
// repos only: each case builds a minimal `.git` layout in a temp dir (no git
// binary, no real checkout).

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGitBranch, TTL_MS, _clearGitBranchCache } = require('../server/git-branch');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-git-branch-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function repo(head) {
  const dir = path.join(root, `repo-${n++}`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
  return dir;
}

describe('resolveGitBranch', () => {
  beforeEach(() => _clearGitBranchCache());

  it('reads the branch of a normal repo, keeping slashes', () => {
    const dir = repo('ref: refs/heads/fix/session-branch\n');
    assert.equal(resolveGitBranch(dir), 'fix/session-branch');
  });

  it('resolves from a subdirectory of the checkout', () => {
    const dir = repo('ref: refs/heads/main\n');
    const sub = path.join(dir, 'server', 'routes');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(resolveGitBranch(sub), 'main');
  });

  it('follows a linked worktree `.git` file (relative and absolute gitdir)', () => {
    const main = repo('ref: refs/heads/main\n');
    const wtGit = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/wt\n');

    const wtAbs = path.join(root, `wt-abs-${n++}`);
    fs.mkdirSync(wtAbs);
    fs.writeFileSync(path.join(wtAbs, '.git'), `gitdir: ${wtGit}\n`);
    assert.equal(resolveGitBranch(wtAbs), 'feat/wt');

    const wtRel = path.join(root, `wt-rel-${n++}`);
    fs.mkdirSync(wtRel);
    fs.writeFileSync(path.join(wtRel, '.git'), `gitdir: ${path.relative(wtRel, wtGit)}\n`);
    assert.equal(resolveGitBranch(wtRel), 'feat/wt');
  });

  it('detached HEAD (bare sha) → null', () => {
    const dir = repo('0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(resolveGitBranch(dir), null);
  });

  it('a directory outside any repo → null', () => {
    const dir = path.join(root, `plain-${n++}`);
    fs.mkdirSync(dir);
    // The temp root itself must not sit inside a checkout for this to be meaningful.
    assert.equal(resolveGitBranch(dir), null);
  });

  it('missing dir, relative path, non-string, sentinel cwd → null, never throws', () => {
    assert.equal(resolveGitBranch(path.join(root, 'does-not-exist')), null);
    assert.equal(resolveGitBranch('relative/dir'), null);
    assert.equal(resolveGitBranch('(quota-check)'), null);
    assert.equal(resolveGitBranch(null), null);
    assert.equal(resolveGitBranch(undefined), null);
    assert.equal(resolveGitBranch(42), null);
    assert.equal(resolveGitBranch(''), null);
  });

  it('a malformed `.git` file or unreadable HEAD → null', () => {
    const bad = path.join(root, `badfile-${n++}`);
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, '.git'), 'not a gitdir line\n');
    assert.equal(resolveGitBranch(bad), null);
    const noHead = path.join(root, `nohead-${n++}`);
    fs.mkdirSync(path.join(noHead, '.git'), { recursive: true });
    assert.equal(resolveGitBranch(noHead), null);
  });

  it('caches per cwd within the TTL and re-reads after it', () => {
    const dir = repo('ref: refs/heads/one\n');
    const t0 = 1_000_000;
    assert.equal(resolveGitBranch(dir, t0), 'one');
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/two\n');
    assert.equal(resolveGitBranch(dir, t0 + TTL_MS - 1), 'one', 'cached within TTL');
    assert.equal(resolveGitBranch(dir, t0 + TTL_MS), 'two', 'branch switch seen after TTL');
  });

  it('caches a null result too (no repeated filesystem walk)', () => {
    const dir = path.join(root, `later-repo-${n++}`);
    fs.mkdirSync(dir);
    const t0 = 2_000_000;
    assert.equal(resolveGitBranch(dir, t0), null);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/new\n');
    assert.equal(resolveGitBranch(dir, t0 + 1), null);
    assert.equal(resolveGitBranch(dir, t0 + TTL_MS), 'new');
  });
});
