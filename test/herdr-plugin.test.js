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
    // PROXY_PORT joined the plugin's env surface in #555 (the launch port
    // escape hatch): an ambient value would silently retarget every spawn.
    //
    // ANTHROPIC_CUSTOM_HEADERS joined it in #575 (native launch with header
    // identity). It leaks where ANTHROPIC_BASE_URL does not, and the difference
    // is the merge: launchEnvVars OVERWRITES the base url but deliberately
    // PREPENDS the user's existing headers (lib/ccxray.js, "the user's own value
    // is PREPENDED rather than replaced"), so a developer whose own shell was
    // launched by this plugin hands every spawned launch-agent a header to
    // prepend. The exact-equality assertion in 'launch-agent stamps the
    // workspace id into the pane identity header' then sees three headers. It
    // shipped green because it only fails for that developer. Rule for the next
    // variable: an overwritten one is safe here, a merged one is not.
    if (key.startsWith('HERDR_')
      || key.startsWith('CCXRAY_')
      || key === 'PROXY_PORT'
      || key === 'ANTHROPIC_CUSTOM_HEADERS') continue;
    env[key] = value;
  }
  // Load budget: the plugin's CLI calls have deliberately tight per-call
  // budgets (1200ms / 1500ms) that a mock can miss when `node --test` saturates
  // the machine. A missed budget does not report as a timeout — it degrades a
  // value and fails an unrelated assertion in another suite, which is how two
  // tests in this file flaked for weeks. Same remedy as #542's launcher budget.
  // 10s: comfortably above any load spike, and below runScript's own 15s kill
  // so a genuinely hung mock still fails as a spawn timeout rather than hanging.
  env.CCXRAY_HERDR_CMD_TIMEOUT_MS = '10000';
  env.CCXRAY_HOME = isolatedHome();
  // Spawn-layer twin of the NO_TRANSCRIPTS rule below: a spawned script's own
  // sessionSummaryDetails call sees the child's env, where an unset
  // CCXRAY_IMPORT_HOMES means the developer's real $HOME/.claude*/projects.
  env.CCXRAY_IMPORT_HOMES = NO_TRANSCRIPTS;
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

function paneAlertFor(detail) {
  const { paneAlert } = require('../plugins/herdr/bin/lib/ccxray');
  return paneAlert({
    hasTelemetry: true,
    refusedCount: detail.refusedCount,
    staleText: detail.stale?.text,
    failures: detail.failures,
    cacheDropped: detail.cacheDropped,
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

// ISOLATION: sessionSummaryDetails now consults the Claude transcript tree to
// decide staleness, and server/importer.js's rule is that an unset
// CCXRAY_IMPORT_HOMES means $HOME/.claude*/projects — the developer's real one.
// Measured: one unisolated call statted 7 real paths. It "passed" only because no
// real transcript is named s1.jsonl, which is the #407 shape (a leak that passes
// because the real data happens to be empty). Every sessionSummaryDetails call
// pins this empty root unless it is deliberately providing a transcript.
// See docs/testing.md and docs/decisions/0015-cost-worker-lifecycle-drain-exit.md R4.
const NO_TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-no-transcripts-'));
process.on('exit', () => { try { fs.rmSync(NO_TRANSCRIPTS, { recursive: true, force: true }); } catch {} });

function writeToolDefinitions(home, hash, tools, prefix = 'tools_') {
  const shared = path.join(home, 'logs', 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, `${prefix}${hash}.json`), JSON.stringify(tools));
}

// A mock `herdr` that starts in ~5ms instead of ~150ms+.
//
// `#!/usr/bin/env node` mocks are spawned INSIDE runHerdr's timeout budget
// (herdrAgentReport uses 1500ms), and a cold Node startup on a loaded machine
// can exceed it. The timeout does not surface as a timeout: herdrOk flips to
// false, or currentWorkspaceScope falls back to the plugin cwd, and the failure
// appears as an unrelated string/path assertion in a different suite. Two tests
// in this file were flaky for exactly that reason — always on the first run
// after files changed on disk, never in isolation.
//
// The remaining `#!/usr/bin/env node` mocks in this file carry real logic
// (argv logging, timers, exit codes); convert them the same way if they start
// flaking.
function writeShMock(bin, stdout) {
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'CCXRAY_MOCK_EOF'\n${stdout}\nCCXRAY_MOCK_EOF\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeHerdr(agents = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-bin-'));
  const bin = path.join(dir, 'herdr');
  const response = JSON.stringify({ id: 'test', result: { type: 'agent_list', agents } });
  return writeShMock(bin, response);
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

  it('opens panes as tabs by default (overlay requires a pane entrypoint, not an action)', () => {
    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    assert.match(manifest, /id = "onboarding"[\s\S]*?placement = "tab"/);
    assert.match(manifest, /id = "mission-control"[\s\S]*?placement = "tab"/);
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
    assert.equal(moveSelection(items, 'launch-codex', 1), 'keybindings');
    assert.equal(moveSelection(items, 'keybindings', -1), 'launch-codex');
    assert.equal(items.find(item => item.key === 'M').enabled, false);
    assert.equal(items.find(item => item.key === 'S').detail, 'installed · Enter remove');
    // A state built without a keys snapshot must still render.
    assert.equal(items.find(item => item.key === 'B').detail, 'not bound · Enter install');
  });

  // Whether a key reaches ccxray is state the user cannot see anywhere else:
  // Herdr's manifest cannot declare keybindings, so an uninstalled binding is
  // indistinguishable from a broken one until the row says which.
  it('Quick Start shows the bound key and offers the reverse action', () => {
    const { menuItems } = require('../plugins/herdr/bin/onboarding');
    const base = {
      ccxrayReady: true,
      hubRunning: true,
      sessions: 3,
      sidebar: true,
      providers: [{ id: 'claude', label: 'Claude', key: '1', available: true }],
    };
    const unbound = menuItems({ ...base, keys: { mission: null, quickStart: null, any: false } });
    assert.equal(unbound.find(item => item.key === 'B').detail, 'not bound · Enter install');
    assert.equal(unbound.find(item => item.key === 'M').detail, 'live attention');

    const bound = menuItems({
      ...base,
      keys: { mission: 'prefix+m', quickStart: 'prefix+shift+m', any: true },
    });
    assert.equal(bound.find(item => item.key === 'B').detail, 'prefix+m / prefix+shift+m · Enter remove');
    assert.equal(bound.find(item => item.key === 'M').detail, 'live attention · prefix+m');
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
    writeShMock(bin, JSON.stringify(response));

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
      env: { ...env, CCXRAY_HOME: makeHome(), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
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
      env: { CCXRAY_HOME: makeHome([mainTurn, backgroundTurn]), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
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
      env: { CCXRAY_HOME: makeHome([main, background]), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
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
      env: { CCXRAY_HOME: makeHome(imported), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
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
      env: { CCXRAY_HOME: makeHome(turns), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
      sessionId: 's3',
      nowMs: T + 7000,
      sidebarCols: 32,
    });
    assert.equal(detail.failures, 0, 'no turn failed; the badge must not claim one did');
    // Asserted on the raw count, not row 2's tail: row 3 owns alerts now, so
    // `doesNotMatch(ctxBar, /fail/)` would hold for every input and protect
    // nothing. paneAlert is the channel a failure actually reaches.
    assert.equal(paneAlertFor(detail), null);
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
      env: { CCXRAY_HOME: makeHome(turns), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
      sessionId: 's4',
      nowMs: T + 7000,
      sidebarCols: 32,
    });
    assert.equal(detail.failures, 2);
    assert.equal(paneAlertFor(detail).text, 'fail 2x');
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
      env: { CCXRAY_HOME: makeHome(entries), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
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
      env: { CCXRAY_HOME: makeHome(entries), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
      paneId: 'w1:p5',
      nowMs: T + 1000,
    });
    assert.equal(detail.sessionId, 'orphan-1');
    assert.equal(Math.round(detail.ctxPct), 40);
  });
});

// The badge's model label read a PLURALITY over the session's main turns while
// ctx% and cache% next to it read the latest main turn. So `/model sonnet` did
// not change the label until the new model out-counted the old one. Measured on
// the real 4 MiB badge window (23 sessions, 2026-08-19): the flip needs a median
// of 41 further turns, p90 132, worst 400 — not the "one idle cycle" the symptom
// report assumed. Owner decision (2026-08-19): the label reports the latest main
// turn, matching the fields it sits beside.
describe('Quick Start honours the documented placement', () => {
  // The README said CCXRAY_HERDR_PANE_PLACEMENT applied to Quick Start, Mission
  // Control and Capability Footprint. The other two passed it; Quick Start did
  // not, so the manifest's `placement = "tab"` always won and the env var
  // silently did nothing there.
  it('passes the placement, defaulting to tab', () => {
    const { openArgs } = require('../plugins/herdr/bin/open-onboarding.js');
    const dflt = openArgs(pluginEnv({ HERDR_WORKSPACE_ID: 'w1' }));
    assert.ok(dflt.includes('--placement'), 'placement must be passed at all');
    assert.equal(dflt[dflt.indexOf('--placement') + 1], 'tab', 'default unchanged');

    const overlay = openArgs(pluginEnv({
      HERDR_WORKSPACE_ID: 'w1', CCXRAY_HERDR_PANE_PLACEMENT: 'overlay',
    }));
    assert.equal(overlay[overlay.indexOf('--placement') + 1], 'overlay');
  });

  // Requiring this module used to run main() — which opened a real pane, and
  // meant openArgs could not be tested at all. ADR 0015's two-mode shape.
  //
  // The fake MUST be wired into the ambient env: `main()` resolves its binary
  // from `process.env.HERDR_BIN_PATH`, so a version of this test that only
  // built a fake and checked its log could not fail — a regression that ran
  // main() would invoke the REAL herdr (and write real plugin state) while the
  // untouched fake log kept the assertion green.
  it('is side-effect free when imported', () => {
    const herdr = makeRecordingHerdr();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-state-'));
    withAmbientEnv({
      HERDR_ENV: '1',
      HERDR_BIN_PATH: herdr.bin,
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: stateDir }),
      CCXRAY_HOME: isolatedHome(),
    }, () => {
      delete require.cache[require.resolve('../plugins/herdr/bin/open-onboarding.js')];
      require('../plugins/herdr/bin/open-onboarding.js');
    });
    assert.equal(fs.existsSync(herdr.log), false, 'import must not invoke herdr');
    assert.deepEqual(fs.readdirSync(stateDir), [], 'import must not write plugin state');
  });
});

describe('codex round 1 fixes', () => {
  const turn = (i, cost, ts) => ({
    id: `cx${i}`, sessionId: 's-cx', provider: 'anthropic', cwd: '/work/cx',
    agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
    model: 'claude-opus-5', receivedAt: ts, maxContext: 200000,
    usage: { input_tokens: 1000, output_tokens: 10 },
    cost: { cost, confidence: 'exact' }, responseId: `msg_cx${i}`,
  });
  const badgeFor = home => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    return sessionSummaryDetails({}, {
      env: pluginEnv({
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
        CCXRAY_HERDR_NOW_MS: '1787000900000',
      }),
      paneId: 'w1:p1', cwd: '/work/cx',
    });
  };

  // An aggregate row with no usable flush cursor must not be topped up: `|| 0`
  // made every tail turn look post-flush, so its cost was ADDED to a total that
  // already counted it — doubling the number rather than merely lagging it.
  it('does not top up an aggregate that has no flush cursor', () => {
    const home = makeHome([turn(1, 1, 1787000001000), turn(2, 1, 1787000002000)]);
    fs.writeFileSync(path.join(home, 'logs', 'sessions.json'), JSON.stringify({
      sid: 's-cx', count: 10, totalCost: 10,
      fallbackCost: 0, fallbackCount: 0, unknownCount: 0,
      firstReceivedAt: 1787000000000, // lastReceivedAt deliberately absent
    }) + '\n');
    const badge = badgeFor(home);
    assert.equal(badge.turns, 10, 'aggregate alone');
    assert.equal(badge.costText, '$10.00', 'not $12.00');
  });

  // A post-flush turn used to show its cost and count while the elapsed time
  // stayed frozen at the last flush.
  it('extends the duration with post-flush turns', () => {
    const t0 = 1787000000000;
    const home = makeHome([turn(1, 1, t0 + 3 * 3600 * 1000)]);
    fs.writeFileSync(path.join(home, 'logs', 'sessions.json'), JSON.stringify({
      sid: 's-cx', count: 1, totalCost: 1,
      fallbackCost: 0, fallbackCount: 0, unknownCount: 0,
      firstReceivedAt: t0, lastReceivedAt: t0 + 3600 * 1000,
    }) + '\n');
    assert.equal(badgeFor(home).ageText, '3.0h', 'not the 1h the flush knew about');
  });

  // `ccxray status` reads a CCXRAY_HOME-keyed lockfile, so a hub on 5577 is
  // reported even when PROXY_PORT names 5600 — returning it would route the
  // agent to the port the user deliberately moved away from.
  it('ensureProxy refuses a discovered port that is not the requested one', () => {
    const { ensureProxy } = require('../plugins/herdr/bin/lib/ccxray');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-port-'));
    const fake = path.join(dir, 'ccxray');
    // Always reports a hub on 5577, and never becomes ready on 5600.
    fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "status" ]; then echo "Hub: http://localhost:5577 (pid 1, uptime 1s, v1)"; exit 0; fi\nexit 0\n');
    fs.chmodSync(fake, 0o755);
    const port = ensureProxy({
      env: pluginEnv({ CCXRAY_BIN: fake, PROXY_PORT: '5600' }),
      cwd: dir,
    });
    assert.notEqual(port, 5577, 'must not hand back the port PROXY_PORT moved away from');
    // `notEqual` alone also passes for a broken implementation that returns the
    // dead 5600 it never reached. This fake never becomes ready there, so the
    // only honest answer is "no port" — the caller must be told to fail rather
    // than routing the agent at an unavailable proxy.
    assert.equal(port, null, 'an unreachable requested port must resolve to null');
  });

  // Skipping identical writes cannot be unconditional when the write carries a
  // TTL: Herdr drops the tokens when it lapses, so the badge would VANISH while
  // the agent is still working.
  it('re-writes identical tokens once past half the TTL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ttl-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    const pane = JSON.stringify({ result: { pane: { pane_id: 'w1:p1', tokens: { ctx: '9%' }, state_labels: {}, scroll: {} } } });
    fs.writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'if [ "$2" = "get" ]; then', "cat <<'P_EOF'", pane, 'P_EOF', 'exit 0', 'fi',
      "echo '{\"result\":{\"ok\":true}}'",
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ttl-state-'));
    const env = pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin, HERDR_PLUGIN_STATE_DIR: state });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    const writes = () => fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('report-metadata')).length;

    // No record of a previous write → must write, even though tokens match.
    reportPaneTokens({ ctx: '9%' }, { env, ttlMs: 60000 });
    assert.equal(writes(), 1, 'no prior write recorded means write');
    // Immediately after, the TTL is fresh → skip.
    const again = reportPaneTokens({ ctx: '9%' }, { env, ttlMs: 60000 });
    assert.equal(again.skipped, 'unchanged');
    assert.equal(writes(), 1);
    // Age the record past half the TTL → write again.
    const rec = path.join(state, 'pane-write-v1', `${encodeURIComponent('w1:p1')}.json`);
    fs.writeFileSync(rec, JSON.stringify({ at: Date.now() - 45000 }) + '\n');
    reportPaneTokens({ ctx: '9%' }, { env, ttlMs: 60000 });
    assert.equal(writes(), 2, 'past half the TTL the pane must be refreshed');
  });
});

