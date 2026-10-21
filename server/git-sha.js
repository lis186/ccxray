'use strict';

// Resolves the commit the running ccxray code was started from (#728).
// Reads git metadata files only (no process spawn). Only a `.git` directly in
// the package root counts — never a parent repo. Any failure → null.
//
// The sha is captured ONCE by captureGitSha() in startServer(), before the
// listener accepts requests; GET /_api/health only reads the stored snapshot
// (getGitSha never touches the filesystem), so a checkout after start cannot
// change it. Residual: the startup read is synchronous and bounded in SIZE
// (descriptor reads capped at MAX_BYTES), not in TIME — metadata on stalled
// storage can delay startup. Reftable repositories are not parsed → null.
//
// Hardening: every metadata file is opened O_NOFOLLOW|O_NONBLOCK (where the
// platform defines them), fstat'ed as a regular file, and read through the
// descriptor with a hard cap; directories inside a gitdir/commondir are
// lstat'ed and must not be symlinks. A worktree `.git` file must point at a
// gitdir that points back at this root. The gitdir and commondir pointer
// targets must already be physical paths: each is resolved against the
// realpath of the directory it is relative to (the package root's realpath is
// the trusted base, so platform aliases above it are fine) and must equal its
// own realpath — a symlink anywhere along a target's path → null.

const fs = require('fs');
const path = require('path');

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BYTES = 64 * 1024;
const PACKED_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
// Per-worktree ref namespaces live in the worktree's own gitdir; every other
// ref lives in the common dir (git-worktree(1), "Refs").
const PER_WORKTREE_RE = /^refs\/(?:bisect|worktree|rewritten)\//;

class Missing extends Error {}

function openFlags(fsImpl) {
  const c = fsImpl.constants || fs.constants;
  return c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0);
}

// lstat-based check: ENOENT → Missing; a symlink or wrong type → throw.
function lstatKind(p, fsImpl) {
  let st;
  try { st = fsImpl.lstatSync(p); } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) throw new Missing(p);
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error('symlink');
  return st;
}

function requireDir(p, fsImpl) {
  if (!lstatKind(p, fsImpl).isDirectory()) throw new Error('not a directory');
}

