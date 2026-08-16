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

// INVARIANT: plugin code resolves workspace scope, ccxray home, and command
// paths from the ambient environment, so no spawn may inherit the developer's.
// A suite run from inside a Herdr pane exports HERDR_WORKSPACE_ID /
// HERDR_SOCKET_PATH, which flips currentWorkspaceScope() to the live workspace
// and rewrites every scope-sensitive assertion; an exported CCXRAY_HOME points
// the readers at real logs. Same isolation rule as docs/testing.md, extended to
// the plugin's HERDR_* surface.
function pluginEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HERDR_') || key.startsWith('CCXRAY_')) continue;
    env[key] = value;
  }
  env.CCXRAY_HOME = isolatedHome();
  return { ...env, ...overrides };
}

// Sets ambient process env for the duration of fn, restoring prior values —
// used to prove the isolation above rather than assume it.
function withAmbientEnv(vars, fn) {
  const prior = Object.keys(vars).map(key => [key, process.env[key]]);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runScript(script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'bin', script), ...args], {
    cwd: PLUGIN,
    env: pluginEnv(env),
    encoding: 'utf8',
    timeout: 15000,
  });
}

// Default home for spawns that do not name one: empty, throwaway, never ~/.ccxray.
let emptyHome = null;
function isolatedHome() {
  if (!emptyHome) emptyHome = makeHome();
  return emptyHome;
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

    const commandMatches = [...manifest.matchAll(/command = \["\/bin\/sh", "-c", "exec \\\"\$HERDR_PLUGIN_ROOT\/bin\/run-node\.sh\\\" \\\"\$HERDR_PLUGIN_ROOT\/([^"]+?)\\\"/g)];
    assert.ok(commandMatches.length >= 4);
    assert.ok(fs.statSync(path.join(PLUGIN, 'bin', 'run-node.sh')).mode & 0o111, 'Node launcher is executable');
    for (const [, rel] of commandMatches) {
      assert.ok(fs.existsSync(path.join(PLUGIN, rel)), `${rel} exists`);
    }
  });

  it('installs production dependencies for a GitHub-managed checkout', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.ok(
      manifest.includes('[[build]]\ncommand = ["/bin/sh", "bin/install-dependencies.sh"]'),
      'managed installs must provision the repository dependencies before registration',
    );
    assert.ok(fs.existsSync(path.join(PLUGIN, 'bin', 'install-dependencies.sh')));
  });

  it('starts Mission Control directly through the shared Node launcher', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const paneBlock = manifest.match(/\[\[panes\]\][\s\S]*$/)?.[0] || '';
    assert.match(paneBlock, /command = \["\/bin\/sh", "-c", "exec \\\"\$HERDR_PLUGIN_ROOT\/bin\/run-node\.sh\\\" \\\"\$HERDR_PLUGIN_ROOT\/bin\/mission-control\.js\\\""\]/);
    assert.match(fs.readFileSync(path.join(PLUGIN, 'bin', 'mission-control.js'), 'utf8'), /if \(require\.main === module\) main\(\)/);
  });

  it('keeps outcomes and cross-session value comparison out of the Herdr plugin', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /^version = "0\.4\.0"$/m);
    assert.doesNotMatch(manifest, /mark-(?:success|partial|failed)|clear-outcome|mark-outcome\.js/);
    assert.doesNotMatch(manifest, /session-compare|Session Compare/);
  });

  it('automatically refreshes sidebar metadata at startup and agent state changes', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const refreshAll = 'command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/refresh-all-badges.js\\""]';
    const refreshPane = 'command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/refresh-badges.js\\""]';
    assert.ok(manifest.includes(`[[startup]]\n${refreshAll}`));
    assert.ok(manifest.includes(`on = "pane.agent_detected"\n${refreshPane}`));
    assert.ok(manifest.includes(`on = "pane.agent_status_changed"\n${refreshPane}`));
  });

  it('declares a one-time Quick Start startup hook, action, and pane', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.ok(manifest.includes('command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/open-onboarding.js\\" --first-run"]'));
    assert.match(manifest, /id = "quick-start"[\s\S]*title = "Open ccxray Quick Start"/);
    assert.ok(manifest.includes('command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/open-onboarding.js\\""]'));
    assert.match(manifest, /id = "onboarding"[\s\S]*title = "ccxray Quick Start"/);
    assert.ok(manifest.includes('command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/onboarding.js\\""]'));
    assert.ok(manifest.includes('on = "workspace.created"\ncommand = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/open-onboarding.js\\" --first-run"]'));
  });

  it('opens Mission Control and launched providers in stable new tabs by default', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /id = "mission-control"[\s\S]*?placement = "tab"/);
    const onboarding = fs.readFileSync(path.join(PLUGIN, 'bin', 'onboarding.js'), 'utf8');
    assert.match(onboarding, /'--entrypoint', 'mission-control', '--placement', 'tab'/);
  });

  it('labels capability analysis experimental and starts it through an explicit main entrypoint', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /id = "capability-review"[\s\S]*title = "ccxray Capability Footprint \(Experimental\)"/);
    assert.ok(manifest.includes('command = ["/bin/sh", "-c", "exec \\"$HERDR_PLUGIN_ROOT/bin/run-node.sh\\" \\"$HERDR_PLUGIN_ROOT/bin/capability-review.js\\""]'));
  });
});

describe('Quick Start keyboard menu', () => {
  it('decodes navigation, activation, close, and direct hotkeys', () => {
    const { keyIntent } = require('../plugins/herdr/bin/onboarding');
    assert.deepEqual(keyIntent('\x1b[A'), { type: 'move', delta: -1 });
    assert.deepEqual(keyIntent('j'), { type: 'move', delta: 1 });
    assert.deepEqual(keyIntent('\r'), { type: 'activate' });
    assert.deepEqual(keyIntent('\x1b'), { type: 'close' });
    assert.deepEqual(keyIntent('M'), { type: 'hotkey', key: 'm' });
  });

  it('moves over disabled rows and keeps direct hotkeys discoverable', () => {
    const { menuItems, moveSelection, recommendedItemId } = require('../plugins/herdr/bin/onboarding');
    const state = {
      ccxrayReady: true,
      hubRunning: true,
      sessions: 0,
      sidebar: true,
      providers: [
        { id: 'claude', label: 'Claude', key: '1', available: false },
        { id: 'codex', label: 'Codex', key: '2', available: true },
        { id: 'grok', label: 'Grok', key: '3', available: false },
      ],
    };
    const items = menuItems(state);
    assert.equal(recommendedItemId(state), 'launch-codex');
    assert.equal(moveSelection(items, 'launch-codex', 1), 'sidebar');
    assert.equal(moveSelection(items, 'sidebar', -1), 'launch-codex');
    assert.equal(items.find(item => item.key === 'M').enabled, false);
    assert.equal(items.find(item => item.key === 'S').detail, 'installed · Enter remove');
  });

  it('counts traced sessions only in the current workspace', () => {
    const entries = [
      { ...sampleEntry, id: 'w1-turn', sessionId: 'w1-session', agentId: 'herdr:w1:p2', cwd: '/work/one' },
      { ...sampleEntry, id: 'w2-turn', sessionId: 'w2-session', agentId: 'herdr:w2:p2', cwd: '/work/two' },
    ];
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: '/work/one' }),
      CCXRAY_ONBOARDING_PROVIDERS: 'codex',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sessions\s+READY · 1 traced here/);
  });
});