describe('Herdr badge time is the session duration', () => {
  // `now - first turn` (how long ago it started) and `last - first` (how long it
  // ran) differ by however long the session has been idle, and both printed as a
  // bare `9.9h` / `2.2h`. Measured on a real session: 9.9h vs 2.2h for the same
  // pane, which read as the badge disagreeing with the dashboard rather than as
  // two different quantities.
  it('reports how long the session ran, not how long ago it started', () => {
    const t0 = 1787000000000;
    const home = makeHome([{
      id: 'dur1', sessionId: 's-dur', provider: 'anthropic', cwd: '/work/dur',
      agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
      model: 'claude-opus-5', receivedAt: t0, maxContext: 200000,
      usage: { input_tokens: 1000, output_tokens: 10 },
      cost: { cost: 1, confidence: 'exact' }, responseId: 'msg_dur1',
    }]);
    // ran 2h, but started 10h ago
    fs.writeFileSync(path.join(home, 'logs', 'sessions.json'), JSON.stringify({
      sid: 's-dur', count: 5, totalCost: 5,
      fallbackCost: 0, fallbackCount: 0, unknownCount: 0,
      firstReceivedAt: t0, lastReceivedAt: t0 + 2 * 3600 * 1000,
    }) + '\n');
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const badge = sessionSummaryDetails({}, {
      env: pluginEnv({
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
        CCXRAY_HERDR_NOW_MS: String(t0 + 10 * 3600 * 1000),
      }),
      paneId: 'w1:p1', cwd: '/work/dur',
    });
    assert.equal(badge.ageText, '2.0h', 'the duration, not the 10h since it started');
  });
});

describe('ccxray status carries a machine-readable line', () => {
  // Two plugin sites used to decide "is a proxy usable" by regexing an English
  // sentence. The line is OPTIONAL by design — a globally installed `ccxray`
  // can be older than it — so both the parse and the text fallback are pinned.
  it('parseStatus surfaces the Machine line and prefers it', () => {
    const { parseStatus } = require('../plugins/herdr/bin/lib/ccxray');
    const withMachine = parseStatus([
      'No hub running.',
      'Note: port 5577 is held by a standalone (non-hub) ccxray (pid 1), so it cannot be shared as a hub.',
      'Machine: {"proxy":true,"hub":false,"port":5601,"occupant":"ccxray-standalone"}',
    ].join('\n'));
    assert.equal(withMachine.machine.proxy, true);
    // 5601 comes only from the Machine line; the prose says 5577. Proving which
    // one wins is the point of the test.
    assert.equal(withMachine.machine.port, 5601);

    const legacy = parseStatus([
      'No hub running.',
      'Note: port 5577 is held by a standalone (non-hub) ccxray (pid 1), so it cannot be shared as a hub.',
    ].join('\n'));
    assert.equal(legacy.machine, null, 'an older ccxray still parses');
    assert.ok(legacy.notes.length, 'and the text fallback survives');
  });

  it('a malformed Machine line does not throw or poison the parse', () => {
    const { parseStatus } = require('../plugins/herdr/bin/lib/ccxray');
    const parsed = parseStatus('No hub running.\nMachine: not-json\n');
    assert.equal(parsed.machine, null);
  });
});

describe('Herdr pane writes skip when nothing changed', () => {
  // Writing pane metadata makes Herdr re-publish it, and a full-screen agent
  // TUI repaints when it does. `pane.agent_status_changed` fires twice per turn,
  // and the recomputed tokens are usually identical, so an unconditional write
  // charges the user a repaint twice per prompt for no new information.
  const makeHerdrPane = (tokens, stateLabels = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-pane-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    const pane = JSON.stringify({
      id: 'cli:pane:get',
      result: { pane: { pane_id: 'w1:p1', tokens, state_labels: stateLabels, scroll: {} } },
    });
    // sh, not node: this is spawned inside runCommand's budget (see writeShMock).
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'if [ "$2" = "get" ]; then',
      "cat <<'CCXRAY_PANE_EOF'",
      pane,
      'CCXRAY_PANE_EOF',
      '  exit 0',
      'fi',
      'echo \'{"result":{"ok":true}}\'',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log };
  };
  const writes = log => (fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('report-metadata')).length
    : 0);

  it('does not write when every token and state label already matches', () => {
    const { bin, log } = makeHerdrPane({ ctx: '32%', cost: '$1.00' }, { idle: 'x' });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    const res = reportPaneTokens({ ctx: '32%', cost: '$1.00' }, {
      env: pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin }),
      stateLabels: { idle: 'x' },
    });
    assert.equal(res.skipped, 'unchanged');
    assert.equal(writes(log), 0, 'an identical payload must not reach report-metadata');
  });

  it('writes when a single token moved', () => {
    const { bin, log } = makeHerdrPane({ ctx: '32%', cost: '$1.00' });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    reportPaneTokens({ ctx: '33%', cost: '$1.00' }, {
      env: pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin }),
    });
    assert.equal(writes(log), 1);
  });

  it('writes when a token that should be cleared is still present', () => {
    const { bin, log } = makeHerdrPane({ ctx: '32%', stale: 'yes' });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    reportPaneTokens({ ctx: '32%' }, {
      env: pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin }),
      clearTokens: ['stale'],
    });
    assert.equal(writes(log), 1, 'a pending clear is a change');
  });

  it('writes when the pane state cannot be read — a failed read must not suppress an update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-pane-bad-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$2" = "get" ]; then exit 1; fi\necho '{"result":{"ok":true}}'\n`);
    fs.chmodSync(bin, 0o755);
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    reportPaneTokens({ ctx: '32%' }, {
      env: pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin }),
    });
    assert.equal(writes(log), 1);
  });

  it('force skips the comparison entirely', () => {
    const { bin, log } = makeHerdrPane({ ctx: '32%' });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    reportPaneTokens({ ctx: '32%' }, {
      env: pluginEnv({ HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin }),
      force: true,
    });
    assert.equal(writes(log), 1);
    assert.equal(fs.readFileSync(log, 'utf8').includes('pane get'), false,
      'force must not even read the pane');
  });
});

describe('Herdr badge totals come from the hub aggregate', () => {
  // The badge reads a 4 MiB tail of an index that is currently 338 MiB, so its
  // own sum is a SAMPLE and disagrees with the dashboard even when perfectly
  // deduped (measured: 135 of 156 responses, $23.63 of $26.27). sessions.json
  // carries the hub's per-session count, total and ADR 0017 fold, so reading it
  // makes the two surfaces agree by construction. ADR 0019 permits a non-hub
  // process to READ a derived view; it must never write one.
  const writeAggregate = (home, row) => {
    fs.writeFileSync(path.join(home, 'logs', 'sessions.json'), JSON.stringify(row) + '\n');
  };
  const turn = (i, cost, ts) => ({
    id: `agg${i}`, sessionId: 's-agg-hub', provider: 'anthropic', cwd: '/work/agghub',
    agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
    model: 'claude-opus-5', receivedAt: ts, maxContext: 200000,
    usage: { input_tokens: 1000, output_tokens: 10 },
    cost: { cost, confidence: 'exact' }, responseId: `msg_agg${i}`,
  });
  const badgeFor = home => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    return sessionSummaryDetails({}, {
      env: pluginEnv({
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
        CCXRAY_HERDR_NOW_MS: '1787000900000',
      }),
      paneId: 'w1:p1', cwd: '/work/agghub',
    });
  };

  it('reports the hub total, not the truncated window sum', () => {
    // The window holds 2 turns worth $2; the hub knows the session is 157/$26.27.
    const home = makeHome([turn(1, 1, 1787000001000), turn(2, 1, 1787000002000)]);
    writeAggregate(home, {
      sid: 's-agg-hub', count: 157, totalCost: 26.27,
      fallbackCost: 0, fallbackCount: 0, unknownCount: 0,
      lastReceivedAt: 1787000002000, firstReceivedAt: 1787000000000,
    });
    const badge = badgeFor(home);
    assert.equal(badge.turns, 157, 'turn count comes from the aggregate');
    assert.equal(badge.costText, '$26.27', 'so does the total');
  });

  it('adds turns newer than the last flush so a live session is not stuck', () => {
    const home = makeHome([
      turn(1, 1, 1787000001000),          // already folded
      turn(2, 5, 1787000009000),          // arrived after the flush
    ]);
    writeAggregate(home, {
      sid: 's-agg-hub', count: 10, totalCost: 10,
      fallbackCost: 0, fallbackCount: 0, unknownCount: 0,
      lastReceivedAt: 1787000005000, firstReceivedAt: 1787000000000,
    });
    const badge = badgeFor(home);
    assert.equal(badge.turns, 11, '10 folded + 1 post-flush');
    assert.equal(badge.costText, '$15.00', '$10 folded + $5 post-flush');
  });

  it('falls back to the window when the session has no aggregate yet', () => {
    const home = makeHome([turn(1, 1, 1787000001000), turn(2, 1, 1787000002000)]);
    writeAggregate(home, { sid: 'some-other-session', count: 99, totalCost: 99 });
    const badge = badgeFor(home);
    assert.equal(badge.turns, 2, 'a brand-new session still renders from the window');
    assert.equal(badge.costText, '$2.00');
  });
});

describe('Herdr badge dedups by responseId', () => {
  // The same logical response lands as several index lines (ADR 0012), so a raw
  // sum inflates cost and the turn count together. Mission Control already
  // deduped (it goes through filterEntriesToWorkspace); the badge read the index
  // directly and did not, so the two surfaces disagreed on the same session
  // while ctx% matched — ctx% reads ONE latest turn, not a sum, which is what
  // made a double count look like a rendering quirk. Measured on real session
  // 9ea7a6d4: 297 lines / $46.35 raw vs 156 / $26.27 deduped.
  it('counts one turn and one cost per responseId', () => {
    const line = (i, rid, cost) => ({
      id: `d${i}`, sessionId: 's-dedup', provider: 'anthropic', cwd: '/work/dedup',
      agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
      model: 'claude-opus-5', receivedAt: 1787000000000 + i * 1000, maxContext: 200000,
      usage: { input_tokens: 1000, output_tokens: 10 },
      cost: { cost, confidence: 'exact' }, responseId: rid,
    });
    // three logical responses, each written twice
    const home = makeHome([
      line(1, 'msg_a', 1), line(2, 'msg_a', 1),
      line(3, 'msg_b', 1), line(4, 'msg_b', 1),
      line(5, 'msg_c', 1), line(6, 'msg_c', 1),
    ]);
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const badge = sessionSummaryDetails({}, {
      env: pluginEnv({
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
        CCXRAY_HERDR_NOW_MS: '1787000900000',
      }),
      paneId: 'w1:p1', cwd: '/work/dedup',
    });
    assert.equal(badge.turns, 3, 'six lines carrying three responseIds are three turns');
    assert.equal(badge.costText, '$3.00', 'and three dollars, not six');
  });
});

