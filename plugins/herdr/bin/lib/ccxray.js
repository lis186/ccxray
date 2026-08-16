'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;

function stripAnsi(value) {
  return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Backup names carry a second-resolution timestamp, so an install followed
// immediately by a remove (two keypresses in Quick Start) collided and
// COPYFILE_EXCL threw an unhandled EEXIST. Retry with a suffix instead of
// overwriting an existing backup.
function backupConfigFile(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const base = `${file}.ccxray-summary-backup-${stamp}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      fs.copyFileSync(file, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not create a backup for ${file}`);
}

function pluginRoot(env = process.env) {
  return env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

function resolveHerdrConfigPath(env = process.env) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  const configHome = env.XDG_CONFIG_HOME
    || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'herdr', 'config.toml');
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
  const clean = stripAnsi(text);
  const ok = result.status === 0 || /No hub running/i.test(clean);
  const parsed = parseStatus(text);
  if (!ok) parsed.running = false;
  return {
    ok,
    command: resolveCcxrayCommand(opts.env || process.env).label,
    result,
    text: clean.trim(),
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
  if (!Number.isFinite(pct)) return 'unknown';
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
  const nativeSessionId = opts.sessionId || null;
  const allEntries = readIndexTailEntries({ env: opts.env });
  const entries = allEntries.filter(entry => entry.sessionId);
  const routed = Boolean(opts.routed) || (agentId && allEntries.some(entry => entry.agentId === agentId));

  let turns = [];
  if (nativeSessionId) turns = entries.filter(e => e.sessionId === nativeSessionId);
  if (!turns.length && agentId) turns = entries.filter(e => e.agentId === agentId);
  if (!turns.length && top.sessionId) turns = entries.filter(e => e.sessionId === top.sessionId);
  if (!turns.length && opts.cwd) turns = entries.filter(e => e.cwd === opts.cwd);

  const exactAgentMatch = agentId && turns.some(entry => entry.agentId === agentId);
  const nativeSessionMatch = nativeSessionId && turns.some(entry => entry.sessionId === nativeSessionId);
  if (agentId && !exactAgentMatch && !nativeSessionMatch) {
    const ctxText = '?';
    return {
      matched: false,
      sessionId: null,
      ctxPct: null,
      ctxText,
      ctxBand: contextBand(null),
      ctxBar: emptyContextBar(opts),
      ageText: '?',
      cost: null,
      costText: 'n/a',
      model: 'unknown',
      turns: 0,
      summary: routed ? 'ccxray: ready · send prompt' : 'ccxray: not linked',
    };
  }

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
    return { ...detail, matched: true, summary: clip(summary, 80) };
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

function herdrAgentReport(opts = {}) {
  const result = runHerdr(['agent', 'list'], {
    env: opts.env || process.env,
    timeoutMs: opts.timeoutMs || 1500,
  });
  const data = parseJsonOutput(result.stdout);
  const agents = data?.result?.agents || data?.agents;
  return {
    ok: result.status === 0 && Array.isArray(agents),
    agents: Array.isArray(agents) ? agents : [],
    result,
  };
}

function groupSessions(entries) {
  const bySession = new Map();
  for (const entry of entries) {
    const sid = entry.sessionId || 'unknown';
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(entry);
  }
  return [...bySession.values()].map(turns => (
    turns.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0))
  ));
}

function paneSessionTelemetry(entries, agent) {
  const groups = groupSessions(entries);
  const nativeSessionId = agent?.agent_session?.kind === 'id'
    ? agent.agent_session.value
    : null;
  const native = nativeSessionId
    ? groups.find(turns => turns.some(turn => turn.sessionId === nativeSessionId))
    : null;
  const withMain = groups
    .map(turns => ({
      turns,
      main: turns.filter(turn => !turn.isSubagent),
    }))
    .filter(group => group.main.length)
    .sort((a, b) => (b.main.at(-1)?.receivedAt || 0) - (a.main.at(-1)?.receivedAt || 0));
  const latest = groups
    .slice()
    .sort((a, b) => (b.at(-1)?.receivedAt || 0) - (a.at(-1)?.receivedAt || 0))[0];
  const selected = native || withMain[0]?.turns || latest || [];
  const mainTurns = selected.filter(turn => !turn.isSubagent);
  const selectedSessionId = selected.at(-1)?.sessionId || null;
  const childSessions = groups.filter(turns => (
    turns !== selected && turns.some(turn => turn.parentSessionId === selectedSessionId)
  ));
  const subagentTurns = [
    ...selected.filter(turn => turn.isSubagent),
    ...childSessions.flat(),
  ].sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));

  return {
    turns: mainTurns.length ? mainTurns : selected,
    subagentTurns,
    sessionRole: mainTurns.length ? 'main' : (selected.length ? 'subagent' : null),
    selectedBy: native ? 'native' : (withMain.length ? 'main' : (latest ? 'latest' : null)),
  };
}

