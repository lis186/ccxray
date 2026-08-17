#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  currentWorkspaceScope,
  herdrRuntime,
  parseJsonOutput,
  pluginRoot,
  forgetRoutedPane,
  recordRoutedPane,
  reportPaneTokens,
  runHerdr,
} = require('./lib/ccxray');

const SUPPORTED = new Set(['claude', 'codex', 'grok']);

function parseArgs(argv) {
  return {
    agent: argv[0],
    planOnly: argv.includes('--plan') || process.env.CCXRAY_HERDR_LAUNCH_PLAN === '1',
    placement: process.env.CCXRAY_HERDR_LAUNCH_PLACEMENT === 'split' ? 'split' : 'tab',
    direction: process.env.CCXRAY_HERDR_LAUNCH_DIRECTION || 'right',
    ratio: process.env.CCXRAY_HERDR_LAUNCH_RATIO || '0.5',
  };
}

// INVARIANT: the launch directory comes from currentWorkspaceScope(), the same
// resolver Quick Start displays and every other pane-scoped reader uses. It
// rejects paths inside the plugin's own checkout and recovers the workspace cwd
// instead. Falling back to process.cwd() here would start the agent inside the
// Herdr-managed plugin checkout, which reinstalling replaces.
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

function openArgs(args, ctx) {
  if (args.placement === 'tab') {
    const out = ['tab', 'create'];
    if (ctx.workspaceId) out.push('--workspace', ctx.workspaceId);
    out.push('--cwd', ctx.cwd, '--label', `ccxray ${args.agent}`, '--focus');
    return out;
  }
  const out = ['pane', 'split'];
  if (ctx.sourcePaneId) out.push('--pane', ctx.sourcePaneId);
  else out.push('--current');
  out.push('--direction', args.direction, '--ratio', args.ratio, '--cwd', ctx.cwd, '--focus');
  return out;
}

function runnerCommand(agent, paneId, ctx) {
  const override = process.env.CCXRAY_HERDR_LAUNCH_COMMAND_JSON;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length && parsed.every(p => typeof p === 'string')) return parsed;
    } catch {}
  }
  return [
    process.execPath,
    path.join(pluginRoot(), 'bin', 'run-agent.js'),
    agent,
    paneId,
    ctx.workspaceId,
    ctx.tabId,
    ctx.sourcePaneId,
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPPORTED.has(args.agent)) {
    console.error(`Unsupported agent "${args.agent || ''}". Expected claude, codex, or grok.`);
    process.exit(2);
  }
  const ctx = context();
  if (!ctx.cwd) {
    console.error('No project directory for this workspace; focus a pane inside your project, then launch again.');
    process.exit(1);
  }
  const plannedOpen = openArgs(args, ctx);

  if (args.planOnly) {
    console.log(JSON.stringify({
      agent: args.agent,
      open: plannedOpen,
      placement: args.placement,
      cwd: ctx.cwd,
      sourcePaneId: ctx.sourcePaneId || null,
      workspaceId: ctx.workspaceId || null,
      tabId: ctx.tabId || null,
    }, null, 2));
    process.exit(0);
  }

  const opened = runHerdr(plannedOpen, { timeoutMs: 5000 });
  const openedData = parseJsonOutput(opened.stdout);
  const paneId = openedData?.result?.root_pane?.pane_id || openedData?.result?.pane?.pane_id;
  if (!paneId) {
    process.stderr.write(opened.stderr || opened.stdout || opened.error?.message || 'Failed to create the Herdr agent pane.\n');
    process.exit(1);
  }

  runHerdr(['pane', 'rename', paneId, `ccxray ${args.agent}`], { timeoutMs: 3000 });
  const summary = `launching ${args.agent} via ccxray`;
  reportPaneTokens({ xray: 'launching', agent: args.agent, summary }, {
    env: { ...process.env, HERDR_PANE_ID: paneId },
    stateLabels: {
      unknown: summary,
      idle: summary,
      working: summary,
      blocked: summary,
      done: summary,
    },
    ttlMs: 30000,
  });

  const command = runnerCommand(args.agent, paneId, {
    ...ctx,
    tabId: openedData?.result?.tab?.tab_id || ctx.tabId,
  });
  recordRoutedPane(paneId, args.agent);
  const run = runHerdr(['pane', 'run', paneId, ...command], { timeoutMs: 3000 });
  // A timeout is an unknown outcome, not a failure: Herdr may already have
  // started the command. Forgetting the routed record here is the harmful
  // choice — if the pane did start, nothing would recognise it as ours until
  // its first trace lands. Keep the record, say plainly that we could not
  // confirm, and still exit non-zero so nothing downstream assumes success.
  if (run.timedOut) {
    process.stderr.write(
      `Could not confirm the launcher started in ${paneId} within 3s. `
      + 'The pane may still come up; its identity is preserved either way.\n',
    );
    process.exit(1);
  }
  if (run.status !== 0 || run.error) {
    forgetRoutedPane(paneId);
    process.stderr.write(run.stderr || run.stdout || run.error?.message || 'Failed to run launcher command.\n');
    process.exit(1);
  }

  console.log(`ccxray ${args.agent} launch pane: ${paneId}`);
  console.log(`placement: ${args.placement}`);
  console.log(`cwd: ${ctx.cwd}`);
  console.log(`identity: herdr:${paneId}`);
}

main();