describe('Herdr aggregate cost confidence (ADR 0017)', () => {
  const costTurn = (i, confidence, cost) => ({
    id: `c${i}`, sessionId: 's-agg', provider: 'anthropic', cwd: '/work/agg',
    agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
    model: 'claude-opus-5', receivedAt: 1787000000000 + i * 1000, maxContext: 200000,
    usage: { input_tokens: 1000, output_tokens: 10 },
    cost: { cost, confidence }, responseId: `msg_c${i}`,
  });
  const badgeFor = turns => {
    const home = makeHome(turns);
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    return sessionSummaryDetails({}, {
      // CCXRAY_IMPORT_HOMES is pinned explicitly even though pluginEnv() already
      // sets it: the audit below is a TEXTUAL check on this call site, and the
      // convention it enforces is worth more than the redundancy it costs.
      env: pluginEnv({
        CCXRAY_HOME: home,
        CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
        CCXRAY_HERDR_NOW_MS: '1787000900000',
      }),
      paneId: 'w1:p1', cwd: '/work/agg',
    });
  };

  // The rejected alternative marked ANY non-exact total `~`. On a lightly
  // contaminated total that overstates by ~357x, which is why ADR 0017 gates on
  // share instead. One fallback turn in 20 is 5% — below both thresholds.
  it('leaves a lightly contaminated total unmarked', () => {
    const turns = [costTurn(1, 'fallback', 0.1)];
    for (let i = 2; i <= 20; i += 1) turns.push(costTurn(i, 'exact', 0.1));
    assert.equal(badgeFor(turns).costText, '$2.00');
  });

  it('marks at the 10% share threshold and degrades precision past 50%', () => {
    const marked = [costTurn(1, 'fallback', 0.1)];
    for (let i = 2; i <= 10; i += 1) marked.push(costTurn(i, 'exact', 0.1));
    assert.equal(badgeFor(marked).costText, '~$1.00', '10% of count marks');

    const degraded = [];
    for (let i = 1; i <= 9; i += 1) degraded.push(costTurn(i, 'fallback', 2));
    degraded.push(costTurn(10, 'exact', 2));
    // 18/20 of cost is fabricated: the displayed digits must not outrun the
    // known digits, so the total renders to two significant figures.
    assert.equal(badgeFor(degraded).costText, '~$20');
  });

  it('suffixes + when unpriced turns are excluded, and — when nothing is priced', () => {
    const partial = [costTurn(1, 'unknown', null)];
    for (let i = 2; i <= 10; i += 1) partial.push(costTurn(i, 'exact', 0.1));
    assert.equal(badgeFor(partial).costText, '$0.90+');

    const nothing = [1, 2, 3].map(i => costTurn(i, 'unknown', null));
    assert.equal(badgeFor(nothing).costText, '—');
  });

  it('Mission Control uses the same fold, not worst-of', () => {
    const turns = [costTurn(1, 'fallback', 0.1)];
    for (let i = 2; i <= 20; i += 1) turns.push(costTurn(i, 'exact', 0.1));
    const home = makeHome(turns);
    const { missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');
    const snapshot = missionControlSnapshot({
      env: pluginEnv({ CCXRAY_HOME: home, CCXRAY_HERDR_NOW_MS: '1787000900000' }),
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });
    assert.equal(snapshot.rows.length, 1);
    assert.deepEqual(snapshot.rows[0].costAgg,
      { count: 20, fallbackCount: 1, fallbackCost: 0.1, unknownCount: 0 });
    const { aggCostText } = require('../plugins/herdr/bin/lib/ccxray');
    assert.equal(aggCostText(snapshot.rows[0].cost, snapshot.rows[0].costAgg), '$2.00',
      'a 5%-contaminated row total must not be marked');
  });
});

// INVARIANT(ADR 0005 shape): ONE ranked list answers "what is the most important
// thing about this pane right now", for both the sidebar badge's row-3 $alert and
// Mission Control's action. Two orderings used to contradict each other:
// the now-removed contextSignal ranked context above every tool failure, while
// chain ranked `fail >= 2` above context and `cache dropped` above `fail == 1`.
describe('Herdr pane concerns are ranked once (ADR 0005 shape)', () => {
  const {
    paneAction,
    paneAlert,
    paneConcerns,
    quotaRefusalCount,
  } = require('../plugins/herdr/bin/lib/ccxray');

  it('ranks any tool failure above a dropped cache', () => {
    const signals = { hasTelemetry: true, failures: 1, cacheDropped: true };
    assert.equal(paneAction(signals), 'inspect failed tool');
    assert.equal(paneAlert(signals).kind, 'fail-single');
  });

  it('row 3 skips the tiers rows 1 and 2 already render', () => {
    // Repeating context on row 3 while row 2 shows the percentage, or repeating
    // process state while row 1 shows it, is the duplication this layout exists
    // to remove. Mission Control is a single row and still acts on both.
    const ctxOnly = { hasTelemetry: true, ctxPct: 95 };
    assert.equal(paneAlert(ctxOnly), null);
    assert.equal(paneAction(ctxOnly), 'compact or start fresh');

    const blocked = { hasTelemetry: true, status: 'blocked' };
    assert.equal(paneAlert(blocked), null);
    assert.equal(paneAction(blocked), 'inspect last error');

    const dark = { hasTelemetry: false };
    assert.equal(paneAlert(dark), null);
    assert.equal(paneAction(dark), 'relaunch via ccxray');
  });

  it('keeps the signed-off $alert order once row-owned tiers are dropped', () => {
    const signals = {
      hasTelemetry: true,
      refusedCount: 2,
      staleText: 'stale 3m',
      failures: 3,
      cacheDropped: true,
      ctxPct: 95,
      status: 'blocked',
    };
    assert.deepEqual(
      paneConcerns(signals).filter(concern => !concern.sidebarOwned).map(concern => concern.kind),
      ['quota-refused', 'stale', 'fail-multi', 'cache-dropped'],
      'quota > stale > fail > cache-dropped is owner-signed-off');
    assert.equal(paneAlert(signals).text, 'quota refused 2x');
  });

  it('counts a quota refusal as an observed 429, never a forecast', () => {
    assert.equal(quotaRefusalCount([{ status: 200 }, { status: 429 }, { status: 200 }]), 1);
    assert.equal(quotaRefusalCount([{ status: 200 }]), 0);
    // Same last-six window as toolFailureCount, so an old refusal ages out.
    const aged = [{ status: 429 }].concat(Array.from({ length: 6 }, () => ({ status: 200 })));
    assert.equal(quotaRefusalCount(aged), 0);
  });

  // Asserted through the pre-existing missionControlSnapshot API on purpose: the
  // old code answers this one (with the other ordering) instead of throwing on a
  // missing export, so the red it produces is the ordering change and nothing else.
  it('Mission Control acts on the failure, not the dropped cache', () => {
    const T = 1787000000000;
    const base = {
      sessionId: 'mc-order-1', model: 'claude-opus-5', agentKey: 'orchestrator',
      isSubagent: false, convId: 'aaaa', maxContext: 200000,
      // The pane's own agentId is what attributes a turn to its row.
      agentId: 'herdr:w1:p1', cwd: '/work/mc-order', provider: 'anthropic',
    };
    const turns = [
      {
        ...base, id: 'mo1', receivedAt: T, sysHash: 'h1', turnToolFail: false,
        usage: { input_tokens: 10000, cache_read_input_tokens: 90000 },
      },
      {
        ...base, id: 'mo2', receivedAt: T + 1000, sysHash: 'h2', turnToolFail: true,
        usage: { input_tokens: 100000, cache_read_input_tokens: 0 },
      },
    ];
    const { missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');
    const snapshot = missionControlSnapshot({
      env: pluginEnv({ CCXRAY_HOME: makeHome(turns), CCXRAY_HERDR_NOW_MS: String(T + 2000) }),
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });
    assert.equal(snapshot.rows.length, 1);
    const row = snapshot.rows[0];
    // Pin the fixture before trusting the verdict: a fixture that stopped
    // dropping the cache would make this pass for the wrong reason.
    assert.equal(row.cacheDropped, true, 'fixture must actually drop the cache');
    assert.equal(row.failures, 1, 'fixture must carry exactly one failure');
    assert.ok(row.ctxPct <= 80, 'context must stay below the tier that outranks both');
    assert.equal(row.action, 'inspect failed tool');
  });
});

// Row 3 of the three-row sidebar: `$facts` (grey) and `$alert` (warning colour),
// exactly one non-empty per refresh, the other returned in clearTokens — the
// mechanism `ctx_bar_*` already ships with.
describe('Herdr sidebar row 3 fills exactly one token', () => {
  const { badgeTokens, applyRow3Tokens } = require('../plugins/herdr/bin/refresh-badges.js');
  const T = 1787000000000;
  const status = { ok: true, parsed: { running: true, machine: { proxy: true, port: 5577 } } };
  const usage = {
    ok: true,
    data: {
      meta: { totalCost: 999.99, totalEntries: 1234 },
      sessions: { topSessions: [{ sessionId: 'sTOP', cost: 42.5, turns: 77, model: 'claude-opus-5', durationMin: 60 }] },
      models: [{ model: 'claude-fable-5' }],
      cache: { hitRate: 0.91 },
      tools: { failRate: 0.07 },
    },
  };
  const turn = extra => ({
    sessionId: 'r3', agentId: 'herdr:w1:p1', model: 'claude-opus-5',
    agentKey: 'orchestrator', isSubagent: false, convId: 'c1', maxContext: 200000,
    provider: 'anthropic', cwd: '/work/r3', receivedAt: T,
    cost: { cost: 42.08, confidence: 'exact' }, turnToolFail: false, ...extra,
  });
  const render = turns => badgeTokens(status, usage, {
    env: pluginEnv({ CCXRAY_HOME: makeHome(turns) }),
    paneId: 'w1:p1',
    nowMs: T + 3600000,
    sidebarCols: 40,
  });

  it('shows the facts when nothing is wrong and the alert when something is', () => {
    const healthy = render([turn({ id: 'h1', usage: { input_tokens: 50000 } })]);
    assert.equal(healthy.tokens.facts, '$42.08 · 60m');
    assert.equal(healthy.tokens.alert, undefined);
    assert.ok(healthy.clearTokens.includes('alert'));
    assert.equal(healthy.clearTokens.includes('facts'), false);

    const failed = render([turn({ id: 'f1', usage: { input_tokens: 50000 }, turnToolFail: true })]);
    assert.equal(failed.tokens.alert, 'fail 1x');
    assert.equal(failed.tokens.facts, undefined);
    assert.ok(failed.clearTokens.includes('facts'));
    assert.equal(failed.clearTokens.includes('alert'), false);
  });

  it('leaves context pressure to row 2 instead of repeating it', () => {
    // 190K/200K = 95%. Row 2 already renders the percentage, the sparkline AND
    // the colour band, so an alert saying "full" would be the fourth encoding of
    // one fact — the duplication this layout exists to remove.
    const full = render([turn({ id: 'c1', usage: { input_tokens: 190000 } })]);
    assert.equal(full.tokens.alert, undefined);
    assert.equal(full.tokens.facts, '$42.08 · 60m');
  });

  it('fills neither token for a pane whose session it cannot locate', () => {
    // NOT a fail-on-old: `$facts` did not exist before, so the old code would
    // fail this for a missing token rather than for a behaviour difference. The
    // claim is only that row 1 keeps sole ownership of "not linked" — rendering
    // the detail's honest-but-useless `n/a · ?` beside it is the duplication.
    const elsewhere = render([turn({ id: 'x1', agentId: 'herdr:w1:pOTHER' })]);
    assert.equal(elsewhere.tokens.facts, undefined);
    assert.equal(elsewhere.tokens.alert, undefined);
    assert.ok(elsewhere.clearTokens.includes('facts'));
    assert.ok(elsewhere.clearTokens.includes('alert'));
  });

  it('fills neither token when there is no hub to report', () => {
    const dark = badgeTokens({ ok: true, parsed: { running: false, notes: [] } }, { ok: false }, {
      env: pluginEnv({ CCXRAY_HOME: makeHome([]) }),
      paneId: 'w1:p1',
      sidebarCols: 40,
    });
    assert.equal(dark.tokens.facts, undefined);
    assert.equal(dark.tokens.alert, undefined);
  });

  it('keeps every alert label inside a narrow sidebar', () => {
    // The spelled-out 'cache dropped after prompt change' is 33 columns; the
    // sidebar brief must fit a realistic row, and anything longer is clipped by
    // us rather than cut by Herdr.
    const dropped = render([
      turn({ id: 'd1', sysHash: 'h1', usage: { input_tokens: 10000, cache_read_input_tokens: 90000 } }),
      turn({ id: 'd2', sysHash: 'h2', receivedAt: T + 1000, usage: { input_tokens: 100000, cache_read_input_tokens: 0 } }),
    ]);
    assert.equal(dropped.tokens.alert, 'cache dropped');
    assert.ok(dropped.tokens.alert.length <= 14, 'must fit a 14-column sidebar');

    const wide = {};
    applyRow3Tokens(wide, { matched: true, costText: '$1234.56', ageText: '12.3h' }, { sidebarCols: 14 });
    assert.equal(wide.facts, '$1234.56 · 12…');
  });
});

// Row 1 is `state_icon · agent · state_text`, and a ccxray state label REPLACES
// the native state_text. Setting it unconditionally made row 1 read
// `claude · ccxray: traced · claude`.
describe('Herdr row 1 keeps Herdr own state text when the pane is located', () => {
  const T = 1787000000000;
  const paneTurn = extra => ({
    id: 'r1a', sessionId: 'row1', model: 'claude-opus-5', provider: 'anthropic',
    agentKey: 'orchestrator', isSubagent: false, convId: 'c1', maxContext: 200000,
    receivedAt: T, cwd: '/work/row1', usage: { input_tokens: 40000 },
    cost: { cost: 1.5, confidence: 'exact' }, turnToolFail: false, ...extra,
  });
  const run = turns => {
    const herdr = makeRecordingHerdr();
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome(turns),
      CCXRAY_HERDR_LAST: '9999d',
      CCXRAY_HERDR_NOW_MS: String(T + 60000),
      HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
    });
    const args = fs.existsSync(herdr.log) ? fs.readFileSync(herdr.log, 'utf8') : '';
    return { result, args };
  };

  it('clears the state labels instead of overwriting the state text', () => {
    // fail-on-old: the old code emitted --state-label on every refresh and never
    // emitted --clear-state-labels, so both assertions below invert.
    const { args } = run([paneTurn({ agentId: 'herdr:w1:p1' })]);
    assert.match(args, /report-metadata/);
    assert.match(args, /--clear-state-labels/,
      'a located pane must hand row 1 back to Herdr');
    assert.equal(/--state-label/.test(args), false,
      'and must not overwrite the native state text');
  });

  it('still labels a pane whose session it cannot locate', () => {
    // The label is reserved for what Herdr cannot know: that ccxray is not
    // seeing this pane at all.
    const { args } = run([paneTurn({ agentId: 'herdr:w1:pOTHER' })]);
    assert.match(args, /--state-label idle=ccxray: not linked/);
    assert.equal(/--clear-state-labels/.test(args), false);
  });
});