describe('Herdr workspace scope', () => {
  it('keeps Herdr-attributed traces inside the current workspace', () => {
    const { filterEntriesToWorkspace } = require('../plugins/herdr/bin/lib/ccxray');
    const entries = [
      { id: 'w1', agentId: 'herdr:w1:p1', cwd: '/shared' },
      { id: 'w2', agentId: 'herdr:w2:p1', cwd: '/shared' },
      { id: 'plain', cwd: '/shared' },
      { id: 'other', cwd: '/other' },
    ];
    const scoped = filterEntriesToWorkspace(entries, {
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/shared' }),
    });
    assert.deepEqual(scoped.entries.map(entry => entry.id), ['w1', 'plain']);
    assert.equal(scoped.scope.kind, 'workspace');
    assert.equal(scoped.scope.workspaceId, 'w1');
    assert.equal(scoped.scope.cwd, '/shared');
  });

  it('deduplicates a live pane turn from its later transcript import', () => {
    const { filterEntriesToWorkspace } = require('../plugins/herdr/bin/lib/ccxray');
    const entries = [
      {
        id: 'live', sessionId: 'session-1', responseId: 'response-1',
        agentId: 'herdr:w1:p1', cwd: '/work/one', imported: false,
      },
      {
        id: 'imported', sessionId: 'session-1', responseId: 'response-1',
        cwd: '/work/one', imported: true,
      },
    ];
    const scoped = filterEntriesToWorkspace(entries, {
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/work/one' }),
    });
    assert.deepEqual(scoped.entries.map(entry => entry.id), ['live']);
  });

  it('recovers the project cwd when a plugin pane is focused', () => {
    const { currentWorkspaceScope } = require('../plugins/herdr/bin/lib/ccxray');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-scope-'));
    const bin = path.join(dir, 'herdr');
    const response = {
      id: 'test',
      result: {
        type: 'pane_list',
        panes: [
          { pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/work/project' },
          { pane_id: 'w1:p2', workspace_id: 'w1', cwd: PLUGIN, label: 'ccxray Mission Control' },
        ],
      },
    };
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response) + '\n')});\n`);
    fs.chmodSync(bin, 0o755);

    const scope = currentWorkspaceScope(pluginEnv({
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_ROOT: PLUGIN,
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: 'w1',
        focused_pane_cwd: PLUGIN,
        workspace_cwd: PLUGIN,
      }),
    }));
    assert.equal(scope.cwd, '/work/project');
  });

  it('remembers an exact plugin-routed pane until its first trace arrives', () => {
    const {
      recordRoutedPane,
      routedPaneKnown,
      sessionSummaryDetails,
    } = require('../plugins/herdr/bin/lib/ccxray');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-routed-'));
    const env = { HERDR_PLUGIN_STATE_DIR: stateDir };
    recordRoutedPane('w1:p9', 'codex', env);
    assert.equal(routedPaneKnown('w1:p9', env), true);
    assert.equal(routedPaneKnown('w1:p8', env), false);

    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { ...env, CCXRAY_HOME: makeHome() },
      paneId: 'w1:p9',
      routed: true,
    });
    assert.equal(detail.summary, 'ccxray: ready · send prompt');
    assert.equal(detail.matched, false);
  });
});

// The sidebar badge reports the MAIN agent's context% and cache%. A second
// conversation can ride the same sessionId — a background helper on another model
// with its own convId — and before this fix the badge simply took the group's
// latest turn, so the number oscillated between the two conversations with no
// compaction involved. Real evidence: session 7baf1fc0, main convId 5e666e0a
// (opus-5, orchestrator, 245 msgs, ~319K) interleaved with 5abe96ae (sonnet-5,
// agentKey 'agent', 2 msgs, ~126K) → 30.2 → 12.3 → 30.5 → 12.5 → …
describe('Herdr sidebar main-agent anchoring', () => {
  const T = Date.parse('2026-08-17T00:00:00.000Z');
  const mainTurn = {
    id: 'a1', sessionId: 's1', model: 'claude-opus-5', agentKey: 'orchestrator',
    isSubagent: false, convId: 'aaaa', receivedAt: T, beta1m: true,
    maxContext: 1000000, usage: { input_tokens: 319000 },
  };
  // Latest by receivedAt, and NOT flagged a subagent — `agentKey: 'agent'` is
  // core's catch-all, which is why isMainTurnByAgentKey() calls this turn main.
  const backgroundTurn = {
    id: 'b1', sessionId: 's1', model: 'claude-sonnet-5', agentKey: 'agent',
    isSubagent: false, convId: 'bbbb', coreHash: '', receivedAt: T + 1000,
    maxContext: 200000, usage: { input_tokens: 126000 },
  };

  it('anchors context% on the main conversation, not the latest turn', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome([mainTurn, backgroundTurn]) },
      sessionId: 's1',
      nowMs: T + 2000,
    });
    assert.equal(detail.matched, true);
    // 319000/1000000 = 31.9%. Before the fix: 126000/1000000 = 12.6%.
    assert.equal(Math.round(detail.ctxPct), 32);
    assert.equal(detail.model, 'claude-opus-5');
  });

  it('anchors cache% on the main conversation too', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    // Main reads 90% of its context from cache; the background turn reads none.
    const main = { ...mainTurn, usage: { input_tokens: 31900, cache_read_input_tokens: 287100 } };
    const background = { ...backgroundTurn, usage: { input_tokens: 126000 } };
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome([main, background]) },
      sessionId: 's1',
      nowMs: T + 2000,
      sidebarCols: 32,
    });
    // cacheHitText folds only the anchored turns, so the background turn's
    // uncached 126K must not dilute the ratio: 287100/319000 = 90%.
    assert.match(detail.ctxBar, /cache 90%/);
  });

  it('falls back to every turn when no turn is positively a main agent', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    // Imported turns carry neither agentKey nor isSubagent — an all-imported
    // session must keep behaving exactly as it did. Guard, passes on both sides.
    const imported = [
      { id: 'i1', sessionId: 's2', model: 'claude-opus-5', receivedAt: T, imported: true,
        maxContext: 1000000, usage: { input_tokens: 100000 } },
      { id: 'i2', sessionId: 's2', model: 'claude-opus-5', receivedAt: T + 1000, imported: true,
        maxContext: 1000000, usage: { input_tokens: 250000 } },
    ];
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(imported) },
      sessionId: 's2',
      nowMs: T + 2000,
    });
    assert.equal(Math.round(detail.ctxPct), 25);
  });

  // `toolFail` is the cumulative request-side flag; `turnToolFail` is the
  // per-turn one (#438). Counting `turnToolFail || toolFail` makes one historical
  // failure mark every later turn, so the badge reports `fail 6x` for a session
  // whose last six turns each failed nothing. Measured on the live index
  // (session 7baf1fc0): all six carried turnToolFail:false, toolFail:true —
  // buggy count 6, true count 0.
  it('counts only per-turn tool failures in the badge signal', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const turns = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, sessionId: 's3', model: 'claude-opus-5', agentKey: 'orchestrator',
      isSubagent: false, receivedAt: T + i * 1000, maxContext: 1000000,
      usage: { input_tokens: 100000, cache_read_input_tokens: 100000 },
      turnToolFail: false, toolFail: true,
    }));
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(turns) },
      sessionId: 's3',
      nowMs: T + 7000,
      sidebarCols: 32,
    });
    assert.doesNotMatch(detail.ctxBar, /fail/, 'no turn failed; the badge must not claim one did');
  });

  it('still reports a genuine per-turn tool failure', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const turns = Array.from({ length: 6 }, (_, i) => ({
      id: `u${i}`, sessionId: 's4', model: 'claude-opus-5', agentKey: 'orchestrator',
      isSubagent: false, receivedAt: T + i * 1000, maxContext: 1000000,
      usage: { input_tokens: 100000, cache_read_input_tokens: 100000 },
      turnToolFail: i >= 4, toolFail: true,
    }));
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(turns) },
      sessionId: 's4',
      nowMs: T + 7000,
      sidebarCols: 32,
    });
    assert.match(detail.ctxBar, /fail 2x/);
  });

  // Every turn from a pane carries that pane's agentId, including turns from a
  // subagent that was given its own sessionId. Grouping by sessionId and taking
  // the most recently active group therefore lets a short-lived child session
  // displace the pane's own main session in the badge.
  it('reports the pane root session, not a more recent child session', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const entries = [
      { id: 'm1', sessionId: 'main-1234', agentId: 'herdr:w1:p4', model: 'claude-opus-5',
        agentKey: 'orchestrator', isSubagent: false, receivedAt: T - 120000,
        maxContext: 1000000, usage: { input_tokens: 300000 }, cost: { cost: 0.2, confidence: 'exact' } },
      { id: 'c1', sessionId: 'child-5678', parentSessionId: 'main-1234', agentId: 'herdr:w1:p4',
        model: 'claude-sonnet-5', agentKey: 'orchestrator', isSubagent: false, receivedAt: T,
        maxContext: 1000000, usage: { input_tokens: 950000 }, cost: { cost: 0.07, confidence: 'exact' } },
    ];
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(entries) },
      paneId: 'w1:p4',
      nowMs: T + 1000,
    });
    // Before the fix: child-5678, 95%, claude-sonnet-5 — the pane looked nearly
    // full while its own conversation sat at 30%.
    assert.equal(detail.sessionId, 'main-1234');
    assert.equal(Math.round(detail.ctxPct), 30);
    assert.equal(detail.model, 'claude-opus-5');
  });

  it('still reports a session whose parent is not this pane', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    // parentSessionId names a session this pane never saw, so there is no root to
    // prefer and the only group must still be reported. Guard: passes both sides.
    const entries = [
      { id: 'o1', sessionId: 'orphan-1', parentSessionId: 'elsewhere-9', agentId: 'herdr:w1:p5',
        model: 'claude-opus-5', agentKey: 'orchestrator', isSubagent: false, receivedAt: T,
        maxContext: 1000000, usage: { input_tokens: 400000 } },
    ];
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(entries) },
      paneId: 'w1:p5',
      nowMs: T + 1000,
    });
    assert.equal(detail.sessionId, 'orphan-1');
    assert.equal(Math.round(detail.ctxPct), 40);
  });
});

// run-node.sh is the shim every plugin entrypoint goes through. `exec` replaces
// the shell, so once the mise branch fires the candidate loop below it is
// unreachable — a mise whose newest installed Node is too old took the process
// down with it while a usable Node sat at one of the candidate paths.
describe('Herdr Node launcher fallback', () => {
  function makeFakeToolchain({ miseNodeMajor }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-node-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-nodehome-'));

    // A Node that reports `miseNodeMajor`: the >=18 probe is `-e <script>`.
    const fakeNode = path.join(dir, 'fake-node');
    fs.writeFileSync(fakeNode, [
      '#!/bin/sh',
      'if [ "$1" = "-e" ]; then',
      `  [ ${miseNodeMajor} -ge 18 ] && exit 0`,
      '  exit 1',
      'fi',
      `echo "FAKE_NODE_${miseNodeMajor}"`,
      '',
    ].join('\n'));
    fs.chmodSync(fakeNode, 0o755);

    const mise = path.join(dir, 'mise');
    fs.writeFileSync(mise, [
      '#!/bin/sh',
      'if [ "$1" = "latest" ]; then',
      `  echo "${miseNodeMajor}.20.2"`,
      '  exit 0',
      'fi',
      'if [ "$1" = "exec" ]; then',
      '  shift 4',            // drop: exec, node@X, --, node
      `  exec "${fakeNode}" "$@"`,
      'fi',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(mise, 0o755);

    // A real, supported Node at one of run-node.sh's candidate paths.
    fs.mkdirSync(path.join(home, '.volta', 'bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(home, '.volta', 'bin', 'node'));

    const script = path.join(dir, 'probe.js');
    fs.writeFileSync(script, 'process.stdout.write("REAL_NODE_" + process.versions.node.split(".")[0]);\n');
    return { dir, home, script };
  }

  function runLauncher({ dir, home, script }) {
    return spawnSync('/bin/sh', [path.join(PLUGIN, 'bin', 'run-node.sh'), script], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  it('skips a mise Node that is too old and uses a supported one', () => {
    const fake = makeFakeToolchain({ miseNodeMajor: 16 });
    const result = runLauncher(fake);
    assert.doesNotMatch(result.stdout, /FAKE_NODE_16/, 'must not run a Node older than 18');
    assert.match(result.stdout, /REAL_NODE_/);
  });

  it('still uses the mise Node when it is supported', () => {
    // Guard: the fix must not disable the mise branch outright. Here mise
    // reports a supported major, so the launcher should stay on it.
    const fake = makeFakeToolchain({ miseNodeMajor: 22 });
    const result = runLauncher(fake);
    assert.match(result.stdout, /FAKE_NODE_22/);
  });
});

describe('Mission Control keyboard model', () => {
  it('maps visible controls and preserves pane selection across refreshes', () => {
    const {
      missionKeyIntent,
      moveMissionSelection,
      reconcileMissionState,
    } = require('../plugins/herdr/bin/mission-control');
    assert.deepEqual(missionKeyIntent('\x1b[A'), { type: 'move', delta: -1 });
    assert.deepEqual(missionKeyIntent('j'), { type: 'move', delta: 1 });
    assert.deepEqual(missionKeyIntent('\r'), { type: 'focus' });
    assert.deepEqual(missionKeyIntent('d'), { type: 'dashboard' });
    assert.deepEqual(missionKeyIntent('f'), { type: 'filter' });
    assert.deepEqual(missionKeyIntent('?'), { type: 'help' });
    assert.deepEqual(missionKeyIntent('q'), { type: 'close' });

    const rows = [
      { paneId: 'w1:p1', severity: 'red' },
      { paneId: 'w1:p2', severity: 'green' },
      { paneId: 'w1:p3', severity: 'ready' },
    ];
    let state = reconcileMissionState({ selectedKey: 'w1:p2', selectedIndex: 1, filter: 'all' }, rows);
    assert.equal(state.selectedKey, 'w1:p2');
    state = reconcileMissionState(state, [rows[2], rows[1], rows[0]]);
    assert.equal(state.selectedKey, 'w1:p2');
    state = moveMissionSelection(state, [rows[2], rows[1], rows[0]], 1);
    assert.equal(state.selectedKey, 'w1:p1');
    state = reconcileMissionState(state, [rows[2], rows[1]]);
    assert.equal(state.selectedKey, 'w1:p2');
  });

  it('cycles explicit filters and gives recovery feedback for unavailable actions', () => {
    const {
      cycleMissionFilter,
      executeMissionAction,
      filteredMissionRows,
    } = require('../plugins/herdr/bin/mission-control');
    const rows = [
      { paneId: 'w1:p1', sessionId: 'session-red', severity: 'red' },
      { paneId: 'w1:p2', sessionId: 'session-green', severity: 'green' },
      { paneId: 'w1:p3', sessionId: 'session-ready', severity: 'ready' },
    ];
    assert.equal(cycleMissionFilter('all'), 'attention');
    assert.equal(cycleMissionFilter('attention'), 'ready');
    assert.equal(cycleMissionFilter('ready'), 'all');
    assert.deepEqual(filteredMissionRows(rows, 'attention').map(row => row.paneId), ['w1:p1']);
    assert.deepEqual(filteredMissionRows(rows, 'ready').map(row => row.paneId), ['w1:p3']);

    const herdr = makeRecordingHerdr();
    const env = pluginEnv({
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HOME: makeHome(),
      BROWSER: 'none',
    });
    assert.equal(executeMissionAction({ type: 'focus' }, rows[0], env), 'Focused w1:p1.');
    assert.match(fs.readFileSync(herdr.log, 'utf8'), /agent focus w1:p1/);
    assert.equal(
      executeMissionAction({ type: 'dashboard' }, rows[0], env),
      'Dashboard unavailable: start a traced agent or run Doctor.',
    );
  });
});

describe('Herdr TUI primitives', () => {
  it('keeps the selected row inside a stable scrolling viewport', () => {
    const { budgetedListViewport, listViewport } = require('../plugins/herdr/bin/lib/tui');
    assert.deepEqual(listViewport(12, 0, 4, 0), { start: 0, end: 4 });
    assert.deepEqual(listViewport(12, 5, 4, 0), { start: 2, end: 6 });
    assert.deepEqual(listViewport(12, 10, 4, 2), { start: 7, end: 11 });
    assert.deepEqual(listViewport(2, 1, 4, 0), { start: 0, end: 2 });
    assert.deepEqual(budgetedListViewport(12, 5, 3, 0), {
      start: 4,
      end: 6,
      overflow: '↑ 4 · ↓ 6 more',
      overflowBefore: true,
    });
  });

  it('measures wide terminal glyphs and wraps without losing content', () => {
    const { displayWidth, wrapText } = require('../plugins/herdr/bin/lib/tui');
    assert.equal(displayWidth('ctx 模型 80%'), 12);
    const source = 'Evidence: 模型 context remains visible';
    const lines = wrapText(source, 16);
    assert.equal(lines.join(' '), source);
    assert.ok(lines.every(line => displayWidth(line) <= 16));
  });

  it('moves the shell prompt to a fresh line when an interactive frame exits', () => {
    const { restoreFrameCursor } = require('../plugins/herdr/bin/lib/tui');
    let output = '';
    restoreFrameCursor({ write(value) { output += value; } });
    assert.equal(output, '\n\x1b[?25h');
  });
});

// wrapText's inner loop consumed `takeWidth(remainder, available)`. A glyph wider
// than the space available makes takeWidth return '', so neither `line` nor
// `remainder` advanced: the loop pushed empty lines forever. Runs in a child
// because a synchronous infinite loop cannot be interrupted by a test timeout.
// GUARD (passes before and after — no behaviour changed here). Quick Start's
// closeMenu restores the terminal and may ask Herdr to close the pane, but
// unlike mission-control.js and capability-review.js it never calls
// process.exit(0). A review flagged that as a hang; measured under a real pty it
// is not one — with the listener removed and stdin paused the loop drains and
// the process ends on its own. The asymmetry is still fragile: the day someone
// adds a timer or an open handle to this file, `q` silently stops working. This
// pins the observable behaviour so that day fails a test instead of a user.
// `executeItem` runs spawnSync, which blocks the event loop for seconds. Keys
// typed while it blocks are delivered the moment it returns, aimed at the menu
// that existed before the action. On the Sidebar row that was destructive: `s`
// installs, the queued `s` sees the refreshed state and removes it, so a double
// tap left the config untouched while the menu said "Sidebar summary removed".
//
// The behavioural differential was measured directly rather than automated —
// under a real pty with a herdr stub whose config calls take a second, a double
// tap at 0.4s leaves 0 summary rows and 2 backups before the fix versus 2 rows
// and 1 backup after (two backups being the tell that both scripts ran). That
// harness proved too timing-fragile to keep in the suite: under full-suite load
// it reported 0 backups because the first install had not finished either, and a
// flaky test is worse than none. The procedure is written up in
// .scratch/REVIEW-531-LEDGER.md; what is pinned here is the gate itself, with a
// fake clock, deterministically.
describe('Herdr Quick Start action gate', () => {
  const { createActionGate } = require('../plugins/herdr/bin/onboarding');

  it('swallows a keypress delivered right after an action and then reopens', () => {
    let now = 1000;
    const gate = createActionGate(250, () => now);
    assert.equal(gate.blocked(), false, 'the first key must always act');
    gate.armAfterAction();
    now += 1;                       // the queued keypress arrives immediately
    assert.equal(gate.blocked(), true);
    now += 100;
    assert.equal(gate.blocked(), true);
    now += 200;                     // 301ms after the action
    assert.equal(gate.blocked(), false, 'a deliberate later keypress must act');
  });

  it('does not block before any action has run', () => {
    let now = 5000;
    const gate = createActionGate(250, () => now);
    now += 10_000;
    assert.equal(gate.blocked(), false);
  });
});

describe('Herdr Quick Start close', () => {
  it('exits the process when the menu is closed', () => {
    const home = makeHome();
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-qs-')), 'config.toml');
    fs.writeFileSync(cfg, '[ui]\n');
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-mark-')), 'exit');
    const onboarding = path.join(PLUGIN, 'bin', 'onboarding.js');
    // `script` gives the child a real pty, which onboarding requires to go
    // interactive. Keeping stdin open past the keypress is what exposes a
    // process that never exits; the marker records that it did.
    const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(onboarding)}; `
      + `echo done > ${JSON.stringify(marker)}`;
    // stdin is held open far longer than the poll window on purpose: otherwise
    // the process would exit on stdin EOF and the test would pass for the wrong
    // reason. Seeing the marker inside the window means `q` itself ended it.
    const command = `( printf 'q'; sleep 40 ) | script -q /dev/null `
      + `env CCXRAY_HOME=${JSON.stringify(home)} HERDR_CONFIG_PATH=${JSON.stringify(cfg)} `
      + `CCXRAY_PRICING_CACHE=/nonexistent/p.json HERDR_PANE_ID= `
      + `/bin/sh -c ${JSON.stringify(inner)} >/dev/null 2>&1 &\n`
      + `for i in $(seq 1 40); do [ -f ${JSON.stringify(marker)} ] && break; sleep 0.2; done\n`
      + `[ -f ${JSON.stringify(marker)} ] && echo EXITED || echo LINGERED\n`
      + `pkill -f ${JSON.stringify(onboarding)} 2>/dev/null; true`;
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 30000 });
    assert.match(result.stdout, /EXITED/, 'closing Quick Start must end the process, not leave it inert on screen');
  });
});

