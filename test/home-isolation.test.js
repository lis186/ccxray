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
