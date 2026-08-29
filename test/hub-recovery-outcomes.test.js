'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const { renderHubClientStatus } = require('../server/hub-client-status');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const EXPECTED_FAILURE_BANNER = 'state unavailable after recovery';

// The source override lets the same behavioral test run against the parent of
// the checked-out commit for differential evidence:
// `CCXRAY_HUB_SOURCE=parent npm test -- ...`.
function readHubSource() {
  if (process.env.CCXRAY_HUB_SOURCE === 'parent') {
    const baseline = execFileSync('git', ['rev-parse', 'HEAD^'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return execFileSync('git', ['show', `${baseline}:server/hub.js`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  }
  return fs.readFileSync(path.join(SERVER_DIR, 'hub.js'), 'utf8');
}

function replaceRequired(source, from, to, label) {
  const replaced = source.replace(from, to);
  assert.notEqual(replaced, source, `${label} declaration must be present for harness timing`);
  return replaced;
}

function loadHub(home, { spawn } = {}) {
  process.env.CCXRAY_HOME = home;
  let source = readHubSource();
  source = replaceRequired(source, 'const HUB_HEALTH_CHECK_MS = 5000;', 'const HUB_HEALTH_CHECK_MS = 20;', 'HUB_HEALTH_CHECK_MS');
  source = replaceRequired(source, 'const READINESS_TIMEOUT_MS = 10000;', 'const READINESS_TIMEOUT_MS = 120;', 'READINESS_TIMEOUT_MS');
  const module = { exports: {} };
  const localRequire = request => {
    if (request === 'child_process' && spawn) return { spawn };
    if (request.startsWith('.')) return require(path.resolve(SERVER_DIR, request));
    return require(request);
  };
  const factory = vm.runInNewContext(
    `(function (require, module, exports, __dirname, __filename) {\n${source}\n})`,
    {
      Buffer,
      clearInterval,
      clearTimeout,
      console: { error() {}, log() {}, warn() {} },
      Date,
      process,
      setInterval,
      setTimeout,
    },
  );
  factory(localRequire, module, module.exports, SERVER_DIR, path.join(SERVER_DIR, 'hub.js'));
  return module.exports;
}

function recoveryBanner() {
  return renderHubClientStatus(null, 'recovery-failed', null);
}

function failingSpawn(launchState) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  const emit = child.emit.bind(child);
  child.emit = (event, ...args) => {
    if (event === 'error' && child.listenerCount('error') === 0) {
      // Node would turn an error event with no listener into an uncaught
      // exception. Record that differential without letting the test runner
      // itself terminate the test process.
      launchState.crashed = true;
      launchState.uncaughtErrors.push(args[0]);
      return false;
    }
    return emit(event, ...args);
  };
  setTimeout(() => {
    const error = new Error('simulated hub launch failure');
    error.code = 'ENOENT';
    child.emit('error', error);
  }, 100);
  return child;
}

async function waitForForkLock(lockPath) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (fs.existsSync(lockPath)) return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return null;
}

async function runScenario(kind) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-recovery-test-'));
  const forkLockPath = path.join(home, 'hub.fork.lock');
  const lockPath = path.join(home, 'hub.json');
  const rendered = [];
  const launchState = { crashed: false, uncaughtErrors: [] };
  let forkLock = null;
  const previousHome = process.env.CCXRAY_HOME;
  const previousImportDisable = process.env.CCXRAY_IMPORT_DISABLE;

  try {
    process.env.CCXRAY_IMPORT_DISABLE = '1';
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
    if (kind !== 'fork-launch-failure') {
      fs.writeFileSync(forkLockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    }
    const hub = loadHub(
      home,
      kind === 'fork-launch-failure'
        ? { spawn: () => failingSpawn(launchState) }
        : {},
    );
    hub.startHubMonitor(
      999999999,
      40001,
      () => rendered.push('recovered'),
      () => {
        // A real unhandled ChildProcess error terminates the client before
        // the pending readiness timeout can render anything.
        if (!launchState.crashed) rendered.push(recoveryBanner());
      },
    );

    if (kind === 'fork-launch-failure') {
      forkLock = await waitForForkLock(forkLockPath);
    } else if (kind === 'wrong-port') {
      // The monitor deletes the old lock before waitForHubReady begins. This
      // replacement lock arrives after that deletion and deliberately reports
      // a different port.
      await new Promise(resolve => setTimeout(resolve, 40));
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, port: 40002 }));
    }

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && rendered.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { rendered, forkLock, ...launchState };
  } finally {
    if (previousHome === undefined) delete process.env.CCXRAY_HOME;
    else process.env.CCXRAY_HOME = previousHome;
    if (previousImportDisable === undefined) delete process.env.CCXRAY_IMPORT_DISABLE;
    else process.env.CCXRAY_IMPORT_DISABLE = previousImportDisable;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const isParentSource = process.env.CCXRAY_HUB_SOURCE === 'parent';

function expectedFor(kind) {
  // HEAD^ already contains the five-outcome fix. Only the newly added sixth
  // outcome is expected to differ from that baseline.
  return isParentSource && kind === 'fork-launch-failure' ? [] : [recoveryBanner()];
}

describe('hub recovery terminal outcomes (behavioral differential)', () => {
  const missingOutcomes = [
    ['replacement hub on the wrong port', 'wrong-port'],
    ['fork/readiness throws or times out', 'readiness-timeout'],
    ['fork launch emits an asynchronous error', 'fork-launch-failure'],
  ];

  for (const [label, kind] of missingOutcomes) {
    it(`${label} reaches the client status render`, async () => {
      const result = await runScenario(kind);
      assert.deepEqual(result.rendered, expectedFor(kind));
      if (kind === 'fork-launch-failure') {
        assert.ok(result.forkLock, 'fork-launch-failure must acquire the fork lock before spawning');
        assert.equal(result.forkLock.pid, process.pid, 'fork lock must be owned by this test process');
        if (isParentSource) {
          assert.equal(result.crashed, true, 'parent must crash on the unhandled child error');
          assert.equal(result.uncaughtErrors.length, 1, 'parent must expose the unhandled child error');
        } else {
          assert.equal(result.crashed, false, 'fixed source must handle the child error');
          assert.equal(result.uncaughtErrors.length, 0, 'fixed source must handle the child error');
        }
      }
      if (!isParentSource || kind !== 'fork-launch-failure') {
        assert.equal(result.rendered[0], recoveryBanner());
        assert.match(result.rendered[0], new RegExp(EXPECTED_FAILURE_BANNER));
      }
    });
  }

  it('requires an explicit failure callback instead of permitting omission', () => {
    if (isParentSource) return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-recovery-callback-test-'));
    let interval = null;
    let thrown = null;
    try {
      process.env.CCXRAY_IMPORT_DISABLE = '1';
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
      const hub = loadHub(home);
      try {
        interval = hub.startHubMonitor(1, 40001, () => {});
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (interval) clearInterval(interval);
      fs.rmSync(home, { recursive: true, force: true });
    }

    assert.match(String(thrown), /requires success and failure callbacks/);
  });
});
