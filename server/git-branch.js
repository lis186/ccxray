'use strict';

// Resolve the checked-out git branch of a working directory without spawning
// git. Called on the request path, so it reads `.git/HEAD` directly, caches the
// answer per cwd for a short TTL (the branch can change under a live session),
// and never throws: any failure is `null`, the same as "not a git checkout".
//
// Contract:
// - `ref: refs/heads/<name>` → `<name>` (slashes kept, e.g. `fix/foo`)
// - detached HEAD (a bare sha) or any non-branch ref → null. A sha names a
//   commit, not a branch, and per-branch attribution must not mint one bucket
//   per commit; `null` is also what an unknown cwd records.
// - a linked worktree's `.git` FILE (`gitdir: <path>`, relative or absolute) is
//   followed to the per-worktree git dir, whose HEAD is the worktree's own.
// - a missing cwd, a non-string cwd, or a directory outside any repo → null.

const fs = require('fs');
const path = require('path');

const TTL_MS = 5000;
const MAX_CACHE = 512;
const cache = new Map(); // cwd → { branch, at }

function findGitDir(dir) {
  let cur = dir;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch {}
    if (st && st.isDirectory()) return dotGit;
    if (st && st.isFile()) {
      const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      return m ? path.resolve(cur, m[1]) : null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null;
  try {
    if (!fs.statSync(cwd).isDirectory()) return null;
    const gitDir = findGitDir(path.resolve(cwd));
    if (!gitDir) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function resolveGitBranch(cwd, now = Date.now()) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.branch;
  const branch = readBranch(cwd);
  if (!hit && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(cwd, { branch, at: now });
  return branch;
}

function _clearGitBranchCache() { cache.clear(); }

module.exports = { resolveGitBranch, TTL_MS, _clearGitBranchCache };