describe('Herdr TUI narrow-width safety', () => {
  function evalInChild(expr) {
    const script = `const t=require(${JSON.stringify(path.join(PLUGIN, 'bin', 'lib', 'tui.js'))});`
      + `process.stdout.write(JSON.stringify(${expr}));`;
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  }

  for (const [label, expr] of [
    ['a wide glyph alone', 't.wrapText("中", 1)'],
    ['a wide glyph among narrow ones', 't.wrapText("a 中 b", 1)'],
    ['a wide word at width 1', 't.wrapText("中文字", 1)'],
    ['an emoji at width 1', 't.wrapText("🙂🙂", 1)'],
  ]) {
    it(`wraps ${label} without hanging`, () => {
      const result = evalInChild(expr);
      assert.equal(result.signal, null, `${expr} did not terminate`);
      assert.equal(result.status, 0, `${expr} crashed: ${result.stderr}`);
      const lines = JSON.parse(result.stdout);
      assert.ok(Array.isArray(lines) && lines.length > 0 && lines.length < 100, `unreasonable output: ${result.stdout.slice(0, 120)}`);
      assert.equal(lines.join('').replace(/\s/g, ''), expr.match(/"([^"]+)"/)[1].replace(/\s/g, ''),
        'every glyph must survive the wrap');
    });
  }

  it('still wraps normally when the width fits', () => {
    // Guard: the fix must not change ordinary wrapping. Passes on both sides.
    const result = evalInChild('t.wrapText("中文字", 2)');
    assert.deepEqual(JSON.parse(result.stdout), ['中', '文', '字']);
  });
});

