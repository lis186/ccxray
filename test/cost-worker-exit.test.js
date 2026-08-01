'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

let tmpHome;
const workers = new Set();

function forkWorker() {
  const worker = fork(require.resolve('../server/cost-worker.js'), [], {
    silent: true,
    env: { ...process.env, HOME: tmpHome },
  });
  workers.add(worker);
  worker.once('close', () => workers.delete(worker));
  return worker;
}

function waitForClose(worker, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.kill('SIGKILL');
      try {
        assert.fail(timeoutMessage);
      } catch (err) {
        reject(err);
      }
    }, timeoutMs);

    worker.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForExit(worker, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.kill('SIGKILL');
      try {
        assert.fail(timeoutMessage);
      } catch (err) {
        reject(err);
      }
    }, timeoutMs);

    worker.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('cost worker termination', () => {
  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cost-worker-test-'));
    const projectDir = path.join(tmpHome, '.claude', 'projects', 'p');
    fs.mkdirSync(projectDir, { recursive: true });

    const lines = [];
    for (let i = 1; i <= 5000; i++) {
      lines.push(JSON.stringify({
        timestamp: new Date(1704067200000 + i).toISOString(),
        message: {
          id: `msg_${String(i).padStart(4, '0')}`,
          model: 'claude-sonnet-4-5-20250514',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        },
      }));
    }
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n');
  });

  after(() => {
    for (const worker of workers) worker.kill('SIGKILL');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('flushes complete stdout and exits', { timeout: 12000 }, async () => {
    const worker = forkWorker();
    const chunks = [];
    worker.stdout.on('data', chunk => chunks.push(chunk));

    const { code } = await waitForClose(
      worker,
      10000,
      'worker did not exit — #396 regression',
    );
    const stdout = Buffer.concat(chunks);
    assert.equal(code, 0);
    assert.ok(
      stdout.length > 65536,
      `expected stdout above the 65536-byte pipe-buffer guard, received ${stdout.length}`,
    );
    let parsed;
    try {
      parsed = JSON.parse(stdout.toString());
    } catch (err) {
      assert.fail(`worker stdout was truncated at ${stdout.length} bytes: ${err.message}`);
    }
    assert.equal(parsed.length, 5000);
  });

  it('exits when its parent disconnects', { timeout: 4000 }, async () => {
    const worker = forkWorker();
    // This depends on the scan still being in flight when disconnect() lands.
    // If the worker already exited naturally, the assertion would be vacuous.
    // Do not pin it with a FIFO: a blocked libuv threadpool read can prevent
    // process.exit(0) from terminating on Node v22/macOS.
    const exited = waitForExit(
      worker,
      2000,
      'worker did not exit after IPC disconnect — #395 regression',
    );
    worker.disconnect();

    const { code } = await exited;
    assert.equal(code, 0);
  });
});

// Intentionally uncovered: run() swallows each I/O failure internally, so its
// terminal error path is near-unreachable without fabricating an e2e failure.
