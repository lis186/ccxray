'use strict';

// Session id handling, bounded metadata reads, and the dashboard same-origin check.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const store = require('../server/store');
const auth = require('../server/auth');
const { resolveGitBranch, _clearGitBranchCache } = require('../server/git-branch');
const { safeDecodeURIComponent } = require('../server/helpers');

describe('session id handling', () => {
  it('reserved session ids are not used as session ids', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const body = { metadata: { session_id: reserved }, messages: [{ role: 'user', content: 'hello' }] };
      assert.notEqual(store.detectSession(body).sessionId, reserved);
    }
    assert.equal(Object.getPrototypeOf(store.sessionMeta), null);
    assert.equal(Object.getPrototypeOf(store.activeRequests), null);
  });

  it('sanitizeSessionId treats reserved names as no id', () => {
    assert.equal(store.sanitizeSessionId('__proto__'), null);
    assert.equal(store.sanitizeSessionId(' constructor '), null);
    assert.equal(store.sanitizeSessionId('abc'), 'abc');
  });

  it('non-string metadata.user_id is ignored', () => {
    for (const v of [42, {}, [], true]) assert.equal(store.extractSessionId({ metadata: { user_id: v } }), null);
  });

  it('persisted rows with reserved ids are skipped when loading and healing', async () => {
    const { isReservedSessionId } = require('../server/session-id');
    assert.equal(isReservedSessionId('__proto__'), true);
    assert.equal(isReservedSessionId('abc'), false);
    assert.equal(store.setSessionTitle('__proto__', 'a title', 1), false);
    assert.equal(Object.keys(store.sessionMeta).includes('__proto__'), false);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-persisted-'));
    try {
      const logs = path.join(home, 'logs');
      fs.mkdirSync(logs);
      fs.writeFileSync(path.join(logs, 'sessions.json'),
        ['__proto__', 'constructor', 'good'].map(sid => JSON.stringify({ sid, count: 0 })).join('\n') + '\n');
      const out = require('child_process').execFileSync(process.execPath, ['-e', `
        const si = require(${JSON.stringify(path.join(__dirname, '../server/session-index'))});
        si.loadSessionIndex().then(() => console.log(JSON.stringify(si.getAll().map(s => s.sid))));
      `], { env: { ...process.env, CCXRAY_HOME: home, LOGS_DIR: logs, CCXRAY_EXPORT_DISABLE: '1' }, encoding: 'utf8' });
      const sids = JSON.parse(out.trim().split('\n').pop());
      assert.deepEqual(sids, ['good']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('usage aggregation counts arbitrary keys as ordinary keys', () => {
    const { analyze } = require('../server/usage');
    const rows = ['__proto__', 'constructor', 'toString'].map((name, i) => ({
      id: `t${i}`, sessionId: name, model: name, provider: name, receivedAt: 1000 + i,
      turnToolCalls: { [name]: 1 },
    }));
    const r = analyze(rows);
    assert.equal(r.sessions.count, 3);
  });
});

describe('safeDecodeURIComponent', () => {
  it('returns null for malformed escapes', () => {
    assert.equal(safeDecodeURIComponent('%FF'), null);
    assert.equal(safeDecodeURIComponent('a%20b'), 'a b');
  });
});

describe('dashboard write origin gate', () => {
  const PORT = 5577;
  const req = (method, headers, url = '/_api/settings', socket = {}) =>
    ({ method, headers, url, socket: { remoteAddress: '127.0.0.1', localPort: PORT, ...socket } });
  const res = () => ({ code: null, writeHead(c) { this.code = c; }, end() {} });
  const check = r => { const s = res(); return { ok: auth.verifyDashboardWrite(r, s), code: s.code }; };
  const post = origin => check(req('POST', { host: `127.0.0.1:${PORT}`, origin }));

  it('allows writes without Origin or Sec-Fetch-Site', () => {
    assert.equal(check(req('POST', { host: `127.0.0.1:${PORT}` })).ok, true);
  });
  it('allows same-origin requests', () => {
    assert.equal(check(req('POST', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' })).ok, true);
    assert.equal(post(`http://127.0.0.1:${PORT}`).ok, true);
  });
  it('treats loopback spellings on the same port and scheme as one origin', () => {
    assert.equal(post(`http://localhost:${PORT}`).ok, true);
    assert.equal(post(`http://[::1]:${PORT}`).ok, true);
  });
  it('rejects a different port', () => {
    assert.deepEqual(post(`http://localhost:${PORT + 1}`), { ok: false, code: 403 });
    assert.deepEqual(post('http://127.0.0.1'), { ok: false, code: 403 });
  });
  it('rejects a different scheme', () => {
    assert.deepEqual(post(`https://127.0.0.1:${PORT}`), { ok: false, code: 403 });
  });
  it('rejects other hosts and a null Origin', () => {
    assert.deepEqual(post('https://example.com'), { ok: false, code: 403 });
    assert.deepEqual(post(`http://example.com:${PORT}`), { ok: false, code: 403 });
    assert.deepEqual(post('null'), { ok: false, code: 403 });
  });
  it('rejects cross-site and same-site fetch metadata', () => {
    assert.deepEqual(check(req('POST', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site' })), { ok: false, code: 403 });
    assert.deepEqual(check(req('POST', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-site' })), { ok: false, code: 403 });
  });
  it('compares the listener port, not the Host header', () => {
    assert.deepEqual(check(req('POST', { host: 'localhost:9999', origin: 'http://localhost:9999' })), { ok: false, code: 403 });
  });
  it('does not gate reads or upstream paths', () => {
    assert.equal(check(req('GET', { host: `127.0.0.1:${PORT}`, origin: 'https://example.com' })).ok, true);
    assert.equal(check(req('POST', { host: `127.0.0.1:${PORT}`, origin: 'https://example.com' }, '/v1/messages')).ok, true);
  });
  it('hasJsonContentType accepts only application/json', () => {
    assert.equal(auth.hasJsonContentType({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
    assert.equal(auth.hasJsonContentType({ headers: { 'content-type': 'text/plain' } }), false);
    assert.equal(auth.hasJsonContentType({ headers: {} }), false);
  });
  it('bootstrap-token route applies the same policy', () => {
    const { handleAuthRoutes } = require('../server/routes/auth');
    const s = res();
    const handled = handleAuthRoutes(req('POST', { host: `127.0.0.1:${PORT}`, origin: 'http://localhost:1' }, '/_auth/bootstrap-token'), s);
    assert.equal(handled, true);
    assert.equal(s.code, 403);
  });
});

describe('git-branch bounded reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-git-input-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nonWin = { skip: process.platform === 'win32' };

  // Run the reader in a child so a stuck read is bounded by the parent's timeout.
  function branchInChild(dir) {
    const script = `const { resolveGitBranch } = require(${JSON.stringify(path.join(__dirname, '../server/git-branch'))});
      console.log(JSON.stringify(resolveGitBranch(${JSON.stringify(dir)})));`;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(out.error, undefined, 'reader did not finish within the parent-enforced timeout');
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim());
  }

  it('returns null for a FIFO at .git/HEAD', nonWin, () => {
    const dir = path.join(root, 'fifo-repo');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    execFileSync('mkfifo', [path.join(dir, '.git', 'HEAD')]);
    assert.equal(branchInChild(dir), null);
  });

  it('returns null for a FIFO .git pointer file', nonWin, () => {
    const dir = path.join(root, 'fifo-ptr');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [path.join(dir, '.git')]);
    assert.equal(branchInChild(dir), null);
  });

  it('returns null when .git/HEAD is a symlink to a FIFO', nonWin, () => {
    const dir = path.join(root, 'symlink-fifo');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const fifo = path.join(root, 'target-fifo');
    execFileSync('mkfifo', [fifo]);
    fs.symlinkSync(fifo, path.join(dir, '.git', 'HEAD'));
    assert.equal(branchInChild(dir), null);
  });

  it('resolves a .git/HEAD symlink to a regular file', nonWin, () => {
    const dir = path.join(root, 'symlink-regular');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const target = path.join(root, 'head-target');
    fs.writeFileSync(target, 'ref: refs/heads/linked\n');
    fs.symlinkSync(target, path.join(dir, '.git', 'HEAD'));
    _clearGitBranchCache();
    assert.equal(resolveGitBranch(dir), 'linked');
  });

  it('returns null when .git/HEAD is larger than the read bound', () => {
    const dir = path.join(root, 'oversized');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/' + 'a'.repeat(5000) + '\n');
    _clearGitBranchCache();
    assert.equal(resolveGitBranch(dir), null);
  });

  it('still resolves a normal repo and a worktree pointer file', () => {
    _clearGitBranchCache();
    const dir = path.join(root, 'repo');
    fs.mkdirSync(path.join(dir, '.git', 'worktrees', 'w'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/feat/x\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, '.git', 'worktrees', 'w')}\n`);
    assert.equal(resolveGitBranch(dir), 'main');
    assert.equal(resolveGitBranch(wt), 'feat/x');
  });
});