function paneTelemetryCandidates(entries, agent) {
  const linkedEntries = entries.filter(entry => entry.sessionId);
  const agentId = `herdr:${agent.pane_id}`;
  const exact = linkedEntries.filter(entry => entry.agentId === agentId);
  const nativeSessionId = agent?.agent_session?.kind === 'id'
    ? agent.agent_session.value
    : null;
  if (!nativeSessionId) return { entries: exact, mapping: exact.length ? 'exact' : 'unlinked' };

  const native = linkedEntries.filter(entry => (
    entry.sessionId === nativeSessionId || entry.parentSessionId === nativeSessionId
  ));
  const combined = new Map([...exact, ...native].map(entry => [entry.id, entry]));
  const nativeIsExact = exact.some(entry => entry.sessionId === nativeSessionId);
  return {
    entries: [...combined.values()],
    mapping: native.length ? (nativeIsExact ? 'exact' : 'native') : (exact.length ? 'exact' : 'unlinked'),
  };
}

function subagentSummary(turns, nowMs) {
  if (!turns.length) return null;
  const identities = new Set(turns.map(turn => (
    turn.parentSessionId ? `session:${turn.sessionId}`
      : turn.convId ? `conv:${turn.convId}`
        : turn.agentKey ? `agent:${turn.agentKey}`
          : `session:${turn.sessionId || 'unknown'}`
  )));
  const activeCutoff = nowMs - 5 * 60000;
  const recentTurns = turns.filter(turn => Number(turn.receivedAt || 0) >= activeCutoff);
  const seenRecently = new Set(recentTurns
    .map(turn => (
      turn.parentSessionId ? `session:${turn.sessionId}`
        : turn.convId ? `conv:${turn.convId}`
          : turn.agentKey ? `agent:${turn.agentKey}`
            : `session:${turn.sessionId || 'unknown'}`
    )));
  return {
    count: identities.size,
    seenRecently: seenRecently.size,
    turns: turns.length,
    cost: turns.reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0),
    exactCost: turns.every(turn => turn.cost?.confidence === 'exact'),
    recentCost: recentTurns.reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0),
    exactRecentCost: recentTurns.every(turn => turn.cost?.confidence === 'exact'),
    toolCalls: Object.values(observedToolCalls(turns))
      .reduce((sum, count) => sum + Number(count || 0), 0),
    failures: turns.filter(turnFailed).length,
    failureCoverage: turns.filter(hasFailureCoverage).length,
  };
}

function sessionCachePercent(turns) {
  let total = 0;
  let cached = 0;
  for (const turn of turns) {
    const usage = turn.usage || {};
    const read = Number(usage.cache_read_input_tokens || 0);
    const input = Number(usage.input_tokens || 0);
    const created = Number(usage.cache_creation_input_tokens || 0);
    total += input + created + read;
    cached += read;
  }
  return total > 0 ? cached / total * 100 : null;
}

function promptChanged(turns) {
  if (turns.length < 2) return false;
  const previous = turns.at(-2);
  const latest = turns.at(-1);
  return ['sysHash', 'toolsHash', 'coreHash'].some(key => (
    previous[key] && latest[key] && previous[key] !== latest[key]
  ));
}

function turnCachePercent(turn) {
  const usage = turn?.usage || {};
  const read = Number(usage.cache_read_input_tokens || 0);
  const input = Number(usage.input_tokens || 0);
  const created = Number(usage.cache_creation_input_tokens || 0);
  const total = input + created + read;
  return total > 0 ? read / total * 100 : null;
}

