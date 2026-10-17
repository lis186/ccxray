'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function cli(args, script = 'server/index.js') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cli-output-'));
  try {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs/index.ndjson'), '');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('CCXRAY_')) delete env[key];
    Object.assign(env, { HOME: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
      CLOUDSDK_CONFIG: home, CLAUDE_CONFIG_DIR: home, PROXY_PORT: '1',
      CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1' });
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000,
      env,
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
it('prints the package version for both global version flags', () => {
  for (const flag of ['--version', '-v']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), require('../package.json').version);
  }
});
it('documents current status output and the version flags', () => {
  const r = cli(['--help']);
  assert.match(r.stdout, /status\s+Show process, home export state, shell config and diagnostics/);
  assert.match(r.stdout, /--version, -v/);
});
it('setup help documents every flag and succeeds; invalid arguments exit 2', () => {
  const r = cli(['setup', '--help']);
  assert.equal(r.status, 0, r.stderr);
  for (const flag of ['export', 'remove', 'check', 'browser', 'dry-run', 'yes', 'shell', 'no-probe', 'bucket', 'domains', 'prefix', 'cwd-allowlist', 'retention-days']) {
    assert.match(r.stdout, new RegExp(`--${flag}[^\\n]+\\s{2,}\\S`));
  }
  // #691: both modes are documented — record-only default and opt-in export.
  assert.match(r.stdout, /ccxray setup\s+Record-only \(default\)/);
  assert.match(r.stdout, /ccxray setup --export --bucket B --domains D/);
  assert.match(r.stdout, /--no-probe[^\n]*--check/);
  assert.equal(cli(['setup', '--invalid']).status, 2);
});
it('utility commands do not print the Context HUD startup line', () => {
  for (const args of [['setup', '--check', '--no-probe'], ['status'], ['open']]) {
    const r = cli(args);
    assert.notEqual(r.status, null, r.stderr);
    assert.doesNotMatch(r.stderr, /bootstrap-failed|Cannot find module/);
    assert.doesNotMatch(r.stdout + r.stderr, /Context HUD:/);
  }
});

it('keeps the HUD startup log for normal settings loading', () => {
  const r = cli(["require('./server/settings').readSettings()"], '-e');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Context HUD: enabled \(settings.json\)/);
});
