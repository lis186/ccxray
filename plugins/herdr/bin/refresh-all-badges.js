#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { herdrAgentReport, readIndexTailEntries, statusReport, usageReport } = require('./lib/ccxray');

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
  const status = statusReport();
  const usage = usageReport({ last: process.env.CCXRAY_HERDR_LAST || '24h' });
  // Only usable reports are shared. A transient failure here must not be
  // broadcast to every pane as "no hub / not linked": a child that finds its
  // report missing recomputes its own copy — the pre-share behavior, but
  // confined to that child. The payload is a minimal DTO, not the raw
  // spawnSync result (whose Error does not survive JSON anyway).
  const linkedPaneIds = new Set(readIndexTailEntries({ env: process.env }).flatMap(entry => {
    const match = String(entry.agentId || '').match(/^herdr:(.+)$/);
    return match ? [match[1]] : [];
  }));
  const shared = { agents, linkedPaneIds: [...linkedPaneIds] };
  if (status.ok) shared.status = { ok: true, parsed: status.parsed };
  if (usage.ok) shared.usage = { ok: true, data: usage.data };

  const timeoutMs = childTimeoutMs();
  let refreshed = 0;
  let failed = 0;
  let timedOut = 0;
  let sharedDir = null;
  try {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-badge-shared-'));
    const sharedFile = path.join(sharedDir, 'report.json');
    fs.writeFileSync(sharedFile, JSON.stringify(shared));
    for (const agent of agents) {
      const context = {
        focused_pane_id: agent.pane_id,
        focused_pane_cwd: agent.foreground_cwd || agent.cwd || null,
        workspace_id: agent.workspace_id || null,
        tab_id: agent.tab_id || null,
        // We already hold the agent list; passing the resolution (even "this
        // pane has no session id") spares each child its own
        // `herdr agent list` round trip. The explicit flag is what the child
        // trusts — a null agent_session alone could come from any context
        // author.
        agent_session: agent.agent_session || null,
        agent_session_known: true,
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
    if (sharedDir) { try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch {} }
  }

  const parts = [`${refreshed} refreshed`];
  if (failed) parts.push(`${failed} failed`);
  if (timedOut) parts.push(`${timedOut} timed out (over ${timeoutMs}ms)`);
  console.log(`ccxray sidebar sync: ${parts.join(', ')}`);
  process.exit(failed || timedOut ? 1 : 0);
}

main();
