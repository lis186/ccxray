#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const {
  completedRepairEvidenceForAgent,
  contextSidebarColumns,
  displayWidth,
  emptyContextBar,
  formatPercent,
  herdrRuntime,
  herdrAgentReport,
  linkEvidence,
  paneAlert,
  reportPaneTokens,
  resolvePaneSessionId,
  reportWorkspaceTokens,
  readIndexTailEntries,
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
      agents: Array.isArray(parsed.agents) ? parsed.agents : null,
      linkedPaneIds: Array.isArray(parsed.linkedPaneIds) ? parsed.linkedPaneIds : null,
      linkedSessionIds: Array.isArray(parsed.linkedSessionIds) ? parsed.linkedSessionIds : null,
      historySessionIds: Array.isArray(parsed.historySessionIds) ? parsed.historySessionIds : null,
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

function fitVariant(variants, cols) {
  return variants.find(value => displayWidth(value) <= cols) || variants.at(-1) || '';
}

function compactWho(agent, cols) {
  const raw = String(agent || '').trim().toLowerCase();
  const label = raw.includes('luna') ? 'luna'
    : raw.includes('sol') ? 'sol'
      : raw.includes('fable') ? 'fable'
        : raw.includes('opus') ? 'opus'
          : raw.includes('haiku') ? 'haiku'
            : raw.includes('sonnet') ? 'sonnet'
              : raw.includes('claude') ? 'claude'
              : raw || 'agent';
  const narrow = label === 'claude' ? 'C' : label.slice(0, 1).toUpperCase();
  if (cols <= 8) return narrow;
  return fitVariant([label, narrow], cols);
}

