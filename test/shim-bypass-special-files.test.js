'use strict';

// #732 review round 3: the bypass-log reader must never block on, or read
// through, a special file (FIFO, symlink) sitting at either log generation.
// The reader is synchronous, so a regression would hang the calling process;
// every check therefore runs it in a child process under a hard timeout.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const READER = path.join(__dirname, '..', 'server', 'shim-bypass.js');
const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const RECORD = JSON.stringify({ t: new Date().toISOString(), tool: 'claude', cwd: '/x', reason: 'timeout', action: 'bypass' }) + '\n';
const LIMIT_MS = 1500;

let dir;
const haveFifo = () => spawnSync('mkfifo', ['--version']).error === undefined;

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bypass-sp-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Runs summarizeBypasses(dir) in a child; resolves { summary } or { timedOut }.
function summarizeInChild(home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(READER)}).summarizeBypasses(${JSON.stringify(home)})))`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let outText = '';
    child.stdout.on('data', d => { outText += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }); }, LIMIT_MS);
    child.on('exit', () => { clearTimeout(timer); try { resolve({ summary: JSON.parse(outText) }); } catch { resolve({ timedOut: false, bad: outText }); } });
  });
}

for (const name of ['shim-bypass.log', 'shim-bypass.log.1']) {
  describe(`special file at ${name}`, () => {
    it('a FIFO with no writer returns promptly as no data', async (t) => {
      if (!haveFifo()) return t.skip('no mkfifo');
      assert.equal(spawnSync('mkfifo', [path.join(dir, name)]).status, 0);
      const r = await summarizeInChild(dir);
      assert.ok(!r.timedOut, 'the reader must not block on a FIFO');
      assert.equal(r.summary.total, 0);
    });

    it('a FIFO next to a regular generation still counts the regular one', async (t) => {
      if (!haveFifo()) return t.skip('no mkfifo');
      const other = name === 'shim-bypass.log' ? 'shim-bypass.log.1' : 'shim-bypass.log';
      fs.writeFileSync(path.join(dir, other), RECORD);
      assert.equal(spawnSync('mkfifo', [path.join(dir, name)]).status, 0);
      const r = await summarizeInChild(dir);
      assert.ok(!r.timedOut);
      assert.equal(r.summary.total, 1);
    });

    it('a symlink is not followed: the target is not read', async () => {
      const target = path.join(dir, 'elsewhere.log');
      fs.writeFileSync(target, RECORD + RECORD);
      fs.symlinkSync(target, path.join(dir, name));
      const r = await summarizeInChild(dir);
      assert.ok(!r.timedOut);
      assert.equal(r.summary.total, 0, 'records behind a link are ignored');
    });
  });
}

describe('server stays responsive with a FIFO at the log path', () => {
  it('serves /_api/shim-bypass and /_api/health while shim-bypass.log is a FIFO', async (t) => {
    if (!haveFifo()) return t.skip('no mkfifo');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    assert.equal(spawnSync('mkfifo', [path.join(home, 'shim-bypass.log')]).status, 0);
    assert.equal(spawnSync('mkfifo', [path.join(home, 'shim-bypass.log.1')]).status, 0);
    const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
    const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser'], {
      env: { PATH: process.env.PATH, HOME: dir, CCXRAY_HOME: home, RESTORE_DAYS: '0', CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1' },
      stdio: 'ignore',
    });
    try {
      const get = p => new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${p}`, { timeout: LIMIT_MS }, res => {
          let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('request timed out')));
      });
      // Wait (bounded) for the listener, then the endpoint under test.
      const until = Date.now() + 15000;
      for (;;) {
        try { if ((await get('/_api/health')).status === 200) break; } catch { /* not up yet */ }
        assert.ok(Date.now() < until, 'server did not start');
        await new Promise(r => setTimeout(r, 25));
      }
      const res = await get('/_api/shim-bypass');
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).total, 0);
      assert.equal((await get('/_api/health')).status, 200, 'event loop still free after the read');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
