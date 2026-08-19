#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  codexAgentArgs,
  currentWorkspaceScope,
  ensureProxy,
  herdrRuntime,
  proxyEnvVars,
  pluginStateDir,
  recordRoutedPane,
  reportPaneTokens,
  runHerdr,
} = require('./lib/ccxray');

function log(msg) {
  try {
    const dir = pluginStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'launch.log'), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

const SUPPORTED = new Set(['claude', 'codex', 'grok']);

// Maps our agent ids to herdr's --kind values. They happen to match today, but
// herdr's list is theirs to change.
const HERDR_KIND = { claude: 'claude', codex: 'codex', grok: 'grok' };

function parseArgs(argv) {
  return {
    agent: argv[0],
    planOnly: argv.includes('--plan') || process.env.CCXRAY_HERDR_LAUNCH_PLAN === '1',
    placement: process.env.CCXRAY_HERDR_LAUNCH_PLACEMENT === 'split' ? 'split' : 'tab',
    direction: process.env.CCXRAY_HERDR_LAUNCH_DIRECTION || 'right',
    ratio: process.env.CCXRAY_HERDR_LAUNCH_RATIO || '0.5',
    proxyPort: (process.env.PROXY_PORT || '').trim(),
  };
}

function parseProxyPort(raw) {
  if (!raw) return null;
  if (!/^\d{1,5}$/.test(raw)) return NaN;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : NaN;
}

// INVARIANT: the launch directory comes from currentWorkspaceScope(), the same
// resolver Quick Start displays and every other pane-scoped reader uses. It
// rejects paths inside the plugin's own checkout and recovers the workspace cwd
// instead.
function context(env = process.env) {
  const runtime = herdrRuntime(env);
  const ctx = runtime.context || {};
  return {
    runtime,
    sourcePaneId: ctx.focused_pane_id || runtime.paneId || '',
    cwd: currentWorkspaceScope(env).cwd || '',
    workspaceId: ctx.workspace_id || runtime.workspaceId || '',
    tabId: ctx.tab_id || runtime.tabId || '',
  };
}

function openArgs(args, ctx, envVars) {
  const out = args.placement === 'tab'
    ? (() => {
        const a = ['tab', 'create'];
        if (ctx.workspaceId) a.push('--workspace', ctx.workspaceId);
        a.push('--cwd', ctx.cwd, '--label', `ccxray ${args.agent}`, '--focus');
        return a;
      })()
    : (() => {
        const a = ['pane', 'split'];
        if (ctx.sourcePaneId) a.push('--pane', ctx.sourcePaneId);
        else a.push('--current');
        a.push('--direction', args.direction, '--ratio', args.ratio, '--cwd', ctx.cwd, '--focus');
        return a;
      })();
  for (const [key, value] of Object.entries(envVars)) {
    out.push('--env', `${key}=${value}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPPORTED.has(args.agent)) {
    console.error(`Unsupported agent "${args.agent || ''}". Expected claude, codex, or grok.`);
    process.exit(2);
  }
  const requestedPort = parseProxyPort(args.proxyPort);
  if (Number.isNaN(requestedPort)) {
    console.error(`Invalid PROXY_PORT "${args.proxyPort}" — expected a port number (1-65535).`);
    process.exit(2);
  }
  const ctx = context();
  if (!ctx.cwd) {
    console.error('No project directory for this workspace; focus a pane inside your project, then launch again.');
    process.exit(1);
  }

  const env = requestedPort
    ? { ...process.env, PROXY_PORT: String(requestedPort) }
    : process.env;

  if (args.planOnly) {
    const examplePort = requestedPort || 5577;
    console.log(JSON.stringify({
      agent: args.agent,
      placement: args.placement,
      cwd: ctx.cwd,
      port: examplePort,
      envVars: proxyEnvVars(args.agent, examplePort, env),
      codexArgs: args.agent === 'codex' ? codexAgentArgs(examplePort) : null,
      sourcePaneId: ctx.sourcePaneId || null,
      workspaceId: ctx.workspaceId || null,
    }, null, 2));
    process.exit(0);
  }

  log(`start agent=${args.agent} cwd=${ctx.cwd}`);
  // 1. Ensure a ccxray proxy is running. An explicit port skips discovery
  //    (testing, or the user knows their proxy is already up).
  const port = requestedPort || ensureProxy({ env, cwd: ctx.cwd });
  if (!port) {
    console.error('Could not start the ccxray proxy. Run `ccxray` in a separate terminal, then try again.');
    process.exit(1);
  }

  // 2. Generate a stable launch id for this pane — paneId is not known until
  //    after tab creation, but the env vars must be set at creation time.
  const launchId = `herdr-${Date.now().toString(36)}`;

  log(`port=${port} launchId=${launchId}`);
  // 3. Compute the env vars that route this agent through the proxy.
  const envVars = proxyEnvVars(args.agent, port, { paneId: launchId });

  // 4. Create a pane with the proxy env vars injected.
  const opened = runHerdr(openArgs(args, ctx, envVars), { timeoutMs: 5000 });
  const paneId = opened.parsed?.result?.root_pane?.pane_id || opened.parsed?.result?.pane?.pane_id;
  if (!paneId) {
    process.stderr.write(opened.stderr || opened.stdout || opened.error?.message || 'Failed to create the Herdr agent pane.\n');
    process.exit(1);
  }

  // 4. Start the agent with retries. `herdr agent start` rejects immediately
  //    with "not an available shell" when the pane's shell is still running its
  //    rc file (.zshrc/.bashrc). It does not wait for readiness on its own, so
  //    we retry with back-off until the shell is idle or we exhaust attempts.
  const agentName = `ccxray-${args.agent}-${paneId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const agentArgs = ['agent', 'start', agentName, '--kind', HERDR_KIND[args.agent], '--pane', paneId, '--timeout', '45000'];
  if (args.agent === 'codex') agentArgs.push('--', ...codexAgentArgs(port));

  let started, startedData, detected;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) spawnSync('sleep', [String(attempt < 3 ? 1 : 2)]);
    started = runHerdr(agentArgs, { timeoutMs: 50000 });
    detected = started.parsed?.result?.agent?.agent;
    log(`attempt=${attempt} detected=${detected} err=${started.parsed?.error?.code || ''}`);
    if (detected) break;
    const err = started.parsed?.error?.code || '';
    if (err !== 'agent_pane_busy') break;
  }

  if (!detected) {
    process.stderr.write(
      started.stderr || started.stdout || started.error?.message
      || `herdr agent start did not detect ${args.agent} in ${paneId}.\n`
    );
    process.exit(1);
  }

  // 5. Record identity for badge linkage + mark the sidebar.
  log(`recording routed pane=${paneId} launchId=${launchId}`);
  recordRoutedPane(paneId, args.agent, process.env, { launchId });
  reportPaneTokens({ xray: 'traced', agent: args.agent, summary: `ccxray: traced · ${args.agent}` }, {
    env: { ...process.env, HERDR_PANE_ID: paneId },
    stateLabels: {
      unknown: `ccxray: traced · ${args.agent}`,
      idle: `ccxray: traced · send prompt`,
      working: `ccxray: traced · ${args.agent}`,
      blocked: `ccxray: traced · ${args.agent}`,
      done: `ccxray: traced · ${args.agent}`,
    },
  });

  console.log(`ccxray ${args.agent} via herdr agent start: ${paneId}`);
  console.log(`placement: ${args.placement}`);
  console.log(`cwd: ${ctx.cwd}`);
  console.log(`proxy: localhost:${port}`);
  console.log(`herdr agent: ${agentName}`);
}

main();
