'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'herdr');
const MANIFEST = path.join(PLUGIN, 'herdr-plugin.toml');

function runScript(script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'bin', script), ...args], {
    cwd: PLUGIN,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

function makeHome(entries = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-plugin-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  if (entries.length) {
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }
  return home;
}

function writeToolDefinitions(home, hash, tools, prefix = 'tools_') {
  const shared = path.join(home, 'logs', 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, `${prefix}${hash}.json`), JSON.stringify(tools));
}

function makeHerdr(agents = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-bin-'));
  const bin = path.join(dir, 'herdr');
  const response = JSON.stringify({ id: 'test', result: { type: 'agent_list', agents } });
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(response)} + '\\n');\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeRecordingHerdr({ status = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-recording-'));
  const bin = path.join(dir, 'herdr');
  const log = path.join(dir, 'args.log');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'test', result: { type: 'plugin_pane_opened' } }) + '\n')});`,
    `process.exit(${status});`,
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

const sampleEntry = {
  id: '2026-08-14T00-00-00-000',
  sessionId: '11111111-2222-3333-4444-555555555555',
  provider: 'anthropic',
  agent: 'claude',
  model: 'claude-sonnet-4-6',
  receivedAt: Date.now(),
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 25, cache_read_input_tokens: 75 },
  cost: { cost: 0.12 },
  maxContext: 1000,
  toolCalls: { Bash: 2 },
  title: 'Validate Herdr plugin',
};

describe('Herdr plugin manifest', () => {
  it('declares stable plugin metadata and command entrypoints', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /^id = "ccxray\.herdr"$/m);
    assert.match(manifest, /^min_herdr_version = "0\.8\.0"$/m);
    assert.match(manifest, /^\[\[actions\]\]$/m);
    assert.match(manifest, /^\[\[panes\]\]$/m);

    const commandMatches = [...manifest.matchAll(/command = \["node", "([^"]+)"\]/g)];
    assert.ok(commandMatches.length >= 4);
    for (const [, rel] of commandMatches) {
      assert.ok(fs.existsSync(path.join(PLUGIN, rel)), `${rel} exists`);
    }
  });

  it('resolves the Mission Control script from HERDR_PLUGIN_ROOT', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const paneBlock = manifest.match(/\[\[panes\]\][\s\S]*$/)?.[0] || '';
    assert.match(paneBlock, /HERDR_PLUGIN_ROOT/);
    assert.doesNotMatch(paneBlock, /command = \["node", "bin\/mission-control\.js"\]/);
  });

  it('keeps outcomes and cross-session value comparison out of the Herdr plugin', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /^version = "0\.3\.0"$/m);
    assert.doesNotMatch(manifest, /mark-(?:success|partial|failed)|clear-outcome|mark-outcome\.js/);
    assert.doesNotMatch(manifest, /session-compare|Session Compare/);
  });

  it('automatically refreshes sidebar metadata at startup and agent state changes', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /\[\[startup\]\]\s+command = \["node", "bin\/refresh-all-badges\.js"\]/);
    assert.match(manifest, /\[\[events\]\]\s+on = "pane\.agent_detected"\s+command = \["node", "bin\/refresh-badges\.js"\]/);
    assert.match(manifest, /\[\[events\]\]\s+on = "pane\.agent_status_changed"\s+command = \["node", "bin\/refresh-badges\.js"\]/);
  });

  it('declares a one-time Quick Start startup hook, action, and pane', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /\[\[startup\]\]\s+command = \["node", "bin\/open-onboarding\.js", "--first-run"\]/);
    assert.match(manifest, /id = "quick-start"[\s\S]*title = "Open ccxray Quick Start"[\s\S]*command = \["node", "bin\/open-onboarding\.js"\]/);
    assert.match(manifest, /id = "onboarding"[\s\S]*title = "ccxray Quick Start"[\s\S]*bin\/onboarding\.js/);
  });
});

describe('Herdr plugin commands', () => {
  it('Quick Start shows readiness and only marks detected provider CLIs available', () => {
    const home = makeHome();
    const config = path.join(home, 'config.toml');
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_HOME: home,
      HERDR_PLUGIN_STATE_DIR: path.join(home, 'state'),
      HERDR_CONFIG_PATH: config,
      CCXRAY_ONBOARDING_PROVIDERS: 'claude,codex',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Quick Start/);
    assert.match(result.stdout, /SETUP  sidebar optional, not installed/);
    assert.match(result.stdout, /START  0 traced sessions/);
    assert.match(result.stdout, /\[1\] Claude\s+available/);
    assert.match(result.stdout, /\[2\] Codex\s+available/);
    assert.match(result.stdout, /\[3\] Grok\s+not found/);
    assert.match(result.stdout, /Next: Press 1 to launch Claude through ccxray/);
    assert.doesNotMatch(result.stdout, /Open Mission Control|Open Capability Review/);
  });

  it('Quick Start progressively reveals analysis after enough traced sessions', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...sampleEntry,
      id: `onboarding-${i}`,
      sessionId: `onboarding-session-${i}`,
      agentId: `herdr:w1:p${i + 1}`,
      receivedAt: Date.now() - i * 1000,
    }));
    const home = makeHome(entries);
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_HOME: home,
      HERDR_PLUGIN_STATE_DIR: path.join(home, 'state'),
      HERDR_CONFIG_PATH: path.join(home, 'missing-config.toml'),
      CCXRAY_ONBOARDING_PROVIDERS: 'codex',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /READY  5 traced sessions/);
    assert.match(result.stdout, /\[M\] Open Mission Control/);
    assert.match(result.stdout, /\[R\] Open Capability Review/);
    assert.match(result.stdout, /Next: Press R to review capability usage before changing configuration/);
  });

  it('opens Quick Start once at startup but allows an explicit reopen', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-onboarding-'));
    const herdr = makeRecordingHerdr();
    const env = {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/work/demo' }),
    };
    const first = runScript('open-onboarding.js', ['--first-run'], env);
    const second = runScript('open-onboarding.js', ['--first-run'], env);
    const manual = runScript('open-onboarding.js', [], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(first.stdout, /Opened ccxray Quick Start/);
    assert.equal(second.stdout, '');
    assert.match(manual.stdout, /Opened ccxray Quick Start/);
    const calls = fs.readFileSync(herdr.log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /plugin pane open --plugin ccxray\.herdr --entrypoint onboarding --placement tab --focus --workspace w1 --cwd \/work\/demo/);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'onboarding-v1.json'), 'utf8'));
    assert.equal(saved.version, 1);
    assert.ok(saved.openedAt);
  });

  it('does not mark onboarding complete when Herdr cannot open it', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-onboarding-'));
    const herdr = makeRecordingHerdr({ status: 1 });
    const result = runScript('open-onboarding.js', ['--first-run'], {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: herdr.bin,
    });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(path.join(stateDir, 'onboarding-v1.json')), false);
  });

  it('recovers from a stale first-run lock after an interrupted startup', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-onboarding-'));
    const lock = path.join(stateDir, 'onboarding-v1.json.lock');
    fs.writeFileSync(lock, 'interrupted\n');
    const stale = new Date(Date.now() - 60000);
    fs.utimesSync(lock, stale, stale);
    const herdr = makeRecordingHerdr();
    const result = runScript('open-onboarding.js', ['--first-run'], {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: herdr.bin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Opened ccxray Quick Start/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'onboarding-v1.json')), true);
  });

  it('allows automatic onboarding to be disabled without opening a pane', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-onboarding-'));
    const herdr = makeRecordingHerdr();
    const result = runScript('open-onboarding.js', ['--first-run'], {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_SKIP_ONBOARDING: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipped by configuration/);
    assert.equal(fs.existsSync(herdr.log), false);
  });

  it('doctor exits cleanly when ccxray has no logs or hub', () => {
    const home = makeHome();
    const result = runScript('doctor.js', [], { CCXRAY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Herdr Doctor/);
    assert.match(result.stdout, /Hub: not running/);
  });

  it('usage-summary prints compact usage for an isolated ccxray home', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('usage-summary.js', ['--last', '9999d'], { CCXRAY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Usage Summary/);
    assert.match(result.stdout, /1 turns across 1 sessions/);
    assert.match(result.stdout, /Validate Herdr plugin/);
  });

  it('mission-control can render once for noninteractive validation', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: home,
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Mission Control/);
    assert.match(result.stdout, /1 recent sessions · 0 attention/);
    assert.match(result.stdout, /GREEN 11111111 claude/);
    assert.match(result.stdout, /ctx 20%/);
    assert.match(result.stdout, /cache 38%/);
  });

  it('mission-control empty state points to Quick Start', () => {
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(),
      HERDR_BIN_PATH: makeHerdr([]),
      CCXRAY_MISSION_COLS: '72',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No traced sessions yet/);
    assert.match(result.stdout, /Next: open ccxray Quick Start and launch an agent/);
  });

  it('mission-control switches to tiny output for narrow Herdr panes', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_MISSION_COLS: '23',
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray MC/);
    assert.match(result.stdout, /1 recent \/ 0 alert/);
    assert.doesNotMatch(result.stdout, /Mission Control/);
    assert.doesNotMatch(result.stdout, /\+\$~/);
    for (const line of result.stdout.trim().split('\n')) {
      assert.ok(line.length <= 22, `line fits narrow pane: ${line}`);
    }
  });

  it('mission-control ranks exact pane telemetry by actionable risk', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'risky-1',
        sessionId: 'risky-session',
        agentId: 'herdr:w1:p1',
        agentType: 'codex',
        model: 'gpt-5.6-sol',
        receivedAt: now - 60000,
        usage: { input_tokens: 600, output_tokens: 10 },
        cost: { cost: 0.10, confidence: 'exact' },
        maxContext: 1000,
        turnToolFail: true,
      },
      {
        ...sampleEntry,
        id: 'risky-2',
        sessionId: 'risky-session',
        agentId: 'herdr:w1:p1',
        agentType: 'codex',
        model: 'gpt-5.6-sol',
        receivedAt: now,
        usage: { input_tokens: 900, output_tokens: 10 },
        cost: { cost: 0.20, confidence: 'exact' },
        maxContext: 1000,
        turnToolFail: true,
      },
      {
        ...sampleEntry,
        id: 'healthy-1',
        sessionId: 'healthy-session',
        agentId: 'herdr:w1:p2',
        agentType: 'claude',
        receivedAt: now,
        usage: { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 10 },
        cost: { cost: 0.02, confidence: 'exact' },
        maxContext: 1000,
        turnToolFail: false,
        toolFail: true,
      },
    ];
    const agents = [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'codex' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'claude' },
    ];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '72',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 panes · 1 attention/);
    assert.match(result.stdout, /RED w1:p1 codex · working/);
    assert.match(result.stdout, /ctx 90% \(\+30%\/turn\)/);
    assert.match(result.stdout, /fail 2x/);
    assert.match(result.stdout, /cache 0% · seen now · exact/);
    assert.ok(result.stdout.indexOf('RED w1:p1') < result.stdout.indexOf('GREEN w1:p2'));
  });

  it('mission-control makes missing pane telemetry visible instead of guessing', () => {
    const agents = [
      { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'grok' },
    ];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '64',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 panes · 1 attention/);
    assert.match(result.stdout, /YELLOW w1:p9 grok · working/);
    assert.match(result.stdout, /no ccxray telemetry/);
    assert.match(result.stdout, /unlinked/);
  });

  it('mission-control distinguishes review-ready agents from yellow risk', () => {
    const now = Date.now();
    const entry = {
      ...sampleEntry,
      agentId: 'herdr:w1:p8',
      receivedAt: now,
      usage: { input_tokens: 100, output_tokens: 10 },
      maxContext: 1000,
    };
    const agents = [{
      pane_id: 'w1:p8', workspace_id: 'w1', tab_id: 'w1:t1',
      agent_status: 'done', agent: 'claude',
    }];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome([entry]),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '80',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 panes · 1 attention/);
    assert.match(result.stdout, /READY w1:p8 claude · done · next review output/);
    assert.doesNotMatch(result.stdout, /YELLOW w1:p8/);
  });

  it('mission-control only escalates prompt changes when observed cache use drops', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'prompt-before',
        sessionId: 'prompt-session',
        agentId: 'herdr:w1:p6',
        receivedAt: now - 60000,
        sysHash: 'aaa111',
        usage: { input_tokens: 50, cache_read_input_tokens: 450, output_tokens: 10 },
        maxContext: 2000,
      },
      {
        ...sampleEntry,
        id: 'prompt-after',
        sessionId: 'prompt-session',
        agentId: 'herdr:w1:p6',
        receivedAt: now,
        sysHash: 'bbb222',
        usage: { input_tokens: 200, cache_read_input_tokens: 0, output_tokens: 10 },
        maxContext: 2000,
      },
      {
        ...sampleEntry,
        id: 'routine-before',
        sessionId: 'routine-session',
        agentId: 'herdr:w1:p5',
        receivedAt: now - 60000,
        sysHash: 'ccc333',
        usage: { input_tokens: 100, output_tokens: 10 },
        maxContext: 2000,
      },
      {
        ...sampleEntry,
        id: 'routine-after',
        sessionId: 'routine-session',
        agentId: 'herdr:w1:p5',
        receivedAt: now,
        sysHash: 'ddd444',
        usage: { input_tokens: 200, output_tokens: 10 },
        maxContext: 2000,
      },
    ];
    const agents = [
      { pane_id: 'w1:p6', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'codex' },
      { pane_id: 'w1:p5', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'claude' },
    ];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '100',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 panes · 1 attention/);
    assert.match(result.stdout, /YELLOW w1:p6 codex · working · next inspect prompt\/tool diff/);
    assert.match(result.stdout, /cache dropped after prompt change/);
    assert.match(result.stdout, /GREEN w1:p5 claude · working/);
  });

  it('mission-control reports observed tool and MCP utilization without charging deferred tools', () => {
    const hash = 'abc123def456';
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'capability-1',
        sessionId: 'capability-session',
        receivedAt: now,
        toolsHash: hash,
        turnToolCalls: { Bash: 1, mcp__github__list_issues: 1 },
        skillCalls: { tdd: 2 },
        cost: { cost: 0.01, confidence: 'exact' },
      },
    ];
    const home = makeHome(entries);
    writeToolDefinitions(home, hash, [
      { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
      { name: 'mcp__github__list_issues', description: 'List issues', input_schema: { type: 'object' } },
      { name: 'mcp__github__create_issue', description: 'Create an issue', input_schema: { type: 'object' } },
      { name: 'mcp__notion__search', description: 'x'.repeat(4000), input_schema: { type: 'object' } },
      { name: 'mcp__slack__search', description: 'Deferred Slack search', defer_loading: true, input_schema: { type: 'object' } },
    ]);
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr([]),
      CCXRAY_MISSION_COLS: '120',
      CCXRAY_MISSION_SHOW_CAPABILITIES: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tools 2\/5/);
    assert.match(result.stdout, /schema est ~/);
    assert.match(result.stdout, /deferred 1/);
    assert.match(result.stdout, /not called here MCP notion ~1\.0K/);
    assert.match(result.stdout, /skills tdd x2/);

    const defaultResult = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr([]),
      CCXRAY_MISSION_COLS: '120',
    });
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.doesNotMatch(defaultResult.stdout, /tool tax|unused MCP|skills tdd/);
  });

  it('capability-review uses eligible-session samples before suggesting changes', () => {
    const hash = 'abc123def789';
    const now = Date.now();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...sampleEntry,
      id: `review-${i}`,
      sessionId: `review-session-${i}`,
      receivedAt: now - i * 60000,
      toolsHash: hash,
      turnToolCalls: i < 4 ? { mcp__github__list_issues: 1 } : {},
      skillCalls: i < 3 ? { tdd: 2 } : {},
    }));
    const home = makeHome(entries);
    writeToolDefinitions(home, hash, [
      { name: 'mcp__github__list_issues', description: 'List issues', input_schema: { type: 'object' } },
      { name: 'mcp__github__create_issue', description: 'Create issue', input_schema: { type: 'object' } },
      { name: 'mcp__notion__search', description: 'x'.repeat(4800), input_schema: { type: 'object' } },
      { name: 'mcp__slack__search', description: 'Deferred', defer_loading: true, input_schema: { type: 'object' } },
    ]);
    const result = runScript('capability-review.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NOW_MS: String(now),
      CCXRAY_CAPABILITY_COLS: '100',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Capability Review/);
    assert.match(result.stdout, /5 sessions with schema · estimates/);
    assert.match(result.stdout, /MCP notion/);
    assert.match(result.stdout, /schema ~1\.2K\/session · used 0\/5 eligible/);
    assert.match(result.stdout, /DEFER CANDIDATE · validate with a project-scoped experiment/);
    assert.match(result.stdout, /MCP github/);
    assert.match(result.stdout, /used 4\/5 eligible/);
    assert.match(result.stdout, /KEEP/);
    assert.match(result.stdout, /tdd · seen 3\/5 sessions · 6 calls · observed only/);
  });

  it('focus-attention jumps to the highest-priority actionable pane', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'focus-red',
        sessionId: 'focus-red-session',
        agentId: 'herdr:w1:p1',
        receivedAt: now,
        usage: { input_tokens: 900, output_tokens: 10 },
        maxContext: 1000,
        turnToolFail: true,
      },
      {
        ...sampleEntry,
        id: 'focus-green',
        sessionId: 'focus-green-session',
        agentId: 'herdr:w1:p2',
        receivedAt: now,
        usage: { input_tokens: 100, output_tokens: 10 },
        maxContext: 1000,
      },
    ];
    const agents = [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'blocked', agent: 'codex' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'working', agent: 'claude' },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-focus-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'args.log');
    const listResponse = JSON.stringify({ id: 'test', result: { type: 'agent_list', agents } });
    const okResponse = JSON.stringify({ id: 'test', result: { type: 'ok' } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      `const fs = require('fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
      `process.stdout.write((args[0] === 'agent' && args[1] === 'list' ? ${JSON.stringify(listResponse)} : ${JSON.stringify(okResponse)}) + '\\n');`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const result = runScript('focus-attention.js', [], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: bin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Focused w1:p1 · RED codex · inspect last error/);
    assert.match(fs.readFileSync(log, 'utf8'), /agent focus w1:p1/);
  });

  it('mission-control keeps pane identity on the main session and summarizes subagents separately', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'main-turn',
        sessionId: 'main-session-1234',
        agentId: 'herdr:w1:p4',
        receivedAt: now - 120000,
        isSubagent: false,
        usage: { input_tokens: 300, output_tokens: 20 },
        cost: { cost: 0.20, confidence: 'exact' },
        maxContext: 1000,
      },
      {
        ...sampleEntry,
        id: 'same-session-child',
        sessionId: 'main-session-1234',
        agentId: 'herdr:w1:p4',
        receivedAt: now - 30000,
        isSubagent: true,
        agentKey: 'explore',
        convId: 'child-conv-1',
        usage: { input_tokens: 900, output_tokens: 20 },
        cost: { cost: 0.05, confidence: 'exact' },
        maxContext: 1000,
      },
      {
        ...sampleEntry,
        id: 'child-session-turn',
        sessionId: 'child-session-5678',
        parentSessionId: 'main-session-1234',
        agentId: 'herdr:w1:p4',
        receivedAt: now,
        isSubagent: true,
        agentKey: 'worker',
        usage: { input_tokens: 950, output_tokens: 20 },
        cost: { cost: 0.07, confidence: 'exact' },
        maxContext: 1000,
      },
    ];
    const agents = [{
      pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t1',
      agent_status: 'working', agent: 'codex',
    }];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '100',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 panes · 0 attention · \+\$0\.32\/5m/);
    assert.match(result.stdout, /ctx 30%/);
    assert.match(result.stdout, /main \$0\.20/);
    assert.match(result.stdout, /subagents 2, seen 5m 2, total \$0\.12/);
    assert.doesNotMatch(result.stdout, /ctx 95%/);
    assert.doesNotMatch(result.stdout, / · ~$/m);
  });

  it('mission-control marks aggregate burn and child cost when confidence is mixed', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'main-estimated',
        sessionId: 'mixed-main',
        agentId: 'herdr:w1:p3',
        receivedAt: now,
        isSubagent: false,
        cost: { cost: 0.20, confidence: 'exact' },
      },
      {
        ...sampleEntry,
        id: 'child-estimated',
        sessionId: 'mixed-child',
        parentSessionId: 'mixed-main',
        agentId: 'herdr:w1:p3',
        receivedAt: now,
        isSubagent: true,
        cost: { cost: 0.07, confidence: 'estimated' },
      },
    ];
    const agents = [{
      pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1',
      agent_status: 'working', agent: 'codex',
    }];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '100',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 panes · 0 attention · \+~\$0\.27\/5m/);
    assert.match(result.stdout, /main \$0\.20/);
    assert.match(result.stdout, /subagents 1, seen 5m 1, total ~\$0\.07/);
  });

  it('open-dashboard explains missing hub without opening a browser', () => {
    const home = makeHome();
    const result = runScript('open-dashboard.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NO_BROWSER: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ccxray hub is not running/);
  });

  it('refresh-badges computes tokens and reports missing Herdr context clearly', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(sampleEntry.receivedAt + 5 * 60000),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ccxray badges refreshed/);
    assert.match(result.stdout, /Workspace: n\/a \(HERDR_WORKSPACE_ID is not set\)/);
    assert.match(result.stdout, /Pane: n\/a \(HERDR_PANE_ID is not set\)/);
    assert.match(result.stdout, /cost=\$0\.12/);
    assert.match(result.stdout, /ctx=20%/);
    assert.match(result.stdout, /age=5m/);
    assert.match(result.stdout, /model=claude-sonnet-4-6/);
    assert.match(result.stdout, /turns=1/);
    assert.match(result.stdout, /summary=sonnet-4-6, 5m, \$0\.12/);
    assert.match(result.stdout, /ctx_bar=▁▁▁▂ 20%/);
    assert.match(result.stdout, /ctx_band=green/);
    assert.match(result.stdout, /ctx_bar_green=▁▁▁▂ 20%/);
    assert.match(result.stdout, /Clear: ctx_bar_unknown ctx_bar_yellow ctx_bar_red/);
  });

  it('refresh-badges uses a neutral band when context is unknown', () => {
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome(),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ctx=\?/);
    assert.match(result.stdout, /ctx_band=unknown/);
    assert.match(result.stdout, /ctx_bar_unknown=▁▁▁▁ \?/);
    assert.match(result.stdout, /Clear: ctx_bar_green ctx_bar_yellow ctx_bar_red/);
  });

  it('refresh-badges targets the pane carried by a Herdr event hook', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-event-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'args.log');
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'test', result: { type: 'ok' } }) + '\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const entry = { ...sampleEntry, agentId: 'herdr:w1:p7' };
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([entry]),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane_agent_status_changed',
        data: { pane_id: 'w1:p7', workspace_id: 'w1', agent_status: 'idle' },
      }),
      CCXRAY_BADGE_EVENT_DELAY_MS: '0',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(log, 'utf8'), /pane report-metadata w1:p7/);
  });

  it('refresh-badges never borrows another session when the target pane is unlinked', () => {
    const unrelated = {
      ...sampleEntry,
      agentId: 'herdr:w1:p2',
      model: 'claude-opus-5',
      cost: { cost: 99 },
    };
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([unrelated]),
      HERDR_PANE_ID: 'w1:p9',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=ccxray: not linked/);
    assert.match(result.stdout, /ctx_band=unknown/);
    assert.match(result.stdout, /cost=n\/a/);
    assert.match(result.stdout, /turns=0/);
    assert.doesNotMatch(result.stdout, /opus-5|\$99/);
  });

  it('refresh-badges renders sidebar summary as model/cost plus context sparkline', () => {
    const receivedAt = Date.now() - 15 * 60000;
    const entries = [200, 400, 600, 800].map((tokens, i) => ({
      ...sampleEntry,
      id: `turn-${i}`,
      sessionId: 'sparkline-session',
      model: 'claude-opus-5',
      receivedAt: receivedAt + i * 60000,
      usage: { input_tokens: tokens, output_tokens: 10 },
      cost: { cost: 0.1275 },
      maxContext: 1000,
      title: `Sparkline turn ${i + 1}`,
    }));
    const home = makeHome(entries);
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(receivedAt + 15 * 60000),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /summary=opus-5, 15m, \$0\.51/);
    assert.match(result.stdout, /ctx_bar=▂▃▅▆ 80%/);
    assert.match(result.stdout, /ctx_band=yellow/);
    assert.match(result.stdout, /ctx_bar_yellow=▂▃▅▆ 80%/);
    assert.doesNotMatch(result.stdout, /ctx_bar_red=/);
  });

  it('refresh-badges switches context color band above 80 percent', () => {
    const receivedAt = Date.now() - 3 * 60000;
    const entries = [900].map((tokens, i) => ({
      ...sampleEntry,
      id: `red-turn-${i}`,
      sessionId: 'red-sidebar-session',
      model: 'claude-opus-5',
      receivedAt: receivedAt + i * 60000,
      usage: { input_tokens: tokens, output_tokens: 5 },
      cost: { cost: 0.01 },
      maxContext: 1000,
      title: `Red turn ${i + 1}`,
    }));
    const home = makeHome(entries);
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(receivedAt + 3 * 60000),
      CCXRAY_HERDR_SIDEBAR_COLS: '36',
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ctx=90%/);
    assert.match(result.stdout, /ctx_band=red/);
    assert.match(result.stdout, /ctx_bar_red=▁▁▁█ 90% · full/);
    assert.match(result.stdout, /Clear: ctx_bar_unknown ctx_bar_green ctx_bar_yellow/);
  });

  it('refresh-badges sizes ctx_bar by available sidebar columns', () => {
    const receivedAt = Date.now() - 20 * 60000;
    const usagePoints = [100, 200, 300, 400, 500, 600, 700, 800, 700, 600, 700, 800];
    const entries = usagePoints.map((tokens, i) => ({
      ...sampleEntry,
      id: `dynamic-turn-${i}`,
      sessionId: 'dynamic-sidebar-session',
      model: 'claude-opus-5',
      receivedAt: receivedAt + i * 60000,
      usage: { input_tokens: tokens, output_tokens: 5 },
      cost: { cost: 0.01 },
      maxContext: 1000,
      title: `Dynamic turn ${i + 1}`,
    }));
    const home = makeHome(entries);

    const narrow = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(receivedAt + 20 * 60000),
      CCXRAY_HERDR_SIDEBAR_COLS: '10',
    });
    assert.equal(narrow.status, 1);
    assert.match(narrow.stdout, /ctx_bar=▆▆▆▅▆▆ 80%/);

    const wide = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(receivedAt + 20 * 60000),
      CCXRAY_HERDR_SIDEBAR_COLS: '36',
    });
    assert.equal(wide.status, 1);
    assert.match(wide.stdout, /ctx_bar=▂▂▃▃▅▅▆▆▆▅▆▆ 80% · near full/);
  });

  it('launch-agent can produce a Herdr split plan without side effects', () => {
    const context = {
      focused_pane_id: 'w1:p1',
      focused_pane_cwd: '/work/demo',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
    };
    const result = runScript('launch-agent.js', ['codex', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.agent, 'codex');
    assert.deepEqual(plan.split.slice(0, 4), ['pane', 'split', '--pane', 'w1:p1']);
    assert.equal(plan.cwd, '/work/demo');
  });

  it('run-agent exports Herdr identity before launching ccxray', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.env.CCXRAY_AGENT_ID, 'herdr:w1:p9');
    assert.equal(plan.env.CCXRAY_AGENT_TYPE, 'codex');
    assert.equal(plan.env.CCXRAY_HERDR_SOURCE_PANE_ID, 'w1:p1');
    assert.ok(plan.args.includes('--no-browser'));
    assert.ok(plan.args.includes('codex'));
  });

  it('run-agent adds common app CLI directories to PATH for Herdr panes', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run'], {
      HOME: '/tmp/ccxray-demo-home',
      PATH: '/usr/bin',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    const parts = plan.env.PATH.split(path.delimiter);
    assert.equal(parts[0], '/tmp/ccxray-demo-home/.local/bin');
    assert.ok(parts.includes('/tmp/ccxray-demo-home/.grok/bin'));
    assert.ok(parts.includes('/Applications/ChatGPT.app/Contents/Resources'));
    assert.ok(parts.includes('/opt/homebrew/bin'));
  });

  it('install-sidebar-summary appends a safe sidebar row with a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const result = runScript('install-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\[ui\.sidebar\.agents\]/);
    assert.match(config, /\$summary/);
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    assert.doesNotMatch(config, /token\s*=\s*"\$ctx_bar"/);
    assert.match(result.stdout, /backup:/);
  });

  it('install-sidebar-summary upgrades the old one-line sidebar summary config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[ui.sidebar.agents]',
      'row_gap = 0',
      'rows = [',
      '  ["agent"],',
      '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
      ']',
      '',
    ].join('\n'));
    const result = runScript('install-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\$summary/);
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    assert.match(result.stdout, /updated sidebar summary rows/);
  });

  it('install-sidebar-summary upgrades the uncolored ctx_bar row to color rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[ui.sidebar.agents]',
      'row_gap = 0',
      'rows = [',
      '  ["agent"],',
      '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
      '  [{ token = "$ctx_bar", fg = "#a6e3a1", dim = true }],',
      ']',
      '',
    ].join('\n'));
    const result = runScript('install-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    assert.doesNotMatch(config, /token\s*=\s*"\$ctx_bar"/);
    assert.match(result.stdout, /updated sidebar summary rows/);
  });

  it('remove-sidebar-summary removes only ccxray rows and keeps the Herdr layout valid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-config-'));
    const config = path.join(dir, 'config.toml');
    fs.writeFileSync(config, [
      '[ui.sidebar.agents]',
      'row_gap = 0',
      'rows = [',
      '  ["state_icon", "workspace", "tab"],',
      '  ["agent"],',
      '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
      '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
      '  [{ token = "$ctx_bar_green", fg = "#a6e3a1", dim = true }],',
      '  [{ token = "$ctx_bar_yellow", fg = "#f9e2af", dim = true }],',
      '  [{ token = "$ctx_bar_red", fg = "#f38ba8", dim = true }],',
      ']',
      '',
      '[terminal]',
      'new_cwd = "follow"',
      '',
    ].join('\n'));
    const result = runScript('remove-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: config,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed ccxray sidebar summary rows/);
    const updated = fs.readFileSync(config, 'utf8');
    assert.doesNotMatch(updated, /\$summary|\$ctx_bar_/);
    assert.match(updated, /\["state_icon", "workspace", "tab"\]/);
    assert.match(updated, /\[terminal\]/);
    assert.equal(fs.readdirSync(dir).filter(name => name.includes('ccxray-summary-backup')).length, 1);
  });

  it('can be validated by Herdr CLI when Herdr is installed', () => {
    const herdr = spawnSync('herdr', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (herdr.error && herdr.error.code === 'ENOENT') return;
    assert.equal(herdr.status, 0, herdr.stderr);

    const out = execFileSync('herdr', ['plugin', 'link', '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.match(out, /Link a local plugin/);
  });
});