// The reported config, verbatim in shape: eight rows accumulated across three
// installer generations, rendering the model three times, the cost twice and the
// percentage twice, with four truncations. The old installer could only APPEND,
// so running it here made the card worse, not better.
describe('Herdr sidebar installer migrates accumulated generations', () => {
  const ACCUMULATED = [
    'onboarding = false',
    '',
    '[ui.sidebar.agents]',
    'rows = [',
    '  ["state_icon", "agent", "state_text"],',
    '  ["$ctx", "$model", "$cost"],',
    '  [{ token = "$tg", fg = "#50c878" }, { token = "$ty", fg = "#e0b040" }, { token = "$tr", fg = "#e05050" }],',
    '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
    '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
    '  [{ token = "$ctx_bar_green", fg = "#a6e3a1", dim = true }],',
    '  [{ token = "$ctx_bar_yellow", fg = "#f9e2af", dim = true }],',
    '  [{ token = "$ctx_bar_red", fg = "#f38ba8", dim = true }],',
    ']',
    '',
    '[ui]',
    'agent_panel_sort = "spaces"',
    '',
  ].join('\n');

  const install = config => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-migrate-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, config);
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    const result = runScript('install-sidebar-summary.js', [], env);
    return { result, configPath, env, after: fs.readFileSync(configPath, 'utf8') };
  };
  // Line-scan to the array's own closing bracket: indexOf(']') would stop at the
  // first row's own bracket.
  const sidebarRows = (config) => {
    const lines = config.split('\n');
    const start = lines.findIndex(line => /^\s*rows\s*=\s*\[/.test(line));
    const rows = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*\]/.test(line)) break;
      if (/^\s*\[/.test(line)) rows.push(line);
    }
    return rows;
  };

  // FAIL-ON-OLD: the previous installer appended, so `$summary` and the atomic
  // row both survive and the array grows instead of shrinking.
  it('replaces every superseded generation instead of stacking on top', () => {
    const { result, after } = install(ACCUMULATED);
    assert.equal(result.status, 0, result.stderr);
    for (const dead of ['$summary', '$tg', '$ty', '$tr']) {
      assert.equal(after.includes(dead), false, `${dead} must be gone`);
    }
    // `$ctx`/`$model`/`$cost` are gone as a ROW; $ctx_bar_* legitimately contains
    // the substring `$ctx`, so assert on the row rather than on the text.
    assert.equal(sidebarRows(after).some(row => /"\$ctx"/.test(row)), false);
    assert.equal(sidebarRows(after).some(row => /"\$model"/.test(row)), false);
    assert.equal(sidebarRows(after).some(row => /"\$cost"/.test(row)), false);

    assert.match(after, /\$facts/);
    assert.match(after, /\$alert/);
    assert.match(after, /\["state_icon", "agent", "state_text"\]/);
    // Seven config rows: row 1, four ctx_bar colour variants, and row 3's pair.
    // Herdr skips rows whose tokens are all empty, so this renders three lines.
    assert.equal(sidebarRows(after).length, 7);
    // The user's other tables are untouched.
    assert.match(after, /agent_panel_sort = "spaces"/);
    assert.equal(after.match(/\[ui\.sidebar\.agents\]/g).length, 1);
  });

  it('is idempotent', () => {
    const first = install(ACCUMULATED);
    const second = runScript('install-sidebar-summary.js', [], first.env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(first.configPath, 'utf8'), first.after,
      'a second run must not change the file');
    assert.match(second.stdout, /already installed/);
  });

  it('keeps a superseded row the user extended, because we cannot know which half they wanted', () => {
    const { after } = install([
      '[ui.sidebar.agents]',
      'rows = [',
      '  ["$summary", "$mine"],',
      ']',
      '',
    ].join('\n'));
    assert.match(after, /\["\$summary", "\$mine"\]/);
    assert.match(after, /\$facts/);
  });

  it('reports what it deleted, so a surprising removal is visible', () => {
    const { result } = install(ACCUMULATED);
    assert.match(result.stdout, /superseded row removed: \$ctx \$model \$cost/);
    assert.match(result.stdout, /superseded row removed: \$tg \$ty \$tr/);
    assert.match(result.stdout, /superseded row removed: \$summary/);
  });

  // codex round 1, P1: a table emitted by the previous installer carries legacy
  // default rows (`state_icon workspace tab` + `agent`) that must be replaced,
  // not just left behind — otherwise the card renders four lines.
  it('replaces the legacy default rows from a plugin-managed table', () => {
    const { result, after } = install([
      '',
      '# ccxray sidebar summary rows (managed by the ccxray Herdr plugin)',
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
    assert.equal(result.status, 0, result.stderr);
    // Legacy rows are gone, new row 1 is in place.
    assert.equal(after.includes('"workspace"'), false, 'old workspace column must go');
    assert.match(after, /\["state_icon", "agent", "state_text"\]/);
    // Seven config rows → three visible lines.
    assert.equal(sidebarRows(after).length, 7);
    assert.match(result.stdout, /legacy default rows/);
  });

  // codex round 1, P2a: removal must recognize a table emitted by the previous
  // installer, or stripping its token rows leaves an empty table behind.
  it('removes the whole section when it carries the legacy skeleton', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-legacy-remove-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[ui]',
      'show_agent_labels_on_pane_borders = true',
      '',
      '# ccxray sidebar summary rows (managed by the ccxray Herdr plugin)',
      '[ui.sidebar.agents]',
      'row_gap = 0',
      'rows = [',
      '  ["state_icon", "workspace", "tab"],',
      '  ["agent"],',
      '  [{ token = "$summary", fg = "#89b4fa", dim = true }],',
      '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
      ']',
      '',
    ].join('\n'));
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    const result = runScript('remove-sidebar-summary.js', [], env);
    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(configPath, 'utf8');
    assert.doesNotMatch(after, /\[ui\.sidebar\.agents\]/,
      'the whole managed section must go');
    assert.match(after, /show_agent_labels_on_pane_borders/,
      'the user table must survive');
  });

  // codex round 2 P1: a user-authored table (no SECTION_MARKER) that happens to
  // contain `["agent"]` must NOT have it replaced — it is the user's row.
  it('preserves legacy-looking rows in a user-authored table', () => {
    const { result, after } = install([
      '[ui.sidebar.agents]',
      'rows = [',
      '  ["state_icon", "workspace", "tab"],',
      '  ["agent"],',
      ']',
      '',
    ].join('\n'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(after, /\["state_icon", "workspace", "tab"\]/,
      'without the marker these are the user\'s own rows');
    assert.match(after, /\["agent"\]/);
    assert.match(after, /\$facts/);
  });

  it('Quick Start and the installer agree on what installed means', () => {
    const { configHasManagedRows } = require('../plugins/herdr/bin/install-sidebar-summary');
    assert.equal(configHasManagedRows(ACCUMULATED), false, 'the old generation is not installed');
    const { after } = install(ACCUMULATED);
    assert.equal(configHasManagedRows(after), true);
    // A commented-out example row is not an installation.
    const commented = after.split('\n').map(l => (l.includes('$facts') ? `#${l}` : l)).join('\n');
    assert.equal(configHasManagedRows(commented), false);
  });
});

// The standalone dashboard action ran a bare `ccxray open`, throwing away the one
// thing its caller knew: which pane they were looking at. Mission Control's `d`
// has passed --session since it shipped.
describe('Herdr dashboard action deep-links the pane session', () => {
  const recordingCcxray = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-open-'));
    const bin = path.join(dir, 'ccxray');
    const log = path.join(dir, 'argv.log');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      // parseStatus needs a JSON Machine line and something that reads as a live
      // hub; `port=5577` matches neither of its patterns.
      'if [ "$1" = "status" ]; then',
      '  echo "Hub running on http://localhost:5577 (pid 4242, clients 1)"',
      '  echo \'Machine: {"proxy":true,"hub":true,"port":5577}\''
      ,
      'fi',
      'exit 0',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log };
  };
  const argvFor = extraEnv => {
    const ccxray = recordingCcxray();
    const result = runScript('open-dashboard.js', [], {
      CCXRAY_BIN: ccxray.bin,
      CCXRAY_HERDR_NO_BROWSER: '1',
      ...extraEnv,
    });
    const argv = fs.existsSync(ccxray.log) ? fs.readFileSync(ccxray.log, 'utf8') : '';
    return { result, argv };
  };

  it('passes the focused pane session to ccxray open', () => {
    // fail-on-old: the old action emitted a bare `open` for this same input.
    const { result, argv } = argvFor({
      HERDR_PANE_ID: 'w1:p1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1',
        agent_session: { kind: 'id', value: 'sess-abc-123' },
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(argv, /^open --session sess-abc-123$/m);
    assert.match(result.stdout, /opening the dashboard on session sess-abc-123/);
  });

  it('falls back to a plain open when the pane has no session id', () => {
    const { result, argv } = argvFor({
      HERDR_PANE_ID: 'w1:p1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1',
        // agent_session_known means the context author already asked and the
        // answer was "none", so the resolver must not re-list the agents.
        agent_session_known: true,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(argv, /^open$/m);
    assert.match(result.stdout, /no session id yet/);
  });

  it('resolves the session the same way the badge does', () => {
    // One helper, so `prefix+m` -> d and the standalone action cannot open
    // different sessions for the same pane.
    const { resolvePaneSessionId } = require('../plugins/herdr/bin/lib/ccxray');
    const context = { agent_session: { kind: 'id', value: 'sess-xyz' } };
    assert.equal(resolvePaneSessionId({ env: pluginEnv({}), paneId: 'w1:p1', context }), 'sess-xyz');
    assert.equal(resolvePaneSessionId({ env: pluginEnv({}), paneId: 'w1:p1', context, eventSessionId: 'from-event' }),
      'from-event', 'an event id wins, as it does in the badge');
    assert.equal(resolvePaneSessionId({
      env: pluginEnv({}), paneId: 'w1:p1', context: { agent_session_known: true },
    }), null);
  });
});

// codex round 1, P2b: a quota refusal must not leave Mission Control severity
// green. The attention filter hides green rows, so a pane that got 429'd would
// be invisible to the operator.
describe('Herdr Mission Control marks a quota refusal red', () => {
  it('updates severity and reasons when status 429 is observed', () => {
    const T = 1787000000000;
    const turn = {
      id: 'q1', sessionId: 'sq1', model: 'claude-opus-5', agentKey: 'orchestrator',
      isSubagent: false, convId: 'c1', maxContext: 200000, provider: 'anthropic',
      agentId: 'herdr:w1:p1', cwd: '/work/quota', receivedAt: T,
      usage: { input_tokens: 50000 }, cost: { cost: 1, confidence: 'exact' },
      turnToolFail: false, status: 429,
    };
    const { missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');
    const snapshot = missionControlSnapshot({
      env: pluginEnv({ CCXRAY_HOME: makeHome([turn]), CCXRAY_HERDR_NOW_MS: String(T + 2000) }),
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });
    assert.equal(snapshot.rows.length, 1);
    const row = snapshot.rows[0];
    assert.equal(row.severity, 'red', 'a quota refusal must not stay green');
    assert.ok(row.reasons.some(r => /quota refused/.test(r)));
    assert.equal(row.action, 'wait for quota reset');
  });
});

describe('ensureProxy cold start', () => {
  // `ccxray --no-browser` with no agent is a FOREGROUND standalone server (a hub
  // is forked only by `ccxray <agent>` without --port). ensureProxy used
  // spawnSync with a 15s timeout, so it blocked for the full timeout and then
  // SIGTERM'd the very server it had started; the readiness probe then looked
  // only for a hub, which never existed. The cold-start path could not succeed.
  //
  // Asserted by STATE, not timing: the fake server records the signal it
  // receives, so "we killed what we started" is directly observable.
  it('leaves the server it started alive and accepts a standalone port', () => {
    const { ensureProxy } = require('../plugins/herdr/bin/lib/ccxray');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ensure-'));
    const fake = path.join(dir, 'ccxray');
    fs.writeFileSync(fake, [
      '#!/bin/sh',
      'if [ "$1" = "status" ]; then',
      '  echo "No hub running"',
      '  if [ -f "$CCXRAY_FAKE_DIR/listening" ]; then',
      '    echo "Note: port 5999 is held by a standalone ccxray"',
      '  fi',
      '  exit 0',
      'fi',
      '# the --no-browser foreground server',
      'echo $$ > "$CCXRAY_FAKE_DIR/pid"',
      'trap \'echo TERM > "$CCXRAY_FAKE_DIR/killed"; exit 0\' TERM',
      'touch "$CCXRAY_FAKE_DIR/listening"',
      'while true; do sleep 0.2; done',
    ].join('\n'));
    fs.chmodSync(fake, 0o755);

    let port = null;
    try {
      port = ensureProxy({
        env: pluginEnv({ CCXRAY_BIN: fake, CCXRAY_FAKE_DIR: dir }),
        cwd: dir,
      });
      assert.equal(port, 5999, 'the readiness probe must accept a standalone port');
      assert.equal(fs.existsSync(path.join(dir, 'killed')), false,
        'must not SIGTERM the server it just started');
      assert.ok(fs.existsSync(path.join(dir, 'pid')), 'the server should have started');
    } finally {
      // Never leave the fake behind — an orphaned proxy is the failure mode this
      // whole path is about.
      try {
        const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim());
        if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
});

describe('Herdr model label agrees across surfaces', () => {
  // The sidebar anchors on mainDisplayTurns (agentKey whitelist, then raw
  // !isSubagent); Mission Control's turns arrive filtered only by raw
  // !isSubagent. A Task-tool subagent carries the PARENT's sessionId with
  // isSubagent false — the documented ADR 0005 miss — so when the label moved
  // from a session-wide plurality to "the latest turn", the two surfaces began
  // naming different models for one pane. The plurality had masked it.
  it('names the same model in the sidebar badge and the Mission Control row', () => {
    const base = {
      sessionId: 's-agree', provider: 'anthropic', cwd: '/work/agree',
      agentId: 'herdr:w1:p1', maxContext: 200000,
      usage: { input_tokens: 1000, output_tokens: 10 }, cost: { cost: 0.01 },
    };
    const home = makeHome([
      { ...base, id: 'a1', responseId: 'msg_a1', receivedAt: 1787000001000, agentKey: 'orchestrator', isSubagent: false, model: 'claude-opus-5' },
      { ...base, id: 'a2', responseId: 'msg_a2', receivedAt: 1787000002000, agentKey: 'orchestrator', isSubagent: false, model: 'claude-opus-5' },
      // Arrives last, looks like main to a raw flag check, is not main. Its
      // context is deliberately ~60% against a2's ~0.5% so an unanchored
      // percentage cannot coincide with the anchored one by accident.
      {
        ...base, id: 'a3', responseId: 'msg_a3', receivedAt: 1787000003000,
        agentKey: 'general-purpose', isSubagent: false, model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 120000, output_tokens: 10 },
      },
    ]);
    const env = pluginEnv({ CCXRAY_HOME: home, CCXRAY_HERDR_NOW_MS: '1787000004000' });
    const { sessionSummaryDetails, missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');

    const badge = sessionSummaryDetails({}, { env, paneId: 'w1:p1', cwd: '/work/agree' });
    const snapshot = missionControlSnapshot({
      env,
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });

    assert.equal(badge.model, 'claude-opus-5', 'badge reads the last MAIN turn');
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].model, badge.model,
      'Mission Control must not name a different model than the badge');
    // The model label was the first symptom, not the whole divergence: ctx% and
    // cache% read the same anchored set, so a `general-purpose` turn carrying
    // isSubagent:false must not move them on one surface and not the other.
    // a3's context is deliberately far from a2's so an unanchored percentage
    // cannot coincide with the anchored one.
    assert.equal(Math.round(snapshot.rows[0].ctxPct), Math.round(badge.ctxPct),
      'Mission Control must not report a different ctx% than the badge');
  });
});

describe('Herdr sidebar model reports the latest main turn', () => {
  const T = Date.parse('2026-08-19T00:00:00.000Z');
  const turn = (i, model) => ({
    id: `s${i}`, sessionId: 'sw', model, agentKey: 'orchestrator', isSubagent: false,
    convId: 'aaaa', receivedAt: T + i * 1000, maxContext: 200000,
    usage: { input_tokens: 20000 },
  });

  it('flips on the first turn after a /model switch, not on plurality', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    // 40 opus turns, then one sonnet turn — the shape of a /model switch mid-session.
    const entries = [];
    for (let i = 0; i < 40; i += 1) entries.push(turn(i, 'claude-opus-5'));
    entries.push(turn(40, 'claude-sonnet-5'));
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(entries), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
      sessionId: 'sw',
      nowMs: T + 60000,
    });
    assert.equal(detail.matched, true);
    // Under the plurality rule this was 'claude-opus-5' (40 vs 1).
    assert.equal(detail.model, 'claude-sonnet-5');
  });

  // The plurality rule existed to damp oscillation, but `anchor` is already
  // main-only (mainDisplayTurns drops subagent turns), so the noise it damped is
  // filtered upstream — a subagent on another model must still not move the label.
  it('still ignores a non-main turn that arrives last', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const entries = [
      turn(0, 'claude-opus-5'),
      { ...turn(1, 'claude-fable-5'), agentKey: 'agent', isSubagent: true, convId: 'bbbb' },
    ];
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: { CCXRAY_HOME: makeHome(entries), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS },
      sessionId: 'sw',
      nowMs: T + 60000,
    });
    assert.equal(detail.model, 'claude-opus-5');
  });
});

