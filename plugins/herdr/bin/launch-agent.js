#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  herdrRuntime,
  parseJsonOutput,
  pluginRoot,
  reportPaneTokens,
  runHerdr,
} = require('./lib/ccxray');

const SUPPORTED = new Set(['claude', 'codex', 'grok']);

function parseArgs(argv) {
  return {
    agent: argv[0],
    planOnly: argv.includes('--plan') || process.env.CCXRAY_HERDR_LAUNCH_PLAN === '1',
    direction: process.env.CCXRAY_HERDR_LAUNCH_DIRECTION || 'right',
    ratio: process.env.CCXRAY_HERDR_LAUNCH_RATIO || '0.5',
  };
}

function context(env = process.env) {
  const runtime = herdrRuntime(env);
  const ctx = runtime.context || {};
  return {
    runtime,
    sourcePaneId: ctx.focused_pane_id || runtime.paneId || '',
    cwd: ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd(),
    workspaceId: ctx.workspace_id || runtime.workspaceId || '',
    tabId: ctx.tab_id || runtime.tabId || '',
  };
}

function splitArgs(args, ctx) {
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
  const plannedSplit = splitArgs(args, ctx);

  if (args.planOnly) {
    console.log(JSON.stringify({
      agent: args.agent,
      split: plannedSplit,
      cwd: ctx.cwd,
      sourcePaneId: ctx.sourcePaneId || null,
      workspaceId: ctx.workspaceId || null,
      tabId: ctx.tabId || null,
    }, null, 2));
    process.exit(0);
  }

  const split = runHerdr(plannedSplit, { timeoutMs: 5000 });
  const splitData = parseJsonOutput(split.stdout);
  const paneId = splitData?.result?.pane?.pane_id;
  if (!paneId) {
    process.stderr.write(split.stderr || split.stdout || 'Failed to split Herdr pane.\n');
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

  const command = runnerCommand(args.agent, paneId, ctx);
  const run = runHerdr(['pane', 'run', paneId, ...command], { timeoutMs: 3000 });
  if (run.status !== 0 || run.error) {
    process.stderr.write(run.stderr || run.stdout || run.error?.message || 'Failed to run launcher command.\n');
    process.exit(1);
  }

  console.log(`ccxray ${args.agent} launch pane: ${paneId}`);
  console.log(`cwd: ${ctx.cwd}`);
  console.log(`identity: herdr:${paneId}`);
}

main();
