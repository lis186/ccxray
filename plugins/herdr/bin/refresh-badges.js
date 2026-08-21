#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  contextSidebarColumns,
  formatPercent,
  herdrAgentReport,
  herdrRuntime,
  paneAlert,
  reportPaneTokens,
  reportWorkspaceTokens,
  requestImport,
  routedPaneKnown,
  routedPaneLaunchId,
  runHerdr,
  sessionSummaryDetails,
  statusReport,
  usageReport,
} = require('./lib/ccxray');
const { agentNotification, recordAgentStatus } = require('./lib/notifications');

const CTX_BAR_COLOR_TOKENS = ['ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];
const ROW3_TOKENS = ['facts', 'alert'];

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

// #543: the fan-out parent (refresh-all-badges) precomputes the
// pane-independent status/usage reports once and shares them via a temp file,
// because re-running them here costs up to 17s against the parent's 10s cap.
// Per-report fail open: the parent only shares reports that succeeded, and
// anything missing or malformed means "compute our own" — so a transient
// parent failure degrades one report for one child back to the pre-share
// behavior instead of painting every pane "no hub / not linked". The
// event-driven single-pane path (no env var) is byte-identical to before.
function sharedReports(env = process.env) {
  if (!env.CCXRAY_BADGE_SHARED_REPORT) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(env.CCXRAY_BADGE_SHARED_REPORT, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      status: parsed.status && parsed.status.ok && parsed.status.parsed ? parsed.status : null,
      usage: parsed.usage && parsed.usage.ok && parsed.usage.data ? parsed.usage : null,
    };
  } catch {}
  return {};
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

function clampCols(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 8 ? Math.min(n, 96) : 18;
}

function clipToCols(text, cols) {
  const value = String(text);
  return value.length <= cols ? value : `${value.slice(0, Math.max(1, cols - 1))}…`;
}

// Row 3 is TWO tokens with one meaning each, and exactly one of them carries
// content per refresh — the mechanism `ctx_bar_*` above has already shipped with.
// One token holding either a fact or a warning would have to change colour with
// its meaning, which is the Channel Discipline violation docs/design-principles.md
// exists to stop; here each token keeps a fixed colour and what changes is which
// one is non-empty.
//
// A pane whose session could not be located fills NEITHER. Row 1's state_labels
// already says "not linked", and `$facts` would render the detail's honest but
// useless `n/a · ?` beside it — the duplication this three-row layout exists to
// remove. Row height never changes, only content, which
// docs/design-principles.md:60 permits explicitly ("Content inside containers
// may change freely").
function applyRow3Tokens(tokens, detail, opts = {}) {
  const located = Boolean(detail) && detail.matched !== false;
  // ctx, blocked and no-telemetry are `sidebarOwned` in the shared ranking, so
  // they cannot reach row 3 — rows 2 and 1 render them. Passing hasTelemetry
  // true is therefore not a claim: the unlocated case returned above.
  const alert = located ? paneAlert({
    hasTelemetry: true,
    refusedCount: detail.refusedCount,
    staleText: detail.stale?.text,
    failures: detail.failures,
    cacheDropped: detail.cacheDropped,
  }) : null;
  // Clip to the measured sidebar width here rather than letting Herdr cut the
  // row: an alert we chose to show must be legible, and the caller knows the
  // width. `cols` falls back to ctx_bar's own default when unmeasured.
  const cols = clampCols(opts.sidebarCols);
  if (alert) tokens.alert = clipToCols(alert.text, cols);
  else if (located) tokens.facts = clipToCols(`${detail.costText} · ${detail.ageText}`, cols);
  return ROW3_TOKENS.filter(name => tokens[name] === undefined);
}

// A standalone (non-hub) ccxray is a perfectly good proxy — the user's traffic
// is being traced, it just didn't fork a hub. Mirror ensureProxy's recognition.
function proxyAvailable(parsed) {
  if (parsed.machine) return Boolean(parsed.machine.proxy);
  if (parsed.running) return true;
  // Fallback for a `ccxray` that predates the Machine line.
  return (parsed.notes || []).some(n => /held by a standalone.*ccxray/i.test(n));
}

function badgeTokens(status, usage, opts = {}) {
  const tokens = {
    xray: proxyAvailable(status.parsed) ? 'ok' : 'no-hub',
  };

  let stale = null;
  let detail = null;
  if (usage.ok && usage.data?.meta) {
    detail = sessionSummaryDetails(usage.data, opts);
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
    // Never fall back to usage.data.meta.totalEntries: that is every session's
    // line count, and a per-agent row rendering it claims the whole index as one
    // pane's turn count. Dead today (no path returns a nullish detail.turns) and
    // therefore removed without a differential test — it is a loaded landmine,
    // not a live defect, and the moment an unlocated path returns null it fires.
    tokens.turns = detail.turns == null ? '?' : String(detail.turns);
    tokens.cache = detail.matched === false ? '?' : formatPercent(usage.data.cache?.hitRate);
    tokens.fail = detail.matched === false ? '?' : formatPercent(usage.data.tools?.failRate);
  } else {
    tokens.summary = proxyAvailable(status.parsed) ? 'ccxray: not linked' : 'ccxray: no hub';
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
    located: Boolean(detail) && detail.matched !== false,
    clearTokens: [
      ...applyContextColorTokens(tokens, tokens.ctx_band),
      ...applyRow3Tokens(tokens, detail, opts),
    ],
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
  const shared = sharedReports();
  const status = shared.status || statusReport();
  const usage = shared.usage || usageReport({ last: process.env.CCXRAY_HERDR_LAST || '24h' });
  const context = runtime.context || {};
  const targetPaneId = runtime.paneId || context.focused_pane_id || null;
  let nativeSessionId = event.sessionId || null;
  if (!nativeSessionId && context.agent_session?.kind === 'id') {
    nativeSessionId = context.agent_session.value;
  }
  // agent_session_known means the context author already consulted the agent
  // list for this pane — including the "no session id" answer — so re-listing
  // here could only repeat that answer more slowly.
  if (!nativeSessionId && targetPaneId && !context.agent_session_known) {
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
    routed: proxyAvailable(status.parsed) && routedPaneKnown(targetPaneId, process.env),
    launchId: routedPaneLaunchId(targetPaneId, process.env),
  });
  const { tokens, clearTokens } = badge;
  // A stale badge means completed turns are sitting on disk that ccxray never
  // logged, which is exactly what a rescan fixes — so the marker doubles as the
  // trigger. Detached: the badge write below must not wait for a disk scan.
  const importRequest = badge.stale ? requestImport({ env: process.env }) : null;
  const ttlMs = Number(process.env.CCXRAY_BADGE_TTL_MS || 600000);
  // Row 1 is `state_icon · agent · state_text`, and a state label REPLACES the
  // native state_text. Setting it unconditionally to the summary made row 1 read
  // `claude · ccxray: traced · claude`: the agent name twice, and the model a
  // third time once row 3 shows the cost. Herdr's own idle/working is the right
  // content for a located pane — it is the one thing on this row Herdr knows
  // better than we do — so the label is reserved for the states it cannot know
  // ("not linked", "no hub"), and actively cleared otherwise.
  const stateLabels = badge.located ? null : {
    unknown: tokens.summary,
    idle: tokens.summary,
    working: tokens.summary,
    blocked: tokens.summary,
    done: tokens.summary,
  };

  const pane = reportPaneTokens(tokens, {
    env, ttlMs, stateLabels, clearTokens, agent: event.agent,
    clearStateLabels: !stateLabels,
  });
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

module.exports = { badgeTokens, applyContextColorTokens, applyRow3Tokens, eventContext };
