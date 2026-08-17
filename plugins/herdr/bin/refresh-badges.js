#!/usr/bin/env node
'use strict';

const {
  contextSidebarColumns,
  formatPercent,
  herdrAgentReport,
  herdrRuntime,
  reportPaneTokens,
  reportWorkspaceTokens,
  requestImport,
  routedPaneKnown,
  runHerdr,
  sessionSummaryDetails,
  statusReport,
  usageReport,
} = require('./lib/ccxray');
const { agentNotification, recordAgentStatus } = require('./lib/notifications');

const CTX_BAR_COLOR_TOKENS = ['ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];

function eventContext(env = process.env) {
  if (!env.HERDR_PLUGIN_EVENT_JSON) return {};
  try {
    const parsed = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON);
    const data = parsed?.data || parsed || {};
    return {
      paneId: data.pane_id || data.pane?.pane_id || null,
      workspaceId: data.workspace_id || data.pane?.workspace_id || null,
      tabId: data.tab_id || data.pane?.tab_id || null,
      cwd: data.foreground_cwd || data.cwd || data.pane?.foreground_cwd || data.pane?.cwd || null,
      agent: data.agent || data.display_agent || null,
      status: data.agent_status || data.status || data.pane?.agent_status || null,
      sessionId: (data.agent_session || data.pane?.agent_session)?.kind === 'id'
        ? (data.agent_session || data.pane?.agent_session).value
        : null,
    };
  } catch {
    return {};
  }
}

