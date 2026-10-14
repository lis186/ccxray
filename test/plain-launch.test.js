'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { BOOTSTRAP_AGENTS, parseGlobalFlags, parsePort } = require('../server/plain-launch');

// Oracle: the global-flag splice as it stood in server/index.js at 62fcf05,
// copied verbatim apart from process.argv → argv and process.exit → return.
function legacySplice(argvIn) {
  const argv = argvIn.slice();
  const portIdx = argv.indexOf('--port');
  let port = null;
  if (portIdx !== -1) {
    const portVal = argv[portIdx + 1];
    const parsed = parseInt(portVal, 10);
    if (!portVal || isNaN(parsed) || parsed < 1 || parsed > 65535) {
      return { invalidPort: true };
    }
    port = parsed;
    argv.splice(portIdx, 2);
  }
  let hubMode = argv.includes('--hub-mode');
  if (hubMode) argv.splice(argv.indexOf('--hub-mode'), 1);
  const allowUpstreamLoop = argv.includes('--allow-upstream-loop');
  if (argv.includes('--allow-upstream-loop')) argv.splice(argv.indexOf('--allow-upstream-loop'), 1);
  const noBrowser = argv.includes('--no-browser');
  if (noBrowser) argv.splice(argv.indexOf('--no-browser'), 1);
  return { argv, port, hubMode, allowUpstreamLoop, noBrowser };
}

function viaModule(argvIn) {
  const f = parseGlobalFlags(argvIn);
  let port = null;
  if (f.hasPort) {
    port = parsePort(f.portValue);
    if (port == null) return { invalidPort: true };
  }
  return { argv: f.argv, port, hubMode: f.hubMode, allowUpstreamLoop: f.allowUpstreamLoop, noBrowser: f.noBrowser };
}

const HEAD = ['/usr/bin/node', '/x/server/index.js'];
const CASES = [
  [],
  ['claude'],
  ['claude', '-p', 'hi'],
  ['--port', '8080', 'claude'],
  ['claude', '--port', '8080', '-p', 'hi'],
  ['claude', '-p', 'hi', '--port', '8080'],
  ['--no-browser', 'claude', '--bg'],
  ['claude', '--no-browser'],
  ['claude', '--allow-upstream-loop', '--no-browser', 'x'],
  ['--port', '5600', '--hub-mode'],
  ['--hub-mode', '--port', '5600'],
  ['--port'],
  ['--port', 'abc', 'claude'],
  ['--port', '0', 'claude'],
  ['--port', '65536', 'claude'],
  ['--port', '65535', 'claude'],
  ['--port', '--no-browser', 'claude'],
  ['claude', '--port', '1', '--port', '2'],
  ['claude', '--no-browser', '--no-browser'],
  ['codex', '--model', 'o3', '--port', '9000'],
  ['claude', '--', '--port', '9000'],
  ['status'],
  ['rebuild-index', '--apply', '--no-browser'],
];

describe('plain-launch parseGlobalFlags', () => {
  for (const tail of CASES) {
    it(`matches the legacy splice for: ${JSON.stringify(tail)}`, () => {
      assert.deepEqual(viaModule([...HEAD, ...tail]), legacySplice([...HEAD, ...tail]));
    });
  }

  it('BOOTSTRAP_AGENTS equals the AGENT_PROVIDERS keys', () => {
    const { AGENT_PROVIDERS } = require('../server/providers');
    assert.deepEqual([...BOOTSTRAP_AGENTS].sort(), Object.keys(AGENT_PROVIDERS).sort());
  });

  // INVARIANT guard: the bootstrap fail-open path loads this module after the
  // proxy stack failed, so its load-time closure must not reach that stack.
  it('loads no project module outside its allowlist', () => {
    const root = path.resolve(__dirname, '..');
    const r = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(root, 'server', 'plain-launch.js'))});
      console.log(JSON.stringify(Object.keys(require.cache)));
    `], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const loaded = JSON.parse(r.stdout)
      .filter(f => f.startsWith(root))
      .map(f => path.relative(root, f).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(loaded, [
      'server/client-shutdown.js',
      'server/plain-launch.js',
      'server/win-launch.js',
    ]);
  });
});
