'use strict';

// Tests for ANTHROPIC_BASE_URL parsing logic in server/config.js.
// Because config.js is a singleton (module cache), we test parseBaseUrl()
// directly (exported for testability) and re-require config in isolated
// child processes via spawnAndCollect for integration scenarios.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_SCRIPT = path.resolve(__dirname, '..', 'server', 'config.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-config-test-'));

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helper: run a node snippet in a child process with given env ────

function runSnippet(snippet, env = {}) {
  return new Promise((resolve) => {
    // Start from process.env, sanitise ambient ANTHROPIC_* vars that would
    // leak from a developer's shell and corrupt test results, then apply
    // the caller's explicit overrides on top.
    const sanitised = { ...process.env };
    delete sanitised.ANTHROPIC_BASE_URL;
    delete sanitised.ANTHROPIC_TEST_HOST;
    delete sanitised.ANTHROPIC_TEST_PORT;
    delete sanitised.ANTHROPIC_TEST_PROTOCOL;
    Object.assign(sanitised, env);

    const child = spawn(process.execPath, ['-e', snippet], {
      env: sanitised,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

// ── 4.1: parseBaseUrl unit tests ───────────────────────────────────

describe('parseBaseUrl()', () => {
  // Load the exported helper into this process for lightweight unit tests.
  // We delete env overrides first so the module doesn't log warnings.
  let parseBaseUrl;
  before(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_TEST_HOST;
    delete process.env.ANTHROPIC_TEST_PORT;
    delete process.env.ANTHROPIC_TEST_PROTOCOL;
    // Re-require after clearing env (module may already be cached; that's fine
    // since parseBaseUrl is a pure function not affected by env at call time).
    ({ parseBaseUrl } = require('../server/config'));
  });

  it('parses valid HTTPS URL with explicit port', () => {
    const result = parseBaseUrl('https://proxy.corp.example.com:8443');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.corp.example.com', port: 8443, basePath: '' });
  });

  it('infers port 443 for HTTPS URL without explicit port', () => {
    const result = parseBaseUrl('https://proxy.corp.example.com');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.corp.example.com', port: 443, basePath: '' });
  });

  it('parses valid HTTP URL and infers port 80', () => {
    const result = parseBaseUrl('http://internal-gateway.corp:9090');
    assert.deepEqual(result, { protocol: 'http', hostname: 'internal-gateway.corp', port: 9090, basePath: '' });
  });

  it('infers port 80 for HTTP URL without explicit port', () => {
    const result = parseBaseUrl('http://internal-gateway.corp');
    assert.deepEqual(result, { protocol: 'http', hostname: 'internal-gateway.corp', port: 80, basePath: '' });
  });

  it('handles trailing slash correctly (common user mistake)', () => {
    const result = parseBaseUrl('https://proxy.example.com/');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.example.com', port: 443, basePath: '' });
  });

  it('captures path from URL with base path', () => {
    const result = parseBaseUrl('https://adb-1033261988689278.18.azuredatabricks.net/serving-endpoints/anthropic');
    assert.deepEqual(result, { protocol: 'https', hostname: 'adb-1033261988689278.18.azuredatabricks.net', port: 443, basePath: '/serving-endpoints/anthropic' });
  });

  it('strips trailing slash from base path', () => {
    const result = parseBaseUrl('https://gateway.example.com/api/v1/');
    assert.deepEqual(result, { protocol: 'https', hostname: 'gateway.example.com', port: 443, basePath: '/api/v1' });
  });

  it('returns null for malformed URL', () => {
    const result = parseBaseUrl('not-a-valid-url');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = parseBaseUrl('');
    assert.equal(result, null);
  });

  it('returns null for null/undefined', () => {
    assert.equal(parseBaseUrl(null), null);
    assert.equal(parseBaseUrl(undefined), null);
  });
});

// ── 4.2: Priority chain integration tests ─────────────────────────

describe('upstream priority chain', () => {
  const snippet = `
    const c = require(${JSON.stringify(CONFIG_SCRIPT)});
    process.stdout.write(JSON.stringify({
      host: c.ANTHROPIC_HOST,
      port: c.ANTHROPIC_PORT,
      protocol: c.ANTHROPIC_PROTOCOL,
      source: c.ANTHROPIC_BASE_URL_SOURCE,
      basePath: c.ANTHROPIC_BASE_PATH,
    }));
  `;

  it('ANTHROPIC_TEST_HOST overrides ANTHROPIC_BASE_URL', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_TEST_HOST: 'test.example.com',
      ANTHROPIC_TEST_PORT: '9000',
      ANTHROPIC_TEST_PROTOCOL: 'http',
      ANTHROPIC_BASE_URL: 'https://other.example.com:8443',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'test.example.com');
    assert.equal(result.port, 9000);
    assert.equal(result.protocol, 'http');
    assert.equal(result.source, 'test-override');
  });

  it('ANTHROPIC_BASE_URL is used when no ANTHROPIC_TEST_* vars are set', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://proxy.example.com:7777',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'proxy.example.com');
    assert.equal(result.port, 7777);
    assert.equal(result.protocol, 'https');
    assert.equal(result.source, 'ANTHROPIC_BASE_URL');
  });

  it('falls back to api.anthropic.com defaults when neither is set', async () => {
    const { stdout } = await runSnippet(snippet, { CCXRAY_HOME: TEST_HOME });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'api.anthropic.com');
    assert.equal(result.port, 443);
    assert.equal(result.protocol, 'https');
    assert.equal(result.source, 'default');
  });

  it('falls back to defaults when ANTHROPIC_BASE_URL is malformed', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'not-a-url',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'api.anthropic.com');
    assert.equal(result.source, 'default');
  });

  it('exposes base path from ANTHROPIC_BASE_URL with path component', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://adb-xxx.azuredatabricks.net/serving-endpoints/anthropic',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'adb-xxx.azuredatabricks.net');
    assert.equal(result.basePath, '/serving-endpoints/anthropic');
  });

  it('exposes empty base path when ANTHROPIC_BASE_URL has no path', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.basePath, '');
  });
});

