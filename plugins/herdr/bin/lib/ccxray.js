'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;

function stripAnsi(value) {
  return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function pluginRoot(env = process.env) {
  return env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

function findRepoRoot(env = process.env) {
  if (env.CCXRAY_REPO_ROOT && fs.existsSync(path.join(env.CCXRAY_REPO_ROOT, 'server', 'index.js'))) {
    return env.CCXRAY_REPO_ROOT;
  }
  const candidate = path.resolve(pluginRoot(env), '..', '..');
  if (fs.existsSync(path.join(candidate, 'server', 'index.js'))) return candidate;
  return null;
}

function resolveCcxrayCommand(env = process.env) {
  if (env.CCXRAY_BIN_JSON) {
    try {
      const parts = JSON.parse(env.CCXRAY_BIN_JSON);
      if (Array.isArray(parts) && parts.length > 0 && parts.every(p => typeof p === 'string')) {
        return { bin: parts[0], argsPrefix: parts.slice(1), label: parts.join(' ') };
      }
    } catch {}
  }
  if (env.CCXRAY_BIN) {
    return { bin: env.CCXRAY_BIN, argsPrefix: [], label: env.CCXRAY_BIN };
  }

  const root = findRepoRoot(env);
  if (root) {
    const entry = path.join(root, 'server', 'index.js');
    return { bin: process.execPath, argsPrefix: [entry], label: `node ${entry}` };
  }

  return { bin: 'ccxray', argsPrefix: [], label: 'ccxray' };
}

function runCommand(command, args = [], opts = {}) {
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const result = spawnSync(command.bin, [...(command.argsPrefix || []), ...args], {
    cwd: opts.cwd || findRepoRoot(opts.env || process.env) || pluginRoot(opts.env || process.env),
    env: opts.env || process.env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });

  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
  };
}

function runCcxray(args, opts = {}) {
  return runCommand(resolveCcxrayCommand(opts.env || process.env), args, opts);
}

function runHerdr(args, opts = {}) {
  const env = opts.env || process.env;
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  return runCommand({ bin: herdr, argsPrefix: [] }, args, opts);
}

function parseJsonOutput(output) {
  const clean = stripAnsi(output).trim();
  if (!clean) return null;
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseStatus(text) {
  const clean = stripAnsi(text);
  const noHub = /No hub running/i.test(clean);
  const portMatch = clean.match(/localhost:(\d{2,5})/) || clean.match(/\bport\s+(\d{2,5})\b/i);
  const pidMatch = clean.match(/\bpid[:\s]+(\d+)\b/i) || clean.match(/\bPID[:\s]+(\d+)\b/);
  const clientsMatch = clean.match(/\bclients?[:\s]+(\d+)\b/i);
  return {
    running: !noHub && Boolean(portMatch || pidMatch || /hub/i.test(clean)),
    port: portMatch ? Number(portMatch[1]) : null,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    clients: clientsMatch ? Number(clientsMatch[1]) : null,
  };
}

function statusReport(opts = {}) {
  const result = runCcxray(['status'], { timeoutMs: opts.timeoutMs || 5000, env: opts.env });
  const text = `${result.stdout}${result.stderr}`;
  const parsed = parseStatus(text);
  return {
    ok: result.status === 0 || /No hub running/i.test(stripAnsi(text)),
    command: resolveCcxrayCommand(opts.env || process.env).label,
    result,
    text: stripAnsi(text).trim(),
    parsed,
  };
}

function usageReport(opts = {}) {
  const args = ['usage', '--json'];
  if (opts.last) args.push('--last', opts.last);
  if (opts.cwd) args.push('--cwd', opts.cwd);

  const result = runCcxray(args, { timeoutMs: opts.timeoutMs || 12000, env: opts.env });
  const data = parseJsonOutput(result.stdout);
  const errorData = data && data.error ? data : null;
  return {
    ok: result.status === 0 && data && !data.error,
    data,
    errorData,
    result,
    text: stripAnsi(`${result.stdout}${result.stderr}`).trim(),
  };
}

function resolveCcxrayLogsDir(env = process.env) {
  return env.LOGS_DIR || path.join(env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray'), 'logs');
}

function readIndexTailEntries(opts = {}) {
  const env = opts.env || process.env;
  const indexPath = path.join(resolveCcxrayLogsDir(env), 'index.ndjson');
  if (!fs.existsSync(indexPath)) return [];

  const stat = fs.statSync(indexPath);
  const maxBytes = opts.maxBytes || 4 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(indexPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }

  return text.split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function formatPercent(value) {
  const n = Number(value || 0);
  return `${Math.round(n * 100)}%`;
}

function formatWholePercent(value) {
  if (!Number.isFinite(value)) return '?';
  return `${Math.max(0, Math.min(999, Math.round(value)))}%`;
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 90) return `${min}m`;
  const hours = ms / 3600000;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

function shortId(value) {
  return String(value || 'unknown').slice(0, 8);
}

function shortModel(value) {
  return String(value || 'unknown')
    .replace(/^claude-/, '')
    .replace(/^openai\//, '')
    .replace(/^xai\//, '')
    .replace(/-20\d\d\d\d\d\d$/, '');
}

function clip(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + '~';
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function contextBlock(pct) {
  if (!Number.isFinite(pct) || pct <= 0) return '▁';
  if (pct <= 25) return '▂';
  if (pct <= 45) return '▃';
  if (pct <= 60) return '▅';
  if (pct <= 85) return '▆';
  return '█';
}

function contextBand(pct) {
  if (!Number.isFinite(pct)) return 'green';
  if (pct <= 40) return 'green';
  if (pct <= 80) return 'yellow';
  return 'red';
}

function contextPercents(turns, win) {
  if (!win) return [];
  return turns
    .map(turn => {
      const used = contextUsed(turn);
      return used && win ? used / win * 100 : null;
    })
    .filter(Number.isFinite);
}

function contextSparkline(turns, win, opts = {}) {
  const pcts = turns
    ? contextPercents(turns, win)
    : [];
  const maxBars = clampNumber(opts.maxBars, 3, 32) || 4;
  const targetBars = pcts.length >= 4 ? Math.min(pcts.length, maxBars) : Math.min(4, maxBars);
  const recent = pcts.slice(-targetBars);
  const padded = Array(Math.max(0, targetBars - recent.length)).fill(0).concat(recent);
  return padded.map(contextBlock).join('');
}

function cacheHitText(turns) {
  let total = 0;
  let cached = 0;
  for (const turn of turns) {
    const usage = turn.usage || {};
    const read = usage.cache_read_input_tokens || 0;
    const used = contextUsed(turn);
    if (used > 0) total += used;
    if (read > 0) cached += read;
  }
  if (!total) return null;
  return `cache ${formatWholePercent(cached / total * 100)}`;
}

function toolFailureCount(turns) {
  return turns.slice(-6).filter(turn => turn.turnToolFail || turn.toolFail).length;
}

function contextSignal(turns, detail) {
  if (detail.ctxPct >= 90) return 'full';
  if (detail.ctxPct >= 80) return 'near full';
  const failures = toolFailureCount(turns);
  if (failures) return `fail ${failures}x`;
  return cacheHitText(turns);
}

function formatContextBar(turns, win, ctxText, opts = {}) {
  const sidebarCols = clampNumber(opts.sidebarCols, 8, 96) || 18;
  const minSparkBars = sidebarCols < 10 ? 3 : 4;
  const pctText = ` ${ctxText || '?'}`;
  const rawSignal = opts.signal || null;
  let signalText = rawSignal ? ` · ${rawSignal}` : '';
  let maxBars = sidebarCols - pctText.length - signalText.length;
  if (!rawSignal || sidebarCols < 22 || maxBars < 6) {
    signalText = '';
    maxBars = sidebarCols - pctText.length;
  }
  maxBars = Math.max(minSparkBars, maxBars);
  const spark = contextSparkline(turns, win, { maxBars });
  return clip(`${spark}${pctText}${signalText}`, sidebarCols);
}

function emptyContextBar(opts = {}) {
  return formatContextBar([], 0, '?', opts);
}

function summarizeUsage(data) {
  if (!data || !data.meta) return ['No usage data available.'];
  const topSession = data.sessions?.topSessions?.[0];
  const topModel = data.models?.[0];
  const lines = [
    `${data.meta.totalEntries || 0} turns across ${data.meta.totalSessions || 0} sessions, ${formatMoney(data.meta.totalCost)} total`,
    `Cache hit ${formatPercent(data.cache?.hitRate)}; tool fail ${formatPercent(data.tools?.failRate)}; ${data.tools?.totalCalls || 0} tool calls`,
  ];
  if (topModel) lines.push(`Top model: ${topModel.model} (${topModel.turns} turns, ${formatMoney(topModel.cost)})`);
  if (topSession) {
    const title = topSession.title ? ` - ${topSession.title}` : '';
    lines.push(`Top session: ${shortId(topSession.sessionId)} (${topSession.turns} turns, ${formatMoney(topSession.cost)})${title}`);
  }
  return lines;
}

function summarizeUsageCompact(data, opts = {}) {
  const cols = Math.max(28, Math.min(Number(opts.cols) || 48, 96));
  const max = cols - 2;
  if (!data || !data.meta) return ['No usage data'];

  const topSession = data.sessions?.topSessions?.[0];
  const topModel = data.models?.[0];
  const lines = [
    `Turns ${data.meta.totalEntries || 0} / Sessions ${data.meta.totalSessions || 0} / ${formatMoney(data.meta.totalCost)}`,
    `Cache ${formatPercent(data.cache?.hitRate)} / Tool fail ${formatPercent(data.tools?.failRate)} / Calls ${data.tools?.totalCalls || 0}`,
  ];
  if (topModel) {
    lines.push(`Model ${topModel.model} (${topModel.turns}, ${formatMoney(topModel.cost)})`);
  }
  if (topSession) {
    lines.push(`Session ${shortId(topSession.sessionId)} (${topSession.turns}, ${formatMoney(topSession.cost)})`);
    if (topSession.title) lines.push(clip(topSession.title, max));
  }
  return lines.map(line => clip(line, max));
}

function summarizeUsageTiny(data, opts = {}) {
  const cols = Math.max(16, Math.min(Number(opts.cols) || 23, 31));
  const max = cols - 1;
  if (!data || !data.meta) return ['No usage'];

  const topSession = data.sessions?.topSessions?.[0];
  const topModel = data.models?.[0];
  const lines = [
    `Turns ${data.meta.totalEntries || 0}`,
    `Sessions ${data.meta.totalSessions || 0}`,
    `Cost ${formatMoney(data.meta.totalCost)}`,
    `Cache ${formatPercent(data.cache?.hitRate)}`,
    `Fail ${formatPercent(data.tools?.failRate)}`,
    `Calls ${data.tools?.totalCalls || 0}`,
  ];
  if (topModel) lines.push(`Model ${clip(topModel.model, Math.max(max - 6, 8))}`);
  if (topSession) {
    lines.push(`Top ${shortId(topSession.sessionId)}`);
    lines.push(`Top turns ${topSession.turns}`);
    lines.push(`Top ${formatMoney(topSession.cost)}`);
    if (topSession.title) lines.push(clip(topSession.title, max));
  }
  return lines.map(line => clip(line, max));
}

function sessionSummary(data) {
  return sessionSummaryDetails(data).summary;
}

function contextUsed(entry) {
  if (Number.isFinite(entry?.ctxUsed)) return entry.ctxUsed;
  const usage = entry?.usage || {};
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function sessionWindow(turns) {
  if (turns.some(t => t.beta1m)) return 1000000;
  return turns.reduce((max, t) => Math.max(max, t.maxContext || 0), 0) || 200000;
}

function dominantModel(turns, fallback) {
  const counts = {};
  for (const turn of turns) counts[turn.model || fallback || 'unknown'] = (counts[turn.model || fallback || 'unknown'] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || fallback || 'unknown';
}

function summarizeTurnGroup(turns, fallback = {}, nowMs = Date.now(), opts = {}) {
  const sorted = turns.slice().sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
  const latest = sorted.at(-1) || {};
  const firstTs = sorted.find(t => Number.isFinite(t.receivedAt))?.receivedAt;
  const cost = sorted.reduce((sum, t) => sum + (t.cost?.cost || 0), 0);
  const win = sessionWindow(sorted);
  const used = contextUsed(latest);
  const ctxPct = used && win ? used / win * 100 : null;
  const ctxText = ctxPct == null ? '?' : formatWholePercent(ctxPct);
  const detail = {
    ctxPct,
    ctxText,
    ctxBand: contextBand(ctxPct),
  };
  const signal = contextSignal(sorted, detail);
  return {
    sessionId: latest.sessionId || fallback.sessionId || null,
    ctxPct,
    ctxText,
    ctxBand: detail.ctxBand,
    ctxBar: formatContextBar(sorted, win, ctxText, {
      sidebarCols: opts.sidebarCols,
      signal,
    }),
    ageText: firstTs ? formatAge(nowMs - firstTs) : '?',
    cost: sorted.length ? cost : fallback.cost,
    costText: formatMoney(sorted.length ? cost : fallback.cost),
    model: dominantModel(sorted, fallback.model),
    turns: sorted.length || fallback.turns || 0,
  };
}

function sessionSummaryDetails(data, opts = {}) {
  const top = data?.sessions?.topSessions?.[0] || {};
  const nowMs = Number(opts.nowMs || opts.env?.CCXRAY_HERDR_NOW_MS) || Date.now();
  const paneId = opts.paneId || null;
  const agentId = opts.agentId || (paneId ? `herdr:${paneId}` : null);
  const entries = readIndexTailEntries({ env: opts.env });

  let turns = [];
  if (agentId) turns = entries.filter(e => e.agentId === agentId);
  if (!turns.length && top.sessionId) turns = entries.filter(e => e.sessionId === top.sessionId);
  if (!turns.length && opts.cwd) turns = entries.filter(e => e.cwd === opts.cwd);

  if (turns.length) {
    const bySession = new Map();
    for (const entry of turns) {
      const sid = entry.sessionId || 'unknown';
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(entry);
    }
    const groups = [...bySession.values()].sort((a, b) => {
      const aLast = Math.max(...a.map(t => t.receivedAt || 0));
      const bLast = Math.max(...b.map(t => t.receivedAt || 0));
      return bLast - aLast;
    });
    const detail = summarizeTurnGroup(groups[0], top, nowMs, opts);
    const summary = `${shortModel(detail.model)}, ${detail.ageText}, ${detail.costText}`;
    return { ...detail, summary: clip(summary, 80) };
  }

  const fallback = {
    sessionId: top.sessionId || null,
    ctxPct: null,
    ctxText: '?',
    ageText: top.durationMin ? formatAge(top.durationMin * 60000) : '?',
    cost: top.cost ?? data?.meta?.totalCost ?? 0,
    costText: formatMoney(top.cost ?? data?.meta?.totalCost),
    model: top.model || data?.models?.[0]?.model || 'unknown',
    turns: top.turns || data?.meta?.totalEntries || 0,
    ctxBar: emptyContextBar(opts),
    ctxBand: contextBand(null),
  };
  return {
    ...fallback,
    summary: clip(`${shortModel(fallback.model)}, ${fallback.ageText}, ${fallback.costText}`, 80),
  };
}

function contextSidebarColumns(opts = {}) {
  const env = opts.env || process.env;
  const context = opts.context || readHerdrContext(env) || {};
  for (const value of [
    opts.sidebarCols,
    env.CCXRAY_HERDR_SIDEBAR_COLS,
    context.sidebar_width,
    context.sidebar_cols,
    context.sidebarCols,
    context.ui?.sidebar_width,
    context.ui?.sidebar_cols,
  ]) {
    const cols = clampNumber(value, 8, 96);
    if (cols) return cols;
  }

  const paneId = opts.paneId || env.HERDR_PANE_ID || context.focused_pane_id;
  if (!paneId || env.CCXRAY_HERDR_NO_LAYOUT === '1') return 18;

  const result = runHerdr(['pane', 'layout', '--pane', paneId], {
    env,
    timeoutMs: opts.timeoutMs || 1200,
  });
  if (result.status !== 0 || result.error) return 18;
  const data = parseJsonOutput(result.stdout);
  const inferred = data?.result?.layout?.area?.x;
  return clampNumber(inferred, 8, 96) || 18;
}

function readHerdrContext(env = process.env) {
  if (!env.HERDR_PLUGIN_CONTEXT_JSON) return null;
  try { return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON); } catch { return null; }
}

function herdrRuntime(env = process.env) {
  return {
    present: env.HERDR_ENV === '1' || Boolean(env.HERDR_SOCKET_PATH || env.HERDR_PLUGIN_ID),
    pluginId: env.HERDR_PLUGIN_ID || null,
    actionId: env.HERDR_PLUGIN_ACTION_ID || null,
    entrypointId: env.HERDR_PLUGIN_ENTRYPOINT_ID || null,
    workspaceId: env.HERDR_WORKSPACE_ID || null,
    tabId: env.HERDR_TAB_ID || null,
    paneId: env.HERDR_PANE_ID || null,
    context: readHerdrContext(env),
  };
}

function reportPaneTokens(tokens, opts = {}) {
  const env = opts.env || process.env;
  if (!env.HERDR_PANE_ID) return { ok: false, reason: 'HERDR_PANE_ID is not set' };
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const args = ['pane', 'report-metadata', env.HERDR_PANE_ID, '--source', 'ccxray'];
  for (const name of opts.clearTokens || []) {
    args.push('--clear-token', String(name));
  }
  for (const [name, value] of Object.entries(tokens)) {
    args.push('--token', `${name}=${String(value)}`);
  }
  if (opts.title) args.push('--title', String(opts.title));
  if (opts.displayAgent) args.push('--display-agent', String(opts.displayAgent));
  if (opts.stateLabels) {
    for (const [status, label] of Object.entries(opts.stateLabels)) {
      args.push('--state-label', `${status}=${String(label)}`);
    }
  }
  if (opts.ttlMs) args.push('--ttl-ms', String(opts.ttlMs));
  const result = runCommand({ bin: herdr, argsPrefix: [] }, args, {
    env,
    timeoutMs: opts.timeoutMs || 2000,
  });
  return {
    ok: result.status === 0,
    result,
    reason: result.error ? result.error.message : stripAnsi(`${result.stdout}${result.stderr}`).trim(),
  };
}

function reportWorkspaceTokens(tokens, opts = {}) {
  const env = opts.env || process.env;
  if (!env.HERDR_WORKSPACE_ID) return { ok: false, reason: 'HERDR_WORKSPACE_ID is not set' };
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const args = ['workspace', 'report-metadata', env.HERDR_WORKSPACE_ID, '--source', 'ccxray'];
  for (const name of opts.clearTokens || []) {
    args.push('--clear-token', String(name));
  }
  for (const [name, value] of Object.entries(tokens)) {
    args.push('--token', `${name}=${String(value)}`);
  }
  if (opts.ttlMs) args.push('--ttl-ms', String(opts.ttlMs));
  const result = runCommand({ bin: herdr, argsPrefix: [] }, args, {
    env,
    timeoutMs: opts.timeoutMs || 2000,
  });
  return {
    ok: result.status === 0,
    result,
    reason: result.error ? result.error.message : stripAnsi(`${result.stdout}${result.stderr}`).trim(),
  };
}

module.exports = {
  findRepoRoot,
  contextBand,
  contextSidebarColumns,
  formatMoney,
  formatPercent,
  formatContextBar,
  herdrRuntime,
  parseJsonOutput,
  parseStatus,
  pluginRoot,
  readIndexTailEntries,
  reportPaneTokens,
  reportWorkspaceTokens,
  resolveCcxrayCommand,
  runCcxray,
  runHerdr,
  sessionSummary,
  sessionSummaryDetails,
  shortId,
  shortModel,
  statusReport,
  stripAnsi,
  summarizeUsage,
  summarizeUsageCompact,
  summarizeUsageTiny,
  usageReport,
};
