#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { herdrAgentReport } = require('./lib/ccxray');

function main() {
  const report = herdrAgentReport({ env: process.env, timeoutMs: 3000 });
  if (!report.ok) {
    console.log('ccxray sidebar sync skipped: Herdr agent list unavailable');
    process.exit(0);
  }

  let refreshed = 0;
  let failed = 0;
  for (const agent of report.agents) {
    if (!agent.pane_id) continue;
    const context = {
      focused_pane_id: agent.pane_id,
      focused_pane_cwd: agent.foreground_cwd || agent.cwd || null,
      workspace_id: agent.workspace_id || null,
      tab_id: agent.tab_id || null,
    };
    const result = spawnSync(process.execPath, [path.join(__dirname, 'refresh-badges.js')], {
      env: {
        ...process.env,
        HERDR_PANE_ID: agent.pane_id,
        HERDR_WORKSPACE_ID: agent.workspace_id || '',
        HERDR_TAB_ID: agent.tab_id || '',
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
        CCXRAY_BADGE_EVENT_DELAY_MS: '0',
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.status === 0) refreshed++;
    else failed++;
  }

  console.log(`ccxray sidebar sync: ${refreshed} refreshed${failed ? `, ${failed} failed` : ''}`);
  process.exit(failed ? 1 : 0);
}

main();