describe('Herdr attention notifications', () => {
  it('notifies only once per background done or blocked transition', () => {
    const { agentNotification, recordAgentStatus } = require('../plugins/herdr/bin/lib/notifications');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-notifications-'));
    const env = { HERDR_PLUGIN_STATE_DIR: stateDir };

    assert.equal(agentNotification({ paneId: 'w1:p1', status: 'working', agent: 'Claude' }, '', { env }), null);
    const doneEvent = { paneId: 'w1:p1', status: 'done', agent: 'Claude' };
    assert.deepEqual(
      agentNotification(doneEvent, 'opus-5, 15m, $0.51', { env }),
      { title: 'Claude finished', body: 'opus-5, 15m, $0.51 · w1:p1', sound: 'done' },
    );
    recordAgentStatus(doneEvent, env);
    assert.equal(agentNotification({ paneId: 'w1:p1', status: 'done', agent: 'Claude' }, '', { env }), null);
    assert.equal(agentNotification({ paneId: 'w1:p1', status: 'working', agent: 'Claude' }, '', { env }), null);
    const blockedEvent = { paneId: 'w1:p1', status: 'blocked', agent: 'Claude' };
    assert.deepEqual(
      agentNotification(blockedEvent, 'ctx 84%', { env }),
      { title: 'Claude needs attention', body: 'ctx 84% · w1:p1', sound: 'request' },
    );
    recordAgentStatus(blockedEvent, env);
  });

  it('keeps a notification retryable until Herdr confirms delivery', () => {
    const { agentNotification, recordAgentStatus } = require('../plugins/herdr/bin/lib/notifications');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-notification-retry-'));
    const env = { HERDR_PLUGIN_STATE_DIR: stateDir };
    const event = { paneId: 'w1:p5', status: 'blocked', agent: 'Codex' };
    assert.ok(agentNotification(event, 'ctx 91%', { env }));
    assert.ok(agentNotification(event, 'ctx 91%', { env }), 'failed delivery remains retryable');
    recordAgentStatus(event, env);
    assert.equal(agentNotification(event, 'ctx 91%', { env }), null);
  });

  it('honors notification modes and suppresses the focused pane', () => {
    const { agentNotification } = require('../plugins/herdr/bin/lib/notifications');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-notification-mode-'));
    const blockedOnly = { HERDR_PLUGIN_STATE_DIR: stateDir, CCXRAY_HERDR_NOTIFICATIONS: 'blocked' };
    assert.equal(agentNotification({ paneId: 'w1:p2', status: 'done' }, '', { env: blockedOnly }), null);
    assert.equal(agentNotification({ paneId: 'w1:p3', status: 'blocked' }, '', { env: blockedOnly, focused: true }), null);
    const off = { HERDR_PLUGIN_STATE_DIR: stateDir, CCXRAY_HERDR_NOTIFICATIONS: 'off' };
    assert.equal(agentNotification({ paneId: 'w1:p4', status: 'blocked' }, '', { env: off }), null);
  });
});

describe('Capability Footprint keyboard model', () => {
  it('supports recognition-first navigation and stable selection', () => {
    const {
      capabilityKeyIntent,
      moveCapabilitySelection,
      reconcileCapabilityState,
    } = require('../plugins/herdr/bin/capability-review');
    assert.deepEqual(capabilityKeyIntent('k'), { type: 'move', delta: -1 });
    assert.deepEqual(capabilityKeyIntent('\x1b[B'), { type: 'move', delta: 1 });
    assert.deepEqual(capabilityKeyIntent('f'), { type: 'filter' });
    assert.deepEqual(capabilityKeyIntent('r'), { type: 'refresh' });
    assert.deepEqual(capabilityKeyIntent('?'), { type: 'help' });
    assert.deepEqual(capabilityKeyIntent('q'), { type: 'close' });
    const rows = [{ key: 'mcp:a' }, { key: 'mcp:b' }, { key: 'skill:tdd' }];
    let state = reconcileCapabilityState({ selectedKey: 'mcp:b', selectedIndex: 1 }, rows);
    state = reconcileCapabilityState(state, [rows[2], rows[1], rows[0]]);
    assert.equal(state.selectedKey, 'mcp:b');
    state = moveCapabilitySelection(state, [rows[2], rows[1], rows[0]], 1);
    assert.equal(state.selectedKey, 'mcp:a');
  });
});

