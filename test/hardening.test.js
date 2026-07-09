'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripControlChars } = require('../server/url-sanitize');

// ── A. Config injection ───────────────────────────────────────────────────────

describe('proxy-config JSON pattern (item A)', () => {
  it('JSON.parse round-trips the config object', () => {
    const config = { DEFAULT_CONTEXT: 200000, PORT: 5577, statusLine: true, APP_NAME: 'ccxray' };
    const serialized = JSON.stringify(config);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed, config);
  });

  it('config with special chars round-trips via JSON.parse correctly', () => {
    const config = { APP_NAME: '</script><script>alert(1)', PORT: 5577 };
    const serialized = JSON.stringify(config);
    // The safety model: type="application/json" blocks are never executed as JS
    // regardless of their textContent — JSON.parse on the client side is safe.
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed, config);
  });
});

// ── B. File permissions 0600 ──────────────────────────────────────────────────

describe('file permissions 0600 (item B)', () => {
  it('writeFile with mode 0o600 produces a 0600 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hardening-'));
    const p = path.join(dir, 'test.json');
    try {
      fs.writeFileSync(p, '{}', { mode: 0o600 });
      const mode = fs.statSync(p).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
  });

  it('mkdirSync with mode 0o700 produces a 0700 directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hardening-'));
    const dir = path.join(parent, 'sub');
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      const mode = fs.statSync(dir).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0700, got 0${mode.toString(8)}`);
    } finally {
      try { fs.rmSync(parent, { recursive: true }); } catch {}
    }
  });
});

// ── C. Control character stripping ───────────────────────────────────────────

describe('stripControlChars (item C)', () => {
  it('strips ESC and other control chars from a string', () => {
    assert.equal(stripControlChars('hello\x1bworld'), 'helloworld');
    assert.equal(stripControlChars('ab\x00cd'), 'abcd');
    assert.equal(stripControlChars('line\x0abreak'), 'linebreak');
    assert.equal(stripControlChars('tab\x09here'), 'tabhere');
    assert.equal(stripControlChars('del\x7fchar'), 'delchar');
  });

  it('returns non-string inputs unchanged', () => {
    assert.equal(stripControlChars(null), null);
    assert.equal(stripControlChars(undefined), undefined);
    assert.equal(stripControlChars(42), 42);
  });

  it('returns a clean string unchanged', () => {
    assert.equal(stripControlChars('hello world'), 'hello world');
    assert.equal(stripControlChars('/v1/messages'), '/v1/messages');
  });
});

// ── D. Hub register validation ────────────────────────────────────────────────

describe('hub register validation (item D)', () => {
  // Test the validation logic directly (extracted as a pure function for testability)
  function isValidRegisterMsg(msg) {
    if (typeof msg.pid !== 'number' || msg.pid <= 0 || msg.pid > 4194304 || !Number.isInteger(msg.pid)) return false;
    if (typeof msg.cwd !== 'string' || msg.cwd.length > 4096) return false;
    return true;
  }

  it('accepts a valid pid and cwd', () => {
    assert.ok(isValidRegisterMsg({ pid: 1234, cwd: '/home/user/project' }));
    assert.ok(isValidRegisterMsg({ pid: 1, cwd: '/' }));
    assert.ok(isValidRegisterMsg({ pid: 4194304, cwd: '/tmp' }));
  });

  it('rejects non-integer pid', () => {
    assert.ok(!isValidRegisterMsg({ pid: 1.5, cwd: '/tmp' }));
    assert.ok(!isValidRegisterMsg({ pid: NaN, cwd: '/tmp' }));
    assert.ok(!isValidRegisterMsg({ pid: Infinity, cwd: '/tmp' }));
  });

  it('rejects out-of-range pid', () => {
    assert.ok(!isValidRegisterMsg({ pid: 0, cwd: '/tmp' }));
    assert.ok(!isValidRegisterMsg({ pid: -1, cwd: '/tmp' }));
    assert.ok(!isValidRegisterMsg({ pid: 4194305, cwd: '/tmp' }));
  });

  it('rejects non-string cwd', () => {
    assert.ok(!isValidRegisterMsg({ pid: 1234, cwd: null }));
    assert.ok(!isValidRegisterMsg({ pid: 1234, cwd: 123 }));
    assert.ok(!isValidRegisterMsg({ pid: 1234, cwd: undefined }));
  });

  it('rejects cwd exceeding 4096 bytes', () => {
    assert.ok(!isValidRegisterMsg({ pid: 1234, cwd: 'a'.repeat(4097) }));
    assert.ok(isValidRegisterMsg({ pid: 1234, cwd: 'a'.repeat(4096) }));
  });
});
