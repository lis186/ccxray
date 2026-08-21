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

  // The pane-identity token this launch will stamp on its traffic. Minted here
  // rather than after tab creation because `--env` is fixed at `herdr tab
  // create` time and paneId is what that command RETURNS.
  //
  // INVARIANT: the token carries the workspace id, because the reader side
  // (`filterEntriesToWorkspace`) treats any `herdr:`-prefixed agentId as
  // already attributed and keeps it only when it starts with
  // `herdr:<workspaceId>:` — the `startsWith('herdr:')` branch skips the cwd
  // fallback entirely, so a workspace-less stamp is dropped rather than
  // recovered, and Quick Start / Mission Control see no turns at all.
  // The pid suffix keeps two launches in the same millisecond distinct.
  const launchToken = [ctx.workspaceId, `herdr-${Date.now().toString(36)}-${process.pid.toString(36)}`]
    .filter(Boolean).join(':');

  if (args.planOnly) {
    const examplePort = requestedPort || 5577;
    console.log(JSON.stringify({
      agent: args.agent,
      placement: args.placement,
      cwd: ctx.cwd,
      port: examplePort,
      launchToken,
      envVars: proxyEnvVars(args.agent, examplePort, { paneId: launchToken, skipAuth: true }),
      codexArgs: args.agent === 'codex' ? codexAgentArgs(examplePort, { skipAuth: true }) : null,
      sourcePaneId: ctx.sourcePaneId || null,
      workspaceId: ctx.workspaceId || null,
    }, null, 2));
    process.exit(0);
  }

  log(`start agent=${args.agent} cwd=${ctx.cwd}`);
  // 1. Ensure a ccxray proxy is running.
  //
  // PROXY_PORT does NOT skip this. Its documented meaning — and the meaning
  // every port-occupant hint in server/hub.js offers it as — is "move the hub
  // to this port", i.e. discovery AND fork happen there; `--port` is the flag
  // that opts out of hub mode. Skipping ensureProxy turned it into "point the
  // agent at this port and hope", so `PROXY_PORT=5600` handed the agent
  // ANTHROPIC_BASE_URL=localhost:5600 with nothing listening and reported
  // success. The port is already plumbed: config.PORT reads PROXY_PORT, and
  // `env` carries it, so both `ccxray status` and the server we start resolve
  // to it without a second parameter.
  const port = ensureProxy({ env, cwd: ctx.cwd });
  if (!port) {
    console.error('Could not start the ccxray proxy. Run `ccxray` in a separate terminal, then try again.');
    process.exit(1);
  }

  log(`port=${port} launchToken=${launchToken}`);
  // 3. Compute the env vars that route this agent through the proxy.
  const envVars = proxyEnvVars(args.agent, port, { paneId: launchToken, env });

  // 4. Create a pane with the proxy env vars injected.
  const opened = runHerdr(openArgs(args, ctx, envVars), { timeoutMs: 5000 });
  const paneId = opened.parsed?.result?.root_pane?.pane_id || opened.parsed?.result?.pane?.pane_id;
  if (!paneId) {
    process.stderr.write(opened.stderr || opened.stdout || opened.error?.message || 'Failed to create the Herdr agent pane.\n');
    process.exit(1);
  }

  // 5. Record identity for badge linkage — BEFORE starting the agent, not
  //    after. The pane now exists with the identity header already injected, so
  //    anything it sends carries this launch token; the record is what lets the
  //    badge and Mission Control attribute that traffic to this pane.
  //
  //    Recording after `agent start` meant the `!detected` exit below dropped
  //    it, which is the worst case to drop it in: detection timing out does NOT
  //    mean nothing started — the agent may be running and tracing fine — and
  //    without the record that pane renders as "no ccxray telemetry" forever.
  //    If the agent genuinely never starts, no traffic ever carries the token
  //    and the record is inert.
  log(`recording routed pane=${paneId} launchToken=${launchToken}`);
  // Store the SAME token the header carried: sessionSummaryDetails rebuilds the
  // agentId as `herdr:${launchId}`, so the two must be byte-identical.
  recordRoutedPane(paneId, args.agent, process.env, { launchId: launchToken });

  // 6. Start the agent with retries. `herdr agent start` rejects immediately
  //    with "not an available shell" when the pane's shell is still running its
  //    rc file (.zshrc/.bashrc). It does not wait for readiness on its own, so
  //    we retry with back-off until the shell is idle or we exhaust attempts.
  const agentName = `ccxray-${args.agent}-${paneId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const agentArgs = ['agent', 'start', agentName, '--kind', HERDR_KIND[args.agent], '--pane', paneId, '--timeout', '45000'];
  if (args.agent === 'codex') agentArgs.push('--', ...codexAgentArgs(port, { env }));

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

  // 7. Mark the sidebar. Unlike the routed record above this stays on the
  //    success path: it claims the agent is up, which is exactly what a failed
  //    detection leaves in doubt.
  reportPaneTokens({ xray: 'traced', agent: args.agent, summary: `ccxray: traced · ${args.agent}` }, {
    // A pane created seconds ago holds nothing to compare against.
    force: true,
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
