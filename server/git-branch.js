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

const MAX_GIT_FILE_BYTES = 4096;
// O_NONBLOCK keeps open() from waiting on a FIFO; undefined on Windows → 0.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

// Read a small regular file, or null. Opens first and fstats the same
// descriptor (no pathname stat → no check/use gap); anything that is not a
// regular file is refused unread, and at most MAX_GIT_FILE_BYTES are read.
function readSmallRegularFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_GIT_FILE_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_GIT_FILE_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function findGitDir(dir) {
  let cur = dir;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch {}
    if (st && st.isDirectory()) return dotGit;
    if (st && st.isFile()) {
      const text = readSmallRegularFile(dotGit);
      const m = text && text.match(/^gitdir:\s*(.+?)\s*$/m);
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
    const headText = readSmallRegularFile(path.join(gitDir, 'HEAD'));
    if (headText === null) return null;
    const m = headText.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
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