function compactRoute(status, opts = {}) {
  const cols = clampCols(opts.sidebarCols);
  const state = String(status || '').toLowerCase();
  const pane = String(opts.paneId || '').split(':').at(-1) || '';
  const suffix = pane ? ` ${pane}` : '';
  let variants;
  if (!opts.proxy) variants = ['!hub', '!'];
  else if (opts.historyOnly) variants = ['history · live off', 'history/off', 'hist/off'];
  else if (state === 'blocked') variants = [`!block${suffix}`, '!block', '!'];
  else if (!opts.located && !opts.routed) variants = [`?link${suffix}`, '?link', '?'];
  else if (!opts.located) variants = [`+ready${suffix}`, '+ready', '+'];
  else if (['working', 'running', 'active'].includes(state)) variants = [`>live${suffix}`, '>live', '>'];
  else if (state === 'done') variants = [`=done${suffix}`, '=done', '='];
  else if (state === 'idle' || !state) variants = [`=idle${suffix}`, '=idle', '='];
  else variants = [`?state${suffix}`, '?state', '?'];
  return fitVariant(variants, cols);
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
  // Choose complete variants rather than clipping. A partial warning or a
  // partial cost/age pair is not observable state; it is an ambiguous glyph
  // sequence. `cols` falls back to ctx_bar's own default when unmeasured.
  const cols = clampCols(opts.sidebarCols);
  if (alert) {
    const short = alert.kind === 'quota-refused' ? '!quota'
      : alert.kind === 'stale' ? '!stale'
        : alert.kind.startsWith('fail') ? '!fail'
          : alert.kind === 'cache-dropped' ? '!cache'
            : `!${alert.kind}`;
    tokens.alert = fitVariant([alert.text, short, '!'], cols);
  } else if (located) {
    const cost = detail.costText || '$?';
    const age = detail.ageText || '?';
    const cache = detail.cacheText ? String(detail.cacheText).replace(/^cache\s+/i, 'c') : '';
    const full = `${cost} · ${age}`;
    const withCache = `${cost} · ${cache} · ${age}`;
    const variants = cols >= 24 && cache ? [withCache, full, cost] : [full, cost];
    tokens.facts = fitVariant(variants, cols);
  }
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

function startWorkingRefreshLoop(event, env) {
  if (env.CCXRAY_BADGE_LOOP_CHILD === '1') return null;
  if (!['working', 'running', 'active'].includes(String(event.status || '').toLowerCase())) return null;
  try {
    const child = spawn(process.execPath, [require('path').join(__dirname, 'badge-refresh-loop.js')], {
      env: { ...env },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'spawn-failed' };
  }
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
    const ctxMarker = detail.ctxWindowMarker || '';
    tokens.ctx = detail.stale
      ? `${detail.ctxText}${ctxMarker} stale`
      : `${detail.ctxText}${ctxMarker}`;
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
    tokens.ctx_bar = emptyContextBar({ sidebarCols: opts.sidebarCols });
    tokens.ctx = '?';
    tokens.age = '?';
    tokens.cost = 'n/a';
    tokens.model = 'unknown';
    tokens.turns = '0';
    tokens.ctx_band = 'unknown';
  }

  const cols = clampCols(opts.sidebarCols);
  tokens.who = compactWho(detail?.model || opts.agent || opts.model, cols);
  tokens.route = compactRoute(opts.status, {
    sidebarCols: cols,
    paneId: opts.paneId,
    proxy: proxyAvailable(status.parsed),
    located: Boolean(detail) && detail.matched !== false,
    // A routed launch record is readiness evidence only before Herdr has a
    // native session. Once native identity exists, missing exact index evidence
    // is `?link`, never `+ready`.
    routed: Boolean(opts.routed) && !opts.sessionId,
    historyOnly: Boolean(detail?.historyOnly),
  });

  const located = Boolean(detail) && detail.matched !== false;
  const liveLinked = located && detail.liveLinked !== false;

  return {
    tokens,
    stale,
    ctxPct: detail?.ctxPct ?? null,
    ctxWindowSource: detail?.ctxWindowSource || null,
    located,
    liveLinked,
    repairCandidate: proxyAvailable(status.parsed) && !opts.identityConflict
      ? (detail?.repairCandidate || null)
      : null,
    clearTokens: [
      ...applyContextColorTokens(tokens, tokens.ctx_band),
      ...applyRow3Tokens(tokens, detail, opts),
    ],
  };
}

function workspaceXrayToken(status, env = process.env, sharedAgents = null, sharedLinkedPaneIds = null, opts = {}) {
  const cols = clampCols(opts.sidebarCols);
  if (!proxyAvailable(status?.parsed || {})) return fitVariant(['xray off', 'off'], cols);
  const agents = Array.isArray(sharedAgents)
    ? sharedAgents
    : (() => {
      const report = herdrAgentReport({ env });
      return report.ok ? report.agents : null;
    })();
  if (!agents) return fitVariant(['xray ?', '?'], cols);
  const workspaceId = env.HERDR_WORKSPACE_ID;
  const scoped = agents.filter(agent => !workspaceId || agent.workspace_id === workspaceId);
  const observedEntries = Array.isArray(sharedLinkedPaneIds) ? [] : readIndexTailEntries({ env });
  const evidence = linkEvidence(observedEntries);
  const observedSessionIds = new Set(Array.isArray(opts.linkedSessionIds)
    ? opts.linkedSessionIds
    : evidence.liveSessionIds);
  const historySessionIds = new Set(Array.isArray(opts.historySessionIds)
    ? opts.historySessionIds
    : evidence.historySessionIds);
  // A targeted repair may find the exact session earlier than the bounded
  // Sidebar tail and cache its newest index row. Fold that same evidence into
  // the aggregate so a pane and workspace cannot disagree about live/history.
  for (const agent of scoped) {
    const sessionId = agent.agent_session?.kind === 'id' ? agent.agent_session.value : null;
    if (!sessionId || observedSessionIds.has(sessionId) || historySessionIds.has(sessionId)) continue;
    const cached = completedRepairEvidenceForAgent(agent, env);
    if (!cached) continue;
    if (cached.imported === true) historySessionIds.add(sessionId);
    else observedSessionIds.add(sessionId);
  }
  const linked = scoped.filter(agent => {
    const labels = agent.state_labels && typeof agent.state_labels === 'object' ? agent.state_labels : {};
    const label = Object.values(labels).join(' ').toLowerCase();
    if (/not linked|no hub/.test(label)) return false;
    const sessionId = agent.agent_session?.kind === 'id' ? agent.agent_session.value : null;
    if (sessionId) {
      if (observedSessionIds.has(sessionId)) return true;
      if (historySessionIds.has(sessionId)) return false;
      // Native identity exists but exact session evidence does not. An older
      // exact pane agentId or compatibility label is not allowed to fill it in.
      return false;
    }
    // Pane ids and old labels are not session identities. In particular they
    // survive agent restart/session rotation, so using either when Herdr has no
    // native session makes the workspace aggregate contradict the pane's ?link.
    return false;
  }).length;
  return fitVariant([`xray ${linked}/${scoped.length}`, `${linked}/${scoped.length}`, `${linked}+`, '?'], cols);
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
  const reportedSessionId = event.sessionId
    || (context.agent_session?.kind === 'id' ? context.agent_session.value : null);
  let agents = Array.isArray(shared.agents) ? shared.agents : null;
  // Native-session repair is allowed only after one live Herdr owner is
  // observed. This one list also serves session resolution when the event did
  // not carry an id, avoiding two independent snapshots of agent ownership.
  if (!agents && (reportedSessionId || (targetPaneId && !context.agent_session_known))) {
    const report = herdrAgentReport({ env });
    if (report.ok) agents = report.agents;
  }
  // Shared with open-dashboard so the badge and the deep link cannot disagree
  // about which session this pane is on.
  const nativeSessionId = resolvePaneSessionId({
    env,
    paneId: targetPaneId,
    context,
    eventSessionId: event.sessionId,
    agents,
  });
  const paneAgent = agents?.find(agent => agent.pane_id === targetPaneId) || null;
  const nativeOwners = nativeSessionId && agents
    ? agents.filter(agent => (
      agent.agent_session?.kind === 'id'
      && agent.agent_session.value === nativeSessionId
    ))
    : [];
  const identityConflict = nativeOwners.length > 1;
  const allowRepair = Boolean(nativeSessionId && agents && nativeOwners.length === 1);
  // Startup fan-out has no pane.agent_status event payload. Reuse the native
  // status from the same agent snapshot so a working pane does not receive the
  // compact route's idle default during that refresh.
  const agentStatus = event.status || paneAgent?.agent_status || null;
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
    agent: event.agent || paneAgent?.agent || paneAgent?.display_agent || null,
    status: agentStatus,
    routed: proxyAvailable(status.parsed) && routedPaneKnown(targetPaneId, process.env),
    launchId: routedPaneLaunchId(targetPaneId, process.env),
    identityConflict,
    allowRepair,
  });
  const { tokens, clearTokens } = badge;
  // The candidate is already exact to provider + native session + cwd + one
  // located transcript. Detached: the badge write below never waits for it.
  const importRequest = badge.repairCandidate
    ? requestImport({ env: process.env, target: badge.repairCandidate, paneId: targetPaneId })
    : null;
  const ttlMs = Number(process.env.CCXRAY_BADGE_TTL_MS || 600000);
  // Row 1 is state_icon + $who. Linkage and activity are explicit compact
  // tokens on rows 1/2; native state labels are cleared so they cannot append a
  // long duplicate line or bypass the width-safe contract.
  const stateLabels = null;

  // Herdr caps pane metadata at 16 unique token names (set + clear combined).
  // Only tokens with an owning managed row are sent to the pane. Atomic tokens
  // from the pre-migration layout ($ctx,
  // $model, $cost, etc.) are not cleared because an un-migrated config may
  // still render them, and herdr retains values a report does not mention; the
  // installer migration removes those rows, after which the retained values
  // are inert. summary/ctx_band/ctx_bar are cleared as a one-time cleanup —
  // they were sent by previous badge writes but never reached a config row.
  const PANE_REPORT_TOKENS = new Set([
    'who', 'route',
    // ctx_bar colour variants — applyContextColorTokens writes the active one
    'ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red',
    // row 3
    'facts', 'alert',
  ]);
  const paneTokens = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (PANE_REPORT_TOKENS.has(name)) paneTokens[name] = value;
  }
  clearTokens.push('xray', 'summary', 'ctx_band', 'ctx_bar');
  const pane = reportPaneTokens(paneTokens, {
    env, ttlMs, stateLabels, clearTokens, agent: event.agent,
    // A loop child uses a short TTL to keep a working badge honest. The next
    // non-working event must renew it with the normal TTL even when tokens are
    // unchanged, otherwise an idle pane can lose its badge after one loop TTL.
    force: Boolean(event.status && !['working', 'running', 'active'].includes(String(event.status).toLowerCase())),
    clearStateLabels: true,
  });
  const workspaceTokens = { xray: workspaceXrayToken(status, env, shared.agents, shared.linkedPaneIds, {
    sidebarCols,
    linkedSessionIds: shared.linkedSessionIds,
    historySessionIds: shared.historySessionIds,
  }) };
  const workspace = reportWorkspaceTokens(workspaceTokens, {
    env,
    ttlMs,
    clearTokens: [...PANE_REPORT_TOKENS, 'summary', 'ctx_band', 'ctx_bar'],
  });
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

  // Herdr does not emit another status event for every transcript turn. Keep a
  // bounded loop alive only while this event says the agent is working; the
  // loop rechecks Herdr state and exits on idle, pane removal, or max age.
  const refreshLoop = startWorkingRefreshLoop(event, env);

  console.log('ccxray badges refreshed');
  console.log(`Workspace: ${runtime.workspaceId || 'n/a'} (${workspace.ok ? 'ok' : workspace.reason})`);
  console.log(`Pane: ${runtime.paneId || 'n/a'} (${pane.ok ? 'ok' : pane.reason})`);
  console.log(`Tokens: ${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (clearTokens.length) console.log(`Clear: ${clearTokens.join(' ')}`);
  if (importRequest) console.log(`Import: requested (${importRequest.ok ? 'spawned' : importRequest.reason})`);
  if (notificationResult?.status === 0) console.log(`Notification: ${notification.title}`);
  else if (notificationResult) console.log('Notification unavailable: run Doctor for Herdr details.');
  if (refreshLoop) console.log(`Refresh loop: ${refreshLoop.ok ? 'started' : refreshLoop.reason}`);

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

module.exports = {
  badgeTokens,
  applyContextColorTokens,
  applyRow3Tokens,
  compactRoute,
  compactWho,
  eventContext,
  startWorkingRefreshLoop,
  workspaceXrayToken,
};
