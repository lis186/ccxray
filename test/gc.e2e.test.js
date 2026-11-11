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

  it('requires exactly one of --dry-run / --apply', () => {
    for (const args of [['gc'], ['gc', '--dry-run', '--apply']]) {
      const r = ccxray(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /Usage: ccxray gc --dry-run \| --apply/);
    }
    assert.ok(fs.existsSync(path.join(home, 'logs', 'shared', 'sys_aaaaaaaaaaaa.json')));
  });

  it('--dry-run lists the file and deletes nothing; --apply deletes it', () => {
    const dry = ccxray(['gc', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /sys_aaaaaaaaaaaa\.json/);
    assert.ok(fs.existsSync(path.join(home, 'logs', 'shared', 'sys_aaaaaaaaaaaa.json')));
    const applied = ccxray(['gc', '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.ok(!fs.existsSync(path.join(home, 'logs', 'shared', 'sys_aaaaaaaaaaaa.json')));
  });
});
