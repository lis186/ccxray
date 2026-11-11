'use strict';

// Shared helpers for shared/ files and the `ccxray gc` quarantine (#775).
// Built-ins only. The Herdr plugin keeps its own copy of restoreFileSync (it
// must stay standalone) — keep the two in step.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TRASH_PREFIX = '.gc-trash-';

// Errors that mean the filesystem cannot make hard links.
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

// Atomic no-replace publish of `src` at `dst`: link(src, dst). true = created,
// false = dst already exists (somebody else won). On a filesystem without hard
// links the fallback is an atomic rename(src, dst) — never a copy, so no
// reader can ever see a partially written final file. The rename consumes
// `src` and only replaces if dst appeared after the access() check (a race
// that content-addressing makes benign).
async function linkNoReplace(src, dst) {
  try {
    await fsp.link(src, dst);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!NO_LINK.has(e.code)) throw e;
  }
  try {
    await fsp.access(dst);
    return false;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fsp.rename(src, dst);
  return true;
}

// Move `filename` out of quarantine dir `dir` back into shared/, never
// replacing a final file a writer created in the meantime.
//   'restored' — now at shared/<filename>, trash copy removed
//   'exists'   — shared/<filename> already exists; trash copy left in place
//   'missing'  — not in this quarantine dir (or already restored by another process)
async function restoreFile(sharedDir, dir, filename) {
  const src = path.join(sharedDir, dir, filename);
  try {
    if (!(await linkNoReplace(src, path.join(sharedDir, filename)))) return 'exists';
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing';
    throw e;
  }
  await fsp.unlink(src).catch(() => {});
  return 'restored';
}

module.exports = { TRASH_PREFIX, linkNoReplace, restoreFile };
