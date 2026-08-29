'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const { renderHubClientStatus } = require('../server/hub-client-status');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const EXPECTED_FAILURE_BANNER = 'state unavailable after recovery';

// The source override lets the same behavioral test run against 4911212 for
// differential evidence: `CCXRAY_HUB_SOURCE=parent npm test -- ...`.
function readHubSource() {
  if (process.env.CCXRAY_HUB_SOURCE === 'parent') {
    return execFileSync('git', ['show', '4911212:server/hub.js'], { encoding: 'utf8' });
  }
  return fs.readFileSync(path.join(SERVER_DIR, 'hub.js'), 'utf8');
}

function loadHub(home) {
  process.env.CCXRAY_HOME = home;
  const source = readHubSource()
    .replace('const HUB_HEALTH_CHECK_MS = 5000;', 'const HUB_HEALTH_CHECK_MS = 20;')
    .replace('const READINESS_TIMEOUT_MS = 10000;', 'const READINESS_TIMEOUT_MS = 120;');
  const module = { exports: {} };
  const localRequire = request => {
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

async function runScenario(kind) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-recovery-test-'));
  const forkLockPath = path.join(home, 'hub.fork.lock');
  const lockPath = path.join(home, 'hub.json');
  const rendered = [];

  try {
    fs.writeFileSync(forkLockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const hub = loadHub(home);
    hub.startHubMonitor(
      999999999,
      40001,
      () => rendered.push('recovered'),
      () => rendered.push(recoveryBanner()),
    );

    if (kind === 'wrong-port') {
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
    return rendered;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const expected = process.env.CCXRAY_HUB_SOURCE === 'parent'
  ? []
  : [recoveryBanner()];

describe('hub recovery terminal outcomes (behavioral differential)', () => {
  const missingOutcomes = [
    ['replacement hub on the wrong port', 'wrong-port'],
    ['fork/readiness throws or times out', 'readiness-timeout'],
  ];

  for (const [label, kind] of missingOutcomes) {
    it(`${label} reaches the client status render`, async () => {
      const rendered = await runScenario(kind);
      assert.deepEqual(rendered, expected);
      if (process.env.CCXRAY_HUB_SOURCE !== 'parent') {
        assert.equal(rendered[0], recoveryBanner());
        assert.match(rendered[0], new RegExp(EXPECTED_FAILURE_BANNER));
      }
    });
  }
});
