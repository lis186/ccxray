'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');

describe('agent provider registry', () => {
  it('lists the supported provider launchers', () => {
    assert.deepEqual(providers.listAgentProviderIds(), ['claude', 'codex', 'grok']);
    assert.equal(providers.supportedProviderList(), 'claude, codex, grok');
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
      '-c',
      'chatgpt_base_url="http://localhost:5577/v1"',
      'exec',
      'hello',
    ]);
    assert.equal(launch.env.PATH, '/usr/bin');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://anthropic.example.com');
    assert.match(launch.installHint, /openai\/codex/);
  });

  it('builds the Codex desktop app launch through the registry', () => {
    const launch = providers.getAgentLaunch('codex', 5577, ['app', '/repo'], {
      PATH: '/usr/bin',
    });

    assert.equal(launch.bin, 'codex');
    assert.deepEqual(launch.args, [
      '-c',
      'openai_base_url="http://localhost:5577/v1"',
      '-c',
      'chatgpt_base_url="http://localhost:5577/v1"',
      'app',
      '/repo',
    ]);
    assert.equal(launch.env.PATH, '/usr/bin');
  });

  it('builds the Grok launch through the registry', () => {
    const launch = providers.getAgentLaunch('grok', 5577, ['-p', 'hi'], {
      PATH: '/usr/bin',
    });

    assert.equal(launch.provider, 'grok');
    assert.equal(launch.label, 'Grok CLI');
    assert.equal(launch.upstream, 'openai');
    assert.equal(launch.bin, 'grok');
    assert.deepEqual(launch.args, ['-p', 'hi']);
    assert.equal(launch.env.PATH, '/usr/bin');
    assert.equal(launch.env.GROK_CLI_CHAT_PROXY_BASE_URL, 'http://localhost:5577/v1');
    assert.match(launch.installHint, /x\.ai\/cli/);
  });

  it('PROVIDER_AGENT maps upstream family to agent label', () => {
    assert.equal(providers.agentForProvider('openai'), 'codex');
    assert.equal(providers.agentForProvider('anthropic'), 'claude');
    assert.equal(providers.agentForProvider('unknown'), 'claude');
    assert.equal(providers.PROVIDER_AGENT.openai, 'codex');
  });

  it('OPENAI_WIRE_CLIENTS registers Grok as a Responses-wire module (not a parser fork)', () => {
    const client = providers.matchOpenAIWireClient({
      'x-grok-client-identifier': 'grok-shell',
    });
    assert.ok(client);
    assert.equal(client.id, 'grok');
    assert.equal(client.upstreamKey, 'xai');
    assert.equal(client.rawSessionId, 'grok-raw');
    assert.equal(providers.resolveOpenAIWireAgent({}, { model: 'grok-4.5' }), 'grok');
    assert.equal(providers.resolveOpenAIWireAgent({}, { model: 'gpt-5.5' }), 'codex');
    assert.equal(providers.matchOpenAIWireClient({}), null);
  });

  it('describeAgentModule + cwdFallback + raw buckets form the module contract', () => {
    assert.equal(providers.agentUsesCwdFallback('claude'), false);
    assert.equal(providers.agentUsesCwdFallback('codex'), true);
    assert.equal(providers.agentUsesCwdFallback('grok'), true);
    const grok = providers.describeAgentModule('grok');
    assert.equal(grok.wire, 'openai');
    assert.equal(grok.openAIWireClient, true);
    assert.equal(grok.upstreamKey, 'xai');
    assert.ok(providers.listRawSessionBuckets().has('grok-raw'));
    assert.equal(providers.describeAgentModule('nope'), null);
  });

  it('declares resume profiles per upstream', () => {
    const { UPSTREAM_PROFILES } = providers;
    assert.deepEqual(UPSTREAM_PROFILES.anthropic.resume, {
      template: '{agent} --resume {sid}',
      condition: 'always',
    });
    assert.deepEqual(UPSTREAM_PROFILES.openai.resume, {
      template: 'codex resume {sid}',
      condition: 'has-usage',
    });
    assert.deepEqual(UPSTREAM_PROFILES.xai.resume, {
      template: 'grok --resume {sid}',
      condition: 'has-usage',
    });
  });

  it('centralizes display names and unsupported-provider handling', () => {
    assert.equal(providers.getDisplayName('claude', {}), 'ccxray');
    assert.equal(providers.getDisplayName('codex', {}), 'ccxray');
    assert.equal(providers.getDisplayName('grok', {}), 'ccxray');
    assert.equal(providers.getDisplayName('codex', { CCXRAY_DISPLAY_NAME: 'customray' }), 'customray');
    assert.equal(providers.getAgentLaunch('unknown-ai', 5577, []), null);
    assert.equal(providers.getAgentProvider('unknown-ai'), null);
    assert.equal(providers.isAgentProvider('unknown-ai'), false);
    assert.equal(providers.isAgentProvider('grok'), true);
  });
});
