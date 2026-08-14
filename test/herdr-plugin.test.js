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
});

describe('Herdr plugin commands', () => {
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
    const result = runScript('mission-control.js', ['--once'], { CCXRAY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Mission Control/);
    assert.match(result.stdout, /Turns 1 \/ Sessions 1/);
  });

  it('mission-control switches to tiny output for narrow Herdr panes', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_MISSION_COLS: '23',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray MC/);
    assert.match(result.stdout, /Turns 1/);
    assert.doesNotMatch(result.stdout, /Mission Control/);
    for (const line of result.stdout.trim().split('\n')) {
      assert.ok(line.length <= 22, `line fits narrow pane: ${line}`);
    }
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
    assert.match(result.stdout, /Clear: ctx_bar_yellow ctx_bar_red/);
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
    assert.match(result.stdout, /Clear: ctx_bar_green ctx_bar_yellow/);
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
    assert.match(config, /\$ctx_bar_green/);
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

  it('can be validated by Herdr CLI when Herdr is installed', () => {
    const herdr = spawnSync('herdr', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (herdr.error && herdr.error.code === 'ENOENT') return;
    assert.equal(herdr.status, 0, herdr.stderr);

    const out = execFileSync('herdr', ['plugin', 'link', '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.match(out, /Link a local plugin/);
  });
});
