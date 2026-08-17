#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { herdrAgentReport, statusReport, usageReport } = require('./lib/ccxray');

function childTimeoutMs(env = process.env) {
  const value = Number(env.CCXRAY_BADGE_CHILD_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 100 ? value : 10000;
}

function main() {
  const report = herdrAgentReport({ env: process.env, timeoutMs: 3000 });
  if (!report.ok) {
    console.log('ccxray sidebar sync skipped: Herdr agent list unavailable');
    process.exit(0);
  }

  const agents = report.agents.filter(agent => agent.pane_id);
  if (!agents.length) {
    console.log('ccxray sidebar sync: 0 refreshed');
    process.exit(0);
  }

  // #543: statusReport (5s) + usageReport (12s) are pane-independent, but each
  // child used to re-run both — alone already over the per-child cap below, so
  // a slow-but-healthy refresh was killed mid-write. The wall-clock budget
  // belongs to this layer (serial fan-out: the user waits N × cap), so instead
  // of raising the cap we run the shared reports once and hand the result to
  // every child. The children's own per-call timeouts remain as defense
  // against a hung CLI, not as a budget.
  const shared = {
    status: statusReport(),
    usage: usageReport({ last: process.env.CCXRAY_HERDR_LAST || '24h' }),
  };
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-badge-shared-'));
  const sharedFile = path.join(sharedDir, 'report.json');
  fs.writeFileSync(sharedFile, JSON.stringify(shared));

  const timeoutMs = childTimeoutMs();
  let refreshed = 0;
  let failed = 0;
  let timedOut = 0;
  try {
    for (const agent of agents) {
      const context = {
        focused_pane_id: agent.pane_id,
        focused_pane_cwd: agent.foreground_cwd || agent.cwd || null,
        workspace_id: agent.workspace_id || null,
        tab_id: agent.tab_id || null,
        // We already hold the agent list; passing the session spares each
        // child its own `herdr agent list` round trip.
        agent_session: agent.agent_session || null,
      };
      const result = spawnSync(process.execPath, [path.join(__dirname, 'refresh-badges.js')], {
        env: {
          ...process.env,
          HERDR_PANE_ID: agent.pane_id,
          HERDR_WORKSPACE_ID: agent.workspace_id || '',
          HERDR_TAB_ID: agent.tab_id || '',
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
          CCXRAY_BADGE_EVENT_DELAY_MS: '0',
          CCXRAY_BADGE_SHARED_REPORT: sharedFile,
        },
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      if (result.status === 0) refreshed++;
      // A killed child never got to report what it knows (refresh-badges's own
      // exit code is honest since #553); say "timed out", not just "failed".
      else if (result.error && result.error.code === 'ETIMEDOUT') timedOut++;
      else failed++;
    }
  } finally {
    try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch {}
  }

  const parts = [`${refreshed} refreshed`];
  if (failed) parts.push(`${failed} failed`);
  if (timedOut) parts.push(`${timedOut} timed out (over ${timeoutMs}ms)`);
  console.log(`ccxray sidebar sync: ${parts.join(', ')}`);
  process.exit(failed || timedOut ? 1 : 0);
}

main();
