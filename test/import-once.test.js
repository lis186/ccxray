'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ISOLATION (docs/testing.md): CCXRAY_HOME for ccxray's own data, and
// CCXRAY_IMPORT_HOMES for the transcript scan root — server/importer.js reads
// $HOME/.claude*/projects when the latter is unset, so a test without it scans
// the developer's real transcripts. This is the ADR 0015 R4 root table applied
// to a new CLI entry point.
function tmpdir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// The minimum a Claude transcript needs for parseSessionFile to yield a turn:
// an assistant record with usage, a non-zero token total, and a timestamp.
//
// `baseMs` must differ per session: the importer derives an entry id from the
// timestamp (`tsToId`), so two sessions whose turns share a wall-clock instant
// collide on id and the second is dropped as an already-seen entry.
let transcriptClock = Date.parse('2026-08-17T00:00:00.000Z');
function writeTranscript(projectsRoot, sessionId, cwd, turns = 1) {
  const baseMs = transcriptClock;
  transcriptClock += turns * 60000 + 3600000;
  const dir = path.join(projectsRoot, String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp: new Date(baseMs + i * 60000).toISOString(),
      message: {
        id: `msg_${sessionId}_${i}`,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000 + i, output_tokens: 50 },
      },
    }));
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function runImport(home, projectsRoot, extraEnv = {}, args = ['--once']) {
  const out = execFileSync(
    process.execPath, ['server/index.js', 'import', ...args],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: projectsRoot,
        CCXRAY_IMPORT_CODEX_HOMES: tmpdir('ccxray-import-nocodex-'),
        ...extraEnv,
      },
      timeout: 30000,
    },
  ).toString().trim();
  return JSON.parse(out.split('\n').filter(Boolean).pop());
}

describe('ccxray import --once', () => {
  it('imports transcript turns the index has never seen', () => {
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    writeTranscript(projects, 'aaaaaaaa-1111-2222-3333-444444444444', '/work/proj', 3);

    const first = runImport(home, projects);
    assert.equal(first.ok, true);
    assert.equal(first.imported, 3, 'three assistant turns should import');

    const index = fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8');
    const lines = index.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.ok(lines.every(l => l.imported), 'imported lines must carry the imported flag');
  });

  // The whole reason this command may run beside a live hub: it appends index
  // lines and leaves the hub's sessions.json alone, because session-index's
  // tmp file has a FIXED name and a second writer can rename another process's
  // half-written bytes. sessions.json is rebuildable — loadSessionIndex already
  // rebuilds when index.ndjson is the newer file.
  it('never writes sessions.json, so it cannot race a running hub', () => {
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    writeTranscript(projects, 'bbbbbbbb-1111-2222-3333-444444444444', '/work/proj', 2);

    const result = runImport(home, projects);
    assert.equal(result.imported, 2);
    assert.equal(fs.existsSync(path.join(home, 'logs', 'sessions.json')), false,
      'import --once must not write the derived session view');
    assert.equal(fs.existsSync(path.join(home, 'logs', 'sessions.json.tmp')), false,
      'and must not leave the shared tmp name behind');
  });

  it('throttles a second run inside the interval, and --force overrides it', () => {
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    writeTranscript(projects, 'cccccccc-1111-2222-3333-444444444444', '/work/proj', 1);

    assert.equal(runImport(home, projects).imported, 1);
    const second = runImport(home, projects);
    assert.equal(second.ran, false, 'a rescan seconds later is wasted work');
    assert.equal(second.reason, 'throttled');
    assert.ok(second.retryInMs > 0);

    const forced = runImport(home, projects, {}, ['--once', '--force']);
    assert.equal(forced.ran, true, '--force must override the throttle');
    assert.equal(forced.imported, 0, 'already-imported turns must dedup, not double');
  });

  it('runs again once the throttle window has passed', () => {
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    writeTranscript(projects, 'dddddddd-1111-2222-3333-444444444444', '/work/proj', 1);

    assert.equal(runImport(home, projects).imported, 1);
    writeTranscript(projects, 'eeeeeeee-1111-2222-3333-444444444444', '/work/proj', 2);
    const second = runImport(home, projects, { CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS: '0' });
    assert.equal(second.imported, 2, 'the new session should import on the next allowed run');
  });

  // A detached run has nobody reading its stdout, so reporting ok/exit-0 on a
  // failure is a silent death that is indistinguishable from a throttle skip.
  // Only 'locked' — somebody else is doing the work — may report success.
  it('fails loudly when it cannot take the lock at all', () => {
    const home = tmpdir('ccxray-import-ro-');
    const projects = tmpdir('ccxray-import-projects-');
    fs.chmodSync(home, 0o500);
    let failed = null;
    try { runImport(home, projects, {}, ['--once', '--force']); } catch (e) { failed = e; }
    fs.chmodSync(home, 0o700);
    assert.ok(failed, 'an unwritable home must exit non-zero');
    const result = JSON.parse(failed.stdout.toString().trim().split('\n').pop());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lock-error');
  });

  it('rejects an import mode it does not implement', () => {
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    let failed = null;
    try { runImport(home, projects, {}, ['--everything']); } catch (e) { failed = e; }
    assert.ok(failed, 'an unknown mode must not silently do a full import');
    assert.match(failed.stderr.toString(), /ccxray import --once/);
  });
});