function cacheDroppedAfterPromptChange(turns) {
  if (!promptChanged(turns)) return false;
  const previous = turnCachePercent(turns.at(-2));
  const latest = turnCachePercent(turns.at(-1));
  return Number.isFinite(previous)
    && Number.isFinite(latest)
    && previous >= 20
    && latest <= 5
    && previous - latest >= 20;
}

function estimatedTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

function toolName(tool) {
  return tool?.name || tool?.function?.name || tool?.type || 'unknown';
}

function mcpServerName(name) {
  if (!String(name).startsWith('mcp__')) return null;
  return String(name).split('__')[1] || 'unknown';
}

function readToolDefinitions(turns, opts = {}) {
  const latestWithHash = turns.slice().reverse().find(turn => turn.toolsHash);
  const hash = latestWithHash?.toolsHash;
  if (!hash || !/^[a-f0-9]{6,64}$/i.test(hash)) return null;
  const cache = opts.cache;
  const cacheKey = `${latestWithHash.provider || 'unknown'}:${hash}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const sharedDir = path.join(resolveCcxrayLogsDir(opts.env || process.env), 'shared');
  const prefixes = latestWithHash.provider === 'openai'
    ? ['openai_tools_', 'tools_']
    : ['tools_', 'openai_tools_'];
  let tools = null;
  for (const prefix of prefixes) {
    const file = path.join(sharedDir, `${prefix}${hash}.json`);
    try {
      if (fs.statSync(file).size > 32 * 1024 * 1024) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        tools = parsed;
        break;
      }
    } catch {}
  }
  if (cache) cache.set(cacheKey, tools);
  return tools;
}

function observedToolCalls(turns) {
  const calls = {};
  const legacyMax = {};
  for (const turn of turns) {
    if (turn.turnToolCalls !== null && turn.turnToolCalls !== undefined) {
      for (const [name, count] of Object.entries(turn.turnToolCalls || {})) {
        calls[name] = (calls[name] || 0) + Number(count || 0);
      }
      continue;
    }
    for (const [name, count] of Object.entries(turn.toolCalls || {})) {
      legacyMax[name] = Math.max(legacyMax[name] || 0, Number(count || 0));
    }
  }
  for (const [name, count] of Object.entries(legacyMax)) {
    calls[name] = (calls[name] || 0) + count;
  }
  return calls;
}

function observedSkillCalls(turns) {
  const calls = {};
  for (const turn of turns) {
    for (const [name, count] of Object.entries(turn.skillCalls || {})) {
      calls[name] = Math.max(calls[name] || 0, Number(count || 0));
    }
  }
  return Object.entries(calls)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function capabilityPortfolio(turns, opts = {}) {
  const definitions = readToolDefinitions(turns, opts);
  const skills = observedSkillCalls(turns);
  if (!definitions) return skills.length ? { skills } : null;

  const calls = observedToolCalls(turns);
  const tools = definitions.map(definition => {
    const name = toolName(definition);
    const deferred = definition?.defer_loading === true;
    return {
      name,
      server: mcpServerName(name),
      tokens: deferred ? 0 : estimatedTokens(definition),
      deferred,
      calls: Number(calls[name] || 0),
    };
  });
  const upfront = tools.filter(tool => !tool.deferred);
  const used = tools.filter(tool => tool.calls > 0);
  const mcpMap = new Map();
  for (const tool of tools.filter(tool => tool.server)) {
    if (!mcpMap.has(tool.server)) {
      mcpMap.set(tool.server, { server: tool.server, tools: 0, usedTools: 0, calls: 0, tokens: 0 });
    }
    const row = mcpMap.get(tool.server);
    row.tools++;
    if (tool.calls > 0) row.usedTools++;
    row.calls += tool.calls;
    row.tokens += tool.tokens;
  }
  const mcp = [...mcpMap.values()].sort((a, b) => b.tokens - a.tokens);
  return {
    exposedTools: tools.length,
    upfrontTools: upfront.length,
    usedTools: used.length,
    schemaTokens: upfront.reduce((sum, tool) => sum + tool.tokens, 0),
    usedSchemaTokens: used.reduce((sum, tool) => sum + tool.tokens, 0),
    deferredTools: tools.filter(tool => tool.deferred).length,
    mcp,
    largestUnusedMcp: mcp.filter(row => row.usedTools === 0 && row.tokens > 0)[0] || null,
    skills,
    confidence: 'estimated',
  };
}

function capabilityRecommendation(row) {
  if (row.avgSchemaTokens === 0) return 'DEFERRED';
  if (row.eligibleSessions < 5) return 'OBSERVE';
  const adoption = row.usedSessions / row.eligibleSessions;
  if (adoption >= 0.5) return 'KEEP';
  if (adoption <= 0.1 && row.avgSchemaTokens >= 1000) return 'DEFER CANDIDATE';
  const toolUse = row.exposedTools > 0 ? row.usedTools / row.exposedTools : 0;
  if (adoption > 0.1 && toolUse <= 0.25 && row.avgSchemaTokens >= 1000) return 'FILTER CANDIDATE';
  return 'REVIEW';
}

function capabilityReview(entries, opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  const windowMs = Number(opts.windowMs) || 7 * 24 * 60 * 60000;
  const cutoff = nowMs - windowMs;
  const sessions = groupSessions(entries.filter(entry => (
    entry.sessionId
    && entry.sessionId !== 'direct-api'
    && Number(entry.receivedAt || 0) >= cutoff
  )));
  const cache = new Map();
  const servers = new Map();
  const skills = new Map();
  let sessionsWithSchema = 0;
  let sessionsWithSkillCoverage = 0;

  for (const turns of sessions) {
    const portfolio = capabilityPortfolio(turns, { env: opts.env, cache });
    if (portfolio?.mcp) {
      sessionsWithSchema++;
      for (const mcp of portfolio.mcp) {
        if (!servers.has(mcp.server)) {
          servers.set(mcp.server, {
            server: mcp.server,
            eligibleSessions: 0,
            usedSessions: 0,
            schemaTokens: 0,
            exposedTools: 0,
            usedTools: 0,
            calls: 0,
          });
        }
        const row = servers.get(mcp.server);
        row.eligibleSessions++;
        if (mcp.usedTools > 0) row.usedSessions++;
        row.schemaTokens += mcp.tokens;
        row.exposedTools += mcp.tools;
        row.usedTools += mcp.usedTools;
        row.calls += mcp.calls;
      }
    }
    if (turns.some(turn => Object.hasOwn(turn, 'skillCalls'))) sessionsWithSkillCoverage++;
    for (const skill of portfolio?.skills || []) {
      if (!skills.has(skill.name)) skills.set(skill.name, { name: skill.name, sessions: 0, calls: 0 });
      const row = skills.get(skill.name);
      row.sessions++;
      row.calls += skill.count;
    }
  }

  const mcp = [...servers.values()].map(row => {
    const result = {
      ...row,
      avgSchemaTokens: row.eligibleSessions ? row.schemaTokens / row.eligibleSessions : 0,
    };
    result.recommendation = capabilityRecommendation(result);
    return result;
  }).sort((a, b) => b.avgSchemaTokens - a.avgSchemaTokens || a.server.localeCompare(b.server));

  return {
    windowMs,
    totalSessions: sessions.length,
    sessionsWithSchema,
    sessionsWithSkillCoverage,
    mcp,
    skills: [...skills.values()].sort((a, b) => b.sessions - a.sessions || b.calls - a.calls),
    confidence: 'estimated',
  };
}

function turnFailed(turn) {
  if (typeof turn.turnToolFail === 'boolean') return turn.turnToolFail;
  return turn.toolFail === true;
}

function hasFailureCoverage(turn) {
  return typeof turn.turnToolFail === 'boolean' || typeof turn.toolFail === 'boolean';
}

function missionControlRow(turns, agent, nowMs, mapping, opts = {}) {
  const latest = turns.at(-1) || {};
  const first = turns[0] || {};
  const win = turns.length ? sessionWindow(turns) : 0;
  const pcts = win ? contextPercents(turns, win) : [];
  const ctxPct = pcts.at(-1) ?? null;
  const previousPct = pcts.length > 1 ? pcts.at(-2) : null;
  const ctxDelta = Number.isFinite(ctxPct) && Number.isFinite(previousPct)
    ? ctxPct - previousPct
    : null;
  const cost = turns.reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0);
  const fiveMinAgo = nowMs - 5 * 60000;
  const recentCost = turns
    .filter(turn => Number(turn.receivedAt || 0) >= fiveMinAgo)
    .reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0);
  const recentTurns = turns.filter(turn => Number(turn.receivedAt || 0) >= fiveMinAgo);
  const failures = turns.slice(-6).filter(turnFailed).length;
  const failureCoverage = turns.slice(-6).filter(hasFailureCoverage).length;
  const hashChanged = promptChanged(turns);
  const cacheDropped = cacheDroppedAfterPromptChange(turns);
  const status = agent?.agent_status || 'recent';
  const paneId = agent?.pane_id || null;
  const latestAt = Number(latest.receivedAt || 0) || null;

  let severity = 'green';
  const reasons = [];
  if (!turns.length) {
    severity = 'yellow';
    reasons.push('no ccxray telemetry');
  }
  if (Number.isFinite(ctxPct)) {
    if (ctxPct > 80) severity = 'red';
    else if (ctxPct > 40 && severity === 'green') severity = 'yellow';
  }
  if (failures >= 2) {
    severity = 'red';
    reasons.push(`fail ${failures}x`);
  } else if (failures === 1) {
    if (severity === 'green') severity = 'yellow';
    reasons.push('fail 1x');
  }
  if (status === 'blocked') {
    severity = 'red';
    reasons.push('blocked');
  } else if (status === 'done' && severity === 'green') {
    severity = 'ready';
  }
  if (cacheDropped) {
    if (severity === 'green') severity = 'yellow';
    reasons.push('cache dropped after prompt change');
  }

  let action = null;
  if (!turns.length) action = 'relaunch via ccxray';
  else if (status === 'blocked' || failures >= 2) action = 'inspect last error';
  else if (Number.isFinite(ctxPct) && ctxPct > 80) action = 'compact or start fresh';
  else if (cacheDropped) action = 'inspect prompt/tool diff';
  else if (failures === 1) action = 'inspect failed tool';
  else if (Number.isFinite(ctxPct) && ctxPct > 40) action = 'checkpoint soon';
  else if (severity === 'ready') action = 'review output';

  const exactCost = turns.length > 0 && turns.every(turn => turn.cost?.confidence === 'exact');
  const subagents = subagentSummary(opts.subagentTurns || [], nowMs);
  const totalCost = cost + Number(subagents?.cost || 0);
  const exactTotalCost = exactCost && (!subagents || subagents.exactCost);
  const mainToolCalls = Object.values(observedToolCalls(turns))
    .reduce((sum, count) => sum + Number(count || 0), 0);
  const allTurns = [...turns, ...(opts.subagentTurns || [])]
    .sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
  const observedStartedAt = Number(allTurns[0]?.receivedAt || 0) || null;
  const observedLatestAt = Number(allTurns.at(-1)?.receivedAt || 0) || null;
  const totalRecentCost = recentCost + Number(subagents?.recentCost || 0);
  const exactRecentCost = recentTurns.every(turn => turn.cost?.confidence === 'exact')
    && (!subagents || subagents.exactRecentCost);
  return {
    paneId,
    workspaceId: agent?.workspace_id || null,
    tabId: agent?.tab_id || null,
    status,
    agent: agent?.display_agent || agent?.agent || latest.agentType || latest.agent || shortModel(latest.model),
    model: dominantModel(turns, latest.model),
    sessionId: latest.sessionId || null,
    sessionRole: opts.sessionRole || null,
    sessionSelectedBy: opts.sessionSelectedBy || null,
    subagents,
    mapping,
    severity,
    reasons,
    action,
    turns: turns.length,
    ctxPct,
    ctxDelta,
    cost,
    totalCost,
    recentCost,
    totalRecentCost,
    exactRecentCost,
    exactCost,
    exactTotalCost,
    cachePct: sessionCachePercent(turns),
    mainToolCalls,
    toolCalls: mainToolCalls + Number(subagents?.toolCalls || 0),
    failures,
    failureCoverage,
    hashChanged,
    cacheDropped,
    capabilities: capabilityPortfolio(turns, {
      env: opts.env,
      cache: opts.toolSchemaCache,
    }),
    startedAt: Number(first.receivedAt || 0) || null,
    latestAt,
    observedStartedAt,
    observedLatestAt,
    sessionAge: observedStartedAt ? formatAge(nowMs - observedStartedAt) : 'unknown',
    durationMs: allTurns.length > 1 && observedStartedAt && observedLatestAt
      ? Math.max(0, observedLatestAt - observedStartedAt)
      : 0,
    freshness: latestAt ? formatAge(nowMs - latestAt) : 'none',
  };
}

function missionControlSnapshot(opts = {}) {
  const env = opts.env || process.env;
  const nowMs = Number(opts.nowMs || env.CCXRAY_HERDR_NOW_MS) || Date.now();
  const unscopedEntries = opts.entries || readIndexTailEntries({ env, maxBytes: opts.maxBytes });
  const scoped = filterEntriesToWorkspace(unscopedEntries, env);
  const entries = scoped.entries;
  const report = opts.agentReport || herdrAgentReport({ env, timeoutMs: opts.timeoutMs });
  const reportedAgents = report.ok ? report.agents : [];
  const agents = scoped.scope.workspaceId
    ? reportedAgents.filter(agent => agent.workspace_id === scoped.scope.workspaceId)
    : reportedAgents;
  const maxRows = clampNumber(opts.maxRows || env.CCXRAY_MISSION_MAX_ROWS, 1, 200) || 100;
  const toolSchemaCache = new Map();
  const rows = [];

  if (agents.length) {
    for (const agent of agents) {
      const candidates = paneTelemetryCandidates(entries, agent);
      const telemetry = paneSessionTelemetry(candidates.entries, agent);
      rows.push(missionControlRow(telemetry.turns, agent, nowMs, candidates.mapping, {
        env,
        toolSchemaCache,
        subagentTurns: telemetry.subagentTurns,
        sessionRole: telemetry.sessionRole,
        sessionSelectedBy: telemetry.selectedBy,
      }));
    }
  } else {
    const bySession = new Map();
    for (const entry of entries) {
      if (!entry.sessionId || entry.sessionId === 'direct-api') continue;
      if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, []);
      bySession.get(entry.sessionId).push(entry);
    }
    for (const turns of bySession.values()) {
      turns.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
      rows.push(missionControlRow(turns, null, nowMs, 'recent', { env, toolSchemaCache }));
    }
  }

  const rank = { red: 0, yellow: 1, ready: 2, green: 3 };
  rows.sort((a, b) => (
    rank[a.severity] - rank[b.severity]
    || (b.latestAt || 0) - (a.latestAt || 0)
  ));
  const visibleRows = rows.slice(0, maxRows);
  return {
    source: agents.length ? 'agents' : 'recent',
    herdrOk: report.ok,
    rows: visibleRows,
    totalRows: rows.length,
    attention: rows.filter(row => row.severity !== 'green').length,
    recentCost: rows.reduce((sum, row) => sum + row.totalRecentCost, 0),
    exactRecentCost: rows.every(row => row.exactRecentCost),
    nowMs,
    scope: scoped.scope,
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

function cwdInsidePlugin(cwd, env = process.env) {
  if (!cwd) return false;
  const root = path.resolve(pluginRoot(env));
  const candidate = path.resolve(cwd);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function recoverWorkspaceCwd(workspaceId, env = process.env) {
  if (!workspaceId) return null;
  const result = runHerdr(['pane', 'list'], { env, timeoutMs: 1200 });
  if (result.status !== 0 || result.error) return null;
  const data = parseJsonOutput(result.stdout);
  const panes = data?.result?.panes || [];
  const candidates = panes.filter(pane => pane.workspace_id === workspaceId
    && pane.cwd
    && !cwdInsidePlugin(pane.cwd, env));
  candidates.sort((left, right) => {
    const leftRoot = /:p1$/.test(left.pane_id || '') ? 0 : 1;
    const rightRoot = /:p1$/.test(right.pane_id || '') ? 0 : 1;
    return leftRoot - rightRoot;
  });
  return candidates[0]?.cwd || null;
}

function currentWorkspaceScope(env = process.env) {
  const runtime = herdrRuntime(env);
  const context = runtime.context || {};
  const workspaceId = runtime.workspaceId || context.workspace_id || null;
  const reportedCwd = context.focused_pane_cwd || context.workspace_cwd || null;
  // A cwd inside the plugin's own checkout is never a project directory: it is
  // replaced on every reinstall. When recovery finds no workspace pane, report
  // no cwd rather than handing the plugin checkout to a caller that would launch
  // an agent in it (launch-agent.js).
  const cwd = (!reportedCwd || cwdInsidePlugin(reportedCwd, env))
    ? recoverWorkspaceCwd(workspaceId, env) || (cwdInsidePlugin(reportedCwd, env) ? null : reportedCwd)
    : reportedCwd;
  if (!workspaceId && !cwd) return { kind: 'global', workspaceId: null, cwd: null };
  return { kind: 'workspace', workspaceId, cwd };
}

function dedupeObservedEntries(entries) {
  const unique = [];
  const indexes = new Map();
  const score = entry => (entry.agentId ? 4 : 0)
    + (!entry.imported ? 2 : 0)
    + (entry.responseMetadata ? 1 : 0);

  for (const entry of entries) {
    const responseId = entry.responseId || entry.responseMetadata?.id;
    const key = responseId ? `${entry.sessionId || ''}:${responseId}` : null;
    if (!key || !indexes.has(key)) {
      if (key) indexes.set(key, unique.length);
      unique.push(entry);
      continue;
    }
    const index = indexes.get(key);
    if (score(entry) > score(unique[index])) unique[index] = entry;
  }
  return unique;
}

function filterEntriesToWorkspace(entries, env = process.env) {
  const scope = currentWorkspaceScope(env);
  if (scope.kind === 'global') return { entries: dedupeObservedEntries(entries), scope };
  const agentPrefix = scope.workspaceId ? `herdr:${scope.workspaceId}:` : null;
  const filtered = entries.filter(entry => {
    const agentId = String(entry.agentId || '');
    if (agentId.startsWith('herdr:')) return Boolean(agentPrefix && agentId.startsWith(agentPrefix));
    return Boolean(scope.cwd && entry.cwd === scope.cwd);
  });
  return {
    scope,
    entries: dedupeObservedEntries(filtered),
  };
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

function pluginStateDir(env = process.env) {
  return env.HERDR_PLUGIN_STATE_DIR
    || path.join(env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray'), 'herdr-plugin');
}

function routedPanePath(paneId, env = process.env) {
  if (!paneId) return null;
  return path.join(pluginStateDir(env), 'routed-panes-v1', `${encodeURIComponent(paneId)}.json`);
}

function recordRoutedPane(paneId, agent, env = process.env) {
  const file = routedPanePath(paneId, env);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ paneId, agent, routedAt: Date.now() })}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return true;
}

function routedPaneKnown(paneId, env = process.env, maxAgeMs = 5 * 60000) {
  const file = routedPanePath(paneId, env);
  if (!file) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.paneId === paneId
      && Number.isFinite(saved.routedAt)
      && Date.now() - saved.routedAt <= maxAgeMs;
  } catch {
    return false;
  }
}

function forgetRoutedPane(paneId, env = process.env) {
  const file = routedPanePath(paneId, env);
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

function reportPaneTokens(tokens, opts = {}) {
  const env = opts.env || process.env;
  if (!env.HERDR_PANE_ID) return { ok: false, reason: 'HERDR_PANE_ID is not set' };
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const args = ['pane', 'report-metadata', env.HERDR_PANE_ID, '--source', 'ccxray'];
  if (opts.agent) args.push('--agent', String(opts.agent));
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
  backupConfigFile,
  capabilityPortfolio,
  capabilityReview,
  currentWorkspaceScope,
  findRepoRoot,
  filterEntriesToWorkspace,
  forgetRoutedPane,
  contextBand,
  contextSidebarColumns,
  formatMoney,
  formatPercent,
  formatContextBar,
  herdrAgentReport,
  herdrRuntime,
  missionControlSnapshot,
  parseJsonOutput,
  parseStatus,
  pluginStateDir,
  pluginRoot,
  readIndexTailEntries,
  recordRoutedPane,
  reportPaneTokens,
  reportWorkspaceTokens,
  resolveCcxrayCommand,
  resolveHerdrConfigPath,
  routedPaneKnown,
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
