'use strict';

// Resolves the commit the running ccxray code was loaded from (#728).
// Reads git metadata files only (no process spawn). Only a `.git` directly in
// the package root counts — never a parent repo. Any failure → null.

const fs = require('fs');
const path = require('path');

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BYTES = 1024 * 1024;

function readText(file, fsImpl) {
  const st = fsImpl.statSync(file);
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error('unreadable');
  return fsImpl.readFileSync(file, 'utf8');
}

function readOptional(file, fsImpl) {
  try { return readText(file, fsImpl); } catch { return null; }
}

function lookupRef(ref, dirs, fsImpl) {
  if (!/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes('..')) return null;
  for (const dir of dirs) {
    const loose = readOptional(path.join(dir, ref), fsImpl);
    if (loose != null) {
      const sha = loose.trim();
      if (SHA_RE.test(sha)) return sha;
    }
  }
  for (const dir of dirs) {
    const packed = readOptional(path.join(dir, 'packed-refs'), fsImpl);
    if (packed == null) continue;
    for (const line of packed.split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp === 40 && line.slice(sp + 1).trim() === ref && SHA_RE.test(line.slice(0, 40))) {
        return line.slice(0, 40);
      }
    }
  }
  return null;
}

function resolveGitSha(root, { fs: fsImpl = fs } = {}) {
  try {
    const dotGit = path.join(root, '.git');
    const st = fsImpl.lstatSync(dotGit);
    let gitDir;
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotGit, fsImpl));
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
    } else {
      return null;
    }
    const dirs = [gitDir];
    const common = readOptional(path.join(gitDir, 'commondir'), fsImpl);
    if (common && common.trim()) dirs.push(path.resolve(gitDir, common.trim()));

    const head = readText(path.join(gitDir, 'HEAD'), fsImpl).trim();
    if (SHA_RE.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head);
    return ref ? lookupRef(ref[1], dirs, fsImpl) : null;
  } catch {
    return null;
  }
}

let cached;
let resolved = false;

// Resolved lazily once per process; later checkouts do not change it.
function getGitSha(root = path.join(__dirname, '..')) {
  if (!resolved) {
    cached = resolveGitSha(root);
    resolved = true;
  }
  return cached;
}

function _resetForTests() { resolved = false; cached = undefined; }

module.exports = { resolveGitSha, getGitSha, _resetForTests };
