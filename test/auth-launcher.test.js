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
    // The launcher reads this once before spawning Claude. Keep it synthetic so
    // the test never consults a developer's real Claude config directory.
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
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
        CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
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
        CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
        ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: foo',
      });

      assert.equal(
        launch.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Existing: foo, X-Ccxray-Auth: ${kUp}`
      );
    });

    it('captures the launch-time Claude OAuth account from the effective config directory', () => {
      const providers = require('../server/providers');
      const claudeConfig = path.join(tmpHome, 'launch-claude');
      fs.mkdirSync(claudeConfig, { recursive: true });
      // Mirrors the real oauthAccount shape, with entirely synthetic values.
      fs.writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({
        oauthAccount: {
          accountUuid: '00000000-0000-4000-8000-000000000001',
          emailAddress: 'a@example.com',
          organizationUuid: '00000000-0000-4000-8000-000000000002',
          hasExtraUsageEnabled: false,
          billingType: 'subscription',
          accountCreatedAt: '2026-01-02T03:04:05.000Z',
          subscriptionCreatedAt: '2026-01-03T04:05:06.000Z',
          displayName: 'Dev Example',
          fullName: 'Dev Example',
          profileFetchedAt: 1770000000000,
          organizationRole: 'member',
          organizationName: 'Example Org',
          organizationType: 'team',
          organizationRateLimitTier: 'standard',
          ccOnboardingFlags: null,
          claudeCodeTrialEndsAt: null,
          claudeCodeTrialDurationDays: null,
          seatTier: null,
          workspaceRole: null,
          userRateLimitTier: null,
        },
      }));

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: foo',
      });

      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Existing: foo/);
      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Auth: /);
      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account: a@example\.com$/);
    });

    it('uses the launch environment config over the parent process config', () => {
      const providers = require('../server/providers');
      const processConfig = path.join(tmpHome, 'process-claude');
      const launchConfig = path.join(tmpHome, 'launch-claude');
      process.env.CLAUDE_CONFIG_DIR = processConfig;
      fs.mkdirSync(processConfig, { recursive: true });
      fs.mkdirSync(launchConfig, { recursive: true });
      fs.writeFileSync(path.join(processConfig, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'a@example.com' },
      }));
      fs.writeFileSync(path.join(launchConfig, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'b@example.com' },
      }));

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: launchConfig,
      });

      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account: b@example\.com$/);
    });

    it('uses the launch HOME config when no launch config directory is supplied', () => {
      const providers = require('../server/providers');
      const parentHome = path.join(tmpHome, 'parent-home');
      const launchHome = path.join(tmpHome, 'launch-home');
      process.env.HOME = parentHome;
      for (const [home, emailAddress] of [
        [parentHome, 'parent@example.com'],
        [launchHome, 'launch@example.com'],
      ]) {
        const claudeConfig = path.join(home, '.claude');
        fs.mkdirSync(claudeConfig, { recursive: true });
        fs.writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({
          oauthAccount: { emailAddress },
        }));
      }

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        HOME: launchHome,
      });

      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account: launch@example\.com$/);
    });

    it('skips a malformed launch config without preventing Claude from starting', () => {
      const providers = require('../server/providers');
      const claudeConfig = path.join(tmpHome, 'malformed-claude');
      fs.mkdirSync(claudeConfig, { recursive: true });
      fs.writeFileSync(path.join(claudeConfig, '.claude.json'), '{not json');

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: claudeConfig,
      });

      assert.equal(launch.bin, 'claude');
      assert.doesNotMatch(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account:/);
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
        const launch = providers.getAgentLaunch('claude', 5577, [], {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
        });

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