describe('ccxray import --once locking', () => {
  const { acquireLock, releaseLock, pidAlive, lockPath, LOCK_TTL_MS } = require('../server/import-once');

  it('refuses while a live owner holds the lock', () => {
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const attempt = acquireLock(env);
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, 'locked');
  });

  // A crashed run must not wedge every later one — the two ways an owner can be
  // gone are a dead pid and a lock older than its TTL.
  it('reclaims a lock whose owner is dead', () => {
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    // pid 1 is alive; a never-allocated high pid is the portable dead case.
    const deadPid = 4194303;
    assert.equal(pidAlive(deadPid), false, 'fixture assumption: this pid is not running');
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: deadPid, startedAt: Date.now() }));
    const attempt = acquireLock(env);
    assert.equal(attempt.ok, true, 'a dead owner must not hold the lock forever');
    releaseLock(attempt);
  });

  it('reclaims a lock older than its TTL even if the pid is alive', () => {
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    const now = Date.now();
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, startedAt: now - LOCK_TTL_MS - 1 }));
    const attempt = acquireLock(env, now);
    assert.equal(attempt.ok, true);
    releaseLock(attempt);
  });

  it('releases the lock so the next run can take it', () => {
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    const first = acquireLock(env);
    assert.equal(first.ok, true);
    assert.equal(acquireLock(env).ok, false, 'a second holder must be refused');
    releaseLock(first);
    const third = acquireLock(env);
    assert.equal(third.ok, true);
    releaseLock(third);
  });
});

describe('session-index flush guard', () => {
  // The guard exists so a second process can append index lines without racing
  // the hub over the fixed-name sessions.json.tmp. Asserted here rather than
  // only in import-once, because the guard lives in session-index and a future
  // edit to flush() would otherwise remove it silently.
  it('writes nothing when CCXRAY_SESSION_INDEX_NO_FLUSH is set', async () => {
    const home = tmpdir('ccxray-flush-guard-');
    const out = execFileSync(process.execPath, ['-e', `
      process.env.CCXRAY_HOME = ${JSON.stringify(home)};
      process.env.CCXRAY_SESSION_INDEX_NO_FLUSH = '1';
      const idx = require(${JSON.stringify(path.join(ROOT, 'server', 'session-index.js'))});
      idx.updateFromEntry({ id: 'x1', sessionId: 's1', receivedAt: 1, provider: 'anthropic',
        model: 'claude-opus-4-6', usage: { input_tokens: 1, output_tokens: 1 } });
      idx.flush().then(() => {
        const fs = require('fs');
        process.stdout.write(String(fs.existsSync(${JSON.stringify(path.join(home, 'logs', 'sessions.json'))})));
      });
    `], { cwd: ROOT, timeout: 20000 }).toString();
    assert.equal(out, 'false', 'the guard must suppress the whole-file write');
  });
});