describe('Herdr plugin commands', () => {
  it('Quick Start renders a cursor menu with unavailable actions visibly disabled', () => {
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
    assert.match(result.stdout, /sidebar\s+SETUP · optional/);
    assert.match(result.stdout, /sessions\s+START · 0 observed/);
    assert.match(result.stdout, /› \[1\] Claude\s+available/);
    assert.match(result.stdout, /\[2\] Codex\s+available/);
    assert.match(result.stdout, /\[3\] Grok\s+not found/);
    assert.match(result.stdout, /\[M\] Mission Control\s+needs 1 session/);
    assert.match(result.stdout, /\[R\] Capability Footprint\s+experimental · needs 5/);
    assert.match(result.stdout, /Up\/Down or j\/k move · Enter select/);
    assert.match(result.stdout, /Recommended: Launch Claude through ccxray/);
  });

  it('Quick Start names the directory a launch would start in', () => {
    const home = makeHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_HOME: home,
      HERDR_PLUGIN_STATE_DIR: path.join(home, 'state'),
      HERDR_CONFIG_PATH: path.join(home, 'config.toml'),
      CCXRAY_ONBOARDING_PROVIDERS: 'claude',
      CCXRAY_ONBOARDING_COLS: '100',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: 'w1',
        workspace_cwd: project,
        focused_pane_cwd: project,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`directory    ${project}`), result.stdout);
  });

  it('Quick Start reports the first line of a failing action, not the last', () => {
    const { resultMessage } = require(path.join(PLUGIN, 'bin', 'onboarding.js'));
    const failure = {
      status: 1,
      stdout: '',
      stderr: [
        'Could not parse [ui.sidebar.agents] in /tmp/config.toml; add these rows to its rows array manually:',
        '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
        ']',
      ].join('\n'),
    };
    assert.equal(
      resultMessage(failure, 'Sidebar summary installed.'),
      'Could not complete: Could not parse [ui.sidebar.agents] in /tmp/config.toml; add these rows to its rows array manually:',
    );
    assert.equal(resultMessage({ status: 0 }, 'Sidebar summary installed.'), 'Sidebar summary installed.');
  });

  it('Quick Start keeps Mission Control primary and labels capability analysis experimental', () => {
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
    assert.match(result.stdout, /sessions\s+READY · 5 observed/);
    assert.match(result.stdout, /\[M\] Mission Control\s+live attention/);
    assert.match(result.stdout, /› \[M\] Mission Control\s+live attention/);
    assert.match(result.stdout, /\[R\] Capability Footprint\s+experimental · 5 sessions/);
    assert.match(result.stdout, /Recommended: Inspect live pressure, cost, and failures/);
  });

  it('Quick Start keeps every cursor-menu row within a narrow pane', () => {
    const home = makeHome([{ ...sampleEntry, agentId: 'herdr:w1:p1' }]);
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_HOME: home,
      HERDR_CONFIG_PATH: path.join(home, 'missing-config.toml'),
      CCXRAY_ONBOARDING_PROVIDERS: 'claude,codex,grok',
      CCXRAY_ONBOARDING_COLS: '40',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /› \[M\] Mission Control/);
    for (const line of result.stdout.trim().split('\n')) {
      assert.ok(line.length <= 39, `Quick Start line fits narrow pane: ${line}`);
    }
    const readable = result.stdout.replace(/\s+/g, ' ');
    assert.match(readable, /Capability Footprint experimental · needs 5/);
    assert.match(readable, /Up\/Down or j\/k move · Enter select · 1-3 launch · q close/);
    assert.match(readable, /Recommended: Inspect live pressure, cost, and failures\./);
  });

  it('Quick Start keeps its title and every action visible in a short narrow pane', () => {
    const { displayWidth } = require('../plugins/herdr/bin/lib/tui');
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_ONBOARDING_ONCE: '1',
      CCXRAY_ONBOARDING_PROVIDERS: 'claude,codex,grok',
      CCXRAY_ONBOARDING_COLS: '28',
      CCXRAY_ONBOARDING_ROWS: '21',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 21, `Quick Start fits 21 rows, got ${lines.length}`);
    assert.match(lines[0], /ccxray Quick Start/);
    assert.match(result.stdout, /\[1\] Claude/);
    assert.match(result.stdout, /\[2\] Codex/);
    assert.match(result.stdout, /\[3\] Grok/);
    assert.match(result.stdout, /\[M\] Mission Control/);
    assert.match(result.stdout, /\[R\] Capability \(exp\)/);
    assert.match(result.stdout, /\[S\] Sidebar summary/);
    assert.match(result.stdout, /\[D\] Doctor/);
    assert.match(result.stdout, /\[Q\] Close/);
    for (const row of lines) assert.ok(displayWidth(row) <= 27, `Quick Start row fits: ${row}`);
  });

  it('Quick Start preserves all actions at its 16-row minimum', () => {
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_ONBOARDING_ONCE: '1',
      CCXRAY_ONBOARDING_PROVIDERS: 'claude,codex,grok',
      CCXRAY_ONBOARDING_COLS: '24',
      CCXRAY_ONBOARDING_ROWS: '16',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 16, `Quick Start fits 16 rows, got ${lines.length}`);
    assert.match(lines[0], /ccxray Quick Start/);
    assert.match(result.stdout, /\[1\] Claude[\s\S]*\[Q\] Close/);
    assert.match(result.stdout, /j\/k · Enter · q/);
  });

  it('Quick Start prioritizes actions over section headings in a short wide pane', () => {
    const result = runScript('onboarding.js', ['--once'], {
      CCXRAY_ONBOARDING_ONCE: '1',
      CCXRAY_ONBOARDING_PROVIDERS: 'claude,codex,grok',
      CCXRAY_ONBOARDING_COLS: '72',
      CCXRAY_ONBOARDING_ROWS: '16',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 16, `Quick Start fits 16 rows, got ${lines.length}`);
    assert.match(lines[0], /ccxray Quick Start/);
    assert.doesNotMatch(result.stdout, /Launch a traced session/);
    assert.match(result.stdout, /\[1\] Claude[\s\S]*\[Q\] Close/);
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

  it('defers first-run onboarding cleanly until a workspace exists', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-onboarding-'));
    const herdr = makeRecordingHerdr({ status: 1 });
    fs.writeFileSync(herdr.bin, [
      '#!/usr/bin/env node',
      'process.stderr.write(JSON.stringify({ error: { code: "no_active_workspace", message: "no active workspace" } }) + "\\n");',
      'process.exit(1);',
      '',
    ].join('\n'));
    fs.chmodSync(herdr.bin, 0o755);

    const result = runScript('open-onboarding.js', ['--first-run'], {
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: herdr.bin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deferred until a workspace is created/);
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

  it('doctor fails truthfully when the ccxray status command crashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-doctor-failure-'));
    const bin = path.join(dir, 'ccxray');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'echo "Error: Cannot find module ws" >&2',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('doctor.js', [], {
      CCXRAY_BIN: bin,
      CCXRAY_HOME: makeHome(),
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Hub: check failed/);
    assert.match(result.stdout, /Cannot find module ws/);
    assert.doesNotMatch(result.stdout, /Hub: running/);
  });

  it('doctor reports usage from the current workspace instead of global history', () => {
    const entries = [
      { ...sampleEntry, id: 'inside', sessionId: 'inside-session', cwd: '/work/inside' },
      { ...sampleEntry, id: 'outside', sessionId: 'outside-session', cwd: '/work/outside' },
    ];
    const result = runScript('doctor.js', [], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_LAST: '9999d',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/work/inside' }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage \(9999d, workspace \/work\/inside\):/);
    assert.match(result.stdout, /1 turns across 1 sessions/);
  });

  it('usage-summary prints compact usage for an isolated ccxray home', () => {
    const home = makeHome([sampleEntry]);
    const result = runScript('usage-summary.js', ['--last', '9999d'], { CCXRAY_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ccxray Usage Summary/);
    assert.match(result.stdout, /1 turns across 1 sessions/);
    assert.match(result.stdout, /Validate Herdr plugin/);
  });

  // Guards the pluginEnv() isolation: running this suite from inside a Herdr
  // pane exports HERDR_* into every spawn, which scopes the readers to the live
  // workspace and drops the fixture entries. Without the scrub this fails.
  it('ignores the ambient Herdr environment of the shell running the suite', () => {
    const home = makeHome([sampleEntry]);
    withAmbientEnv({
      HERDR_ENV: '1',
      HERDR_WORKSPACE_ID: 'ambient-workspace',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/ambient/live' }),
    }, () => {
      const result = runScript('usage-summary.js', ['--last', '9999d'], { CCXRAY_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 turns across 1 sessions/);
      assert.doesNotMatch(result.stdout, /ambient\/live/);
    });
  });

  it('usage-summary defaults to the current Herdr workspace cwd and names its scope', () => {
    const entries = [
      { ...sampleEntry, id: 'inside', sessionId: 'inside-session', cwd: '/work/inside' },
      { ...sampleEntry, id: 'outside', sessionId: 'outside-session', cwd: '/work/outside' },
    ];
    const result = runScript('usage-summary.js', ['--last', '9999d'], {
      CCXRAY_HOME: makeHome(entries),
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: '/work/inside' }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Scope: workspace \/work\/inside/);
    assert.match(result.stdout, /1 turns across 1 sessions/);
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

  it('mission-control recent traces stay scoped to the current workspace', () => {
    const entries = [
      { ...sampleEntry, id: 'inside', sessionId: 'inside-session', agentId: 'herdr:w1:p2', cwd: '/work/inside' },
      { ...sampleEntry, id: 'outside', sessionId: 'outside-session', agentId: 'herdr:w2:p2', cwd: '/work/outside' },
    ];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: '/work/inside' }),
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 workspace traces/);
    assert.match(result.stdout, /inside-s/);
    assert.doesNotMatch(result.stdout, /outside-/);
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

  it('mission-control keeps the selected action readable in a narrow pane', () => {
    const now = Date.now();
    const entry = {
      ...sampleEntry,
      id: 'selected-risk',
      sessionId: 'selected-risk-session',
      agentId: 'herdr:w1:p1',
      agentType: 'codex',
      receivedAt: now,
      usage: { input_tokens: 900, output_tokens: 10 },
      cost: { cost: 0.30, confidence: 'exact' },
      maxContext: 1000,
      turnToolFail: false,
    };
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome([entry]),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr([{
        pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1',
        agent_status: 'working', agent: 'codex',
      }]),
      CCXRAY_MISSION_COLS: '40',
      CCXRAY_MISSION_ROWS: '24',
    });
    assert.equal(result.status, 0, result.stderr);
    const readable = result.stdout.replace(/\s+/g, ' ');
    assert.match(readable, /› RED w1:p1 codex/);
    assert.match(readable, /Selected w1:p1 · codex · working/);
    assert.match(readable, /Session: sonnet-4-6 · age now · 1 turn · 2 tools/);
    assert.match(readable, /Why: context pressure 90%/);
    assert.match(readable, /Next: compact or start fresh/);
    assert.match(readable, /Evidence: pane\/session exact · cost exact · seen now/);
    assert.match(readable, /Enter focus · d dashboard · f filter · r refresh · \? help · q close/);
    for (const line of result.stdout.trim().split('\n')) {
      assert.ok(line.length <= 39, `Mission Control line fits narrow pane: ${line}`);
    }
  });

  it('mission-control keeps decisions and controls inside a 12-row pane', () => {
    const now = Date.now();
    const entry = {
      ...sampleEntry,
      id: 'short-pane',
      sessionId: 'short-pane-session',
      agentId: 'herdr:w1:p1',
      receivedAt: now,
      usage: { input_tokens: 900, output_tokens: 10 },
      maxContext: 1000,
    };
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome([entry]),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr([{
        pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1',
        agent_status: 'working', agent: 'claude',
      }]),
      CCXRAY_MISSION_COLS: '40',
      CCXRAY_MISSION_ROWS: '12',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    const readable = lines.join(' ');
    assert.ok(lines.length <= 12, `Mission Control stays within 12 rows: ${lines.length}`);
    assert.match(readable, /Next: compact or start fresh/);
    assert.match(readable, /Enter focus/);
  });

  it('mission-control preserves readable detail across common pane widths', () => {
    const { displayWidth } = require('../plugins/herdr/bin/lib/tui');
    const now = Date.now();
    const entry = {
      ...sampleEntry,
      id: 'responsive-detail',
      sessionId: 'responsive-session',
      agentId: 'herdr:w1:p1',
      agentType: 'claude',
      model: 'claude-opus-5',
      receivedAt: now,
      usage: { input_tokens: 830, output_tokens: 20 },
      maxContext: 1000,
    };
    const home = makeHome([entry]);
    const herdr = makeHerdr([{
      pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1',
      agent_status: 'idle', agent: 'claude',
    }]);

    for (const width of [36, 48, 80, 120]) {
      const result = runScript('mission-control.js', ['--once'], {
        CCXRAY_HOME: home,
        CCXRAY_HERDR_NOW_MS: String(now),
        HERDR_BIN_PATH: herdr,
        CCXRAY_MISSION_COLS: String(width),
        CCXRAY_MISSION_ROWS: '24',
      });
      assert.equal(result.status, 0, result.stderr);
      const readable = result.stdout.replace(/\s+/g, ' ');
      assert.match(readable, /Session: opus-5 · age now · 1 turn · 2 tools/);
      assert.match(readable, /Next: compact or start fresh/);
      if (width === 36) {
        assert.match(readable, /ccxray MC Filter all/);
        assert.match(readable, /1 active panes \/ 1 alert/);
        assert.doesNotMatch(readable, /\$0\.12~/);
      }
      for (const line of result.stdout.trim().split('\n')) {
        assert.ok(displayWidth(line) <= width - 1, `${width}-column line fits: ${line}`);
      }
    }
  });

  it('mission-control exposes overflow instead of silently dropping many agents', () => {
    const now = Date.now();
    const agents = Array.from({ length: 12 }, (_, index) => ({
      pane_id: `w1:p${index + 1}`,
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      agent_status: 'working',
      agent: index % 2 ? 'claude' : 'codex',
    }));
    const entries = agents.map((agent, index) => ({
      ...sampleEntry,
      id: `many-${index}`,
      sessionId: `many-session-${index}`,
      agentId: `herdr:${agent.pane_id}`,
      agentType: agent.agent,
      receivedAt: now - index,
      usage: { input_tokens: 100 + index, output_tokens: 10 },
      maxContext: 1000,
    }));
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '52',
      CCXRAY_MISSION_ROWS: '18',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /12 active panes/);
    assert.match(result.stdout, /↓ \d+ more/);
    assert.match(result.stdout, /Selected w1:p1/);
  });

  it('mission-control keeps more than 24 recent sessions reachable', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      ...sampleEntry,
      id: `turn-${index}`,
      sessionId: `session-${index}`,
      receivedAt: Date.now() - index * 1000,
    }));
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_MISSION_ROWS: '12',
      CCXRAY_MISSION_COLS: '48',
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /30 recent sessions/);
    assert.match(result.stdout, /↓ \d+ more/);
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
    assert.match(result.stdout, /2 active panes · 1 attention/);
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
    assert.match(result.stdout, /1 active panes · 1 attention/);
    assert.match(result.stdout, /YELLOW w1:p9 grok · working/);
    assert.match(result.stdout, /no ccxray telemetry/);
    assert.match(result.stdout, /unlinked/);
  });

  it('mission-control recovers an exact pane from Herdr native session identity', () => {
    const { missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');
    const now = Date.now();
    const entries = [
      { ...sampleEntry, id: 'old-pane', sessionId: 'session-old', agentId: 'herdr:w1:p17', receivedAt: now - 1000 },
      { ...sampleEntry, id: 'new-pane', sessionId: 'session-new', agentId: 'herdr:w1:p17', receivedAt: now },
    ];
    const agents = [
      {
        pane_id: 'w1:p17', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', agent: 'claude',
        agent_session: { kind: 'id', value: 'session-old' },
      },
      {
        pane_id: 'w1:p21', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', agent: 'claude',
        agent_session: { kind: 'id', value: 'session-new' },
      },
    ];
    // In-process call, so it reads the ambient env unless one is supplied: a
    // suite run from inside a Herdr pane exports HERDR_WORKSPACE_ID, which
    // scopes the snapshot to that live workspace and drops every w1 fixture
    // agent. Same isolation rule as the spawned scripts (see pluginEnv).
    const snapshot = missionControlSnapshot({
      entries,
      nowMs: now,
      agentReport: { ok: true, agents },
      env: pluginEnv(),
    });
    const oldPane = snapshot.rows.find(row => row.paneId === 'w1:p17');
    const newPane = snapshot.rows.find(row => row.paneId === 'w1:p21');
    assert.equal(oldPane.sessionId, 'session-old');
    assert.equal(newPane.sessionId, 'session-new');
    assert.equal(newPane.turns, 1);
    assert.equal(newPane.mapping, 'native');
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
    assert.match(result.stdout, /1 active panes · 1 attention/);
    assert.match(result.stdout, /READY w1:p8 claude · done/);
    assert.match(result.stdout, /Next: review output/);
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
    assert.match(result.stdout, /2 active panes · 1 attention/);
    assert.match(result.stdout, /YELLOW w1:p6 codex · working/);
    assert.match(result.stdout, /Next: inspect prompt\/tool diff/);
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
    assert.match(result.stdout, /ccxray Capability Footprint/);
    assert.match(result.stdout, /Experimental · observations, not outcome-backed recommendations/);
    assert.match(result.stdout, /5 sessions with schema · estimates/);
    assert.match(result.stdout, /› MCP notion/);
    assert.match(result.stdout, /Selected MCP notion/);
    assert.match(result.stdout, /Observed: schema ~1\.2K\/session · used 0\/5 eligible/);
    assert.match(result.stdout, /Interpretation: experiment candidate/);
    assert.match(result.stdout, /Confidence: derived estimate · outcome impact unknown/);
    assert.match(result.stdout, /Next: validate with a project-scoped experiment/);
    assert.match(result.stdout, /MCP github/);
    assert.match(result.stdout, /used 4\/5 eligible/);
    assert.match(result.stdout, /Skill tdd\s+seen 3\/5 sessions · 6 calls · observed only/);
    assert.match(result.stdout, /Up\/Down or j\/k move · f filter · r refresh · \? help · q close/);
  });

  it('capability footprint preserves uncertainty and next steps in a narrow pane', () => {
    const hash = 'abc123fed456';
    const now = Date.now();
    const home = makeHome([{
      ...sampleEntry,
      id: 'narrow-capability',
      sessionId: 'narrow-capability-session',
      receivedAt: now,
      toolsHash: hash,
      turnToolCalls: {},
    }]);
    writeToolDefinitions(home, hash, [
      { name: 'mcp__notion__search', description: 'x'.repeat(4800), input_schema: { type: 'object' } },
    ]);
    const result = runScript('capability-review.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NOW_MS: String(now),
      CCXRAY_CAPABILITY_COLS: '36',
      CCXRAY_CAPABILITY_ROWS: '18',
    });
    assert.equal(result.status, 0, result.stderr);
    const readable = result.stdout.replace(/\s+/g, ' ');
    assert.match(readable, /Experimental · observations, not outcome-backed recommendations/);
    assert.match(readable, /Confidence: derived estimate · outcome impact unknown/);
    assert.match(readable, /Next: collect at least 5 eligible sessions/);
    for (const line of result.stdout.trim().split('\n')) {
      assert.ok(line.length <= 35, `Capability Footprint line fits narrow pane: ${line}`);
    }

    const shortResult = runScript('capability-review.js', ['--once'], {
      CCXRAY_HOME: home,
      CCXRAY_HERDR_NOW_MS: String(now),
      CCXRAY_CAPABILITY_COLS: '36',
      CCXRAY_CAPABILITY_ROWS: '12',
    });
    assert.equal(shortResult.status, 0, shortResult.stderr);
    const shortLines = shortResult.stdout.trim().split('\n');
    assert.ok(shortLines.length <= 12, `Capability Footprint stays within 12 rows: ${shortLines.length}`);
    assert.match(shortLines.join(' '), /Next: collect at least 5 eligible sessions/);
    assert.match(shortLines.join(' '), /Up\/Down or j\/k move/);
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
    assert.match(result.stdout, /1 active panes · 0 attention · \+\$0\.32\/5m/);
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
    assert.match(result.stdout, /1 active panes · 0 attention · \+~\$0\.27\/5m/);
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

  // refresh-all-badges counts a child that exited 0 as refreshed. Exiting 0 when
  // `herdr pane report-metadata` failed makes the fan-out report "N refreshed"
  // while the sidebar still shows the previous badge.
  it('refresh-badges fails when the metadata write failed', () => {
    const herdr = makeRecordingHerdr({ status: 1 });
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([sampleEntry]),
      CCXRAY_HERDR_LAST: '9999d',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
    });
    assert.match(result.stdout, /Pane: w1:p1 \(/);
    assert.notEqual(result.status, 0, 'a failed metadata write must not be reported as success');
  });

  it('refresh-badges succeeds when the metadata write succeeded', () => {
    const herdr = makeRecordingHerdr();
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([sampleEntry]),
      CCXRAY_HERDR_LAST: '9999d',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
    });
    assert.equal(result.status, 0);
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

  it('notifies a background blocked pane once with an attention sound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-notify-event-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'args.log');
    const stateDir = path.join(dir, 'state');
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'test', result: { type: 'ok' } }) + '\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const eventEnv = {
      CCXRAY_HOME: makeHome([{ ...sampleEntry, agentId: 'herdr:w1:p7' }]),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1' }),
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane_agent_status_changed',
        data: { pane_id: 'w1:p7', workspace_id: 'w1', agent_status: 'blocked', agent: 'codex' },
      }),
      CCXRAY_BADGE_EVENT_DELAY_MS: '0',
    };
    const first = runScript('refresh-badges.js', [], eventEnv);
    const second = runScript('refresh-badges.js', [], eventEnv);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /Notification: codex needs attention/);
    assert.doesNotMatch(second.stdout, /Notification:/);
    const calls = fs.readFileSync(log, 'utf8');
    assert.equal((calls.match(/notification show codex needs attention/g) || []).length, 1);
    assert.match(calls, /--sound request/);
  });

  it('refresh-badges shows routed readiness without borrowing another session', () => {
    const unrelated = {
      ...sampleEntry,
      agentId: 'herdr:w1:p2',
      model: 'claude-opus-5',
      cost: { cost: 99 },
    };
    const sessionlessProbe = {
      ...sampleEntry,
      id: 'sessionless-probe',
      sessionId: null,
      agentId: 'herdr:w1:p9',
      model: null,
      cost: null,
    };
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([unrelated, sessionlessProbe]),
      HERDR_PANE_ID: 'w1:p9',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=ccxray: ready · send prompt/);
    assert.match(result.stdout, /ctx_band=unknown/);
    assert.match(result.stdout, /cost=n\/a/);
    assert.match(result.stdout, /turns=0/);
    assert.doesNotMatch(result.stdout, /opus-5|\$99/);
  });

  it('refresh-badges reports not linked when the pane has no routed telemetry', () => {
    const unrelated = { ...sampleEntry, agentId: 'herdr:w1:p2' };
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([unrelated]),
      HERDR_PANE_ID: 'w1:p9',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=ccxray: not linked/);
  });

  it('refresh-badges links by Herdr native session when hub attribution used an older pane', () => {
    const entry = {
      ...sampleEntry,
      sessionId: 'session-new',
      agentId: 'herdr:w1:p17',
      model: 'claude-opus-5',
    };
    const agents = [{
      pane_id: 'w1:p21', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', agent: 'claude',
      agent_session: { kind: 'id', value: 'session-new' },
    }];
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome([entry]),
      HERDR_PANE_ID: 'w1:p21',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_BIN_PATH: makeHerdr(agents),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=opus-5/);
    assert.match(result.stdout, /turns=1/);
    assert.doesNotMatch(result.stdout, /ccxray: not linked/);
  });

  it('refresh-badges prefers the pane native session over polluted exact agentId history', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'native-old',
        sessionId: 'session-old',
        agentId: 'herdr:w1:p17',
        model: 'claude-sonnet-5',
        receivedAt: now - 1000,
      },
      {
        ...sampleEntry,
        id: 'misattributed-new',
        sessionId: 'session-new',
        agentId: 'herdr:w1:p17',
        model: 'claude-opus-5',
        receivedAt: now,
      },
    ];
    const agents = [{
      pane_id: 'w1:p17', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', agent: 'claude',
      agent_session: { kind: 'id', value: 'session-old' },
    }];
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome(entries),
      HERDR_PANE_ID: 'w1:p17',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_BIN_PATH: makeHerdr(agents),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=sonnet-5/);
    assert.doesNotMatch(result.stdout, /summary=opus-5/);
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

  it('launch-agent can produce a stable new-tab plan without side effects', () => {
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
    assert.deepEqual(plan.open.slice(0, 4), ['tab', 'create', '--workspace', 'w1']);
    assert.ok(plan.open.includes('--focus'));
    assert.equal(plan.cwd, '/work/demo');
  });

  it('launch-agent refuses to start an agent inside the plugin checkout', () => {
    const context = {
      focused_pane_id: 'w1:p1',
      focused_pane_cwd: path.join(PLUGIN, 'bin'),
      workspace_id: 'w1',
      tab_id: 'w1:t1',
    };
    const result = runScript('launch-agent.js', ['codex', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
      HERDR_BIN_PATH: makeHerdr([]),
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /No project directory for this workspace/);
    assert.doesNotMatch(result.stdout, /plugins[/\\]herdr/);
  });

  // `herdr pane run` timing out is not the same as failing: herdr may already
  // have started the command. Forgetting the routed record on an unknown outcome
  // is the harmful choice — if the pane did start, its badge never recognises it.
  it('launch-agent keeps the routed record when pane run times out', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-routed-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-slowrun-'));
    const bin = path.join(dir, 'herdr');
    const opened = JSON.stringify({ id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p7' }, tab: { tab_id: 'w1:t2' } } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      // `pane run` answers far slower than launch-agent's 3s budget, then succeeds.
      "if (process.argv[2] === 'pane' && process.argv[3] === 'run') {",
      '  const until = Date.now() + 6000; while (Date.now() < until) {}',
      "  process.stdout.write('{}\\n'); process.exit(0);",
      '}',
      `process.stdout.write(${JSON.stringify(opened + '\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
    });
    const routed = path.join(stateDir, 'routed-panes-v1', `${encodeURIComponent('w1:p7')}.json`);
    assert.ok(fs.existsSync(routed), 'an unconfirmed launch must stay routed, not be forgotten');
    assert.match(result.stderr, /could not confirm/i);
  });

  it('launch-agent forgets the routed record when pane run genuinely fails', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-routed-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-failrun-'));
    const bin = path.join(dir, 'herdr');
    const opened = JSON.stringify({ id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p8' }, tab: { tab_id: 'w1:t2' } } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'pane' && process.argv[3] === 'run') {",
      "  process.stderr.write('no such pane\\n'); process.exit(1);",
      '}',
      `process.stdout.write(${JSON.stringify(opened + '\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
    });
    const routed = path.join(stateDir, 'routed-panes-v1', `${encodeURIComponent('w1:p8')}.json`);
    assert.equal(fs.existsSync(routed), false, 'a refused launch must not stay routed');
    assert.equal(result.status, 1);
  });

  it('launch-agent recovers the workspace directory when the caller sits in the plugin', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-panes-'));
    const bin = path.join(dir, 'herdr');
    const panes = JSON.stringify({
      id: 'test',
      result: { type: 'pane_list', panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: project }] },
    });
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(panes)} + '\\n');\n`);
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p2',
        focused_pane_cwd: PLUGIN,
        workspace_id: 'w1',
        tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).cwd, project);
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

  it('run-node recovers when node is an inactive mise shim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-node-'));
    const target = path.join(dir, 'target.js');
    fs.writeFileSync(target, 'process.stdout.write("NODE_FALLBACK_OK")\n');
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexit 1\n');
    fs.writeFileSync(path.join(dir, 'mise'), [
      '#!/bin/sh',
      'if [ "$1" = "latest" ]; then printf "%s\\n" "22.22.2"; exit 0; fi',
      'if [ "$1" = "exec" ]; then',
      '  shift; shift; shift; shift',
      `  exec ${JSON.stringify(process.execPath)} "$@"`,
      'fi',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(dir, 'node'), 0o755);
    fs.chmodSync(path.join(dir, 'mise'), 0o755);

    const result = spawnSync(path.join(PLUGIN, 'bin', 'run-node.sh'), [target], {
      cwd: PLUGIN,
      env: pluginEnv({ PATH: dir, CCXRAY_NODE: '' }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'NODE_FALLBACK_OK');
  });

  it('run-node finds an installed mise Node when a Herdr pane has a minimal PATH', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-minimal-path-'));
    const bin = path.join(home, '.local', 'share', 'mise', 'installs', 'node', '22.22.2', 'bin');
    const target = path.join(home, 'target.js');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(target, 'process.stdout.write("MINIMAL_PATH_OK")\n');
    fs.writeFileSync(path.join(bin, 'node'), [
      '#!/bin/sh',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'node'), 0o755);

    const result = spawnSync(path.join(PLUGIN, 'bin', 'run-node.sh'), [target], {
      cwd: PLUGIN,
      env: pluginEnv({
        HOME: home,
        PATH: '/usr/bin:/bin',
        CCXRAY_NODE: '',
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'MINIMAL_PATH_OK');
  });

  it('dependency install recovers when npm is an inactive mise shim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-npm-'));
    const log = path.join(dir, 'mise-args.log');
    fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\nexit 1\n');
    fs.writeFileSync(path.join(dir, 'mise'), [
      '#!/bin/sh',
      'if [ "$1" = "latest" ]; then printf "%s\\n" "22.22.2"; exit 0; fi',
      `printf '%s\\n' "$*" > ${JSON.stringify(log)}`,
      'exit 0',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(dir, 'npm'), 0o755);
    fs.chmodSync(path.join(dir, 'mise'), 0o755);

    const result = spawnSync('/bin/sh', [path.join(PLUGIN, 'bin', 'install-dependencies.sh')], {
      cwd: PLUGIN,
      env: pluginEnv({
        PATH: `${dir}:/usr/bin:/bin`,
        CCXRAY_NODE: '',
        CCXRAY_NPM: '',
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const args = fs.readFileSync(log, 'utf8');
    assert.equal(
      args.trim(),
      `exec node@22.22.2 -- npm ci --omit=dev --ignore-scripts --prefix ${ROOT}`,
    );
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

  // remove-sidebar-summary restores its backup when `herdr config check` rejects
  // the result; install did not, so a rejected merge left the user's own herdr
  // config in the broken state and only printed where the backup was.
  it('install-sidebar-summary restores the config when herdr rejects it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-badcheck-'));
    const configPath = path.join(dir, 'config.toml');
    const original = '[ui]\nshow_agent_labels_on_pane_borders = true\n';
    fs.writeFileSync(configPath, original);
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'config' && process.argv[3] === 'check') {",
      "  process.stderr.write('invalid table\\n'); process.exit(1);",
      '}',
      "process.stdout.write('{}\\n');",
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('install-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: configPath,
      HERDR_BIN_PATH: bin,
    });
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original,
      "a rejected merge must not leave the user's config rewritten");
    assert.match(result.stderr, /restored/i);
  });

  it('uses XDG_CONFIG_HOME consistently for sidebar detection and installation', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-home-'));
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-xdg-'));
    const configPath = path.join(xdg, 'herdr', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    };

    const install = runScript('install-sidebar-summary.js', [], env);
    assert.equal(install.status, 0, install.stderr);
    assert.match(fs.readFileSync(configPath, 'utf8'), /\$summary/);
    assert.equal(fs.existsSync(path.join(home, '.config', 'herdr', 'config.toml')), false);

    const quickStart = runScript('onboarding.js', ['--once'], {
      ...env,
      CCXRAY_ONBOARDING_PROVIDERS: '',
    });
    assert.equal(quickStart.status, 0, quickStart.stderr);
    assert.match(quickStart.stdout, /sidebar\s+READY · installed/);
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

  it('install-sidebar-summary adds its rows to a sidebar table the user already has', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[ui.sidebar.agents]',
      'row_gap = 0',
      'rows = [',
      '  ["state_icon", "workspace", "tab"],',
      '  ["agent"],',
      ']',
      '',
      '[terminal]',
      'new_cwd = "follow"',
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
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    assert.match(config, /\["state_icon", "workspace", "tab"\]/);
    assert.match(config, /\["agent"\]/);
    assert.match(config, /\[terminal\]/);
    assert.equal(config.match(/\[ui\.sidebar\.agents\]/g).length, 1);
  });

  it('sidebar summary survives a remove and install round trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
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
    ].join('\n'));
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };

    const removed = runScript('remove-sidebar-summary.js', [], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /\$summary/);

    const reinstalled = runScript('install-sidebar-summary.js', [], env);
    assert.equal(reinstalled.status, 0, reinstalled.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\$summary/);
    assert.match(config, /\$ctx_bar_red/);
    assert.match(config, /\["agent"\]/);
    assert.equal(config.match(/\$summary/g).length, 1);
  });

  it('remove-sidebar-summary drops the whole table when the plugin created it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };

    assert.equal(runScript('install-sidebar-summary.js', [], env).status, 0);
    assert.match(fs.readFileSync(configPath, 'utf8'), /\[ui\.sidebar\.agents\]/);

    const removed = runScript('remove-sidebar-summary.js', [], env);
    assert.equal(removed.status, 0, removed.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.doesNotMatch(config, /\[ui\.sidebar\.agents\]/);
    assert.doesNotMatch(config, /ccxray sidebar summary rows/);
    assert.match(config, /show_agent_labels_on_pane_borders = true/);
  });

  it('remove-sidebar-summary keeps a table the user extended', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    assert.equal(runScript('install-sidebar-summary.js', [], env).status, 0);

    const extended = fs.readFileSync(configPath, 'utf8')
      .replace('  ["agent"],', '  ["agent"],\n  ["cwd"],');
    fs.writeFileSync(configPath, extended);

    assert.equal(runScript('remove-sidebar-summary.js', [], env).status, 0);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\[ui\.sidebar\.agents\]/);
    assert.match(config, /\["cwd"\]/);
    assert.doesNotMatch(config, /\$summary/);
  });

  it('can be validated by Herdr CLI when Herdr is installed', () => {
    const herdr = spawnSync('herdr', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (herdr.error && herdr.error.code === 'ENOENT') return;
    assert.equal(herdr.status, 0, herdr.stderr);

    const out = execFileSync('herdr', ['plugin', 'link', '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.match(out, /Link a local plugin/);
  });
});
