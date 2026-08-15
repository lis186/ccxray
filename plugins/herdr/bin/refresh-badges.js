#!/usr/bin/env node
'use strict';

const {
  contextSidebarColumns,
  formatPercent,
  herdrRuntime,
  reportPaneTokens,
  reportWorkspaceTokens,
  sessionSummaryDetails,
  statusReport,
  usageReport,
} = require('./lib/ccxray');

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

  if (usage.ok && usage.data?.meta) {
    const detail = sessionSummaryDetails(usage.data, opts);
    tokens.summary = detail.summary;
    tokens.ctx_bar = detail.ctxBar;
    tokens.ctx_band = detail.ctxBand;
    tokens.ctx = detail.ctxText;
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
  const sidebarCols = contextSidebarColumns({
    env,
    paneId: targetPaneId,
    context,
  });
  const badge = badgeTokens(status, usage, {
    env: process.env,
    paneId: targetPaneId,
    cwd: event.cwd || context.focused_pane_cwd || context.workspace_cwd || null,
    sidebarCols,
  });
  const { tokens, clearTokens } = badge;
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

  console.log('ccxray badges refreshed');
  console.log(`Workspace: ${runtime.workspaceId || 'n/a'} (${workspace.ok ? 'ok' : workspace.reason})`);
  console.log(`Pane: ${runtime.paneId || 'n/a'} (${pane.ok ? 'ok' : pane.reason})`);
  console.log(`Tokens: ${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (clearTokens.length) console.log(`Clear: ${clearTokens.join(' ')}`);

  process.exit((runtime.workspaceId || runtime.paneId) ? 0 : 1);
}

main();
