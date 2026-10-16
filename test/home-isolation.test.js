'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

for (const mode of ['default', 'explicit', 'logs', 'direct', 'read', 'symlink', 'allowed']) {
  it(`HOME guard: ${mode} application access`, { skip: mode === 'symlink' && process.platform === 'win32' }, () => {
    // Simulate the real home under /tmp; never probe the human's files.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-guard-'));
    const real = path.join(root, 'real');
    const isolated = path.join(root, 'isolated');
    fs.mkdirSync(real); fs.mkdirSync(isolated);
    fs.mkdirSync(path.join(real, '.ccxray'));
    fs.writeFileSync(path.join(real, '.ccxray/settings.json'), '{"starredSessions":["synthetic-protected"]}');
    const original = fs.readFileSync(path.join(real, '.ccxray/settings.json'), 'utf8');
    const env = { ...process.env, NODE_TEST_REAL_HOME: real, HOME: real, USERPROFILE: real,
      CCXRAY_HOME: isolated, LOGS_DIR: path.join(isolated, 'logs') };
    if (mode === 'default') { delete env.CCXRAY_HOME; delete env.LOGS_DIR; }
    if (mode === 'explicit') env.CCXRAY_HOME = path.join(real, '.ccxray');
    if (mode === 'symlink') {
      const alias = path.join(root, 'alias');
      fs.symlinkSync(path.join(real, '.ccxray'), alias, 'dir');
      env.CCXRAY_HOME = alias;
    }
    if (mode === 'logs') env.LOGS_DIR = path.join(real, '.ccxray/logs');
    const snippets = {
      default: "require('./server/settings').writeSettings({starredSessions:['synthetic-fixture']})",
      explicit: "require('./server/settings').writeSettings({starredSessions:['synthetic-fixture']})",
      symlink: "require('./server/settings').writeSettings({starredSessions:['synthetic-fixture']})",
      logs: "require('./server/config').storage.init().catch(e => console.error(e.message))",
      direct: "require('fs').writeFileSync(require('path').join(process.env.HOME, 'must-not-exist'), 'fixture')",
      read: "require('fs').readFileSync(require('path').join(process.env.HOME, '.ccxray/settings.json'))",
      allowed: "require('./server/settings').writeSettings({starredSessions:['synthetic-fixture']})",
    };
    try {
      const child = spawnSync(process.execPath, ['-e', `try { ${snippets[mode]} } catch(e) { console.error(e.message); }`], {
        cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(child.status, mode === 'allowed' ? 0 : 1, child.stderr);
      if (mode !== 'allowed') assert.match(child.stderr, /ETEST_HOME/);
      assert.equal(fs.readFileSync(path.join(real, '.ccxray/settings.json'), 'utf8'), original);
      assert.equal(fs.existsSync(path.join(real, 'must-not-exist')), false);
      if (mode === 'allowed') assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated, 'settings.json'), 'utf8')).starredSessions, ['synthetic-fixture']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

it('HOME guard allows CI isolation roots nested beneath HOME, but protects real app data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ci-home-'));
  const home = path.join(root, 'home');
  const repo = path.join(home, 'work', 'checkout');
  const temp = path.join(home, 'work', 'tmp');
  const runnerTemp = path.join(home, 'work', 'runner-temp');
  const ccx = path.join(home, 'work', 'isolated-ccxray');
  const guard = path.join(repo, 'test', 'helpers', 'home-guard.js');
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'helpers/home-guard.js'), guard);
  for (const dir of [temp, runnerTemp, ccx]) fs.mkdirSync(dir, { recursive: true });
  const protectedDirs = ['.ccxray', '.claude', '.claude-personal', '.codex', '.config/gcloud'];
  for (const dir of protectedDirs) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, 'fixture'), 'protected');
  }
  const env = { ...process.env, NODE_OPTIONS: '', NODE_TEST_REAL_HOME: home,
    HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    RUNNER_TEMP: runnerTemp, CCXRAY_HOME: ccx };
  const run = (code, overrides = {}) => spawnSync(process.execPath, ['--require', guard, '-e', code], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  });
  try {
    // Both explicit homes and independently selected temp/checkout roots are writable.
    for (const dir of [ccx, temp, runnerTemp, repo]) {
      const child = run(`require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'probe'))}, 'isolated')`);
      assert.equal(child.status, 0, child.stderr);
    }
    for (const dir of protectedDirs) {
      const file = path.join(home, dir, 'fixture');
      for (const operation of ['readFileSync', 'writeFileSync']) {
        const child = run(`require('fs').${operation}(${JSON.stringify(file)}, 'utf8')`, { CCXRAY_HOME: path.dirname(file) });
        assert.equal(child.status, 1, child.stderr);
        assert.match(child.stderr, /ETEST_HOME/);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), 'protected');
    }
    const sibling = run(`require('fs').mkdirSync(${JSON.stringify(ccx + '-sibling')})`);
    assert.equal(sibling.status, 1, sibling.stderr);
    assert.match(sibling.stderr, /ETEST_HOME/);
    const broad = run(`require('fs').writeFileSync(${JSON.stringify(path.join(home, 'probe'))}, 'unsafe')`,
      { CCXRAY_HOME: home, TMPDIR: home, TMP: home, TEMP: home, RUNNER_TEMP: home });
    assert.equal(broad.status, 1, broad.stderr);
    assert.match(broad.stderr, /ETEST_HOME/);
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(home, '.ccxray'), path.join(repo, 'alias'), 'dir');
      const child = run(`require('fs').writeFileSync('alias/fixture', 'overwritten')`);
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /ETEST_HOME/);
      assert.equal(fs.readFileSync(path.join(home, '.ccxray/fixture'), 'utf8'), 'protected');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
