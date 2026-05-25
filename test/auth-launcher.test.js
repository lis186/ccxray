'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

describe('auth launcher header injection (1.4a)', () => {
  let tmpHome;
  let originalEnv;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-auth-launcher-'));
    originalEnv = { ...process.env };
    process.env.CCXRAY_HOME = tmpHome;
    // Ensure auth module re-derives from fresh CCXRAY_HOME
    delete require.cache[require.resolve('../server/auth')];
    delete require.cache[require.resolve('../server/providers')];
  });

  afterEach(() => {
    process.env = originalEnv;
    delete require.cache[require.resolve('../server/auth')];
    delete require.cache[require.resolve('../server/providers')];
  });

  function getKUpstreamBase64url() {
    const auth = require('../server/auth');
    const secrets = auth.deriveSecrets(auth.getRootSecret());
    return secrets.K_upstream.toString('base64url');
  }

  describe('Claude launcher', () => {
    it('injects X-Ccxray-Auth via ANTHROPIC_CUSTOM_HEADERS', () => {
      const providers = require('../server/providers');
      const kUp = getKUpstreamBase64url();

      const launch = providers.getAgentLaunch('claude', 5577, ['--continue'], {
        PATH: '/usr/bin',
      });

      assert.equal(
        launch.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Ccxray-Auth: ${kUp}`
      );
      // Still sets ANTHROPIC_BASE_URL
      assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://localhost:5577');
    });

    it('appends to existing ANTHROPIC_CUSTOM_HEADERS', () => {
      const providers = require('../server/providers');
      const kUp = getKUpstreamBase64url();

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: foo',
      });

      assert.equal(
        launch.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Existing: foo, X-Ccxray-Auth: ${kUp}`
      );
    });
  });

  describe('Codex launcher — API-key mode (OPENAI_API_KEY set)', () => {
    it('injects model_providers.ccxray with http_headers + model_provider override', () => {
      const providers = require('../server/providers');
      const kUp = getKUpstreamBase64url();

      const launch = providers.getAgentLaunch('codex', 5577, ['exec', 'hello'], {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
      });

      // Should have model_providers.ccxray config
      const mpArg = launch.args.find(a => a.includes('model_providers.ccxray'));
      assert.ok(mpArg, 'should have model_providers.ccxray arg');
      assert.match(mpArg, /base_url="http:\/\/localhost:5577\/v1"/);
      assert.match(mpArg, /wire_api="responses"/);
      assert.match(mpArg, new RegExp(`X-Ccxray-Auth.*${kUp.slice(0, 10)}`));

      // Should have model_provider="ccxray"
      const providerIdx = launch.args.indexOf('-c');
      const mpOverride = launch.args.find(a => a.includes('model_provider="ccxray"'));
      assert.ok(mpOverride, 'should have model_provider="ccxray" arg');

      // Should NOT have old-style openai_base_url / chatgpt_base_url
      const hasOldStyle = launch.args.some(a => a.includes('openai_base_url'));
      assert.equal(hasOldStyle, false, 'should not have openai_base_url in API-key mode');

      // User args still pass through
      assert.ok(launch.args.includes('exec'));
      assert.ok(launch.args.includes('hello'));
    });
  });

  describe('Codex launcher — ChatGPT-OAuth mode (no OPENAI_API_KEY)', () => {
    it('uses legacy openai_base_url + chatgpt_base_url, no model_provider override', () => {
      const providers = require('../server/providers');

      const launch = providers.getAgentLaunch('codex', 5577, ['exec', 'hello'], {
        PATH: '/usr/bin',
        // No OPENAI_API_KEY
      });

      // Should have old-style base_url configs
      assert.ok(
        launch.args.some(a => a.includes('openai_base_url="http://localhost:5577/v1"')),
        'should have openai_base_url'
      );
      assert.ok(
        launch.args.some(a => a.includes('chatgpt_base_url="http://localhost:5577/v1"')),
        'should have chatgpt_base_url'
      );

      // Should NOT have model_provider override
      const mpOverride = launch.args.find(a => a.includes('model_provider='));
      assert.equal(mpOverride, undefined, 'should not have model_provider in OAuth mode');

      // Should NOT have model_providers.ccxray
      const mpConfig = launch.args.find(a => a.includes('model_providers.ccxray'));
      assert.equal(mpConfig, undefined, 'should not have model_providers.ccxray in OAuth mode');
    });
  });

  describe('graceful fallback when K_upstream derivation fails', () => {
    it('warns but does not abort when getRootSecret throws', () => {
      // Point CCXRAY_HOME at a read-only path so ensureHubDir() fails on mkdir
      const readonlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ro-'));
      const impossibleChild = path.join(readonlyDir, 'nope', 'deeper');
      process.env.CCXRAY_HOME = impossibleChild;
      fs.chmodSync(readonlyDir, 0o444);

      delete require.cache[require.resolve('../server/auth')];
      delete require.cache[require.resolve('../server/providers')];

      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        const providers = require('../server/providers');
        const launch = providers.getAgentLaunch('claude', 5577, [], { PATH: '/usr/bin' });

        assert.ok(launch, 'launch should not be null');
        assert.equal(launch.bin, 'claude');
        assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://localhost:5577');
        assert.equal(launch.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
        assert.ok(warnings.length > 0, 'should have emitted a warning');
        assert.ok(
          warnings.some(w => w.includes('X-Ccxray-Auth')),
          'warning should mention X-Ccxray-Auth'
        );
      } finally {
        console.warn = origWarn;
        fs.chmodSync(readonlyDir, 0o755);
        fs.rmSync(readonlyDir, { recursive: true });
      }
    });
  });
});
