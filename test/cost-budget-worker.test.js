'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { streamUsageEntries } = require('../server/cost-budget');
const tick = () => new Promise(resolve => setImmediate(resolve));

function controlledWorker() {
  const worker = new EventEmitter();
  Object.assign(worker, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const signals = [], timers = [], logs = [];
  worker.kill = (signal = 'SIGTERM') => { signals.push(signal); return true; };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/cost-budget.js'), 'utf8'), {
    module, __dirname: path.join(__dirname, '../server'), Buffer,
    require: id => id === 'child_process' ? { fork: () => worker } : require(id),
    console: { error: (...args) => logs.push(args.join(' ')) },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() { this.unrefed = true; } };
      timers.push(timer); return timer;
    },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  });
  let state = 'pending';
  const promise = module.exports.streamUsageEntries('fixture', { timeoutMs: 50, killGraceMs: 10 });
  promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  return { worker, promise, timers, signals, logs, state: () => state };
}

it('settles only on close, including stdout arriving after exit', async () => {
  const c = controlledWorker();
  c.worker.stdout.write('[{"complete":');
  c.worker.emit('exit', 0, null);
  await tick();
  assert.equal(c.state(), 'pending');
  c.worker.stdout.end('true}]');
  c.worker.emit('close', 0, null);
  assert.equal(JSON.stringify(await c.promise), '[{"complete":true}]');
  assert.ok(c.timers[0].cleared);
});

it('timeout escalates with an unrefed timer and rejects only after close', async () => {
  const c = controlledWorker();
  c.worker.stdout.write('truncated JSON');
  c.timers[0].fn();
  await tick();
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(c.state(), 'pending');
  assert.equal(c.timers[1].ms, 10);
  assert.ok(c.timers[1].unrefed);
  c.timers[1].fn();
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(c.logs.length, 1);
  assert.match(c.logs[0], /sending SIGKILL/);
  c.worker.signalCode = 'SIGKILL';
  c.worker.emit('exit', null, 'SIGKILL');
  await tick();
  assert.equal(c.state(), 'pending');
  c.worker.emit('close', null, 'SIGKILL');
  await assert.rejects(c.promise, /Worker timeout/);
  assert.ok(c.timers.every(t => t.cleared));
  c.timers[0].fn(); c.timers[1].fn();
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL'], 'closed workers must not be signaled again');
});

it('waits for close after a child error and preserves the error', async () => {
  const c = controlledWorker();
  const error = new Error('synthetic spawn error');
  c.worker.emit('error', error);
  await tick();
  assert.equal(c.state(), 'pending');
  c.worker.emit('close', -1, null);
  await assert.rejects(c.promise, e => e === error);
});

async function fixture(mode, check) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-parent-worker-'));
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs/index.ndjson'), '');
  const keys = ['HOME', 'CCXRAY_HOME', 'LOGS_DIR', 'CCXRAY_WORKER_FIXTURE_MODE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let pending, timer;
  try {
    Object.assign(process.env, { HOME: home, CCXRAY_HOME: home, CCXRAY_WORKER_FIXTURE_MODE: mode });
    delete process.env.LOGS_DIR;
    try {
      pending = streamUsageEntries(path.join(__dirname, 'fixtures/cost-budget-worker.js'), { timeoutMs: 5000, killGraceMs: 100 });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const bounded = Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture deadline expired')), 7000);
    })]);
    await check(bounded, home);
  } finally {
    clearTimeout(timer);
    const pidFile = path.join(home, 'worker.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') break; throw e; }
        if (Date.now() > deadline) throw new Error('fixture worker was not reaped');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    // Observe the worker's eventual rejection even if a test assertion failed early.
    await pending?.catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

it('reaps a real SIGTERM-ignoring worker before timeout rejection', { skip: process.platform === 'win32' }, async () => {
  await fixture('hang', async (pending, home) => {
    await assert.rejects(pending, /Worker timeout/);
    const pid = Number(fs.readFileSync(path.join(home, 'worker.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});
it('preserves stderr from a nonzero worker exit', async () => {
  await fixture('error', pending => assert.rejects(pending, /synthetic worker failure/));
});
it('receives a complete large stdout array through close', async () => {
  await fixture('large', async pending => {
    const rows = await pending;
    assert.equal(rows.length, 100000);
    assert.deepEqual(rows.at(-1), { id: 99999, value: 'x'.repeat(100) });
  });
});