// Reads base/rel, checking every component below base is a real directory
// and the file itself is a regular, non-symlink file no larger than max.
function readMeta(base, rel, fsImpl, max = MAX_BYTES) {
  const parts = rel.split('/');
  let p = base;
  for (const part of parts.slice(0, -1)) {
    p = path.join(p, part);
    requireDir(p, fsImpl);
  }
  p = path.join(p, parts[parts.length - 1]);
  if (!lstatKind(p, fsImpl).isFile()) throw new Error('not a regular file');
  let fd;
  try { fd = fsImpl.openSync(p, openFlags(fsImpl)); } catch (err) {
    if (err && err.code === 'ENOENT') throw new Missing(p);
    throw err;
  }
  try {
    if (!fsImpl.fstatSync(fd).isFile()) throw new Error('not a regular file');
    const chunks = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(CHUNK, max + 1 - total));
      const n = fsImpl.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      total += n;
      if (total > max) throw new Error('too large');
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readOptionalMeta(base, rel, fsImpl, max) {
  try { return readMeta(base, rel, fsImpl, max); } catch (err) {
    if (err instanceof Missing) return null;
    throw err;
  }
}

// A one-line pointer file (`.git`, `commondir`, `gitdir`): exactly one
// non-empty line, optional trailing newline.
function singleLine(text) {
  const m = /^([^\r\n]+)\r?\n?$/.exec(text);
  if (!m || !m[1].trim()) throw new Error('malformed pointer');
  return m[1];
}

function samePath(a, b, fsImpl) {
  try { return fsImpl.realpathSync(a) === fsImpl.realpathSync(b); } catch { return false; }
}

// A pointer target must be its own physical path (no symlinked component).
function requirePhysicalDir(p, fsImpl) {
  requireDir(p, fsImpl);
  if (fsImpl.realpathSync(p) !== p) throw new Error('symlink in path');
}

function lookupRef(ref, gitDir, commonDir, fsImpl) {
  if (!/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.split('/').some(s => s === '' || s === '.' || s === '..')) {
    return null;
  }
  const dir = PER_WORKTREE_RE.test(ref) ? gitDir : commonDir;
  // A loose ref overrides its packed counterpart; an existing but unreadable
  // or invalid loose ref is an error, never a reason to consult packed-refs.
  const loose = readOptionalMeta(dir, ref, fsImpl);
  if (loose != null) {
    const sha = loose.replace(/\n$/, '');
    return SHA_RE.test(sha) ? sha : null;
  }
  const packed = readOptionalMeta(dir, 'packed-refs', fsImpl, PACKED_MAX_BYTES);
  if (packed == null) return null;
  for (const line of packed.split('\n')) {
    if (!line || line[0] === '#' || line[0] === '^') continue;
    if (line.length > 41 && line[40] === ' ' && line.slice(41).replace(/\r$/, '') === ref) {
      const sha = line.slice(0, 40);
      return SHA_RE.test(sha) ? sha : null;
    }
  }
  return null;
}

function resolveDirs(root, fsImpl) {
  const dotGit = path.join(root, '.git');
  const st = lstatKind(dotGit, fsImpl);
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  if (!st.isFile()) throw new Error('unsupported .git');

  const m = /^gitdir: (.+)$/.exec(singleLine(readMeta(root, '.git', fsImpl)));
  if (!m) throw new Error('malformed .git file');
  const gitDir = path.resolve(root, m[1]);
  requirePhysicalDir(gitDir, fsImpl);
  lstatKind(path.join(gitDir, 'HEAD'), fsImpl);

  const common = readOptionalMeta(gitDir, 'commondir', fsImpl);
  const back = readOptionalMeta(gitDir, 'gitdir', fsImpl);
  if (common == null && back == null) {
    // Submodule / --separate-git-dir: a full git dir of its own.
    requireDir(path.join(gitDir, 'refs'), fsImpl);
    return { gitDir, commonDir: gitDir };
  }
  // Linked worktree: needs both pointers, and the back-pointer must name
  // this root's .git — otherwise the .git file borrowed someone else's dir.
  if (common == null || back == null) throw new Error('incomplete worktree');
  if (!samePath(path.resolve(gitDir, singleLine(back)), dotGit, fsImpl)) throw new Error('foreign worktree');
  const commonDir = path.resolve(gitDir, singleLine(common));
  requirePhysicalDir(commonDir, fsImpl);
  let ok = false;
  for (const sub of ['refs', 'objects']) {
    try { requireDir(path.join(commonDir, sub), fsImpl); ok = true; } catch (err) {
      if (!(err instanceof Missing)) throw err;
    }
  }
  if (!ok) throw new Error('commondir is not a git dir');
  return { gitDir, commonDir };
}

function resolveGitSha(root, { fs: fsImpl = fs } = {}) {
  try {
    const { gitDir, commonDir } = resolveDirs(fsImpl.realpathSync(root), fsImpl);
    const head = readMeta(gitDir, 'HEAD', fsImpl).replace(/\n$/, '');
    if (SHA_RE.test(head)) return head;
    const ref = /^ref: (\S+)$/.exec(head);
    return ref ? lookupRef(ref[1], gitDir, commonDir, fsImpl) : null;
  } catch {
    return null;
  }
}

let snapshot = null;
let captured = false;

// Called once from startServer() before listen(); later calls are no-ops.
function captureGitSha(root = path.join(__dirname, '..')) {
  if (!captured) {
    snapshot = resolveGitSha(root);
    captured = true;
  }
  return snapshot;
}

// Read-only: the startup snapshot, or null if none was captured.
function getGitSha() { return snapshot; }

function _setForTests(value) { snapshot = value ?? null; captured = value !== undefined; }

module.exports = { resolveGitSha, captureGitSha, getGitSha, _setForTests };