// ── 4.3: Partial ANTHROPIC_TEST_* override warning ─────────────────

describe('partial ANTHROPIC_TEST_* override', () => {
  it('emits warning when only ANTHROPIC_TEST_PORT is set', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_TEST_PORT: '9000',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('partial') || stderr.includes('ANTHROPIC_TEST_HOST') || stderr.includes('ANTHROPIC_TEST_PROTOCOL'),
      `Expected partial-override warning in stderr, got: ${stderr}`
    );
  });

  it('does not warn when full ANTHROPIC_TEST_* triple is set', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_TEST_HOST: 'test.example.com',
      ANTHROPIC_TEST_PORT: '9000',
      ANTHROPIC_TEST_PROTOCOL: 'http',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      !stderr.includes('partial'),
      `Unexpected partial-override warning in stderr: ${stderr}`
    );
  });
});

// ── 4.4: Malformed URL warning reaches stderr (not just console.warn) ──

describe('malformed URL warning via stderr', () => {
  it('writes warning directly to stderr so it survives console muting', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'not-a-url',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('not a valid URL') || stderr.includes('ANTHROPIC_BASE_URL'),
      `Expected malformed URL warning in stderr, got: ${stderr}`
    );
  });
});

// ── 4.5: Self-loop detection ────────────────────────────────────────

describe('self-loop detection', () => {
  it('emits warning when ANTHROPIC_BASE_URL points at the proxy itself', async () => {
    // Use PROXY_PORT=5577 (default) and ANTHROPIC_BASE_URL pointing at same port
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      PROXY_PORT: '5577',
      ANTHROPIC_BASE_URL: 'http://localhost:5577',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('points back at the proxy itself') || stderr.includes('loop'),
      `Expected loop warning in stderr, got: ${stderr}`
    );
  });

  it('does not warn for a legitimate upstream', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      PROXY_PORT: '5577',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com:8443',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      !stderr.includes('points back at the proxy itself'),
      `Unexpected loop warning in stderr: ${stderr}`
    );
  });
});
