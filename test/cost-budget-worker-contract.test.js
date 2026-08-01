'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamUsageEntries } = require('../server/cost-budget');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function syntheticEntries(payloadChar) {
  return Array.from({ length: 2048 }, (_, i) => ({
    id: i,
    payload: payloadChar.repeat(1024),
  }));
}

function killIfAlive(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid, 'SIGKILL'); } catch {}
  } catch {}
}

function setPidFile(pidFile) {
  const previous = process.env.STUB_PID_FILE;
  process.env.STUB_PID_FILE = pidFile;
  return () => {
    if (previous === undefined) delete process.env.STUB_PID_FILE;
    else process.env.STUB_PID_FILE = previous;
  };
}

async function waitForReaped(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return;
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`worker ${pid} was not reaped within ${timeoutMs}ms`);
}

describe('cost worker parent completion contract', () => {
  it('resolves a large IPC result quickly and reaps a worker that never exits naturally', { timeout: 10_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-result-'));
    const pidFile = path.join(tempDir, 'worker.pid');
    const restorePidFile = setPidFile(pidFile);

    try {
      const started = Date.now();
      const entries = await streamUsageEntries({
        workerPath: path.join(FIXTURES_DIR, 'stub-result-never-exits.js'),
        timeoutMs: 500,
      });
      const elapsedMs = Date.now() - started;
      assert.deepEqual(entries, syntheticEntries('x'));
      assert.ok(elapsedMs < 5000, `expected completion under 5s, got ${elapsedMs}ms`);

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitForReaped(pid);
    } finally {
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an IPC error quickly and reaps a worker that never exits naturally', { timeout: 10_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-error-'));
    const pidFile = path.join(tempDir, 'worker.pid');
    const restorePidFile = setPidFile(pidFile);

    try {
      const started = Date.now();
      await assert.rejects(
        streamUsageEntries({
          workerPath: path.join(FIXTURES_DIR, 'stub-error-never-exits.js'),
          timeoutMs: 500,
        }),
        /synthetic worker failure/,
      );
      assert.ok(Date.now() - started < 5000);

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitForReaped(pid);
    } finally {
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects with stderr when a worker crashes before sending a result', { timeout: 10_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-crash-'));
    const pidFile = path.join(tempDir, 'worker.pid');
    const restorePidFile = setPidFile(pidFile);

    try {
      await assert.rejects(
        streamUsageEntries({
          workerPath: path.join(FIXTURES_DIR, 'stub-crash.js'),
          timeoutMs: 500,
        }),
        /synthetic worker crash/,
      );
    } finally {
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drains a large legacy stdout result before resolving the close fallback', { timeout: 10_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-legacy-'));
    const pidFile = path.join(tempDir, 'worker.pid');
    const restorePidFile = setPidFile(pidFile);

    try {
      const entries = await streamUsageEntries({
        workerPath: path.join(FIXTURES_DIR, 'stub-legacy-stdout.js'),
        timeoutMs: 2000,
      });
      assert.deepEqual(entries, syntheticEntries('y'));
    } finally {
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('times out and kills a worker that never sends or exits', { timeout: 10_000 }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-hang-'));
    const pidFile = path.join(tempDir, 'worker.pid');
    const restorePidFile = setPidFile(pidFile);

    try {
      await assert.rejects(
        streamUsageEntries({
          workerPath: path.join(FIXTURES_DIR, 'stub-silent-hang.js'),
          timeoutMs: 500,
        }),
        /Worker timeout/,
      );

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitForReaped(pid);
    } finally {
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves two entries from the real worker and reaps it', { timeout: 10_000 }, async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-real-'));
    const projectDir = path.join(tempHome, '.claude', 'projects', 'x');
    const pidFile = path.join(tempHome, 'worker.pid');
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [1, 2].map(i => JSON.stringify({
      timestamp: `2026-07-01T00:00:0${i}.000Z`,
      message: {
        id: `real-${i}`,
        model: 'claude-sonnet-4-5-20250514',
        usage: { input_tokens: i, output_tokens: i },
      },
    }));
    fs.writeFileSync(path.join(projectDir, 's.jsonl'), `${lines.join('\n')}\n`);

    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    const restorePidFile = setPidFile(pidFile);

    try {
      const entries = await streamUsageEntries({
        workerPath: path.join(FIXTURES_DIR, 'real-cost-worker-with-pid.js'),
        timeoutMs: 2000,
      });
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map(entry => entry.messageId), ['real-1', 'real-2']);

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitForReaped(pid);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      restorePidFile();
      killIfAlive(pidFile);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