function waitForTelemetry(env = process.env) {
  if (!env.HERDR_PLUGIN_EVENT) return;
  const delayMs = Math.max(0, Math.min(Number(env.CCXRAY_BADGE_EVENT_DELAY_MS ?? 250) || 0, 2000));
  if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function applyContextColorTokens(tokens, ctxBand) {
  const band = CTX_BAR_COLOR_TOKENS.includes(`ctx_bar_${ctxBand}`) ? ctxBand : 'unknown';
  const activeToken = `ctx_bar_${band}`;
  tokens.ctx_band = band;
  tokens[activeToken] = tokens.ctx_bar;
  return CTX_BAR_COLOR_TOKENS.filter(name => name !== activeToken);
}

function badgeTokens(status, usage, opts = {}) {
  const tokens = {
    xray: status.parsed.running ? 'ok' : 'no-hub',
  };

  let stale = null;
  if (usage.ok && usage.data?.meta) {
    const detail = sessionSummaryDetails(usage.data, opts);
    stale = detail.stale || null;
    tokens.summary = detail.summary;
    tokens.ctx_bar = detail.ctxBar;
    tokens.ctx_band = detail.ctxBand;
    // The stale marker otherwise lives only in `summary` and the ctx_bar colour
    // band, and a sidebar row shows a token only if it names it. Our own
    // install-sidebar-summary.js does add those rows — but it is not the only way
    // a config gets written. A real one observed in the field
    // (~/.config/herdr/config.toml, rows ["$ctx","$model","$cost"], left behind by
    // an earlier plugin generation) names neither, so the entire marker rendered
    // nowhere and the badge showed a bare confident percentage for a session whose
    // transcript had moved on. `$ctx` is the channel a minimal layout does render,
    // so the state has to survive there too — and marking the number is ADR 0013's
    // own convention for a percentage you cannot vouch for.
    tokens.ctx = detail.stale ? `${detail.ctxText} stale` : detail.ctxText;
    tokens.age = detail.ageText;
    tokens.cost = detail.costText;
    tokens.model = detail.model;
    tokens.turns = String(detail.turns ?? usage.data.meta.totalEntries ?? 0);
    tokens.cache = detail.matched === false ? '?' : formatPercent(usage.data.cache?.hitRate);
    tokens.fail = detail.matched === false ? '?' : formatPercent(usage.data.tools?.failRate);
  } else {
    tokens.summary = status.parsed.running ? 'ccxray: not linked' : 'ccxray: no hub';
    tokens.ctx_bar = '▁▁▁▁ ?';
    tokens.ctx = '?';
    tokens.age = '?';
    tokens.cost = 'n/a';
    tokens.model = 'unknown';
    tokens.turns = '0';
    tokens.ctx_band = 'unknown';
  }

  return {
    tokens,
    stale,
    clearTokens: applyContextColorTokens(tokens, tokens.ctx_band),
  };
}

function main() {
  waitForTelemetry();
  const event = eventContext();
  const env = {
    ...process.env,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID || event.paneId || '',
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID || event.workspaceId || '',
    HERDR_TAB_ID: process.env.HERDR_TAB_ID || event.tabId || '',
  };
  const runtime = herdrRuntime(env);
  const status = statusReport();
  const usage = usageReport({ last: process.env.CCXRAY_HERDR_LAST || '24h' });
  const context = runtime.context || {};
  const targetPaneId = runtime.paneId || context.focused_pane_id || null;
  let nativeSessionId = event.sessionId || null;
  if (!nativeSessionId && targetPaneId) {
    const report = herdrAgentReport({ env });
    const agent = report.agents.find(item => item.pane_id === targetPaneId);
    if (agent?.agent_session?.kind === 'id') nativeSessionId = agent.agent_session.value;
  }
  const sidebarCols = contextSidebarColumns({
    env,
    paneId: targetPaneId,
    context,
  });
  const badge = badgeTokens(status, usage, {
    env: process.env,
    paneId: targetPaneId,
    sessionId: nativeSessionId,
    cwd: event.cwd || context.focused_pane_cwd || context.workspace_cwd || null,
    sidebarCols,
    routed: status.parsed.running && routedPaneKnown(targetPaneId, process.env),
  });
  const { tokens, clearTokens } = badge;
  // A stale badge means completed turns are sitting on disk that ccxray never
  // logged, which is exactly what a rescan fixes — so the marker doubles as the
  // trigger. Detached: the badge write below must not wait for a disk scan.
  const importRequest = badge.stale ? requestImport({ env: process.env }) : null;
  const ttlMs = Number(process.env.CCXRAY_BADGE_TTL_MS || 600000);
  const stateLabels = {
    unknown: tokens.summary,
    idle: tokens.summary,
    working: tokens.summary,
    blocked: tokens.summary,
    done: tokens.summary,
  };

  const pane = reportPaneTokens(tokens, { env, ttlMs, stateLabels, clearTokens, agent: event.agent });
  const workspace = reportWorkspaceTokens(tokens, { env, ttlMs, clearTokens });
  const notification = process.env.HERDR_PLUGIN_EVENT === 'pane.agent_status_changed'
    ? agentNotification(event, tokens.summary, {
      env,
      focused: targetPaneId === context.focused_pane_id,
    })
    : null;
  const notificationResult = notification
    ? runHerdr([
      'notification', 'show', notification.title,
      '--body', notification.body,
      '--sound', notification.sound,
    ], { env, timeoutMs: 3000 })
    : null;
  if (notificationResult?.status === 0) recordAgentStatus(event, env);

  console.log('ccxray badges refreshed');
  console.log(`Workspace: ${runtime.workspaceId || 'n/a'} (${workspace.ok ? 'ok' : workspace.reason})`);
  console.log(`Pane: ${runtime.paneId || 'n/a'} (${pane.ok ? 'ok' : pane.reason})`);
  console.log(`Tokens: ${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (clearTokens.length) console.log(`Clear: ${clearTokens.join(' ')}`);
  if (importRequest) console.log(`Import: requested (${importRequest.ok ? 'spawned' : importRequest.reason})`);
  if (notificationResult?.status === 0) console.log(`Notification: ${notification.title}`);
  else if (notificationResult) console.log('Notification unavailable: run Doctor for Herdr details.');

  // refresh-all-badges counts a child that exited 0 as refreshed. Exiting 0 on a
  // failed `herdr pane report-metadata` made the fan-out report "N refreshed"
  // while the sidebar still showed the previous badge — a silent failure that
  // looked like a success. Report a write we were asked to make and could not.
  const targeted = runtime.workspaceId || runtime.paneId;
  const wrote = (!runtime.paneId || pane.ok) && (!runtime.workspaceId || workspace.ok);
  process.exit(targeted && wrote ? 0 : 1);
}

// ADR 0015's two-mode shape: executed mode runs, imported mode is side-effect
// free so badgeTokens() can be asserted without refreshing anybody's sidebar.
if (require.main === module) main();

module.exports = { badgeTokens, applyContextColorTokens, eventContext };
