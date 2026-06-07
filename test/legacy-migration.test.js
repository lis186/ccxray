'use strict';

// Covers the legacy-logs migration after it was folded into the local storage
// adapter's init() (it previously ran as a require-time side effect in
// config.js — fired on every import, ignored STORAGE_BACKEND). Properties:
//   1. local init() migrates a fresh logs dir from the legacy dir;
//   2. no legacy index.ndjson → no migration;
//   3. a pre-existing logs dir blocks migration (never clobbers);
//   4. no legacyDir wired (the S3/non-local path) → no local migration;
//   5. migration is best-effort — a rename error is swallowed, init() resolves;
//   6. requiring config.js has NO migration side effect at import time.
// All filesystem work is isolated to per-test temp dirs; the real ~/.ccxray is
// never touched.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { createLocalStorage } = require('../server/storage/local');

function mkroot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccxray-legmig-${label}-`));
}

describe('legacy-logs migration (local storage adapter init)', () => {
  it('migrates legacy files into a freshly-created logs dir', async () => {
    const root = mkroot('mig');
    const logsDir = path.join(root, 'logs');
    const legacyDir = path.join(root, 'pkglogs');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'index.ndjson'), '{"id":"old"}\n');
    fs.writeFileSync(path.join(legacyDir, '2026-01-01_req.json'), '{"model":"x"}');
    try {
      await createLocalStorage(logsDir, { legacyDir }).init();
      assert.equal(fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8'), '{"id":"old"}\n');
      assert.ok(fs.existsSync(path.join(logsDir, '2026-01-01_req.json')), 'payload file migrated');
      assert.deepEqual(fs.readdirSync(legacyDir), [], 'legacy dir emptied');
      assert.ok(fs.existsSync(path.join(logsDir, 'shared')), 'shared/ still created by init');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT migrate when the legacy dir has no index.ndjson', async () => {
    const root = mkroot('noidx');
    const logsDir = path.join(root, 'logs');
    const legacyDir = path.join(root, 'pkglogs');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'stray.json'), 'orphan');
    try {
      await createLocalStorage(logsDir, { legacyDir }).init();
      assert.ok(!fs.existsSync(path.join(logsDir, 'stray.json')), 'no migration without index.ndjson sentinel');
      assert.ok(fs.existsSync(path.join(legacyDir, 'stray.json')), 'stray file left in place');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT migrate when the logs dir already existed (no clobber)', async () => {
    const root = mkroot('exist');
    const logsDir = path.join(root, 'logs');
    const legacyDir = path.join(root, 'pkglogs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'index.ndjson'), '{"id":"old"}\n');
    try {
      await createLocalStorage(logsDir, { legacyDir }).init();
      assert.ok(!fs.existsSync(path.join(logsDir, 'index.ndjson')), 'pre-existing logs dir must block migration');
      assert.ok(fs.existsSync(path.join(legacyDir, 'index.ndjson')), 'legacy file stays put');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT migrate when no legacyDir is wired (the S3 / non-local path)', async () => {
    const root = mkroot('nolegacy');
    const logsDir = path.join(root, 'logs');
    const legacyDir = path.join(root, 'pkglogs');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'index.ndjson'), '{"id":"old"}\n');
    try {
      // No opts → no legacyDir. This is exactly how non-local backends are
      // wired: only the local branch in storage/index.js passes legacyDir.
      await createLocalStorage(logsDir).init();
      assert.ok(!fs.existsSync(path.join(logsDir, 'index.ndjson')), 'no legacyDir → no migration');
      assert.ok(fs.existsSync(path.join(legacyDir, 'index.ndjson')), 'legacy untouched');
      assert.ok(fs.existsSync(logsDir), 'logs dir still created by init');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is best-effort: a rename error is swallowed and init() still resolves', async () => {
    const root = mkroot('err');
    const logsDir = path.join(root, 'logs');
    const legacyDir = path.join(root, 'pkglogs');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'index.ndjson'), '{"id":"old"}\n');
    // A legacy file named 'shared' collides with the shared/ directory that
    // init() creates → fsp.rename(file → existing dir) fails. The migration
    // must catch-and-log, not reject init().
    fs.writeFileSync(path.join(legacyDir, 'shared'), 'collide');
    try {
      await assert.doesNotReject(
        () => createLocalStorage(logsDir, { legacyDir }).init(),
        'a failed rename must not crash init()',
      );
      assert.ok(
        fs.existsSync(path.join(logsDir, 'shared')) && fs.statSync(path.join(logsDir, 'shared')).isDirectory(),
        'shared/ dir remains intact after the failed migration',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('config.js has no migration side effect at require time', () => {
  it('requiring config.js does not create the logs dir', async () => {
    // Fresh require in a child process with a temp CCXRAY_HOME whose logs/ does
    // not exist. The act of importing config must not touch the filesystem.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pure-'));
    const CONFIG = path.resolve(__dirname, '..', 'server', 'config.js');
    const snippet = `
      const fsm = require('fs');
      const c = require(${JSON.stringify(CONFIG)});
      process.stdout.write(JSON.stringify({ logsDir: c.LOGS_DIR, exists: fsm.existsSync(c.LOGS_DIR) }));
    `;
    const env = { ...process.env };
    delete env.LOGS_DIR;
    delete env.STORAGE_BACKEND;
    env.CCXRAY_HOME = home;
    const out = await new Promise((resolve) => {
      const ch = spawn(process.execPath, ['-e', snippet], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let s = '';
      ch.stdout.on('data', d => { s += d; });
      ch.on('exit', code => resolve({ s: s.trim(), code }));
    });
    try {
      assert.equal(out.code, 0, 'child should exit cleanly');
      const r = JSON.parse(out.s);
      assert.equal(r.exists, false, 'require(config) must NOT create LOGS_DIR — no require-time side effect');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
