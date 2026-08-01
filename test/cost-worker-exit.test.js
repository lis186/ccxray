'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fork, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Regression guards for server/cost-worker.js's process lifecycle.
//
// server/cost-budget.js resolves ONLY inside worker.on('exit'), else rejects
// after 120s. Three regressions are guarded; mutation testing (2026-08-01)
// showed each test is the ONLY one that catches its mutation:
//   Y  — the worker exits on its own after writing output. Restoring #396's
//        worker (disconnect listener without channel unref) fails this,
//        bounded at ~15s.
//   Y2 — a payload larger than one pipe buffer arrives complete. A bare
//        process.exit(0) after the final stdout write cuts it off at one
//        buffer (65,536 bytes on this platform) with 0 parseable entries;
//        Y alone stays green.
//   X  — parent death still terminates the worker (#395). Deleting the
//        'disconnect' handler leaves Y and Y2 green; only X fails.

const WORKER = path.join(__dirname, '..', 'server', 'cost-worker.js');

// Generous vs. reality (~35ms on an empty HOME, ~64ms on the Y2 fixture):
// asserts "terminates", not "is fast" — it only needs to sit far below
// cost-budget.js's 120s timeout while tolerating a loaded CI box.
const SELF_EXIT_BUDGET_MS = 15_000;
const ORPHAN_EXIT_BUDGET_MS = 5_000;

// os.homedir() reads $HOME on POSIX; the worker scans $HOME/.claude*,
// $HOME/.codex* and $HOME/.config/claude — not CCXRAY_HOME. A throwaway HOME
// keeps the test off the developer's real history and makes runtime
// machine-independent.
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-worker-test-'));
}

// Forked exactly as server/cost-budget.js does — silent:true makes stdout a
// pipe, which is what the drain-before-exit behaviour under test depends on.
function startWorker(home) {
  const worker = fork(WORKER, [], {
    silent: true,
    windowsHide: true,
    env: { ...process.env, HOME: home },
  });
  const chunks = [];
  const errChunks = [];
  worker.stdout.on('data', c => chunks.push(c));
  worker.stderr.on('data', c => errChunks.push(c));
  const verdict = new Promise(resolve => {
    // Resolve a verdict instead of hanging: a regression reports "never
    // exited", bounded at SELF_EXIT_BUDGET_MS, not an opaque runner stall.
    const timer = setTimeout(() => resolve({ exited: false, code: null }), SELF_EXIT_BUDGET_MS);
    // 'close', not 'exit': it fires once the stdio pipes have drained, so
    // `chunks` is complete when the verdict resolves.
    worker.once('close', code => { clearTimeout(timer); resolve({ exited: true, code }); });
  });
  return {
    worker,
    verdict,
    stdout: () => Buffer.concat(chunks),
    stderr: () => Buffer.concat(errChunks).toString(),
  };
}

function killIfAlive(proc) {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

function pidExists(pid) {
  try { process.kill(pid, 0); }
  catch (err) { if (err.code === 'ESRCH') return false; throw err; }
  // A terminated process that nobody has reaped yet is a zombie, and a zombie
  // still answers kill(pid, 0). Once the surrogate is killed the worker is
  // reparented to PID 1, which reaps promptly on a normal VM but not
  // necessarily inside a container whose PID 1 is an ordinary app — there the
  // worker would look alive forever and fail this test for the wrong reason.
  // Linux exposes the state directly, so read it and treat Z as gone.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 3 is the state char; skip past the comm field, which may itself
      // contain spaces or parentheses, by scanning from the last ')'.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch { return false; }
  }
  return true;
}

function readPid(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('surrogate did not print worker pid')), timeoutMs);
    child.stdout.on('data', chunk => {
      out += chunk;
      const m = out.match(/^(\d+)\n/);
      if (!m) return;
      clearTimeout(timer);
      resolve(Number(m[1]));
    });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => {
      if (/^\d+\n/.test(out)) return;
      clearTimeout(timer);
      reject(new Error(`surrogate exited before printing worker pid: code=${code} signal=${signal}`));
    });
  });
}

async function waitForPidExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidExists(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !pidExists(pid);
}

