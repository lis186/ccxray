'use strict';

// #774: scripts/migrate-to-delta.js must follow the live writer's retention rule
// (never delta onto an ancestor prune could reach) and run under the ADR 0021
// maintenance lock. Child-process CLI runs against synthetic logs in a temp home.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-to-delta.js');
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const tmpDirs = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const idFor = (ms) => new Date(ms).toISOString().slice(0, 23).replace(/[:.]/g, '-');
const msg = (role, content) => ({ role, content });

// Two consecutive full records of one session (the second extends the first),
// `ageMs` old. Returns { home, logsDir, ids }.
function fixture({ ageMs, logsInHome = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-migrate-guard-'));
  tmpDirs.push(home);
  const logsDir = logsInHome ? path.join(home, 'logs') : fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-migrate-guard-logs-'));
  if (!logsInHome) tmpDirs.push(logsDir);
  fs.mkdirSync(logsDir, { recursive: true });
  const t0 = Date.now() - ageMs;
  const ids = [idFor(t0), idFor(t0 + 1000)];
  const turn1 = [msg('user', 'a'), msg('assistant', 'b')];
  const turn2 = [...turn1, msg('user', 'c'), msg('assistant', 'd')];
  [turn1, turn2].forEach((messages, i) => {
    fs.writeFileSync(path.join(logsDir, ids[i] + '_req.json'), JSON.stringify({ model: 'm', max_tokens: 1, messages, sysHash: null, toolsHash: null }));
  });
  const indexPath = path.join(logsDir, 'index.ndjson');
  fs.writeFileSync(indexPath, ids.map(id => JSON.stringify({ id, sessionId: SID, sessionInferred: false })).join('\n') + '\n');
  const old = new Date(Date.now() - 10 * 60 * 1000); // the recency guard must not be what stops us
  fs.utimesSync(indexPath, old, old);
  return { home, logsDir, ids };
}

function run({ home, logsDir }, extra = []) {
  const env = { ...process.env, CCXRAY_HOME: home, LOG_RETENTION_DAYS: '14', CCXRAY_SKIP_RECENCY_CHECK: '' };
  for (const k of Object.keys(env)) if (/^(LOGS_DIR|CCXRAY_DELTA_SNAPSHOT_N)$/.test(k)) delete env[k];
  return spawnSync(process.execPath, [SCRIPT, '--write', '--logs-dir', logsDir, ...extra], { env, encoding: 'utf8', timeout: 30000 });
}

const readReq = (logsDir, id) => JSON.parse(fs.readFileSync(path.join(logsDir, id + '_req.json'), 'utf8'));

describe('migrate-to-delta retention guard + maintenance lock (#774)', () => {
  it('converts the second record when its ancestor is recent (control)', () => {
    const fx = fixture({ ageMs: 3600_000 });
    const r = run(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readReq(fx.logsDir, fx.ids[1]).prevId, fx.ids[0]);
  });

  it('leaves the second record FULL when its ancestor is older than half the retention', () => {
    const fx = fixture({ ageMs: 30 * 86400_000 });
    const r = run(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!('prevId' in readReq(fx.logsDir, fx.ids[1])), 'not converted onto an ancestor prune could delete');
    assert.match(r.stdout, /ancestor too old:\s+1/);
  });

  it('uses the 1-day window when --logs-dir is not <home>/logs (shared root)', () => {
    const fx = fixture({ ageMs: 3 * 86400_000, logsInHome: false });
    const r = run(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!('prevId' in readReq(fx.logsDir, fx.ids[1])), '3-day-old ancestor in a shared root stays full');
  });

  it('refuses to write while the maintenance lock is held by a live process, and changes nothing', () => {
    const fx = fixture({ ageMs: 3600_000 });
    fs.writeFileSync(path.join(fx.logsDir, '.index-maintenance.lock'), JSON.stringify({ pid: process.pid, token: 't', op: 'rebuild-index' }));
    const before = fs.readFileSync(path.join(fx.logsDir, fx.ids[1] + '_req.json'), 'utf8');
    const r = run(fx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /maintenance command is already running/);
    assert.equal(fs.readFileSync(path.join(fx.logsDir, fx.ids[1] + '_req.json'), 'utf8'), before);
  });

  it('refuses while the index was just written (a server appears to be recording) and releases its lock', () => {
    const fx = fixture({ ageMs: 3600_000 });
    const now = new Date();
    fs.utimesSync(path.join(fx.logsDir, 'index.ndjson'), now, now);
    const r = run(fx);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /appears to be recording/);
    assert.equal(fs.existsSync(path.join(fx.logsDir, '.index-maintenance.lock')), false, 'lock released');
  });

  it('releases the lock after a normal run', () => {
    const fx = fixture({ ageMs: 3600_000 });
    assert.equal(run(fx).status, 0);
    assert.equal(fs.existsSync(path.join(fx.logsDir, '.index-maintenance.lock')), false);
  });
});
