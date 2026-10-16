'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { childClosed, stopChild } = require('./helpers/child-lifecycle');
const { waitForFrame } = require('./helpers/websocket-barrier');

it('worker errors do not permit directory cleanup before close', async () => {
  const child = new EventEmitter();
  let settled = false;
  const closed = childClosed(child).then(status => { settled = true; return status; });
  const error = new Error('spawn failure');
  child.emit('error', error);
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', -2, null);
  assert.equal((await closed).error, error);
});

it('teardown escalates and waits for close rather than the kill timer', async () => {
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, signal));
  };
  await stopChild(child, childClosed(child), 10);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

it('frame barriers ignore unrelated frames and remove listeners after success', async () => {
  const ws = new EventEmitter();
  let settled = false;
  const done = waitForFrame(ws, d => d === 'expected').then(() => { settled = true; });
  ws.emit('message', 'other');
  await Promise.resolve();
  assert.equal(settled, false);
  ws.emit('message', 'expected');
  await done;
  assert.equal(ws.listenerCount('message'), 0);
});

it('frame barriers reject on timeout and early close', async () => {
  const ws = new EventEmitter();
  await assert.rejects(waitForFrame(ws, () => false, 10), /timeout/);
  assert.equal(ws.listenerCount('message'), 0);
  const done = waitForFrame(ws, () => false);
  ws.emit('close');
  await assert.rejects(done, /closed/);
  assert.equal(ws.listenerCount('message'), 0);
});

it('hub harness reaps a worker before removing its home when setup fails', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.join(__dirname, 'hub-recovery-outcomes.test.js');
  const source = fs.readFileSync(process.env.CCXRAY_INFRA_BASELINE || filename, 'utf8');
  const realRequire = createRequire(filename);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.exitCode = child.signalCode = null;
  let closed = false;
  child.kill = () => setImmediate(() => {
    closed = true;
    child.signalCode = 'SIGTERM';
    child.emit('close', null, 'SIGTERM');
  });
  let removedAfterClose = false;
  const fakeFs = Object.create(fs);
  fakeFs.rmSync = (...args) => { removedAfterClose = closed; fs.rmSync(...args); };
  const context = {
    require(name) {
      if (name === 'node:test') return { describe() {} };
      if (name === 'node:child_process') return { spawn: () => child };
      if (name === 'node:fs') return fakeFs;
      return realRequire(name);
    },
    __dirname, __filename: filename, process: { env: {} },
    setTimeout, clearTimeout, setImmediate,
  };
  vm.createContext(context);
  vm.runInContext(source + `\nwaitForForkLock = async () => { throw new Error('setup failed'); };\nthis.run = runLaunchSubprocess;`, context);
  await assert.rejects(context.run(), /setup failed/);
  assert.equal(removedAfterClose, true);
});
