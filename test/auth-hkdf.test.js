'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Use a per-run temp CCXRAY_HOME so we never touch the user's real ~/.ccxray
// and tests can manipulate the local-secret file freely.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hkdf-test-'));
process.env.CCXRAY_HOME = TEST_HOME;

// Lazy-require so we pick up the env override above.
const auth = require('../server/auth');

function clearTestHome() {
  for (const name of fs.readdirSync(TEST_HOME)) {
    fs.rmSync(path.join(TEST_HOME, name), { recursive: true, force: true });
  }
}

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('deriveSecrets(rootKey) — HKDF label separation', () => {
  it('returns four Buffer keys with the expected labels', () => {
    const root = crypto.randomBytes(32);
    const out = auth.deriveSecrets(root);
    assert.ok(Buffer.isBuffer(out.K_upstream), 'K_upstream is a Buffer');
    assert.ok(Buffer.isBuffer(out.K_session), 'K_session is a Buffer');
    assert.ok(Buffer.isBuffer(out.K_bootstrap), 'K_bootstrap is a Buffer');
    assert.equal(out.K_upstream.length, 32);
    assert.equal(out.K_session.length, 32);
    assert.equal(out.K_bootstrap.length, 32);
    assert.ok(Buffer.isBuffer(out.K_shim));
    assert.equal(out.K_shim.length, 32);
    assert.deepEqual(out.K_shim, Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from('ccxray/v1/shim-identity'), 32)));
  });

  it('is deterministic — same root produces identical secrets', () => {
    const root = Buffer.from('a'.repeat(32));
    const a = auth.deriveSecrets(root);
    const b = auth.deriveSecrets(root);
    assert.deepEqual(a.K_upstream, b.K_upstream);
    assert.deepEqual(a.K_session, b.K_session);
    assert.deepEqual(a.K_bootstrap, b.K_bootstrap);
    assert.deepEqual(a.K_shim, b.K_shim);
  });

  it('produces four pairwise-distinct keys (label separation)', () => {
    const root = crypto.randomBytes(32);
    const { K_upstream, K_session, K_bootstrap, K_shim } = auth.deriveSecrets(root);
    for (const other of [K_upstream, K_session, K_bootstrap]) assert.notDeepEqual(K_shim, other);
    assert.notDeepEqual(K_upstream, K_session);
    assert.notDeepEqual(K_session, K_bootstrap);
    assert.notDeepEqual(K_upstream, K_bootstrap);
  });

  it('different roots produce different secrets', () => {
    const a = auth.deriveSecrets(Buffer.alloc(32, 1));
    const b = auth.deriveSecrets(Buffer.alloc(32, 2));
    assert.notDeepEqual(a.K_upstream, b.K_upstream);
    assert.notDeepEqual(a.K_session, b.K_session);
    assert.notDeepEqual(a.K_bootstrap, b.K_bootstrap);
    assert.notDeepEqual(a.K_shim, b.K_shim);
  });
});

describe('getRootSecret() — AUTH_TOKEN vs ephemeral mode', () => {
  beforeEach(() => {
    delete process.env.AUTH_TOKEN;
    clearTestHome();
  });

  it('with AUTH_TOKEN set: returns sha256(AUTH_TOKEN)', () => {
    process.env.AUTH_TOKEN = 'hunter2';
    const got = auth.getRootSecret();
    const expected = crypto.createHash('sha256').update('hunter2', 'utf8').digest();
    assert.deepEqual(got, expected);
  });

  it('with AUTH_TOKEN set: ignores local-secret on disk', () => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
    fs.writeFileSync(path.join(TEST_HOME, 'local-secret'), Buffer.alloc(32, 9));
    process.env.AUTH_TOKEN = 'env-wins';
    const got = auth.getRootSecret();
    const expected = crypto.createHash('sha256').update('env-wins', 'utf8').digest();
    assert.deepEqual(got, expected);
  });

  it('with AUTH_TOKEN unset: creates ~/.ccxray/local-secret on first call', () => {
    const secretPath = path.join(TEST_HOME, 'local-secret');
    assert.equal(fs.existsSync(secretPath), false, 'precondition: no file');
    const got = auth.getRootSecret();
    assert.equal(got.length, 32);
    assert.equal(fs.existsSync(secretPath), true, 'file created');
    const onDisk = fs.readFileSync(secretPath);
    assert.deepEqual(got, onDisk, 'returned key matches on-disk bytes');
  });

  it('with AUTH_TOKEN unset: subsequent calls reuse the same secret', () => {
    const first = auth.getRootSecret();
    const second = auth.getRootSecret();
    assert.deepEqual(first, second);
  });

  it('with AUTH_TOKEN unset: local-secret file is mode 0600', () => {
    auth.getRootSecret();
    const stat = fs.statSync(path.join(TEST_HOME, 'local-secret'));
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got 0${mode.toString(8)}`);
  });

  it('with AUTH_TOKEN unset: parent dir is mode 0700', () => {
    auth.getRootSecret();
    const stat = fs.statSync(TEST_HOME);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o700, `expected mode 0700, got 0${mode.toString(8)}`);
  });

  it('switching from ephemeral to AUTH_TOKEN changes the derived secrets', () => {
    const ephemeral = auth.getRootSecret();
    process.env.AUTH_TOKEN = 'now-with-token';
    const withToken = auth.getRootSecret();
    assert.notDeepEqual(ephemeral, withToken);
  });
});
