'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ISOLATION (docs/testing.md): CCXRAY_HOME for ccxray's own data, and
// CCXRAY_IMPORT_HOMES for the transcript scan root — its value is the actual
// Claude projects/ directory (or comma-separated list of such roots), while
// server/importer.js reads $HOME/.claude*/projects when it is unset, so a test
// without it scans the developer's real transcripts. This is the ADR 0015 R4 root table applied
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
  // Both halves of one run's contract are asserted from a single spawn: what it
  // must write (index lines) and what it must NOT (the hub's derived view).
  // Each spawn here is a full `node server/index.js`, and the suite runs files
  // in parallel — a run of this file once coincided with a timing-sensitive
  // websocket test timing out, so spawn count is a cost, not free coverage.
  it('appends index lines and never writes sessions.json', () => {
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

    // The whole reason this command may run beside a live hub: session-index's
    // tmp file has a FIXED name, so a second writer can rename another
    // process's half-written bytes. sessions.json is rebuildable —
    // loadSessionIndex already rebuilds when index.ndjson is the newer file.
    assert.equal(fs.existsSync(path.join(home, 'logs', 'sessions.json')), false,
      'import --once must not write the derived session view');
    assert.equal(fs.existsSync(path.join(home, 'logs', 'sessions.json.tmp')), false,
      'and must not leave the shared tmp name behind');
  });

  // Both halves of the throttle return BEFORE the importer is required, so they
  // are exercised in-process. Each spawn is a full `node server/index.js` and the
  // runner executes test files in parallel: measured over 4 baseline runs the
  // suite was 2157/2157 every time, while 2 of 6 runs containing an earlier,
  // spawn-heavier version of this file saw a pre-existing 8s-timeout websocket
  // or hub-lifecycle test flake. Spawn count is a cost.
  it('throttles a second run inside the interval, and --force gets past it', async () => {
    const { importOnce, lockPath } = require('../server/import-once');
    const home = tmpdir('ccxray-import-home-');
    const projects = tmpdir('ccxray-import-projects-');
    writeTranscript(projects, 'cccccccc-1111-2222-3333-444444444444', '/work/proj', 1);
    const env = { CCXRAY_HOME: home, CCXRAY_IMPORT_HOMES: projects };

    // One real run, through the CLI, to leave genuine state behind.
    assert.equal(runImport(home, projects).imported, 1);

    const second = await importOnce({ env });
    assert.equal(second.ran, false, 'a rescan seconds later is wasted work');
    assert.equal(second.reason, 'throttled');
    assert.ok(second.retryInMs > 0);

    // --force must skip the throttle AND still dedup. The lock probe alone would
    // pass for a --force that ran and re-imported everything, so the real run is
    // asserted too: already-imported turns must add nothing.
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const probe = await importOnce({ env, force: true });
    assert.equal(probe.reason, 'locked', '--force must get past the throttle');
    fs.unlinkSync(lockPath(env));

    const forced = runImport(home, projects, {}, ['--once', '--force']);
    assert.equal(forced.ran, true);
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
  it('fails loudly when it cannot take the lock at all', async () => {
    const { importOnce } = require('../server/import-once');
    const home = tmpdir('ccxray-import-ro-');
    fs.chmodSync(home, 0o500);
    let result;
    try { result = await importOnce({ env: { CCXRAY_HOME: home }, force: true }); }
    finally { fs.chmodSync(home, 0o700); }
    assert.equal(result.ok, false, 'an unwritable home is a failure, not a skip');
    assert.equal(result.reason, 'lock-error');
    assert.equal(result.ran, false);
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
  // Required inside each test, not in the describe body: a throw here would
  // unregister all four subtests instead of failing them, which quietly shrinks
  // the differential when this file is replayed against a build that lacks the
  // module (observed: 2175 registered vs 2179).

  it('refuses while a live owner holds the lock', () => {
    const { acquireLock, releaseLock, pidAlive, lockPath } = require('../server/import-once');
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
    const { acquireLock, releaseLock, pidAlive, lockPath } = require('../server/import-once');
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

  // A live owner is never displaced by age alone. Reclaiming from a working
  // importer is the double-import this lock exists to prevent, and a full
  // ~/.claude* walk can outlast any timeout worth picking.
  it('never displaces a live owner, however long it has held the lock', () => {
    const { acquireLock, lockPath, LOCK_PID_REUSE_MS } = require('../server/import-once');
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    const now = Date.now();
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, startedAt: now - LOCK_PID_REUSE_MS + 1000 }));
    const attempt = acquireLock(env, now);
    assert.equal(attempt.ok, false, 'a live scanner still holds its lock');
    assert.equal(attempt.reason, 'locked');
  });

  // The age bound exists only for pid reuse: a lock this old whose recorded pid
  // is now alive almost certainly belongs to an unrelated process.
  it('reclaims a lock old enough that its pid was plausibly recycled', () => {
    const { acquireLock, releaseLock, lockPath, LOCK_PID_REUSE_MS } = require('../server/import-once');
    const home = tmpdir('ccxray-import-lock-');
    const env = { CCXRAY_HOME: home };
    const now = Date.now();
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: process.pid, startedAt: now - LOCK_PID_REUSE_MS - 1 }));
    const attempt = acquireLock(env, now);
    assert.equal(attempt.ok, true);
    releaseLock(attempt);
  });

  // The shape this lock was rewritten for, and the only test here that can tell
  // the two implementations apart: sequential calls pass either way, because the
  // second caller reads the first's FRESH payload and backs off. The bug needs
  // real interleaving — both racers reading the same STALE lock before either
  // unlinks, after which unlink-then-create lets the second delete the first's
  // new lock and both proceed. Racers are separate processes because that is the
  // only way to get concurrent unlink/create against one path; they load only
  // import-once (fs/path/os), not the server graph.
  // The fix, asserted directly and deterministically.
  //
  // The bug: two racers judge the same stale lock, both unlink, the second
  // removes the first's fresh lock, and both proceed to import. The fix is that
  // the takedown is serialized — only the holder of `.reclaim` may delete a lock.
  //
  // An N-racer test was tried first and rejected: it reproduced the bug on the
  // pre-fix lock twice, then stopped reproducing it entirely on an idle machine,
  // because the interleaving it depends on needs contention to appear. A detector
  // whose sensitivity tracks machine load is not evidence — it is a coin flip
  // that also spawned 40 processes into a parallel suite. This asserts the
  // mechanism instead, which is true or false regardless of timing.
  it('will not take down a stale lock another reclaimer is holding', () => {
    const { acquireLock, lockPath } = require('../server/import-once');
    const home = tmpdir('ccxray-import-reclaim-');
    const env = { CCXRAY_HOME: home };
    const now = Date.now();
    const lock = lockPath(env);

    // A dead owner's lock — reclaimable in principle.
    fs.writeFileSync(lock, JSON.stringify({ pid: 4194303, startedAt: now }));
    const before = fs.statSync(lock).ino;
    // ...but another live process is already taking it down.
    fs.writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: process.pid, startedAt: now }));

    const attempt = acquireLock(env, now);
    assert.equal(attempt.ok, false, 'must not acquire while another reclaimer works');
    assert.equal(attempt.reason, 'locked');
    assert.equal(fs.existsSync(lock), true, 'the stale lock must survive');
    assert.equal(fs.statSync(lock).ino, before, 'and must be the same file, not a replacement');
  });

  it('reclaims once the other reclaimer is gone', () => {
    // The same state minus a live reclaimer: the takedown may proceed, so the
    // guard above is a real gate rather than a permanent refusal.
    const { acquireLock, releaseLock, lockPath } = require('../server/import-once');
    const home = tmpdir('ccxray-import-reclaim-');
    const env = { CCXRAY_HOME: home };
    const now = Date.now();
    fs.writeFileSync(lockPath(env), JSON.stringify({ pid: 4194303, startedAt: now }));
    const attempt = acquireLock(env, now);
    assert.equal(attempt.ok, true);
    releaseLock(attempt);
  });

  it('refuses to run the scan under an injected env it cannot honour', async () => {
    // importer.js reads process.env.CCXRAY_IMPORT_HOMES and config.LOGS_DIR is
    // fixed at first require, so an injected env would silently scan the wrong
    // homes and leave the flush guard set on a process that never asked for it.
    const { importOnce, lockPath } = require('../server/import-once');
    const home = tmpdir('ccxray-import-envguard-');
    const env = { CCXRAY_HOME: home };
    const before = process.env.CCXRAY_SESSION_INDEX_NO_FLUSH;
    const result = await importOnce({ env, force: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'env-not-supported');
    assert.equal(process.env.CCXRAY_SESSION_INDEX_NO_FLUSH, before, 'must not leak the guard');
    assert.equal(fs.existsSync(lockPath(env)), false, 'and must release the lock it took');
  });

  it('releases the lock so the next run can take it', () => {
    const { acquireLock, releaseLock, pidAlive, lockPath } = require('../server/import-once');
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
