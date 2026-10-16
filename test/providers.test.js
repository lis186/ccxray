'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providers = require('../server/providers');

describe('agent provider registry', () => {
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-provider-')); });
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  it('lists the supported provider launchers', () => {
    assert.deepEqual(providers.listAgentProviderIds(), ['claude', 'codex', 'grok']);
    assert.equal(providers.supportedProviderList(), 'claude, codex, grok');
  });

  it('builds the Claude launch through the registry', () => {
    const launch = providers.getAgentLaunch('claude', 5577, ['--continue'], {
      PATH: '/usr/bin', HOME: home,
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
      'exec',
      '-c',
      'openai_base_url="http://localhost:5577/v1"',
      '-c',
      'chatgpt_base_url="http://localhost:5577/v1"',
      'hello',
    ]);
    assert.equal(launch.env.PATH, '/usr/bin');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://anthropic.example.com');
    assert.match(launch.installHint, /openai\/codex/);
  });

  it('places Codex config overrides immediately after model-running commands', () => {
    const overrides = [
      '-c', 'openai_base_url="http://localhost:5577/v1"',
      '-c', 'chatgpt_base_url="http://localhost:5577/v1"',
    ];
    const env = { PATH: '/usr/bin' };
    const cases = [
      { label: 'exec', args: ['exec', 'hello'], insertAt: 1 },
      { label: 'exec alias', args: ['e', 'hello'], insertAt: 1 },
      { label: 'review', args: ['review', '--json'], insertAt: 1 },
      { label: 'resume', args: ['resume', 'session-id'], insertAt: 1 },
      { label: 'fork', args: ['fork', 'session-id'], insertAt: 1 },
      { label: 'short model option before exec', args: ['-m', 'gpt-x', 'exec', 'hello'], insertAt: 3 },
      { label: 'long model option before exec', args: ['--model', 'gpt-x', 'exec', 'hello'], insertAt: 3 },
      { label: 'short config option before exec', args: ['-c', 'foo=bar', 'exec', 'hello'], insertAt: 3 },
      { label: 'long config option before exec', args: ['--config', 'foo=bar', 'exec', 'hello'], insertAt: 3 },
      { label: 'long config option with equals before review', args: ['--config=foo=bar', 'review', '--json'], insertAt: 2 },
      { label: 'remote option before resume', args: ['--remote', 'ws://example.test', 'resume', 'session-id'], insertAt: 3 },
      { label: 'remote token env option before fork', args: ['--remote-auth-token-env', 'TOKEN', 'fork', 'session-id'], insertAt: 3 },
      { label: 'other root options before exec', args: ['--enable', 'feature-x', '--profile', 'work', 'exec', 'hello'], insertAt: 5 },
      { label: 'remaining value options before exec', args: [
        '--disable', 'feature-y', '--local-provider', 'ollama', '-s', 'read-only',
        '-a', 'never', '-C', '/repo', '--add-dir', '/extra', '-p', 'work', 'exec', 'hello',
      ], insertAt: 15 },
      { label: 'detached image consumes a subcommand-looking value', args: ['-i', 'one.png', 'exec', 'hello'], insertAt: 0 },
      { label: 'detached long image consumes a subcommand-looking value', args: ['--image', 'one.png', 'exec', 'hello'], insertAt: 0 },
      { label: 'variadic image values consume a later subcommand-looking value', args: ['-i', 'one.png', 'two.png', 'exec', 'hello'], insertAt: 0 },
      { label: 'image option ends at a following root option', args: ['-i', 'one.png', '--model', 'gpt-x', 'exec', 'hello'], insertAt: 5 },
      { label: 'attached image value leaves the root prompt before exec', args: ['--image=one.png', 'two.png', 'exec', 'hello'], insertAt: 3 },
      { label: 'option value literally exec is skipped', args: ['--model', 'exec', 'exec', 'hello'], insertAt: 3 },
      { label: 'root prompt positional before exec', args: ['hello', 'exec', 'hello'], insertAt: 2 },
      { label: 'options and prompt before exec', args: ['--model', 'gpt-x', 'hello', 'exec', 'hello'], insertAt: 4 },
      { label: 'another root command owns later arguments', args: ['app', 'exec', 'hello'], insertAt: 0 },
      { label: 'option terminator hides later exec', args: ['--', 'exec', 'hello'], insertAt: 0 },
      { label: 'options before and after the subcommand', args: ['--model', 'gpt-x', 'exec', '-c', 'foo=bar', 'hello'], insertAt: 3 },
    ];

    for (const { label, args, insertAt } of cases) {
      const expected = [
        ...args.slice(0, insertAt),
        ...overrides,
        ...args.slice(insertAt),
      ];
      const launch = providers.getAgentLaunch('codex', 5577, args, env);
      assert.deepEqual(launch.args, expected, label);
      assert.equal(launch.args.indexOf(overrides[1]) - 1, insertAt, `${label}: insertion index`);
    }
  });

  it('keeps Codex config overrides at the root for interactive and other commands', () => {
    const overrides = [
      '-c', 'openai_base_url="http://localhost:5577/v1"',
      '-c', 'chatgpt_base_url="http://localhost:5577/v1"',
    ];
    const env = { PATH: '/usr/bin' };
    const cases = [
      [],
      ['hello'],
      ['--model', 'gpt-x'],
      ['--model', 'gpt-x', 'hello'],
      ['app', '/repo'],
      ['login'],
    ];

    for (const args of cases) {
      assert.deepEqual(
        providers.getAgentLaunch('codex', 5577, args, env).args,
        [...overrides, ...args],
        JSON.stringify(args)
      );
    }
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

  it('routes every hub-launched provider through its registered client identity', () => {
    const env = { PATH: '/usr/bin', HOME: home, CCXRAY_HUB_CLIENT_PID: '78846' };
    const claude = providers.getAgentLaunch('claude', 5577, [], env);
    const codex = providers.getAgentLaunch('codex', 5577, [], env);
    const grok = providers.getAgentLaunch('grok', 5577, [], env);

    assert.equal(claude.env.ANTHROPIC_BASE_URL, 'http://localhost:5577/_ccxray/client/78846');
    assert.ok(codex.args.includes('openai_base_url="http://localhost:5577/_ccxray/client/78846/v1"'));
    assert.ok(codex.args.includes('chatgpt_base_url="http://localhost:5577/_ccxray/client/78846/v1"'));
    assert.equal(grok.env.GROK_CLI_CHAT_PROXY_BASE_URL, 'http://localhost:5577/_ccxray/client/78846/v1');
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
