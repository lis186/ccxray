'use strict';

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CCXRAY_')) delete process.env[key];
}
for (const key of ['AUTH_TOKEN', 'LOGS_DIR', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS']) {
  delete process.env[key];
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-health-security-'));
const LOGS_DIR = path.join(TEST_HOME, 'logs');
const CLOUDSDK_CONFIG = path.join(TEST_HOME, 'cloudsdk');
const credentialPath = path.join(TEST_HOME, 'private', 'synthetic-key.json');
const email = 'synthetic-export-owner@example.invalid';
const privateKey = 'synthetic-private-key-material-do-not-emit';
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CLOUDSDK_CONFIG, { recursive: true });
fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
fs.writeFileSync(credentialPath, JSON.stringify({
  type: 'service_account',
  client_email: email,
  private_key: privateKey,
}));

process.env.CCXRAY_HOME = TEST_HOME;
process.env.LOGS_DIR = LOGS_DIR;
process.env.CLOUDSDK_CONFIG = CLOUDSDK_CONFIG;
process.env.CCXRAY_EXPORT_GCS_BUCKET = 'synthetic-health-security-bucket';
process.env.CCXRAY_EXPORT_DOMAINS = 'example.com';
process.env.CCXRAY_EXPORT_GCS_KEY_FILE = credentialPath;
process.env.CCXRAY_IMPORT_DISABLE = '1';

// Requiring the report assembler does not start export-sync or any uploader.
const hub = require('../server/hub');
const { inspectHomeStatus } = require('../server/status');

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CCXRAY_')) delete process.env[key];
  }
  for (const key of ['AUTH_TOKEN', 'LOGS_DIR', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

describe('health export report access and credential privacy', () => {
  it('serializes an enabled report without email, key contents, or credential path', () => {
    const reportEnv = { ...process.env };
    delete reportEnv.NODE_TEST_CONTEXT;
    const report = hub.assembleExportReport(reportEnv);
    const serialized = JSON.stringify(report);

    assert.equal(report.exportState, 'enabled');
    assert.equal(report.credential.parse.state, 'ok', 'the enabled credential parse branch must run');
    assert.equal(report.credential.discovery.pathLabel, '$CCXRAY_EXPORT_GCS_KEY_FILE');
    assert.ok(!serialized.includes(email));
    assert.ok(!serialized.includes(privateKey));
    assert.ok(!serialized.includes(credentialPath));
  });

  it('keeps export details out of public health for a simulated non-loopback peer', () => {
    let statusCode = null;
    let body = '';
    const request = {
      method: 'GET',
      url: '/_api/health',
      headers: {},
      socket: { remoteAddress: '203.0.113.12' },
    };
    const response = {
      writeHead(code) { statusCode = code; },
      end(value) { body = value; },
    };

    assert.equal(hub.handleHubRoutes(request, response), true);
    const health = JSON.parse(body);
    assert.equal(statusCode, 200);
    assert.equal(health.ok, true);
    assert.equal(health.exportState, undefined);
    assert.equal(health.identity, undefined);
    assert.equal(health.credential, undefined);
    assert.ok(!body.includes(TEST_HOME));
    assert.ok(!body.includes(email));
    assert.ok(!body.includes(privateKey));
    assert.ok(!body.includes(credentialPath));
    assert.equal(health.exportReportUnavailableReason, 'authentication-required');
  });

  it('includes the report for a default-trusted loopback peer', () => {
    let body = '';
    const request = {
      method: 'GET',
      url: '/_api/health',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const response = {
      writeHead() {},
      end(value) { body = value; },
    };

    assert.equal(hub.handleHubRoutes(request, response), true);
    const health = JSON.parse(body);
    assert.equal(health.identity.home, TEST_HOME);
    assert.equal(typeof health.exportState, 'string');
    assert.equal(health.exportReportUnavailableReason, undefined);
  });

  it('omits the report for loopback without a token when loopback auth is required', () => {
    process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH = '1';
    try {
      let body = '';
      const request = {
        method: 'GET',
        url: '/_api/health',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      };
      const response = {
        writeHead() {},
        end(value) { body = value; },
      };

      assert.equal(hub.handleHubRoutes(request, response), true);
      const health = JSON.parse(body);
      assert.equal(health.exportState, undefined);
      assert.equal(health.identity, undefined);
      assert.equal(health.exportReportUnavailableReason, 'authentication-required');
      assert.ok(!body.includes(TEST_HOME));
    } finally {
      delete process.env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    }
  });

  it('explains an auth-limited status result while inspecting only the caller home', () => {
    const result = inspectHomeStatus(null, {
      env: { CCXRAY_HOME: TEST_HOME, LOGS_DIR },
      unavailableReason: 'loopback authentication is required; status could not read the export report; cannot tell whether export is configured for this home',
    });

    assert.equal(result.paths.home, TEST_HOME);
    assert.ok(result.line.startsWith(`Home: ${TEST_HOME} —`));
    assert.match(result.line, /loopback authentication is required/);
    assert.match(result.line, /cannot tell whether export is configured for this home/);
  });
});
