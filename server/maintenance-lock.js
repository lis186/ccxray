'use strict';

// ADR 0021 Layer B: `<storage.location>/.index-maintenance.lock`, taken with the
// `wx` flag by destructive maintenance commands (rebuild-index --apply /
// --reimport, migrate-logs --apply). A lock held by a live pid refuses a second
// command; a dead pid's lock is reclaimed. Startup `pruneLogs` also honors it
// (#776): a server started mid-migration must not prune or re-anchor logs while
// another process is rewriting them. Dependency-light on purpose — restore.js
// requires this, and it must not pull in hub/store.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// EPERM means the pid exists but belongs to another user — alive, not dead. Treating
// it as dead would let a second writer reclaim or ignore a live holder's lock.
function isPidAlive(pid, kill = process.kill.bind(process)) {
  try { kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

function lockPathFor(storage) {
  // ponytail: realpath so symlinked paths to the same dir share one lock (codex P2)
  let resolved;
  try { resolved = fs.realpathSync(storage.location); } catch { resolved = storage.location; }
  return path.join(resolved, '.index-maintenance.lock');
}

function acquireMaintenanceLock(storage, op, log) {
  const lockPath = lockPathFor(storage);
  const token = crypto.randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, op, startedAt: new Date().toISOString() });
  while (true) {
    try {
      fs.writeFileSync(lockPath, contents, { flag: 'wx', mode: 0o600 });
      return { lockPath, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let existing;
      try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (!existing || !existing.pid || isPidAlive(existing.pid)) {
        log('Another index maintenance command is already running; aborting.');
        return null;
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (unlinkError.code === 'ENOENT') continue;
        throw unlinkError;
      }
    }
  }
}

function releaseMaintenanceLock(lock) {
  if (!lock) return;
  try {
    const current = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (current.token === lock.token) fs.unlinkSync(lock.lockPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// Non-acquiring check: the holder's `{pid, op, startedAt}` while the lock is held
// (live pid, or a lock file that exists but cannot be read or parsed — the same
// fail-closed reading as acquire), else null. Only ENOENT (no lock) or a dead
// holder's pid yields null; EACCES or any other read error is an unknown live holder.
function maintenanceLockHolder(storage, { readFileSync = fs.readFileSync, kill } = {}) {
  if (!storage || !storage.location) return null;
  let raw;
  try { raw = readFileSync(lockPathFor(storage), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? null : { pid: null, op: 'unknown' };
  }
  let existing;
  try { existing = JSON.parse(raw); } catch {}
  if (!existing || !existing.pid) return { pid: null, op: 'unknown' };
  return isPidAlive(existing.pid, kill) ? existing : null;
}

module.exports = { acquireMaintenanceLock, releaseMaintenanceLock, maintenanceLockHolder, isPidAlive, lockPathFor };
