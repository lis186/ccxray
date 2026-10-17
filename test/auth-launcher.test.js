'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Claude Code reads ANTHROPIC_CUSTOM_HEADERS one line at a time, splitting
// each line at its first colon. Keep this test oracle independent of ccxray's
// launch implementation.
function parseClaudeCustomHeaders(value) {
  const headers = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

describe('auth launcher header injection (1.4a)', () => {
  let tmpHome;
  let originalEnv;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-auth-launcher-'));
    originalEnv = { ...process.env };
    process.env.CCXRAY_HOME = tmpHome;
    process.env.HOME = tmpHome;
    process.env.CCXRAY_EXPORT_DISABLE = '1';
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CCXRAY_HUB_CLIENT_PID;
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
        ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: foo\nX-Ccxray-Agent-Id: herdr:w1:p1',
      });

      assert.equal(
        launch.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Existing: foo\nX-Ccxray-Agent-Id: herdr:w1:p1\nX-Ccxray-Auth: ${kUp}`
      );
      const headers = parseClaudeCustomHeaders(launch.env.ANTHROPIC_CUSTOM_HEADERS);
      assert.equal(headers['x-existing'], 'foo');
      assert.equal(headers['x-ccxray-agent-id'], 'herdr:w1:p1');
      assert.equal(headers['x-ccxray-auth'], kUp);
    });

    it('marks Claude print-mode launches for -p and --print wherever they appear', () => {
      const providers = require('../server/providers');
      const cases = [
        { args: ['-p'], label: '-p' },
        { args: ['--print'], label: '--print' },
        { args: ['--model', 'claude-sonnet-4-6', '--print'], label: '--print after other args' },
        {
          args: ['--model', 'claude-sonnet-4-6', '--input-format', 'stream-json', '--output-format', 'stream-json', '-p'],
          label: 'stream-json options with -p after other args',
        },
      ];

      for (const { args, label } of cases) {
        const launch = providers.getAgentLaunch('claude', 6001, args, {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
        });
        assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Print-Mode:\s*true/, label);
      }
    });

    it('does not mark an interactive Claude launch as print mode', () => {
      const providers = require('../server/providers');
      const launch = providers.getAgentLaunch('claude', 6001, ['--continue'], {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
      });

      assert.doesNotMatch(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Print-Mode:/);
    });

    const printModeCases = [
      { args: ['-p'], expected: true, label: 'short print flag' },
      { args: ['--print'], expected: true, label: 'long print flag' },
      { args: ['--model', 'sonnet', '--print'], expected: true, label: 'print flag after other args' },
      {
        args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print'],
        expected: true,
        label: 'print-only format options with print mode',
      },
      { args: ['--output-format', 'json'], expected: false, label: 'output format alone' },
      { args: ['--input-format', 'stream-json'], expected: false, label: 'input format alone' },
      { args: ['--no-session-persistence'], expected: false, label: 'session persistence option alone' },
      { args: ['--max-budget-usd', '1'], expected: false, label: 'print-only budget option alone' },
      { args: ['--include-partial-messages'], expected: false, label: 'print-only partial option alone' },
      { args: ['--', '-p'], expected: false, label: 'short flag after option boundary' },
      { args: ['--model', 'sonnet', '--', '--print'], expected: false, label: 'long flag in prompt after option boundary' },
      { args: ['--', 'include the literal -p and --print in this prompt'], expected: false, label: 'flag-like prompt text' },
    ];

    for (const { args, expected, label } of printModeCases) {
      it(`isClaudePrintMode: ${label}`, () => {
        const { isClaudePrintMode } = require('../server/providers');
        assert.equal(isClaudePrintMode(args), expected);
      });
    }

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

      const headers = parseClaudeCustomHeaders(launch.env.ANTHROPIC_CUSTOM_HEADERS);
      assert.equal(headers['x-existing'], 'foo', 'the user-provided header must be preserved');
      assert.equal(headers['x-ccxray-auth'], getKUpstreamBase64url());
      assert.equal(headers['x-ccxray-account'], 'a@example.com');
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
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
          oauthAccount: { emailAddress },
        }));
      }

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        HOME: launchHome,
      });

      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account: launch@example\.com$/);
    });

    it('uses os.homedir only when the launch environment has no HOME', () => {
      const providers = require('../server/providers');
      let readPath = null;
      const email = providers.getClaudeLaunchAccountEmail({}, {
        readFile(file) {
          readPath = file;
          return JSON.stringify({ oauthAccount: { emailAddress: 'fallback@example.com' } });
        },
      });

      assert.equal(email, 'fallback@example.com');
      assert.equal(readPath, path.join(os.homedir(), '.claude.json'));
    });

    it('prefers CLAUDE_CONFIG_DIR over the default HOME config when both exist', () => {
      const providers = require('../server/providers');
      const launchHome = path.join(tmpHome, 'launch-home');
      const launchConfig = path.join(tmpHome, 'launch-config');
      fs.mkdirSync(launchHome, { recursive: true });
      fs.mkdirSync(launchConfig, { recursive: true });
      fs.writeFileSync(path.join(launchHome, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'home@example.com' },
      }));
      fs.writeFileSync(path.join(launchConfig, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: 'config@example.com' },
      }));

      const launch = providers.getAgentLaunch('claude', 5577, [], {
        PATH: '/usr/bin',
        HOME: launchHome,
        CLAUDE_CONFIG_DIR: launchConfig,
      });

      assert.match(launch.env.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Account: config@example\.com$/);
      assert.doesNotMatch(launch.env.ANTHROPIC_CUSTOM_HEADERS, /home@example\.com/);
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

      const launch = providers.getAgentLaunch('codex', 5577, ['-m', 'gpt-test', 'exec', 'hello'], {
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
      const mpOverride = launch.args.find(a => a.includes('model_provider="ccxray"'));
      assert.ok(mpOverride, 'should have model_provider="ccxray" arg');

      // Should NOT have old-style openai_base_url / chatgpt_base_url
      const hasOldStyle = launch.args.some(a => a.includes('openai_base_url'));
      assert.equal(hasOldStyle, false, 'should not have openai_base_url in API-key mode');

      // Root options stay before the subcommand, while both overrides follow it.
      const commandIdx = launch.args.indexOf('exec');
      assert.deepEqual(launch.args.slice(0, commandIdx), ['-m', 'gpt-test']);
      assert.deepEqual(launch.args.slice(commandIdx + 1, commandIdx + 5), [
        '-c', mpArg,
        '-c', 'model_provider="ccxray"',
      ]);
      assert.equal(launch.args.at(-1), 'hello');
    });
  });

  describe('Codex launcher — ChatGPT-OAuth mode (no OPENAI_API_KEY)', () => {
    it('uses openai_base_url only — never chatgpt_base_url (#671) — and no model_provider override', () => {
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
      // #671: overriding chatgpt_base_url sends Codex's ChatGPT workspace
      // discovery to a plaintext loopback URL, which Codex rejects (-32603).
      assert.equal(
        launch.args.some(a => a.includes('chatgpt_base_url')),
        false,
        'must not override chatgpt_base_url'
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
