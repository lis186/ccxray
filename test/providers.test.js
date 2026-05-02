'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');

describe('agent provider registry', () => {
  it('lists the supported provider launchers', () => {
    assert.deepEqual(providers.listAgentProviderIds(), ['claude', 'codex']);
    assert.equal(providers.supportedProviderList(), 'claude, codex');
  });

  it('builds the Claude launch through the registry', () => {
    const launch = providers.getAgentLaunch('claude', 5577, ['--continue'], {
      PATH: '/usr/bin',
    });

    assert.equal(launch.provider, 'claude');
    assert.equal(launch.label, 'Claude Code');
    assert.equal(launch.upstream, 'anthropic');
    assert.equal(launch.bin, 'claude');
    assert.deepEqual(launch.args, ['--continue']);
    assert.equal(launch.env.PATH, '/usr/bin');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'http://localhost:5577');
    assert.match(launch.installHint, /anthropic-ai\/claude-code/);
  });

  it('builds the Codex launch through the registry', () => {
    const launch = providers.getAgentLaunch('codex', 5577, ['exec', 'hello'], {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
    });

    assert.equal(launch.provider, 'codex');
    assert.equal(launch.label, 'Codex CLI');
    assert.equal(launch.upstream, 'openai');
    assert.equal(launch.displayName, 'ccxray');
    assert.equal(launch.bin, 'codex');
    assert.deepEqual(launch.args, [
      '-c',
      'openai_base_url="http://localhost:5577/v1"',
      'exec',
      'hello',
    ]);
    assert.equal(launch.env.PATH, '/usr/bin');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://anthropic.example.com');
    assert.match(launch.installHint, /openai\/codex/);
  });

  it('centralizes display names and unsupported-provider handling', () => {
    assert.equal(providers.getDisplayName('claude', {}), 'ccxray');
    assert.equal(providers.getDisplayName('codex', {}), 'ccxray');
    assert.equal(providers.getDisplayName('codex', { CCXRAY_DISPLAY_NAME: 'customray' }), 'customray');
    assert.equal(providers.getAgentLaunch('unknown-ai', 5577, []), null);
    assert.equal(providers.getAgentProvider('unknown-ai'), null);
    assert.equal(providers.isAgentProvider('unknown-ai'), false);
  });
});
