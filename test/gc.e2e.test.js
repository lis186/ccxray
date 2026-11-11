'use strict';
// #775 — `ccxray gc` CLI wiring (spawns the real entry point). Temp CCXRAY_HOME only.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');
let home;

function ccxray(args) {
  const env = { ...process.env, CCXRAY_HOME: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1' };
  delete env.CCXRAY_HUB_CLIENT_PID;
  env.PROXY_PORT = '5649';
  return spawnSync(process.execPath, [ENTRY, ...args], { env, encoding: 'utf8', timeout: 20000 });
}

describe('ccxray gc CLI (#775)', () => {
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-gc-e2e-'));
    const shared = path.join(home, 'logs', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    const p = path.join(shared, 'sys_aaaaaaaaaaaa.json');
    fs.writeFileSync(p, '{}');
    const old = new Date(Date.now() - 30 * 86400_000);
    fs.utimesSync(p, old, old);
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it('requires --dry-run, --apply or --purge (not combined)', () => {
    for (const args of [['gc'], ['gc', '--verbose'], ['gc', '--dry-run', '--apply'], ['gc', '--apply', '--purge']]) {
      const r = ccxray(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /Usage: ccxray gc --dry-run \| --apply \| --purge/);
    }
    assert.ok(fs.existsSync(path.join(home, 'logs', 'shared', 'sys_aaaaaaaaaaaa.json')));
  });

  it('--dry-run prints a summary (file names only with --verbose) and moves nothing; --apply quarantines it', () => {
    const dry = ccxray(['gc', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /total\s+1 files .*would quarantine 1/);
    assert.doesNotMatch(dry.stdout, /sys_aaaaaaaaaaaa\.json/);
    const verbose = ccxray(['gc', '--dry-run', '--verbose']);
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /would quarantine sys_aaaaaaaaaaaa\.json/);
    assert.ok(fs.existsSync(path.join(home, 'logs', 'shared', 'sys_aaaaaaaaaaaa.json')));
    const applied = ccxray(['gc', '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    const shared = path.join(home, 'logs', 'shared');
    assert.ok(!fs.existsSync(path.join(shared, 'sys_aaaaaaaaaaaa.json')));
    const trash = fs.readdirSync(shared).filter(n => n.startsWith('.gc-trash-'));
    assert.equal(trash.length, 1, 'quarantined, not unlinked');
    assert.ok(fs.existsSync(path.join(shared, trash[0], 'sys_aaaaaaaaaaaa.json')));
    assert.match(applied.stdout, /Nothing is freed yet/);
  });

  it('--purge --dry-run previews; --purge deletes only quarantine older than 7 days', () => {
    const shared = path.join(home, 'logs', 'shared');
    const oldDir = path.join(shared, '.gc-trash-2020-01-01T00-00-00-000Z');
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'sys_bbbbbbbbbbbb.json'), '{}');
    const dry = ccxray(['gc', '--purge', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would purge \.gc-trash-2020-01-01/);
    assert.ok(fs.existsSync(oldDir));
    const purged = ccxray(['gc', '--purge']);
    assert.equal(purged.status, 0, purged.stderr);
    assert.ok(!fs.existsSync(oldDir));
    assert.equal(fs.readdirSync(shared).filter(n => n.startsWith('.gc-trash-')).length, 1, 'fresh quarantine kept');
  });
});