// The badge is only as fresh as the newest turn ccxray logged. A session ccxray
// stopped observing keeps writing its transcript while the index stands still,
// so the badge pairs a live-ticking age with frozen numbers — measured on real
// data, a transcript at 89% of 1M rendering 35%.
//
// Elapsed time alone cannot separate that from a finished session or a user who
// stepped away, and marking those would spend the marker on cases whose numbers
// are correct. Measured over the badge's real 4MB index window (6 sessions):
// elapsed-only fired on 3 and was wrong about 1; the transcript-ahead rule fired
// on exactly the 2 whose transcripts ran 11h and 13h past our newest evidence,
// with the live sessions at 0m — nothing sat near the threshold.
// The badge is only as fresh as the newest turn ccxray logged. A session ccxray
// stopped observing keeps writing its transcript while the index stands still,
// so the badge pairs a live-ticking age with frozen numbers.
//
// The signal has to be read carefully. Claude Code appends `system`,
// `last-prompt`, `mode`, `permission-mode`, `file-history-snapshot` and
// `attachment` records that never correspond to an API request, so the file
// mtime advances on a session ccxray is watching perfectly. Measured over 161
// locatable real sessions: an mtime rule fired on 41, of which only 4 had turns
// we had genuinely missed — and those 4 were verified independently (each has a
// 100%-imported index whose transcript holds 192 to 752 MORE completed turns
// than ccxray logged). Only a completed turn newer than our newest evidence
// counts, using core's own rule (server/importer.js:165-172).
describe('Herdr sidebar import freshness', () => {
  const T = Date.parse('2026-08-17T00:00:00.000Z');
  const NOW = T + 11 * 3600000;
  const CWD = '/Users/dev/proj.app';
  const turn = {
    id: 'a1', sessionId: 's1', model: 'claude-opus-5', agentKey: 'orchestrator',
    isSubagent: false, receivedAt: T, cwd: CWD, beta1m: true,
    maxContext: 1000000, usage: { input_tokens: 319000 },
  };

  function assistantLine(ms) {
    return JSON.stringify({
      type: 'assistant',
      timestamp: new Date(ms).toISOString(),
      message: { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 50 } },
    });
  }

  // The records Claude Code writes with no API request behind them. These are
  // what made a file-mtime rule fire on 37 healthy sessions.
  function metadataLines(ms) {
    return ['system', 'last-prompt', 'mode', 'permission-mode', 'file-history-snapshot']
      .map(type => JSON.stringify({ type, timestamp: new Date(ms).toISOString() }));
  }

  // ISOLATION: staleness stats and reads a scan root outside CCXRAY_HOME (the
  // ADR 0015 R4 class). CCXRAY_IMPORT_HOMES pins it at a temp projects/ tree so
  // the suite never touches the developer's real ~/.claude*/projects.
  // See docs/testing.md.
  function makeTranscript(opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-transcripts-'));
    if (opts.absent) return root;
    const sessionId = opts.sessionId || 's1';
    const cwd = opts.cwd || CWD;
    const dir = path.join(root, String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    const lines = [];
    if (opts.turnMs != null) lines.push(assistantLine(opts.turnMs));
    if (opts.trailingMetadataMs != null) lines.push(...metadataLines(opts.trailingMetadataMs));
    fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
    const mtime = new Date(opts.mtimeMs != null ? opts.mtimeMs : (opts.turnMs || T));
    fs.utimesSync(file, mtime, mtime);
    return root;
  }

  function detailFor(transcriptRoot, extraEnv = {}) {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    return sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: {
        CCXRAY_HOME: makeHome([turn]),
        CCXRAY_IMPORT_HOMES: transcriptRoot,
        ...extraEnv,
      },
      sessionId: 's1',
      nowMs: NOW,
      sidebarCols: 40,
    });
  }

  // FAIL-ON-OLD: pre-fix code has no `stale` field and reports ctxBand 'green'
  // for this input, because 32% is genuinely under the green threshold — the
  // number is stale, not high.
  it('marks the badge when a completed turn is newer than our newest evidence', () => {
    const detail = detailFor(makeTranscript({ turnMs: NOW }));
    assert.ok(detail.stale, 'expected a staleness marker');
    assert.equal(detail.stale.text, 'stale 11h');
    assert.match(detail.summary, /· stale 11h$/);
    // The reason moved to row 3's $alert. Row 2 keeps the withdrawn colour (the
    // assertion below) and the cache fact, so it no longer repeats the word —
    // `21% · stal…` beside `21% stale` is the duplication being removed.
    assert.doesNotMatch(detail.ctxBar, /stale/);
    assert.equal(paneAlertFor(detail).text, 'stale 11h');
    // The percentage survives; only the confident colour is withdrawn.
    assert.equal(Math.round(detail.ctxPct), 32);
    assert.equal(detail.ctxBand, 'unknown');
  });

  // FAIL-ON-OLD against the mtime implementation this replaced: 37 of its 41
  // real-data firings were exactly this shape — the transcript's newest TURN is
  // no newer than ours, only its metadata records are.
  it('ignores metadata-only writes that carry no API turn behind them', () => {
    const detail = detailFor(makeTranscript({ turnMs: T, trailingMetadataMs: NOW, mtimeMs: NOW }));
    assert.ok(!detail.stale, 'metadata records must not count as missed turns');
    assert.equal(detail.ctxBand, 'green');
  });

  it('ignores an assistant record that completed no turn', () => {
    // A zero-token or usage-less assistant record is not a turn by core's rule
    // (server/importer.js:167-170), so it cannot be evidence we missed one.
    const root = makeTranscript({ turnMs: T, mtimeMs: NOW });
    const dir = path.join(root, CWD.replace(/[^a-zA-Z0-9]/g, '-'));
    const file = path.join(dir, 's1.jsonl');
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW).toISOString(),
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    }) + '\n');
    fs.utimesSync(file, new Date(NOW), new Date(NOW));
    const detail = detailFor(root);
    assert.ok(!detail.stale, 'a zero-token assistant record is not a completed turn');
  });

  // GUARD (passes on both sides — the pre-fix code marks nothing at all). This
  // is the precision half: a session that simply stopped is equally quiet, and
  // its numbers are still correct.
  it('leaves a finished session alone, however old its evidence', () => {
    const detail = detailFor(makeTranscript({ turnMs: T - 60000, mtimeMs: T - 60000 }));
    assert.ok(!detail.stale, 'a finished session must not be marked');
    assert.equal(detail.ctxBand, 'green');
    assert.doesNotMatch(detail.summary, /stale/);
  });

  it('leaves a live session alone while the transcript leads by less than the threshold', () => {
    // A long turn writes its transcript continuously but reaches the index only
    // when the response completes, so a few minutes of lead is normal.
    const detail = detailFor(makeTranscript({ turnMs: T + 5 * 60000, mtimeMs: T + 5 * 60000 }));
    assert.ok(!detail.stale, 'a normal in-flight lead must not be marked');
    assert.equal(detail.ctxBand, 'green');
  });

  // An append normally sets mtime at or after the record it wrote, so the gate
  // skips reading when mtime sits in the normal band. A transcript copied without
  // -p, restored from a backup, or touched to an older time breaks that in the
  // dangerous direction: mtime behind content that is hours ahead of the index.
  // The gate must not read such a file as proof of health.
  it('still reads a transcript whose mtime sits behind our own newest evidence', () => {
    const detail = detailFor(makeTranscript({ turnMs: NOW, mtimeMs: T - 3600000 }));
    assert.ok(detail.stale, 'an mtime behind our evidence is unexplained, not reassuring');
    assert.equal(detail.stale.text, 'stale 11h');
  });

  it('says nothing when no transcript can be located', () => {
    // Codex panes and any session whose cwd we never learned land here — 40% of
    // sessions in the real corpus. A miss degrades to silence, never a guess.
    const detail = detailFor(makeTranscript({ absent: true }));
    assert.ok(!detail.stale, 'an unlocatable transcript must stay silent');
    assert.equal(detail.ctxBand, 'green');
  });

  it('honours CCXRAY_BADGE_STALE_MS', () => {
    const detail = detailFor(
      makeTranscript({ turnMs: T + 5 * 60000, mtimeMs: T + 5 * 60000 }),
      { CCXRAY_BADGE_STALE_MS: '60000' },
    );
    assert.ok(detail.stale, 'a one-minute threshold should fire on a five-minute lead');
  });

  // Freshness reads every turn, not just the main-agent anchor: a subagent turn
  // logged a minute ago proves ccxray is still watching, even while the main
  // conversation is quiet. Anchoring freshness would have marked this stale.
  it('treats a recent subagent turn as proof the session is still observed', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const subagent = {
      id: 'b1', sessionId: 's1', model: 'claude-sonnet-5', agentKey: 'agent',
      isSubagent: true, receivedAt: NOW - 60000, cwd: CWD,
      maxContext: 200000, usage: { input_tokens: 10000 },
    };
    const detail = sessionSummaryDetails({ meta: {}, sessions: {}, models: [] }, {
      env: {
        CCXRAY_HOME: makeHome([turn, subagent]),
        CCXRAY_IMPORT_HOMES: makeTranscript({ turnMs: NOW }),
      },
      sessionId: 's1',
      nowMs: NOW,
      sidebarCols: 40,
    });
    assert.ok(!detail.stale, 'a recent subagent turn proves the session is observed');
  });

  // The badge refresh runs on Herdr's event path, so the rescan it triggers must
  // be detached: spawned, unref'd, never awaited. A refresh that blocked on a
  // disk scan would stall the sidebar for every pane in the workspace.
  it('spawns the rescan without waiting for it', () => {
    const { requestImport } = require('../plugins/herdr/bin/lib/ccxray');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-import-'));
    const marker = path.join(dir, 'ran');
    const bin = path.join(dir, 'fake-ccxray');
    // Sleeps well past any reasonable badge refresh, then records that it ran.
    fs.writeFileSync(bin, `#!/usr/bin/env node\nsetTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ')), 400);\n`);
    fs.chmodSync(bin, 0o755);

    const started = Date.now();
    const result = requestImport({ env: { ...process.env, CCXRAY_BIN: bin } });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.ok(elapsed < 300, `requestImport must return immediately, took ${elapsed}ms`);

    // And the child really does outlive the call.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(fs.existsSync(marker), true, 'the detached child should still run');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'import --once');
  });

  it('can be switched off without switching off the marker', () => {
    const { requestImport } = require('../plugins/herdr/bin/lib/ccxray');
    const result = requestImport({ env: { ...process.env, CCXRAY_BADGE_IMPORT_DISABLE: '1' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
  });

  // A sidebar row only shows tokens it references. Measured on a real
  // ~/.config/herdr/config.toml whose row is ["$ctx","$model","$cost"]: neither
  // `summary` nor any `ctx_bar*` token is referenced, so the marker rendered
  // NOWHERE and the badge showed a bare confident percentage for a session whose
  // transcript had moved on. `$ctx` is the channel such a layout does render.
  it('marks the ctx token too, so a summary-less sidebar still shows the state', () => {
    const { badgeTokens } = require('../plugins/herdr/bin/refresh-badges.js');
    const status = { parsed: { running: true } };
    const usage = { ok: true, data: { meta: {}, sessions: {}, models: [], cache: {}, tools: {} } };
    const opts = {
      env: { CCXRAY_HOME: makeHome([turn]), CCXRAY_IMPORT_HOMES: makeTranscript({ turnMs: NOW }) },
      sessionId: 's1',
      nowMs: NOW,
      sidebarCols: 40,
    };
    const { tokens } = badgeTokens(status, usage, opts);
    assert.equal(tokens.ctx, '32% stale', 'the rendered percentage must carry the state');
    assert.equal(tokens.ctx_band, 'unknown');
    assert.match(tokens.summary, /stale 11h/);
  });

  it('leaves the ctx token clean when the session is current', () => {
    const { badgeTokens } = require('../plugins/herdr/bin/refresh-badges.js');
    const status = { parsed: { running: true } };
    const usage = { ok: true, data: { meta: {}, sessions: {}, models: [], cache: {}, tools: {} } };
    const opts = {
      env: { CCXRAY_HOME: makeHome([turn]), CCXRAY_IMPORT_HOMES: makeTranscript({ turnMs: T, mtimeMs: T }) },
      sessionId: 's1',
      nowMs: NOW,
      sidebarCols: 40,
    };
    const { tokens } = badgeTokens(status, usage, opts);
    assert.equal(tokens.ctx, '32%');
    assert.equal(tokens.ctx_band, 'green');
  });

  // Derived by replaying all 118 cwds in the real index against the 184 project
  // directories on disk: flattening every non-alphanumeric reproduced 43, while
  // flattening only '/' and '.' reproduced 41. The two it missed are real — a
  // cwd with '_' and a worktree branch name with '+' — and each made the whole
  // feature silently inert for that project.
  it('resolves a transcript through Claude\'s cwd encoding', () => {
    const { transcriptFile } = require('../plugins/herdr/bin/lib/ccxray');
    // The expected names are written out literally. Building the fixture with
    // the same regex the production function uses would make this pass for any
    // rule, including a wrong one — it would only prove the two agree.
    const cases = [
      ['/Users/dev/proj.app', '-Users-dev-proj-app'],
      ['/Users/justinlee/dev/android_shopping', '-Users-justinlee-dev-android-shopping'],
      ['/w/claude+vehicle-x', '-w-claude-vehicle-x'],
      ['/Users/x/.claude', '-Users-x--claude'],
      ['/Users/dev/proj/', '-Users-dev-proj'],
      ['/Users//dev/proj', '-Users-dev-proj'],
    ];
    for (const [cwd, expectedDir] of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-slug-'));
      const dir = path.join(root, expectedDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 's1.jsonl');
      fs.writeFileSync(file, assistantLine(T) + '\n');
      fs.utimesSync(file, new Date(T), new Date(T));
      const found = transcriptFile('s1', cwd, { CCXRAY_IMPORT_HOMES: root });
      assert.ok(found, `cwd ${cwd} should resolve to ${expectedDir}`);
      assert.equal(Math.round(found.mtimeMs), T);
    }

    const env = { CCXRAY_IMPORT_HOMES: makeTranscript({ turnMs: T }) };
    assert.equal(transcriptFile('s1', '/other/path', env), null);
    assert.equal(transcriptFile('missing', CWD, env), null);
    assert.equal(transcriptFile(null, CWD, env), null);
    assert.equal(transcriptFile('s1', null, env), null);
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
    // attention includes everything non-green, matching the count at ccxray.js:1134
    assert.deepEqual(filteredMissionRows(rows, 'attention').map(row => row.paneId), ['w1:p1', 'w1:p3']);
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
    // BSD script (macOS) takes the command as positional args after the file;
    // util-linux script (Linux CI) rejects positional commands and needs -c.
    const run = `env CCXRAY_HOME=${JSON.stringify(home)} HERDR_CONFIG_PATH=${JSON.stringify(cfg)} `
      + `CCXRAY_PRICING_CACHE=/nonexistent/p.json HERDR_PANE_ID= `
      + `/bin/sh -c ${JSON.stringify(inner)}`;
    const pty = process.platform === 'linux'
      ? `script -qec ${JSON.stringify(run)} /dev/null`
      : `script -q /dev/null ${run}`;
    // The job-level redirect covers the feeder subshell too — its inherited
    // stderr would otherwise hold spawnSync's pipe open until the sleep ends.
    const command = `{ ( printf 'q'; sleep 12 ) | ${pty}; } >/dev/null 2>&1 &\n`
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
    // `--placement tab` is explicit now: this assertion previously encoded its
    // ABSENCE, which was the bug — the manifest's placement always won and
    // CCXRAY_HERDR_PANE_PLACEMENT did nothing for Quick Start.
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
        // 'fallback', not 'estimated': the server writes only exact / prefix /
        // fallback / unknown (`calculateCost`), and the plugin's `'estimated'`
        // is a capability-analysis field, not a cost confidence. The old
        // worst-of marked ANY non-exact value, so an invented one still
        // rendered `~`; ADR 0017's fold keys strictly on 'fallback', exactly as
        // core's does. 0.07 of 0.27 is a 26% cost share — above the 10% mark
        // threshold, below the 50% degrade threshold, so `~$0.27` still holds.
        cost: { cost: 0.07, confidence: 'fallback' },
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

  it('mission-control renders dash when all turns have unknown cost', () => {
    const now = Date.now();
    const entries = [
      {
        ...sampleEntry,
        id: 'unknown-cost-turn',
        sessionId: 'unknown-session',
        agentId: 'herdr:w1:p5',
        receivedAt: now,
        isSubagent: false,
        cost: { cost: null, confidence: 'unknown' },
      },
    ];
    const agents = [{
      pane_id: 'w1:p5', workspace_id: 'w1', tab_id: 'w1:t1',
      agent_status: 'working', agent: 'codex',
    }];
    const result = runScript('mission-control.js', ['--once'], {
      CCXRAY_HOME: makeHome(entries),
      CCXRAY_HERDR_NOW_MS: String(now),
      HERDR_BIN_PATH: makeHerdr(agents),
      CCXRAY_MISSION_COLS: '100',
    });
    assert.equal(result.status, 0, result.stderr);
    // Old code rendered a confident $0.00; new code renders —
    assert.match(result.stdout, /main —/);
    assert.doesNotMatch(result.stdout, /main \$0\.00/);
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
    assert.match(result.stdout, /ctx_bar_red=▁▁▁█ 90% · cache 0%/);
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
    assert.match(wide.stdout, /ctx_bar=▂▂▃▃▅▅▆▆▆▅▆▆ 80% · cache 0%/);
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
    assert.equal(plan.cwd, '/work/demo');
    assert.equal(plan.workspaceId, 'w1');
    // Plan must include proxy routing info without actually starting a proxy.
    assert.ok(plan.port > 0);
    assert.ok(plan.envVars);
    assert.ok(plan.codexArgs);
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

  // The detected path. Its name used to claim it covered a FAILED detection
  // while the mock returned `agent_started`, so it asserted nothing about the
  // failure it named — and the code did not in fact keep the record there. The
  // real failure case is pinned in 'codex round 2 fixes'.
  it('launch-agent records the routed pane on a detected launch', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-routed-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-slowrun-'));
    const bin = path.join(dir, 'herdr');
    const opened = JSON.stringify({ id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p7' }, tab: { tab_id: 'w1:t2' } } });
    const agentOk = JSON.stringify({ id: 'a', result: { type: 'agent_started', agent: { agent: 'codex', pane_id: 'w1:p7' } } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'agent' && process.argv[3] === 'start') {",
      `  process.stdout.write(${JSON.stringify(agentOk + '\\n')});`,
      '  process.exit(0);',
      '}',
      "if (process.argv[2] === 'pane') {",
      `  process.stdout.write(${JSON.stringify(opened + '\\n')});`,
      '  process.exit(0);',
      '}',
      `process.stdout.write(${JSON.stringify(opened + '\\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      PROXY_PORT: '9999',
    });
    const routed = path.join(stateDir, 'routed-panes-v1', `${encodeURIComponent('w1:p7')}.json`);
    assert.ok(fs.existsSync(routed), 'a detected launch must stay routed');
  });

  it('launch-agent exits non-zero when herdr agent start fails to detect', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-project-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-routed-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-failrun-'));
    const bin = path.join(dir, 'herdr');
    const opened = JSON.stringify({ id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p8' }, tab: { tab_id: 'w1:t2' } } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'agent' && process.argv[3] === 'start') {",
      "  process.stderr.write('agent not detected\\n'); process.exit(1);",
      '}',
      `process.stdout.write(${JSON.stringify(opened + '\\n')});`,
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      PROXY_PORT: '9999',
    });
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
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
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

  // #555: `ccxray status` can append "Note: port N is held by ..." lines; the
  // plugin's status parser must surface them so doctor can show the one hint
  // that explains a failed launch (grok review P2, 2026-08-18).
  it('parseStatus surfaces #555 Note lines without flipping running', () => {
    const { parseStatus } = require('../plugins/herdr/bin/lib/ccxray');
    const parsed = parseStatus([
      'No hub running.',
      'Note: port 5577 is held by a standalone (non-hub) ccxray (pid 4701), so it cannot be shared as a hub.',
      'Note: Leave it running; relaunch with PROXY_PORT=<other-port> (e.g. PROXY_PORT=5600 ccxray claude) to run the hub on a different port.',
    ].join('\n'));
    assert.equal(parsed.running, false);
    assert.equal(parsed.notes.length, 2);
    assert.match(parsed.notes[0], /held by a standalone/);
    // The occupant's port/pid live only in Note lines and must not be
    // reported as the hub's (grok round-2 P3).
    assert.equal(parsed.port, null);
    assert.equal(parsed.pid, null);
    const plain = parseStatus('No hub running.\n');
    assert.deepEqual(plain.notes, []);
  });

  // E2 retro: herdr CLI puts error JSON on stderr. runCommand.parsed must
  // merge both streams so callers don't silently get null on failure.
  it('runCommand exposes parsed JSON from stdout and stderr', () => {
    const { runHerdr } = require('../plugins/herdr/bin/lib/ccxray');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-parsed-'));
    const bin = path.join(dir, 'herdr');
    // Success on stdout
    fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({result:{ok:true}})+"\\n");\n');
    fs.chmodSync(bin, 0o755);
    const ok = runHerdr(['test'], { env: { ...process.env, HERDR_BIN_PATH: bin } });
    assert.deepEqual(ok.parsed?.result, { ok: true });

    // Error on stderr (the E2 pattern)
    fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.stderr.write(JSON.stringify({error:{code:"agent_pane_busy"}})+"\\n");process.exit(1);\n');
    fs.chmodSync(bin, 0o755);
    const err = runHerdr(['test'], { env: { ...process.env, HERDR_BIN_PATH: bin } });
    assert.equal(err.parsed?.error?.code, 'agent_pane_busy');
  });

  // #555 port escape hatch: PROXY_PORT must travel launch-agent → pane runner
  // → spawned ccxray as an explicit contract, because the runner executes in
  // the Herdr pane's environment, not the launcher's.
  it('run-agent forwards --proxy-port into the spawned ccxray env', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run', '--proxy-port=5678']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.PROXY_PORT, '5678');
  });

  it('run-agent lets an explicit --proxy-port win over the pane env PROXY_PORT', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run', '--proxy-port=5678'], {
      PROXY_PORT: '7788',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.PROXY_PORT, '5678');
  });

  it('run-agent still honours a PROXY_PORT already present in the pane env', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run'], {
      PROXY_PORT: '7788',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).env.PROXY_PORT, '7788');
  });

  it('run-agent rejects a malformed --proxy-port loudly', () => {
    const result = runScript('run-agent.js', ['codex', 'w1:p9', 'w1', 'w1:t1', 'w1:p1', '--dry-run', '--proxy-port=lots']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid --proxy-port/);
  });

  it('launch-agent surfaces PROXY_PORT in its plan', () => {
    const result = runScript('launch-agent.js', ['codex', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: '/work/demo', workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      PROXY_PORT: '5678',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.port, 5678);
    assert.ok(plan.envVars);
  });

  it('launch-agent uses PROXY_PORT for the proxy env vars', () => {
    const result = runScript('launch-agent.js', ['claude', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: '/work/demo', workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      PROXY_PORT: '5678',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.envVars.ANTHROPIC_BASE_URL, 'http://localhost:5678');
  });

  // The launch stamp must carry the workspace id, because the reader side
  // (filterEntriesToWorkspace) treats any `herdr:`-prefixed agentId as already
  // attributed and keeps it only under `herdr:<workspaceId>:`. A workspace-less
  // stamp is DROPPED rather than recovered by cwd, so Quick Start's session
  // count stays 0 and Mission Control reports the pane unlinked.
  it('launch-agent stamps the workspace id into the pane identity header', () => {
    const result = runScript('launch-agent.js', ['claude', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: '/work/demo', workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      PROXY_PORT: '5678',
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.match(plan.launchToken, /^w1:herdr-/, 'token starts with the workspace id');
    assert.equal(
      plan.envVars.ANTHROPIC_CUSTOM_HEADERS,
      `X-Ccxray-Agent-Id: herdr:${plan.launchToken}`,
      '--plan must report the header a real launch injects',
    );

    // The reader side keeps it. This is the assertion the old shape failed.
    const { filterEntriesToWorkspace } = require('../plugins/herdr/bin/lib/ccxray');
    const stamped = { sessionId: 's1', cwd: '/work/demo', agentId: `herdr:${plan.launchToken}` };
    const kept = filterEntriesToWorkspace([stamped], pluginEnv({
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: '/work/demo' }),
    })).entries;
    assert.equal(kept.length, 1, 'a workspace-stamped launch id survives the workspace filter');

    // ...and the pre-fix shape does not, which is why this test exists.
    const legacy = { sessionId: 's1', cwd: '/work/demo', agentId: 'herdr:herdr-m9x' };
    const keptLegacy = filterEntriesToWorkspace([legacy], pluginEnv({
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: '/work/demo' }),
    })).entries;
    assert.equal(keptLegacy.length, 0, 'workspace-less herdr: ids are dropped, not cwd-recovered');
  });

  it('launch-agent rejects an invalid PROXY_PORT before creating any pane', () => {
    const herdr = makeRecordingHerdr();
    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_BIN_PATH: herdr.bin,
      PROXY_PORT: '70000',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid PROXY_PORT/);
    assert.equal(fs.existsSync(herdr.log), false, 'must fail before any herdr call');
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
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    // Row 3 replaced $summary: every field the one-line summary carried now has
    // an owning row, so a fresh install must not write it back.
    assert.match(config, /\$facts/);
    assert.match(config, /\$alert/);
    assert.doesNotMatch(config, /\$summary/);
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

  // Herdr's documentation shows sidebar rows in comments. A config carrying a
  // commented-out example dead-ended the install: the token test matched it, so
  // the script said the row already existed, while the row regexes (which need a
  // real `[{ … }],` line) found nothing to insert below.
  it('install-sidebar-summary ignores a commented-out example row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-comment-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[ui]',
      '# example row you can copy:',
      '#   [{ token = "$summary", fg = "#89b4fa" }],',
      '',
    ].join('\n'));
    const result = runScript('install-sidebar-summary.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /\[ui\.sidebar\.agents\]/);
    assert.match(config, /\$ctx_bar_green/);
    // The user's comment is theirs; leave it alone.
    assert.match(config, /# example row you can copy:/);
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
    assert.match(fs.readFileSync(configPath, 'utf8'), /\$facts/);
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
    // The old installer could only APPEND, so this config came back with the new
    // rows stacked on the old ones and rendered MORE duplication. The $summary
    // row is now removed, which is the whole point of the migration.
    assert.doesNotMatch(config, /\$summary/);
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    assert.match(config, /\$facts/);
    assert.match(config, /\$alert/);
    // No marker → the old `["agent"]` is treated as user's own row.
    assert.match(config, /\["agent"\]/);
    assert.match(result.stdout, /superseded row removed: \$summary/);
    assert.match(result.stdout, /migrated sidebar summary rows/);
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
    assert.match(result.stdout, /migrated sidebar summary rows/);
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

  it('install and remove leave no temp files behind (atomic write guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    runScript('install-sidebar-summary.js', [], env);
    const afterInstall = fs.readdirSync(dir).filter(n => n.includes('ccxray-tmp'));
    assert.equal(afterInstall.length, 0, 'install left a temp file');
    runScript('remove-sidebar-summary.js', [], env);
    const afterRemove = fs.readdirSync(dir).filter(n => n.includes('ccxray-tmp'));
    assert.equal(afterRemove.length, 0, 'remove left a temp file');
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
    assert.match(config, /\$facts/);
    assert.match(config, /\$alert/);
    assert.match(config, /\$ctx_bar_unknown/);
    assert.match(config, /\$ctx_bar_green/);
    assert.match(config, /\$ctx_bar_yellow/);
    assert.match(config, /\$ctx_bar_red/);
    // No marker → legacy-looking rows are treated as user's own.
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
    assert.match(config, /\$facts/);
    assert.match(config, /\$ctx_bar_red/);
    // No marker: `["agent"]` is treated as user's own and survives both
    // removal and reinstall.
    assert.match(config, /\["agent"\]/);
    // One row each: a reinstall must not stack a second copy, which is the
    // add-only behaviour the migration replaced.
    assert.equal(config.match(/\$facts/g).length, 1);
    assert.equal(config.match(/\$alert/g).length, 1);
  });

  // Herdr's manifest cannot declare keybindings, so a plugin either documents a
  // snippet or writes it. These cover the write: it must be idempotent, must
  // never take a key the user already bound, and must remove exactly what it
  // added.
  it('install-keybindings adds both bindings with a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\nshow_agent_labels_on_pane_borders = true\n');
    const result = runScript('install-keybindings.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /key = "prefix\+m"/);
    assert.match(config, /key = "prefix\+shift\+m"/);
    assert.match(config, /command = "ccxray\.herdr\.mission-control"/);
    assert.match(config, /command = "ccxray\.herdr\.quick-start"/);
    assert.match(config, /type = "plugin_action"/);
    assert.match(config, /show_agent_labels_on_pane_borders/, 'must not clobber existing config');
    assert.match(result.stdout, /backup:/);
  });

  it('install-keybindings is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '');
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    assert.equal(runScript('install-keybindings.js', [], env).status, 0);
    const first = fs.readFileSync(configPath, 'utf8');
    const second = runScript('install-keybindings.js', [], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(configPath, 'utf8'), first);
    assert.match(second.stdout, /already installed/);
  });

  // Silently rebinding a key the user chose is worse than not installing: the
  // keypress they rely on would start doing something else with no message.
  it('install-keybindings refuses a key the user already bound elsewhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    const original = [
      '[[keys.command]]',
      'key = "prefix+m"',
      'type = "plugin_action"',
      'command = "someone.else.thing"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, original);
    const result = runScript('install-keybindings.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /command = "someone\.else\.thing"/);
    assert.equal(config.match(/key = "prefix\+m"/g).length, 1);
    assert.match(result.stderr, /already bound/);
    assert.match(result.stderr, /CCXRAY_HERDR_KEY_MISSION/);
    // The free key still installs; only the taken one is skipped.
    assert.match(config, /command = "ccxray\.herdr\.quick-start"/);

    // A partial install exits 0 (something WAS written) and names only what it
    // wrote on stdout. Quick Start must surface the stderr conflict alongside
    // it, or the row reports plain success while a key was skipped.
    assert.equal(result.status, 0, 'a partial install is not a failure');
    assert.match(result.stdout, /quick-start|prefix\+shift\+m/);
    assert.doesNotMatch(result.stdout, /prefix\+m →/, 'must not claim the skipped key');
  });

  // A PARTIAL install must keep offering install. Keying the row's action on
  // `any` made Enter remove the one binding that had succeeded, so the missing
  // one could never be added from the TUI.
  it('Quick Start still offers install when only one keybinding is present', () => {
    const { menuItems } = require('../plugins/herdr/bin/onboarding');
    const state = {
      ccxrayReady: true, hubRunning: true, sessions: 1, sidebar: true, providers: [],
      keys: { mission: null, quickStart: 'prefix+shift+m', any: true },
    };
    const row = menuItems(state).find(item => item.id === 'keybindings');
    assert.ok(row, 'the keybindings row exists');
    assert.match(row.detail, /Enter install/, 'partial state must offer install, not remove');
    assert.match(row.detail, /1 of 2/, 'and say that it is partial');

    const bothBound = menuItems({
      ...state,
      keys: { mission: 'prefix+m', quickStart: 'prefix+shift+m', any: true },
    }).find(item => item.id === 'keybindings');
    assert.match(bothBound.detail, /Enter remove/, 'only a complete install offers remove');
  });

  it('install-keybindings honours a key override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '');
    const result = runScript('install-keybindings.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
      CCXRAY_HERDR_KEY_MISSION: 'prefix+alt+i',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(configPath, 'utf8'), /key = "prefix\+alt\+i"/);
  });

  it('remove-keybindings removes only ccxray bindings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      '[[keys.command]]',
      'key = "prefix+u"',
      'type = "plugin_action"',
      'command = "someone.else.thing"',
      '',
    ].join('\n'));
    const env = { HERDR_CONFIG_PATH: configPath, CCXRAY_HERDR_SKIP_RELOAD: '1' };
    assert.equal(runScript('install-keybindings.js', [], env).status, 0);

    const removed = runScript('remove-keybindings.js', [], env);
    assert.equal(removed.status, 0, removed.stderr);
    const config = fs.readFileSync(configPath, 'utf8');
    assert.doesNotMatch(config, /ccxray\.herdr\./);
    assert.doesNotMatch(config, /ccxray keybindings \(managed/);
    assert.match(config, /command = "someone\.else\.thing"/);
    assert.match(config, /key = "prefix\+u"/);
  });

  it('remove-keybindings reports when nothing is installed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-herdr-keys-'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, '[ui]\n');
    const result = runScript('remove-keybindings.js', [], {
      HERDR_CONFIG_PATH: configPath,
      CCXRAY_HERDR_SKIP_RELOAD: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not installed/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '[ui]\n');
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
      .replace('  ["state_icon", "agent", "state_text"],',
        '  ["state_icon", "agent", "state_text"],\n  ["cwd"],');
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

// #543: statusReport (5s) + usageReport (12s) are pane-independent but were
// re-run by every fan-out child against the parent's 10s cap — a slow but
// healthy refresh got killed mid-write and the serial fan-out blocked startup
// for N × cap. The parent now runs both once and shares them; a child killed
// at the cap is reported as timed out, never folded into "failed" silently.
describe('refresh-all-badges shares the pane-independent reports (#543)', () => {
  function makeCountingCcxray({ failFirstUsage = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-counting-bin-'));
    const bin = path.join(dir, 'ccxray');
    const log = path.join(dir, 'calls.log');
    const marker = path.join(dir, 'usage-failed-once');
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === 'usage') {",
      ...(failFirstUsage ? [
        `  if (!fs.existsSync(${JSON.stringify(marker)})) {`,
        `    fs.writeFileSync(${JSON.stringify(marker)}, '1');`,
        "    process.stderr.write('transient failure\\n');",
        '    process.exit(1);',
        '  }',
      ] : []),
      "  process.stdout.write(JSON.stringify({ meta: { totalEntries: 0 }, sessions: {}, models: [] }) + '\\n');",
      "} else process.stdout.write('No hub running\\n');",
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log };
  }

  function makeFanoutHerdr(agents, { sleepMs = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fanout-herdr-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'args.log');
    const agentList = JSON.stringify({ id: 't', result: { type: 'agent_list', agents } });
    fs.writeFileSync(bin, [
      '#!/usr/bin/env node',
      `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === 'agent' && process.argv[3] === 'list') {",
      `  process.stdout.write(${JSON.stringify(agentList + '\n')});`,
      `} else if (${sleepMs}) {`,
      `  setTimeout(() => process.exit(0), ${sleepMs});`,
      '} else {',
      `  process.stdout.write(${JSON.stringify(JSON.stringify({ id: 't', result: { type: 'ok' } }) + '\n')});`,
      '}',
      '',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log };
  }

  const twoAgents = [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent_session: { kind: 'id', value: 'sess-1' } },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent_session: { kind: 'id', value: 'sess-2' } },
  ];
  // The third pane has no native session id — the parent's answer for it is
  // "none", and the child must trust that instead of re-listing.
  const threeAgents = [...twoAgents, { pane_id: 'w1:p3', workspace_id: 'w1' }];

  // FAIL-ON-OLD: pre-fix, each child runs `ccxray status` + `ccxray usage` and
  // its own `herdr agent list` — the counts below read 3/3/4 instead of 1/1/1.
  it('runs status, usage, and agent list once for the whole fan-out', () => {
    const ccxray = makeCountingCcxray();
    const herdr = makeFanoutHerdr(threeAgents);
    const result = runScript('refresh-all-badges.js', [], {
      CCXRAY_HOME: makeHome(),
      CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
      CCXRAY_BIN: ccxray.bin,
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 refreshed/);
    const ccxrayCalls = fs.readFileSync(ccxray.log, 'utf8').trim().split('\n');
    assert.equal(ccxrayCalls.filter(call => call.startsWith('usage')).length, 1,
      `expected one shared usage run, saw: ${ccxrayCalls.join(' | ')}`);
    assert.equal(ccxrayCalls.filter(call => call.startsWith('status')).length, 1,
      `expected one shared status run, saw: ${ccxrayCalls.join(' | ')}`);
    const herdrCalls = fs.readFileSync(herdr.log, 'utf8').trim().split('\n');
    assert.equal(herdrCalls.filter(call => call.startsWith('agent list')).length, 1,
      `children (including the no-session pane) must reuse the parent's agent list, saw: ${herdrCalls.join(' | ')}`);
  });

  // A transient parent failure must not be broadcast: the children whose
  // shared report is missing recompute their own (usage runs 1 failed + 2
  // recomputed = 3 times) and the badges still render from real data. A
  // version that shares failed reports runs usage once and paints every pane
  // "not linked".
  it('does not poison the fan-out when the parent usage report fails once', () => {
    const ccxray = makeCountingCcxray({ failFirstUsage: true });
    const herdr = makeFanoutHerdr(twoAgents);
    const result = runScript('refresh-all-badges.js', [], {
      CCXRAY_HOME: makeHome(),
      CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
      CCXRAY_BIN: ccxray.bin,
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 refreshed/);
    const ccxrayCalls = fs.readFileSync(ccxray.log, 'utf8').trim().split('\n');
    assert.equal(ccxrayCalls.filter(call => call.startsWith('usage')).length, 3,
      `each child must recompute the failed shared usage, saw: ${ccxrayCalls.join(' | ')}`);
  });

  // FAIL-ON-OLD: pre-fix the summary line had no timed-out bucket — a killed
  // child was indistinguishable from an honest non-zero exit.
  it('reports a child killed at the cap as timed out, not refreshed', () => {
    const ccxray = makeCountingCcxray();
    const herdr = makeFanoutHerdr(twoAgents.slice(0, 1), { sleepMs: 3000 });
    const result = runScript('refresh-all-badges.js', [], {
      CCXRAY_HOME: makeHome(),
      CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
      CCXRAY_BIN: ccxray.bin,
      HERDR_BIN_PATH: herdr.bin,
      CCXRAY_HERDR_NO_LAYOUT: '1',
      CCXRAY_BADGE_CHILD_TIMEOUT_MS: '500',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /0 refreshed, 1 timed out \(over 500ms\)/);
  });

  it('refresh-badges falls back to its own reports when the shared file is bad', () => {
    const ccxray = makeCountingCcxray();
    const bogus = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-bogus-shared-')), 'report.json');
    fs.writeFileSync(bogus, 'not json');
    const result = runScript('refresh-badges.js', [], {
      CCXRAY_HOME: makeHome(),
      CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
      CCXRAY_BIN: ccxray.bin,
      CCXRAY_BADGE_SHARED_REPORT: bogus,
    });
    assert.match(result.stdout, /ccxray badges refreshed/);
    const calls = fs.readFileSync(ccxray.log, 'utf8');
    assert.match(calls, /usage/, 'a bad shared file must fail open to a self-run usage report');
    assert.match(calls, /status/, 'a bad shared file must fail open to a self-run status report');
  });
});

// The E3 audit (handoff 2026-08-17): sessionSummaryDetails consults the Claude
// transcript tree, and an unset CCXRAY_IMPORT_HOMES means the developer's real
// $HOME/.claude*/projects (the #407 shape — green only because the real data
// happens to be empty). The #553 session fixed the call sites and verified
// 7 → 0 real-path accesses, but that instrumentation was evidence, not
// enforcement. This is the mechanism: same recursive-source-scan class as
// test/invariant-encapsulation.test.js. See ADR 0015 R4 and docs/testing.md.
describe('audit: sessionSummaryDetails call sites pin CCXRAY_IMPORT_HOMES', () => {
  it('every call whose opts set CCXRAY_HOME also sets CCXRAY_IMPORT_HOMES', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    const marker = 'sessionSummaryDetails(';
    const spans = [];
    let from = 0;
    for (;;) {
      const start = source.indexOf(marker, from);
      if (start === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = start + marker.length - 1; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      assert.notEqual(end, -1, `unbalanced parens after offset ${start}`);
      spans.push(source.slice(start, end + 1));
      from = end + 1;
    }
    assert.ok(spans.length >= 10, `expected the known call sites, found ${spans.length}`);
    for (const span of spans) {
      if (!span.includes('CCXRAY_HOME')) continue;
      assert.ok(span.includes('CCXRAY_IMPORT_HOMES'),
        `sessionSummaryDetails call sets CCXRAY_HOME without pinning CCXRAY_IMPORT_HOMES `
        + `(stats the developer's real transcripts):\n${span.slice(0, 200)}`);
    }
  });
});

describe('codex round 2 fixes', () => {
  const TOKEN = 'GMe19yT9nI3t6-8mYyCbTgCJJmUZlP3YPcfgDAVgZrY';
  // A fake `ccxray` that answers `secret upstream`. sh, not node: these mocks
  // are spawned inside the plugin's tight per-call budget.
  const fakeCcxray = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-secret-'));
    const bin = path.join(dir, 'ccxray');
    fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "secret" ]; then echo "${TOKEN}"; exit 0; fi\nexit 1\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  };

  // `--env KEY=VALUE` on `herdr tab create` OVERRIDES the inherited variable, so
  // assigning our headers dropped the user's. providers.js prepends; so must we.
  it('keeps the user own ANTHROPIC_CUSTOM_HEADERS when adding its own', () => {
    const { proxyEnvVars } = require('../plugins/herdr/bin/lib/ccxray');
    const vars = proxyEnvVars('claude', 5577, {
      paneId: 'w1:p1',
      skipAuth: true,
      env: pluginEnv({ ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: foo' }),
    });
    assert.match(vars.ANTHROPIC_CUSTOM_HEADERS, /X-Existing: foo/,
      'the user header must survive');
    assert.match(vars.ANTHROPIC_CUSTOM_HEADERS, /X-Ccxray-Agent-Id: herdr:w1:p1/);
    assert.ok(vars.ANTHROPIC_CUSTOM_HEADERS.indexOf('X-Existing')
      < vars.ANTHROPIC_CUSTOM_HEADERS.indexOf('X-Ccxray-Agent-Id'),
      'the user value is prepended, matching server/providers.js');
  });

  it('injects X-Ccxray-Auth into a claude launch', () => {
    const { proxyEnvVars } = require('../plugins/herdr/bin/lib/ccxray');
    const vars = proxyEnvVars('claude', 5577, {
      paneId: 'w1:p1',
      env: pluginEnv({ CCXRAY_BIN: fakeCcxray() }),
    });
    assert.match(vars.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Ccxray-Auth: ${TOKEN}`),
      'CCXRAY_LOOPBACK_REQUIRE_AUTH=1 returns 401 without this');
  });

  // Codex carries the credential in a model_providers block, not a header env
  // var — the shape server/providers.js uses, including its OPENAI_API_KEY gate.
  it('routes codex through a model_providers block carrying X-Ccxray-Auth', () => {
    const { codexAgentArgs } = require('../plugins/herdr/bin/lib/ccxray');
    const withKey = codexAgentArgs(5577, {
      env: pluginEnv({ CCXRAY_BIN: fakeCcxray(), OPENAI_API_KEY: 'sk-test' }),
    });
    assert.ok(withKey.some(a => a.includes(`http_headers={"X-Ccxray-Auth"="${TOKEN}"}`)),
      'an API-key codex launch must carry the credential');
    assert.ok(withKey.includes('model_provider="ccxray"'));

    // ChatGPT-OAuth mode (no OPENAI_API_KEY) resolves its provider differently,
    // so the legacy base-url form stays the fallback — same as providers.js.
    const noKey = codexAgentArgs(5577, { env: pluginEnv({ CCXRAY_BIN: fakeCcxray() }) });
    assert.ok(noKey.some(a => a.startsWith('openai_base_url=')), 'legacy fallback');
    assert.ok(!noKey.some(a => a.includes('X-Ccxray-Auth')));
  });

  // `--agent` was sent and never compared, so a changed agent on identical
  // tokens was skipped and Herdr kept the stale one.
  it('re-writes pane metadata when only the agent changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentchg-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    const pane = JSON.stringify({
      result: { pane: { pane_id: 'w1:p1', agent: 'claude', tokens: { ctx: '9%' }, state_labels: {}, scroll: {} } },
    });
    fs.writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'if [ "$2" = "get" ]; then', "cat <<'P_EOF'", pane, 'P_EOF', 'exit 0', 'fi',
      "echo '{\"result\":{\"ok\":true}}'",
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const env = pluginEnv({
      HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentchg-state-')),
    });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    const writes = () => fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('report-metadata')).length;

    // Same agent as the pane reports, identical tokens → nothing moved.
    const same = reportPaneTokens({ ctx: '9%' }, { env, agent: 'claude' });
    assert.equal(same.skipped, 'unchanged', 'an unchanged agent must still skip');
    assert.equal(writes(), 0);
    // A different agent with the same tokens must NOT be skipped.
    reportPaneTokens({ ctx: '9%' }, { env, agent: 'codex' });
    assert.equal(writes(), 1, 'a changed agent must reach Herdr');
  });

  // `[[keys.command]] # comment` is legal TOML. Missing it made the installer
  // believe the key was free and append a colliding duplicate.
  it('sees an existing binding whose header carries a TOML comment', () => {
    const { addBindings, boundKeyFor } = require('../plugins/herdr/bin/lib/keybindings');
    const config = [
      '[[keys.command]] # my own binding',
      'key = "prefix+m"',
      'command = "workspace.switch"',
      '',
    ].join('\n');
    assert.equal(boundKeyFor(config, 'workspace.switch'), 'prefix+m',
      'the commented block must parse');
    const result = addBindings(config, [
      { key: 'prefix+m', command: 'plugin.ccxray.mission-control', description: 'x' },
    ]);
    assert.equal(result.added.length, 0, 'must not append a duplicate prefix+m');
    assert.equal(result.conflicts.length, 1, 'the collision must be reported');
    assert.equal(result.conflicts[0].boundTo, 'workspace.switch');
  });

  // Detection timing out does not mean nothing started, so the routed record —
  // the only thing that links this pane's traffic to it — must survive.
  it('keeps the routed record when herdr agent start never detects', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r2-project-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r2-routed-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r2-failrun-'));
    const bin = path.join(dir, 'herdr');
    const opened = JSON.stringify({
      id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p9' }, tab: { tab_id: 'w1:t2' } },
    });
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "agent" ] && [ "$2" = "start" ]; then',
      '  echo "agent not detected" 1>&2; exit 1',
      'fi',
      "cat <<'O_EOF'", opened, 'O_EOF',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const result = runScript('launch-agent.js', ['codex'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      PROXY_PORT: '9999',
    });
    assert.equal(result.status, 1, 'an undetected agent is still a failed launch');
    const routed = path.join(stateDir, 'routed-panes-v1', `${encodeURIComponent('w1:p9')}.json`);
    assert.ok(fs.existsSync(routed),
      'the pane already carries the identity header, so its record must survive');
  });

  // INVARIANT(ADR 0017): the fallback badge renders an aggregate, so it needs
  // the fold. usage.js emitted none, so a wholly fallback-priced session
  // printed a clean number indistinguishable from an exact one.
  it('marks a fallback-priced session on the usage fallback path', () => {
    const { sessionSummaryDetails } = require('../plugins/herdr/bin/lib/ccxray');
    const data = {
      sessions: {
        topSessions: [{
          sessionId: 'fb-1', turns: 4, cost: 2, durationMin: 10, model: 'claude-opus-5',
          costAgg: { count: 4, fallbackCount: 4, fallbackCost: 2, unknownCount: 0 },
        }],
      },
      meta: { totalCost: 2, totalEntries: 4 },
    };
    const badge = sessionSummaryDetails(data, {
      env: pluginEnv({ CCXRAY_HOME: makeHome([]), CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS }),
      cwd: '/work/nowhere',
    });
    assert.match(badge.costText, /~/, 'an all-fallback total must carry the marker');
  });

  it('server/usage.js emits the confidence fold beside every top-session cost', () => {
    const { analyze } = require('../server/usage.js');
    const base = {
      sessionId: 's-fold', model: 'claude-opus-5', provider: 'anthropic',
      receivedAt: 1787000000000, usage: { input_tokens: 10, output_tokens: 1 },
    };
    const summary = analyze([
      { ...base, id: 'f1', cost: { cost: 1, confidence: 'fallback' } },
      { ...base, id: 'f2', cost: { cost: null, confidence: 'unknown' } },
      { ...base, id: 'f3', cost: { cost: 1, confidence: 'exact' } },
    ]);
    const top = summary.sessions.topSessions.find(s => s.sessionId === 's-fold');
    assert.ok(top, 'the session must be in topSessions');
    assert.deepEqual(top.costAgg,
      { count: 3, fallbackCount: 1, fallbackCost: 1, unknownCount: 1 },
      'a consumer cannot re-derive this — it cannot see the turns');
  });

  // Every keybinding test sets CCXRAY_HERDR_SKIP_RELOAD=1, which returns before
  // `config check`, so the restore-on-reject path had no coverage at all.
  it('restores the user config when Herdr rejects the written one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-reject-'));
    const configPath = path.join(dir, 'herdr.toml');
    const original = '# the user own config\n[[keys.command]]\nkey = "prefix+z"\ncommand = "mine"\n';
    fs.writeFileSync(configPath, original);
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    // Rejects `config check`; anything else succeeds.
    fs.writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'if [ "$1" = "config" ] && [ "$2" = "check" ]; then',
      '  echo "invalid keybinding" 1>&2; exit 1',
      'fi',
      'echo "{}"',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);

    const { writeConfigAndReload } = require('../plugins/herdr/bin/lib/ccxray');
    const status = writeConfigAndReload(configPath, original, `${original}\n[[keys.command]]\nkey = "bad"\n`, {
      env: pluginEnv({ HERDR_BIN_PATH: bin }),
    });
    // Assert the FAKE was reached, not just that a restore happened: with the
    // pre-fix code (env never passed to runHerdr) the real herdr ran instead,
    // and on a machine where it is missing or its own config is invalid the
    // check also fails, the file is also restored, and both assertions below
    // pass for entirely the wrong reason.
    assert.ok(fs.existsSync(log), 'HERDR_BIN_PATH must be the binary that ran');
    assert.match(fs.readFileSync(log, 'utf8'), /config check/,
      'the injected herdr must be the one asked to validate');
    assert.equal(status, 1, 'a rejected config must not report success');
    assert.equal(fs.readFileSync(configPath, 'utf8'), original,
      'the user config must be byte-identical after a rejection');
  });
});

describe('codex round 3 fixes', () => {
  const TOKEN = 'GMe19yT9nI3t6-8mYyCbTgCJJmUZlP3YPcfgDAVgZrY';
  // Records every invocation so a test can assert a lookup did NOT happen.
  const recordingCcxray = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r3-secret-'));
    const bin = path.join(dir, 'ccxray');
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'if [ "$1" = "secret" ]; then', `echo "${TOKEN}"`, 'exit 0', 'fi', 'exit 1',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
  };

  // `contextPercents` DROPS turns with no usage, so the last finite percentage
  // can belong to an older turn. The badge reads the latest anchored turn
  // directly and shows `?`; Mission Control reported the stale number.
  it('reports no ctx% when the latest main turn carries no usage', () => {
    const base = {
      sessionId: 's-nousage', provider: 'anthropic', cwd: '/work/nousage',
      agentId: 'herdr:w1:p1', agentKey: 'orchestrator', isSubagent: false,
      model: 'claude-opus-5', maxContext: 200000, cost: { cost: 0.01, confidence: 'exact' },
    };
    const home = makeHome([
      { ...base, id: 'n1', responseId: 'msg_n1', receivedAt: 1787000001000, usage: { input_tokens: 2000, output_tokens: 10 } },
      // Latest main turn, no usage at all — a real shape for an errored turn.
      { ...base, id: 'n2', responseId: 'msg_n2', receivedAt: 1787000002000 },
    ]);
    const env = pluginEnv({ CCXRAY_HOME: home, CCXRAY_HERDR_NOW_MS: '1787000003000' });
    const { sessionSummaryDetails, missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');

    const badge = sessionSummaryDetails({}, { env, paneId: 'w1:p1', cwd: '/work/nousage' });
    const snapshot = missionControlSnapshot({
      env,
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });
    assert.equal(badge.ctxPct, null, 'the badge cannot know this turn context');
    assert.equal(snapshot.rows[0].ctxPct, null,
      'Mission Control must not substitute an older turn percentage');
  });

  // The comparison set must cover every non-token arg report-metadata accepts.
  // `title` and `display_agent` are absent from `pane get` until set, which is
  // why one reading of an unset pane looked like herdr reported neither.
  it('re-writes pane metadata when only the title or display agent changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r3-meta-'));
    const bin = path.join(dir, 'herdr');
    const log = path.join(dir, 'calls.log');
    const pane = JSON.stringify({
      result: {
        pane: {
          pane_id: 'w1:p1', agent: 'claude', title: 'old title',
          display_agent: 'Claude Code', tokens: { ctx: '9%' }, state_labels: {}, scroll: {},
        },
      },
    });
    fs.writeFileSync(bin, [
      '#!/bin/sh', `echo "$@" >> "${log}"`,
      'if [ "$2" = "get" ]; then', "cat <<'P_EOF'", pane, 'P_EOF', 'exit 0', 'fi',
      "echo '{\"result\":{\"ok\":true}}'",
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const env = pluginEnv({
      HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r3-meta-state-')),
    });
    const { reportPaneTokens } = require('../plugins/herdr/bin/lib/ccxray');
    const writes = () => fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('report-metadata')).length;
    const opts = { env, agent: 'claude', title: 'old title', displayAgent: 'Claude Code' };

    assert.equal(reportPaneTokens({ ctx: '9%' }, opts).skipped, 'unchanged',
      'everything matching the pane must still skip');
    assert.equal(writes(), 0);
    reportPaneTokens({ ctx: '9%' }, { ...opts, title: 'new title' });
    assert.equal(writes(), 1, 'a changed title must reach Herdr');
    reportPaneTokens({ ctx: '9%' }, { ...opts, displayAgent: 'Codex' });
    assert.equal(writes(), 2, 'a changed display agent must reach Herdr');
  });

  // The lookup spawns `ccxray secret upstream`, which can derive and persist a
  // secret and carries a 4s timeout. Only the claude branch consumes it.
  it('does not look up the upstream secret for agents that cannot carry it', () => {
    const { proxyEnvVars } = require('../plugins/herdr/bin/lib/ccxray');
    for (const agent of ['grok', 'codex']) {
      const rec = recordingCcxray();
      proxyEnvVars(agent, 5577, { paneId: 'w1:p1', env: pluginEnv({ CCXRAY_BIN: rec.bin }) });
      assert.doesNotMatch(rec.calls(), /secret/,
        `${agent} has no header to put the token in, so it must not fetch one`);
    }
    // The claude branch still does.
    const rec = recordingCcxray();
    proxyEnvVars('claude', 5577, { paneId: 'w1:p1', env: pluginEnv({ CCXRAY_BIN: rec.bin }) });
    assert.match(rec.calls(), /secret upstream/, 'claude carries it in a header');
  });

  // `--plan` must stay a pure描述 of what a launch WOULD do: no secret derived,
  // nothing written. skipAuth is what guarantees that, and nothing pinned it.
  it('the --plan path derives no secret', () => {
    const rec = recordingCcxray();
    const result = runScript('launch-agent.js', ['claude', '--plan'], {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_id: 'w1:p1',
        focused_pane_cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-r3-plan-')),
        workspace_id: 'w1',
        tab_id: 'w1:t1',
      }),
      HERDR_BIN_PATH: makeHerdr([]),
      CCXRAY_BIN: rec.bin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(rec.calls(), /secret/, 'planning must not mint a credential');
  });
});

describe('codex round 4 fixes', () => {
  // "seen" is EVIDENCE freshness. Built from main-only `latestAt`, the Mission
  // Control row called a pane stale while its subagent was actively working,
  // while the badge's evidenceStaleness (which reads every turn) called it
  // fresh — the ADR 0005 contract says this figure must agree.
  it('a recent subagent turn keeps the Mission Control row fresh', () => {
    const T = 1787000000000;
    const base = {
      sessionId: 's-fresh', provider: 'anthropic', cwd: '/work/fresh',
      agentId: 'herdr:w1:p1', model: 'claude-opus-5', maxContext: 200000,
      usage: { input_tokens: 1000, output_tokens: 10 }, cost: { cost: 0.01, confidence: 'exact' },
    };
    const home = makeHome([
      // Main turn two hours ago.
      { ...base, id: 'f1', responseId: 'msg_f1', receivedAt: T, agentKey: 'orchestrator', isSubagent: false },
      // Subagent turn one minute ago — ccxray is plainly still watching.
      { ...base, id: 'f2', responseId: 'msg_f2', receivedAt: T + 7140000, agentKey: 'general-purpose', isSubagent: true },
    ]);
    const nowMs = T + 7200000; // 2h after the main turn, 1m after the subagent
    const { missionControlSnapshot } = require('../plugins/herdr/bin/lib/ccxray');
    const snapshot = missionControlSnapshot({
      env: pluginEnv({ CCXRAY_HOME: home, CCXRAY_HERDR_NOW_MS: String(nowMs) }),
      agentReport: { ok: true, agents: [{
        pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude',
        agent_status: 'recent', workspace_id: 'w1', agent_session: { kind: 'none' },
      }] },
    });
    assert.equal(snapshot.rows.length, 1);
    assert.doesNotMatch(snapshot.rows[0].freshness, /h$/,
      `seen must not report hours while a subagent ran a minute ago (got ${snapshot.rows[0].freshness})`);
  });
});
