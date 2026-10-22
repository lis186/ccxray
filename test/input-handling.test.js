'use strict';

// Session-keyed state, bounded .git reads, and the dashboard write-origin gate.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../server/store');
const auth = require('../server/auth');
const { resolveGitBranch, _clearGitBranchCache } = require('../server/git-branch');
const { safeDecodeURIComponent } = require('../server/helpers');

describe('session-keyed maps', () => {
  it('a reserved session id does not leak fields to other sessions', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const body = { metadata: { session_id: reserved }, messages: [{ role: 'user', content: 'secret prompt' }] };
      const detected = store.detectSession(body);
      assert.notEqual(detected.sessionId, reserved);
    }
    store.sessionMeta['__proto__'] = { cwd: '/leaked', firstPrompt: 'leaked' };
    store.activeRequests['__proto__'] = 3;
    const other = { };
    assert.equal(other.cwd, undefined);
    assert.equal(({}).cwd, undefined);
    assert.equal(({}).firstPrompt, undefined);
    assert.equal(store.sessionMeta['plain-session']?.cwd, undefined);
    assert.equal(Object.getPrototypeOf(store.sessionMeta), null);
    assert.equal(Object.getPrototypeOf(store.activeRequests), null);
    delete store.sessionMeta['__proto__'];
    delete store.activeRequests['__proto__'];
  });

  it('sanitizeSessionId treats reserved names as no id', () => {
    assert.equal(store.sanitizeSessionId('__proto__'), null);
    assert.equal(store.sanitizeSessionId(' constructor '), null);
    assert.equal(store.sanitizeSessionId('abc'), 'abc');
  });
});

describe('safeDecodeURIComponent', () => {
  it('returns null for malformed escapes', () => {
    assert.equal(safeDecodeURIComponent('%FF'), null);
    assert.equal(safeDecodeURIComponent('a%20b'), 'a b');
  });
});

describe('dashboard write origin gate', () => {
  const req = (method, headers, url = '/_api/settings') => ({ method, headers, url, socket: { remoteAddress: '127.0.0.1' } });
  const res = () => ({ code: null, writeHead(c) { this.code = c; }, end() {} });
  const check = r => { const s = res(); return { ok: auth.verifyDashboardWrite(r, s), code: s.code }; };

  it('allows writes without Origin or Sec-Fetch-Site', () => {
    assert.equal(check(req('POST', { host: '127.0.0.1:5577' })).ok, true);
  });
  it('allows same-origin and same-host Origin', () => {
    assert.equal(check(req('POST', { host: '127.0.0.1:5577', 'sec-fetch-site': 'same-origin' })).ok, true);
    assert.equal(check(req('POST', { host: 'localhost:5577', origin: 'http://localhost:5577' })).ok, true);
  });
  it('rejects cross-site and mismatched Origin with 403', () => {
    assert.deepEqual(check(req('POST', { host: '127.0.0.1:5577', 'sec-fetch-site': 'cross-site' })), { ok: false, code: 403 });
    assert.deepEqual(check(req('POST', { host: '127.0.0.1:5577', 'sec-fetch-site': 'same-site' })), { ok: false, code: 403 });
    assert.deepEqual(check(req('DELETE', { host: '127.0.0.1:5577', origin: 'https://example.com' })), { ok: false, code: 403 });
    assert.deepEqual(check(req('POST', { host: '127.0.0.1:5577', origin: 'null' })), { ok: false, code: 403 });
  });
  it('does not gate reads or upstream paths', () => {
    assert.equal(check(req('GET', { host: '127.0.0.1:5577', origin: 'https://example.com' })).ok, true);
    assert.equal(check(req('POST', { host: '127.0.0.1:5577', origin: 'https://example.com' }, '/v1/messages')).ok, true);
  });
  it('hasJsonContentType accepts only application/json', () => {
    assert.equal(auth.hasJsonContentType({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
    assert.equal(auth.hasJsonContentType({ headers: { 'content-type': 'text/plain' } }), false);
    assert.equal(auth.hasJsonContentType({ headers: {} }), false);
  });
});

describe('git-branch bounded reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-git-input-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns null promptly for a FIFO at .git/HEAD', { skip: process.platform === 'win32' }, () => {
    _clearGitBranchCache();
    const dir = path.join(root, 'fifo-repo');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    execFileSync('mkfifo', [path.join(dir, '.git', 'HEAD')]);
    const t0 = Date.now();
    assert.equal(resolveGitBranch(dir), null);
    assert.ok(Date.now() - t0 < 1000);
  });

  it('returns null for a FIFO .git pointer file', { skip: process.platform === 'win32' }, () => {
    _clearGitBranchCache();
    const dir = path.join(root, 'fifo-ptr');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [path.join(dir, '.git')]);
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