describe('cost-worker: process lifecycle', () => {
  it('Y — exits on its own after writing output', async () => {
    const home = makeHome();
    let w;
    try {
      w = startWorker(home);
      const result = await w.verdict;
      assert.equal(result.exited, true,
        `worker did not exit within ${SELF_EXIT_BUDGET_MS}ms; ` +
        'cost-budget.js would burn its 120s timeout and reject (Usage tab dark)');
      assert.equal(result.code, 0, w.stderr());
      assert.ok(Array.isArray(JSON.parse(w.stdout().toString())),
        'worker stdout should parse as a JSON array');
    } finally {
      killIfAlive(w && w.worker);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Y2 — payload larger than one pipe buffer arrives complete', async () => {
    const home = makeHome();
    // 5,000 lines with a UNIQUE message.id per line — scanHomes dedupes by
    // messageId, so duplicate ids would silently shrink the expected count.
    const projectDir = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(projectDir, { recursive: true });
    const LINES = 5000;
    const lines = Array.from({ length: LINES }, (_, i) => JSON.stringify({
      timestamp: new Date(1_700_000_000_000 + i).toISOString(),
      message: {
        id: `message-${i}`,
        model: 'claude-sonnet-4-5-20250514',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 400,
        },
      },
    }));
    fs.writeFileSync(path.join(projectDir, 's.jsonl'), lines.join('\n') + '\n');

    let w;
    try {
      w = startWorker(home);
      const result = await w.verdict;
      assert.equal(result.exited, true,
        `worker did not exit within ${SELF_EXIT_BUDGET_MS}ms`);
      assert.equal(result.code, 0, w.stderr());

      const raw = w.stdout();
      // Vacuity guard: the fixture must actually exceed the 64KB pipe buffer,
      // otherwise this test cannot detect truncation at all.
      assert.ok(raw.length > 65_536,
        `fixture produced only ${raw.length} bytes; must exceed the 65,536-byte pipe buffer`);
      let entries;
      try {
        entries = JSON.parse(raw.toString());
      } catch (err) {
        assert.fail(`worker stdout truncated at ${raw.length} bytes ` +
          `(a bare process.exit() after the final write cuts the payload off at one pipe buffer): ${err.message}`);
      }
      assert.equal(entries.length, LINES);
    } finally {
      killIfAlive(w && w.worker);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('X — parent SIGKILL still terminates a held-open worker (#395)', async () => {
    // The worker exits naturally in ~30ms on an empty HOME, which would make
    // this test vacuous — the pin must keep it alive until the parent dies.
    // Pin = execArgv --require of a setInterval, NEVER a FIFO .jsonl: a
    // blocked libuv threadpool read prevents process.exit(0) from terminating
    // at all, which makes the test fail on CORRECT code (measured dead end).
    const home = makeHome();
    const holdOpenPath = path.join(home, 'hold-open.js');
    const surrogatePath = path.join(home, 'surrogate.js');
    fs.writeFileSync(holdOpenPath, 'setInterval(() => {}, 1 << 30);\n');
    fs.writeFileSync(surrogatePath, [
      "'use strict';",
      "const { fork } = require('child_process');",
      'const worker = fork(process.argv[2], [], {',
      '  env: { ...process.env, HOME: process.argv[3] },',
      '  silent: true,',
      '  windowsHide: true,',
      "  execArgv: ['--require', process.argv[4]],",
      '});',
      "process.stdout.write(worker.pid + '\\n');",
      'setInterval(() => {}, 1 << 30);',
      '',
    ].join('\n'));

    let surrogate;
    let workerPid;
    try {
      surrogate = spawn(process.execPath, [surrogatePath, WORKER, home, holdOpenPath],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      workerPid = await readPid(surrogate, 5000);
      // Let the pinned worker pass its natural ~30ms exit point, proving the
      // pin holds — a naturally-dead worker here would pass the kill vacuously.
      await new Promise(r => setTimeout(r, 250));
      assert.equal(pidExists(workerPid), true,
        'held-open worker must still be alive before parent death');

      surrogate.kill('SIGKILL');
      const gone = await waitForPidExit(workerPid, ORPHAN_EXIT_BUDGET_MS);
      assert.equal(gone, true,
        `worker ${workerPid} survived parent SIGKILL for ${ORPHAN_EXIT_BUDGET_MS}ms — #395 orphan regression`);
    } finally {
      killIfAlive(surrogate);
      if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
