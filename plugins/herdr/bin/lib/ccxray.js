'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
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

// A FLOOR for every CLI budget in this module, off by default.
//
// The per-call budgets (1200ms for `pane list`, 1500ms for `agent list`) are
// generous for the real herdr — a Rust binary that answers in single-digit ms —
// and deliberately tight so a hung CLI does not freeze a TUI. Under `node
// --test`, which saturates every core, a mock can miss them, and the timeout
// does NOT surface as a timeout: `herdrOk` flips false, or
// `currentWorkspaceScope` falls back to the plugin cwd, so it lands as an
// unrelated string/path assertion in another suite. Same class as the 45s load
// budget the launcher tests were given in #542.
//
// Tests set this generously (see pluginEnv in test/herdr-plugin.test.js);
// production leaves it unset and keeps the tight per-call budgets.
function timeoutFloor(env) {
  const raw = Number((env || process.env).CCXRAY_HERDR_CMD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function runCommand(command, args = [], opts = {}) {
  const env = opts.env || process.env;
  const timeout = Math.max(opts.timeoutMs || DEFAULT_TIMEOUT_MS, timeoutFloor(env));
  const result = spawnSync(command.bin, [...(command.argsPrefix || []), ...args], {
    cwd: opts.cwd || findRepoRoot(opts.env || process.env) || pluginRoot(opts.env || process.env),
    env: opts.env || process.env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
    // herdr CLI puts success JSON on stdout and error JSON on stderr. Callers
    // that only parsed stdout silently got null on failure and could not read
    // the error code (E2 retro). This field merges both so every call site
    // gets the parsed result without remembering which stream to check.
    parsed: parseJsonOutput(stdout) || parseJsonOutput(stderr),
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
  // #555: Note lines describe the port OCCUPANT, not a hub — scraping their
  // port/pid would report the occupant's identity as the hub's.
  const lines = clean.split('\n');
  const notes = lines.map(l => l.trim()).filter(l => l.startsWith('Note: '));
  const hubText = lines.filter(l => !l.trim().startsWith('Note: ')).join('\n');
  const portMatch = hubText.match(/localhost:(\d{2,5})/) || hubText.match(/\bport\s+(\d{2,5})\b/i);
  const pidMatch = hubText.match(/\bpid[:\s]+(\d+)\b/i) || hubText.match(/\bPID[:\s]+(\d+)\b/);
  const clientsMatch = hubText.match(/\bclients?[:\s]+(\d+)\b/i);
  // One machine-readable line beats scraping prose. Kept OPTIONAL: the plugin
  // can be driven by a globally-installed `ccxray` older than the line, so the
  // text fallbacks below must survive.
  let machine = null;
  const machineLine = lines.find(l => l.trim().startsWith('Machine: '));
  if (machineLine) {
    try { machine = JSON.parse(machineLine.trim().slice('Machine: '.length)); } catch { machine = null; }
  }
  return {
    machine,
    running: !noHub && Boolean(portMatch || pidMatch || /hub/i.test(clean)),
    port: portMatch ? Number(portMatch[1]) : null,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    clients: clientsMatch ? Number(clientsMatch[1]) : null,
    notes,
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

// The hub's per-session aggregate, read (never written — ADR 0019 allows a
// non-hub process to READ a derived view).
//
// Why the badge should not re-derive totals from raw index lines: it reads a
// 4 MiB tail of what is currently a 338 MiB index, so its sum is a sample, and
// even a perfectly deduped sample disagrees with the dashboard. Measured on
// session 9ea7a6d4: 135 of 156 responses in the window, $23.63 of $26.27. This
// file carries `count`, `totalCost` AND the complete ADR 0017 confidence fold
// for the session, so reading it makes the badge agree with the dashboard by
// CONSTRUCTION rather than by re-implementation — and it is O(1) in the number
// of turns instead of O(window).
//
// Despite the name it is NDJSON, one session per line. Only the matching line is
// parsed: the file is ~4 MB and the badge refresh path is hot.
function readSessionAggregate(sessionId, env = process.env) {
  if (!sessionId) return null;
  const file = path.join(resolveCcxrayLogsDir(env), 'sessions.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const at = text.indexOf(`"${sessionId}"`);
  if (at === -1) return null;
  const from = text.lastIndexOf('\n', at) + 1;
  const to = text.indexOf('\n', at);
  try {
    const row = JSON.parse(text.slice(from, to === -1 ? undefined : to));
    return row && row.sid === sessionId ? row : null;
  } catch {
    return null;
  }
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

// Herdr measures sidebar content in terminal cells, not JavaScript code units.
// Keep this deliberately dependency-free: the plugin runs from an installed
// bundle where adding a wcwidth package would make the launcher less portable.
function displayWidth(value) {
  let width = 0;
  for (const char of String(value ?? '')) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) continue;
    if (/\p{Mark}/u.test(char) || codePoint < 0x20) continue;
    if ((codePoint >= 0x1100 && codePoint <= 0x115f)
      || (codePoint >= 0x2329 && codePoint <= 0x232a)
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff01 && codePoint <= 0xff60)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
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

function orderedTurns(turns) {
  return (Array.isArray(turns) ? turns : []).slice().sort((a, b) => (
    Number(a?.receivedAt || 0) - Number(b?.receivedAt || 0)
    || String(a?.id || '').localeCompare(String(b?.id || ''))
  ));
}

function contextBand(pct) {
  if (!Number.isFinite(pct)) return 'unknown';
  if (pct <= 40) return 'green';
  if (pct <= 80) return 'yellow';
  return 'red';
}

function contextPercents(turns, win) {
  if (!win) return [];
  let previous = null;
  return orderedTurns(turns)
    .map(turn => {
      const used = contextUsed(turn);
      if (used == null || !Number.isFinite(used) || !win) return null;
      const raw = used / win * 100;
      // Prompt/cache accounting can move by a few tokens between adjacent
      // turns even though the conversation context has not reset. Drawing
      // those tiny reversals creates a false sawtooth (for example 90 → 88 →
      // 91) and makes the recent-history rail look less trustworthy. The
      // importer marks real compaction boundaries; for an unmarked sample a
      // drop of <=15 percentage points is treated as measurement jitter and
      // held at the preceding level. Larger drops remain visible as a genuine
      // reset. This mirrors the existing compaction detector's 15% token-drop
      // threshold and preserves the important compaction/reset edge case.
      const stabilized = previous != null && raw < previous && !turn.isCompacted
        && previous - raw <= 15 ? previous : raw;
      previous = stabilized;
      return stabilized;
    });
}

// The glyph buckets are intentionally coarse: they are a compact trend, not a
// second percentage readout. When several samples move materially while still
// landing in the same bucket, make the direction explicit in the scalar slot.
// Require three known samples and an 8-point net move so ordinary token-count
// jitter does not turn the badge into a noisy ticker.
function contextTrendDirection(turns, win) {
  const pcts = contextPercents(turns, win);
  const finite = pcts.filter(Number.isFinite);
  if (finite.length < 3 || !Number.isFinite(pcts.at(-1))) return '';
  const delta = finite.at(-1) - finite[0];
  if (delta >= 8) return '↑';
  if (delta <= -8) return '↓';
  return '';
}

function contextSparkline(turns, win, opts = {}) {
  const pcts = turns
    ? contextPercents(turns, win)
    : [];
  if (!pcts.some(Number.isFinite)) return '';
  const maxBars = clampNumber(opts.maxBars, 3, 32) || 4;
  const targetBars = Math.min(pcts.length, maxBars);
  const recent = pcts.slice(-targetBars);
  return recent.map(pct => Number.isFinite(pct) ? contextBlock(pct) : '░').join('');
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

// INVARIANT: count with `turnFailed`, never `turnToolFail || toolFail`. `toolFail`
// is the cumulative request-side flag; `turnToolFail` is the per-turn one (#438).
// The disjunction lets ONE historical failure mark every later turn, so a session
// whose last six turns each failed nothing reported `fail 6x` — measured on the
// live index (session 7baf1fc0: six turns, all turnToolFail:false + toolFail:true,
// buggy count 6, true count 0). `turnFailed` prefers the per-turn boolean when it
// exists and only falls back to the cumulative flag for legacy turns that have no
// per-turn evidence at all.
function toolFailureCount(turns) {
  return turns.slice(-6).filter(turnFailed).length;
}

// A quota/rate-limit REFUSAL that actually happened, counted over the same
// last-6-turn window as toolFailureCount. `status` is an index field written at
// every forward.js push site from `proxyRes.statusCode`, and a non-2xx response
// is not short-circuited before the push, so a refused turn reaches the index as
// `status: 429`. This is deliberately an OBSERVED event, not the prediction that
// `~/.ccxray/usage-status/*.json` would support: quota forecasting and reset ETAs
// are #571's surface, and mixing a forecast into an alert channel would make the
// alert fire for something that has not gone wrong yet.
function quotaRefusalCount(turns) {
  return turns.slice(-6).filter(turn => Number(turn.status) === 429).length;
}

// INVARIANT(ADR 0005 shape): every surface that answers "what is the most
// important thing about this pane right now" ranks the answers HERE. Two
// surfaces used to answer it with orderings that contradicted each other:
// the now-removed contextSignal put context above every tool failure, while the
// Mission Control action chain put `fail >= 2` above context and `cache dropped` above
// `fail == 1`. The same pane therefore read "near full" on the sidebar and
// "inspect last error" in Mission Control. A third ordering written for the
// sidebar's row-3 $alert is exactly the failure shape ADR 0005 exists to stop.
//
// `sidebarOwned` marks a tier the three-row sidebar renders in a DIFFERENT row,
// so row 3 must skip it or the layout repeats itself — the duplication this
// refactor exists to remove (row 1 owns process state, row 2 owns context).
// Mission Control is a single row with no such split, so it renders every tier.
const PANE_CONCERN_TIERS = [
  {
    kind: 'no-telemetry',
    sidebarOwned: true,
    match: s => !s.hasTelemetry,
    text: () => 'no ccxray telemetry',
    action: () => 'relaunch via ccxray',
  },
  {
    kind: 'quota-refused',
    match: s => Number(s.refusedCount) > 0,
    text: s => (Number(s.refusedCount) > 1 ? `quota refused ${s.refusedCount}x` : 'quota refused'),
    action: () => 'wait for quota reset',
  },
  {
    kind: 'blocked',
    sidebarOwned: true,
    match: s => s.status === 'blocked',
    text: () => 'blocked',
    action: () => 'inspect last error',
  },
  {
    kind: 'stale',
    match: s => Boolean(s.staleText),
    text: s => s.staleText,
    action: () => 'rescan transcripts',
  },
  {
    kind: 'fail-multi',
    match: s => Number(s.failures) >= 2,
    text: s => `fail ${Number(s.failures)}x`,
    action: () => 'inspect last error',
  },
  {
    kind: 'ctx-high',
    sidebarOwned: true,
    match: s => Number.isFinite(s.ctxPct) && s.ctxPct > 80,
    text: s => (s.ctxPct >= 90 ? 'full' : 'near full'),
    action: () => 'compact or start fresh',
  },
  {
    kind: 'fail-single',
    match: s => Number(s.failures) === 1,
    text: () => 'fail 1x',
    action: () => 'inspect failed tool',
  },
  {
    kind: 'cache-dropped',
    match: s => Boolean(s.cacheDropped),
    text: () => 'cache dropped after prompt change',
    // `brief` is the sidebar form. The spelled-out reason is 33 columns and the
    // row is 18-40, so shipping only `text` would truncate it — and truncation
    // is one of the symptoms this layout exists to remove. Mission Control has
    // the width for the full sentence and keeps using `text`.
    brief: () => 'cache dropped',
    action: () => 'inspect prompt/tool diff',
  },
  {
    kind: 'ctx-mid',
    sidebarOwned: true,
    match: s => Number.isFinite(s.ctxPct) && s.ctxPct > 40,
    text: () => null,
    action: () => 'checkpoint soon',
  },
  {
    kind: 'ready',
    sidebarOwned: true,
    match: s => Boolean(s.ready),
    text: () => null,
    action: () => 'review output',
  },
];

// A signal a caller does not have is absent, never false: Mission Control has no
// transcript comparison, so it passes no `staleText` and the stale tier is
// skipped there rather than asserted absent. Documented residual — the badge can
// report `stale` for a pane whose Mission Control row cannot.
function paneConcerns(signals = {}) {
  return PANE_CONCERN_TIERS
    .filter(tier => tier.match(signals))
    .map(tier => ({
      kind: tier.kind,
      sidebarOwned: Boolean(tier.sidebarOwned),
      text: tier.text(signals),
      brief: tier.brief ? tier.brief(signals) : tier.text(signals),
      action: tier.action(signals),
    }));
}

// The single imperative for a surface that renders every tier (Mission Control).
function paneAction(signals = {}) {
  return paneConcerns(signals)[0]?.action || null;
}

// Row 3's $alert: the top concern the sidebar does not already render elsewhere.
function paneAlert(signals = {}) {
  const concern = paneConcerns(signals).find(item => !item.sidebarOwned && item.text);
  return concern ? { kind: concern.kind, text: concern.brief } : null;
}

function formatContextBar(turns, win, ctxText, opts = {}) {
  const sidebarCols = clampNumber(opts.sidebarCols, 8, 96) || 18;
  const pctText = String(ctxText ?? '?');
  // The scalar is a fixed, right-aligned slot. Keep room for the full
  // formatted range (0–999%) plus the optional window marker so a scalar
  // width change never moves the trend endpoint.
  const scalarSlotWidth = displayWidth('999%↑✗');
  const viewportWidth = sidebarCols - scalarSlotWidth - 1;
  if (viewportWidth < 1) return pctText;
  const pcts = contextPercents(turns || [], win);
  if (!pcts.some(Number.isFinite)) return '?';
  const recent = pcts.slice(-viewportWidth);
  const trend = '░'.repeat(Math.max(0, viewportWidth - recent.length))
    + recent.map(pct => Number.isFinite(pct) ? contextBlock(pct) : '░').join('');
  const scalarPadding = ' '.repeat(Math.max(0, scalarSlotWidth - displayWidth(pctText)));
  return `${trend} ${scalarPadding}${pctText}`;
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

function knownContextSampleCount(turns) {
  return mainDisplayTurns(turns).filter(turn => contextUsed(turn) != null).length;
}

// The aggregate is complete, while the Sidebar's index read is deliberately a
// tail. If the tail contains fewer than three usable main-agent samples even
// though the persisted session is larger, ask the already-existing targeted
// repair path for its bounded sample ring. This also catches a tail containing
// only a contextless subagent row: the session is technically matched, but its
// context answer is not.
function sessionHistoryNeedsRepair(turns, aggregate) {
  const count = Number(aggregate?.count);
  const contextlessSubagent = knownContextSampleCount(turns) === 0
    && turns.some(turn => turn?.isSubagent === true);
  return contextlessSubagent || (Number.isFinite(count)
    && count > turns.length
    && knownContextSampleCount(turns) < 3);
}

function mergeRecoveredSessionSamples(turns, samples, sessionId, cwd) {
  const filtered = (Array.isArray(samples) ? samples : [])
    .filter(entry => entry?.sessionId === sessionId)
    .filter(entry => !cwd || !entry.cwd || path.resolve(entry.cwd) === path.resolve(cwd));
  return dedupeObservedEntries([...(turns || []), ...filtered]);
}

function contextUsed(entry) {
  if (entry?.contextUsageKnown === false) return null;
  if (entry?.contextUsageKnown === true
      && Number.isFinite(entry?.ctxUsed) && entry.ctxUsed >= 0) return entry.ctxUsed;
  if (Number.isFinite(entry?.ctxUsed)) return entry.ctxUsed >= 0 && entry.ctxUsed > 0 ? entry.ctxUsed : null;
  const usage = entry?.usage || {};
  const used = Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  if (!Number.isFinite(used) || used < 0) return null;
  return used > 0 || entry?.contextUsageKnown === true ? used : null;
}

function sessionWindow(turns, aggregate = null) {
  if (turns.some(t => t.beta1m) || aggregate?.beta1m === true) return 1000000;
  return Math.max(
    turns.reduce((max, t) => Math.max(max, Number(t.maxContext) || 0), 0),
    Number(aggregate?.maxContext) || 0,
  ) || 200000;
}

// Keep the badge's denominator provenance aligned with the dashboard's
// sessionCtxWindowSource four-state contract. A bare 200K window is an
// assumption for an unknown Claude deployment; an observed overflow is an
// explicit contradiction until a later import records the larger fossil.
function sessionWindowSource(turns, win = sessionWindow(turns), aggregate = null) {
  const used = turns.reduce((max, turn) => {
    const value = contextUsed(turn);
    return value == null || !Number.isFinite(value) ? max : Math.max(max, value);
  }, 0);
  if (used > win) return 'contradicted';
  if (turns.some(turn => turn.beta1m === true) || aggregate?.beta1m === true) return 'declared';
  return win === 200000 ? 'default' : 'observed';
}

function contextWindowMarker(source) {
  if (source === 'contradicted') return '✗';
  if (source === 'default') return '?';
  return '';
}

// INVARIANT: this selection deliberately DIVERGES from core's
// `isMainTurnByAgentKey()` — do not "unify" them. That predicate returns TRUE for
// exactly the shape this exists to exclude: `agentKey: 'agent'` is in
// AGENT_KEY_UNRELIABLE, so it falls back to the raw `isSubagent` flag, which a
// background conversation carries as false. Importing it here would be a no-op.
// See docs/decisions/0005-agent-key-unreliable-shared-contract.md.
//
// Core's rule is recall-oriented (never misfile a possibly-new main variant as a
// subagent); the badge needs precision (an unrecognized key must not SET the
// number). Hence: prefer turns positively identified as an interactive main
// agent, then degrade to the raw flag, then to everything — so a session run
// entirely by an unrecognized variant, by codex, or by the importer (no agentKey
// at all) behaves exactly as it did before. Never worse, by construction.
//
// Only the KEY LIST comes from core — that is the drift-prone data (it has grown
// twice: `sdk-agent`, `default`). The predicate stays here. The require is
// defensive because `findRepoRoot()` already contemplates a plugin installed
// outside a ccxray checkout, where core's file is simply absent; that degrades
// to the raw-flag tier rather than embedding a copy that would silently rot.
// ADR 0017 says formatAggCost/formatAggCostText are the ONLY way an aggregate
// cost reaches a screen. The badge and Mission Control are a separate PROCESS,
// so honouring that means requiring core's helper rather than re-deriving the
// thresholds here — the same defensive require as mainAgentKeys() below, for the
// same reason (a plugin installed outside a ccxray checkout has no core file).
//
// Degraded mode is deliberately NOT the old worst-of `~`: marking every
// non-exact total is the shape ADR 0017's panel rejected (inverted Lie Factor
// ≈357 on a 0.28%-contaminated total). Without the calibrated thresholds we
// render the number unmarked and keep only the two claims that need no
// calibration — `—` for nothing priced, `+` for an under-count.
let _sharedFormat = null;
function sharedFormat() {
  if (_sharedFormat !== null) return _sharedFormat;
  try {
    _sharedFormat = require('../../../../public/format.js');
  } catch {
    _sharedFormat = false;
  }
  return _sharedFormat;
}

// The confidence fold ADR 0017 requires. A component stream left out of this
// silently reverts the site to unmarked fabrication, so it is computed in ONE
// place and passed around whole.
function costFold(turns) {
  const fold = { count: 0, fallbackCount: 0, fallbackCost: 0, unknownCount: 0 };
  for (const turn of turns || []) {
    fold.count += 1;
    const conf = turn.cost?.confidence;
    const value = Number(turn.cost?.cost);
    if (conf === 'unknown' || !Number.isFinite(value)) {
      fold.unknownCount += 1;
      continue;
    }
    if (conf === 'fallback') {
      fold.fallbackCount += 1;
      fold.fallbackCost += value;
    }
    // exact / prefix / legacy-undefined contribute nothing: a legacy aggregate
    // renders clean, matching pre-#420 behaviour.
  }
  return fold;
}

function mergeCostFolds(...folds) {
  const out = { count: 0, fallbackCount: 0, fallbackCost: 0, unknownCount: 0 };
  for (const f of folds) {
    if (!f) continue;
    out.count += Number(f.count || 0);
    out.fallbackCount += Number(f.fallbackCount || 0);
    out.fallbackCost += Number(f.fallbackCost || 0);
    out.unknownCount += Number(f.unknownCount || 0);
  }
  return out;
}

function aggCostText(cost, fold) {
  const shared = sharedFormat();
  if (shared && typeof shared.formatAggCostText === 'function') {
    return shared.formatAggCostText(cost, fold || {});
  }
  const f = fold || {};
  const count = Number(f.count || 0);
  const unknown = Number(f.unknownCount || 0);
  if (cost == null) return '—';
  if (unknown > 0 && count - unknown === 0) return '—';
  return formatMoney(cost) + (unknown >= 1 ? '+' : '');
}

let _mainAgentKeys;
function mainAgentKeys() {
  if (_mainAgentKeys) return _mainAgentKeys;
  try {
    _mainAgentKeys = require('../../../../public/agent-classification.js').WF_MAIN_AGENT_KEYS || {};
  } catch {
    _mainAgentKeys = {};
  }
  return _mainAgentKeys;
}

// The turns the badge is allowed to read its context% and cache% from. This is a
// display fold, not a classification: it is computed at render time from
// persisted facts, is never stored, and feeds nothing that classifies a turn
// (the plugin has no isCompacted, no severity, no lane placement).
// See docs/decisions/0013-beta1m-persist-session-window-derive.md.
function mainDisplayTurns(turns) {
  const keys = mainAgentKeys();
  const positive = turns.filter(turn => keys[turn.agentKey]);
  if (positive.length) {
    // A live Codex session can begin emitting turns without an agentKey after
    // earlier turns were classified (the current index has this exact shape).
    // Keep those explicitly non-subagent turns in the main fold; otherwise the
    // latest current turn disappears and ctx% falls back to an older turn or ?.
    // Explicit non-main keys such as `agent` and `general-purpose` remain out.
    const mixed = turns.filter(turn => (
      keys[turn.agentKey]
      || (turn.agentKey == null && !turn.isSubagent)
    ));
    return mixed.length ? mixed : positive;
  }
  const notSubagent = turns.filter(turn => !turn.isSubagent);
  return notSubagent.length ? notSubagent : turns;
}

const STALE_THRESHOLD_DEFAULT_MS = 600000;

function staleThresholdMs(env = process.env) {
  const raw = Number(env.CCXRAY_BADGE_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : STALE_THRESHOLD_DEFAULT_MS;
}

// ISOLATION: this is a scan root derived from the ambient $HOME, OUTSIDE
// CCXRAY_HOME — the ADR 0015 R4 class. A test that exercises staleness must set
// CCXRAY_IMPORT_HOMES (the same knob core's importer honours) to the actual
// Claude `projects/` scan root(s), not a `.claude` config home, or it reads the
// developer's real transcripts. See docs/testing.md.
// Keep this tiny parser local instead of requiring server/importer.js: Herdr is
// a separate process and this library must remain independent of core modules.
function configuredScanRoots(rawValue) {
  const roots = [];
  const seen = new Set();
  for (const raw of String(rawValue).split(',')) {
    const value = raw.trim();
    if (!value) continue;
    const absolute = path.resolve(value);
    let resolved = absolute;
    try { resolved = fs.realpathSync(absolute); } catch {}
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

function claudeProjectRoots(env = process.env) {
  if (env.CCXRAY_IMPORT_HOMES !== undefined) {
    return configuredScanRoots(env.CCXRAY_IMPORT_HOMES);
  }
  const home = os.homedir();
  const roots = [];
  let items = [];
  try { items = fs.readdirSync(home); } catch { return roots; }
  for (const name of items) {
    if (!name.startsWith('.claude') || name.includes('.bak')) continue;
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    roots.push(path.join(home, name, 'projects'));
  }
  roots.push(path.join(home, '.config', 'claude', 'projects'));
  return roots;
}

// Claude Code names a project directory after its cwd with every character
// outside [a-zA-Z0-9] flattened to '-'. Derived by replaying all 118 cwds in the
// real index against the 184 project directories on disk: this rule reproduced
// 43, while flattening only '/' and '.' reproduced 41 — it misses '_' and '+'
// (/Users/x/dev/android_shopping really lives at -Users-x-dev-android-shopping).
// The mapping is lossy and homes are globbed, so a lookup can still legitimately
// miss; a miss must degrade to "no marker", never to a guess.
function transcriptSlug(cwd) {
  // Collapse duplicate separators and drop a trailing one first: '/a//b/' and
  // '/a/b' are the same directory to Claude Code but slug to different names,
  // and the difference is a silent miss rather than a visible error.
  const normalized = String(cwd).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptFile(sessionId, cwd, env = process.env) {
  if (!sessionId || !cwd) return null;
  const slug = transcriptSlug(cwd);
  const matches = new Map();
  for (const root of claudeProjectRoots(env)) {
    const file = path.join(root, slug, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      // Named homes can be symlinks to the same transcript tree. Collapse those
      // aliases, but never choose between two distinct files claiming one native
      // session identity merely because one is newer.
      const real = fs.realpathSync(file);
      if (!matches.has(real)) matches.set(real, { file: real, mtimeMs: stat.mtimeMs });
    } catch { /* this home does not hold the session */ }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function codexSessionRoots(env = process.env) {
  // Same parser and same presence test as the Claude side, because core's
  // discoverCodexHomes honours the same comma-list contract for CCXRAY_IMPORT_CODEX_HOMES.
  // Two differences used to live here and both were silent: the whole value was taken
  // as ONE path, so a configured list resolved to a directory literally named
  // "rootA,rootB"; and the truthy test let an explicitly EMPTY value fall through to
  // ambient discovery of $HOME/.codex*, while core reads an empty value as "import
  // nothing". An empty value is a deliberate choice by whoever set it, so it must not
  // reopen the developer's real transcripts.
  if (env.CCXRAY_IMPORT_CODEX_HOMES !== undefined) {
    return configuredScanRoots(env.CCXRAY_IMPORT_CODEX_HOMES);
  }
  const home = os.homedir();
  const roots = [];
  let items = [];
  try { items = fs.readdirSync(home); } catch { return roots; }
  for (const name of items) {
    if (!name.startsWith('.codex') || name.includes('.bak')) continue;
    if (name !== '.codex' && !name.startsWith('.codex-')) continue;
    roots.push(path.join(home, name, 'sessions'));
  }
  return roots;
}

function codexTranscriptFile(sessionId, env = process.env) {
  const compact = String(sessionId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  const createdAt = Number.parseInt(compact.slice(0, 12), 16);
  const min = Date.parse('2000-01-01T00:00:00.000Z');
  const max = Date.parse('2100-01-01T00:00:00.000Z');
  if (!Number.isFinite(createdAt) || createdAt < min || createdAt > max) return null;

  const days = new Set();
  for (const offset of [-86400000, 0, 86400000]) {
    const date = new Date(createdAt + offset);
    days.add([
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join(path.sep));
  }
  const matches = [];
  for (const root of codexSessionRoots(env)) {
    for (const day of days) {
      const dir = path.join(root, day);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || !name.includes(sessionId)) continue;
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) matches.push({ file, mtimeMs: stat.mtimeMs });
        } catch { /* disappeared during the bounded lookup */ }
      }
    }
  }
  // Multiple provider homes claiming the same native identity are ambiguous.
  // The targeted importer must not choose one by recency and attach its history
  // to the wrong pane.
  return matches.length === 1 ? matches[0] : null;
}

function repairTranscript(sessionId, cwd, agent, env = process.env) {
  const kind = String(agent || '').trim().toLowerCase();
  if (!sessionId || !cwd) return null;
  const provider = kind === 'codex' || kind.includes('codex') ? 'codex'
    : (kind === 'claude' || kind.includes('claude') ? 'claude' : null);
  if (!provider) return null;
  const found = provider === 'claude'
    ? transcriptFile(sessionId, cwd, env)
    : codexTranscriptFile(sessionId, env);
  if (!found) return null;
  return {
    provider,
    sessionId,
    cwd,
    file: found.file,
    mtimeMs: found.mtimeMs,
  };
}

// Bounded read, taken only when the mtime gate already suspects staleness. The
// bound is a real false-negative surface: a missed turn followed by more than
// this much metadata, or a single assistant line larger than it, leaves the
// newest turn outside the window and the badge stays quiet. Sized well above the
// largest trailing-metadata run observed on the real corpus rather than tuned.
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

// The newest COMPLETED turn in a transcript, by the transcript's own clock.
//
// A file mtime is not this: Claude Code appends `system`, `last-prompt`, `mode`,
// `permission-mode`, `file-history-snapshot` and `attachment` records that never
// correspond to an API request, so mtime advances on a session ccxray is
// watching perfectly. Measured over 161 locatable real sessions at the original
// 512KB bound, an mtime rule fired on 41 while only 4 had turns we had genuinely
// missed — 37 false positives, including both sessions that first looked like
// proof of the bug. At the 4MB bound the same corpus gives 8 of 194 locatable,
// still zero false positives; the ratio is the finding, not the raw counts.
//
// The turn rule is core's, verbatim (server/importer.js:165-172): an assistant
// record carrying usage with a non-zero token total and a parseable timestamp.
// Reading `obj.timestamp` also puts both sides of the comparison on the SAME
// clock — it is the very field the importer stores as `receivedAt`.
//
// The read is bounded to the file's tail, where the newest records are. A file
// whose tail holds no turn at all yields null and the badge says nothing — the
// safe direction, and the common shape behind it is a stub session that never
// completed a turn (measured at a 512KB bound: 61 of 161 sessions, all 8-84KB
// files of queue-operation/attachment/user records; the bound is 4MB now, so
// that share is a ceiling rather than a current count).
function newestTranscriptTurnMs(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
  const length = stat.size - start;
  if (length <= 0) return null;
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  let newest = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    const usage = obj.message && obj.message.usage;
    if (!usage) continue;
    if ((usage.input_tokens || 0) + (usage.output_tokens || 0) === 0) continue;
    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (newest == null || ts > newest) newest = ts;
  }
  return newest;
}

// The badge is only as fresh as the newest turn ccxray logged. A session ccxray
// stopped observing — started outside the proxy, or resumed after the hub went
// away — keeps writing its transcript while the index stands still, so the badge
// pairs a live-ticking age with numbers frozen hours ago (the reported case: a
// transcript at 89% of 1M still rendering 35%).
//
// Elapsed time ALONE cannot tell that apart from a session that simply finished
// or a user who stepped away; both are equally quiet and their numbers are still
// correct. Over the full index an elapsed-only rule fires on 4467 of 4470
// sessions — it degenerates to "always on", which is the same as off.
//
// The distinguishing fact is on disk, but it has to be read carefully: the file
// mtime is NOT it (see newestTranscriptTurnMs). Only a completed turn newer than
// our newest evidence proves we missed something. Measured over 161 locatable
// real sessions, that fired on 8 of 194 locatable — each verified by an
// independent signal: every one carries a 100%-imported index whose transcript
// holds 63 to 639 MORE completed turns than ccxray ever logged, which is exactly
// the failure this exists to surface. Zero false positives.
function evidenceStaleness(turns, nowMs, opts = {}) {
  const env = opts.env || process.env;
  const newest = turns.reduce((max, turn) => Math.max(max, Number(turn.receivedAt) || 0), 0);
  if (!newest) return null;
  const latest = turns.find(turn => Number(turn.receivedAt) === newest) || {};
  const found = transcriptFile(latest.sessionId, latest.cwd || opts.cwd, env);
  if (!found) return null;
  const thresholdMs = staleThresholdMs(env);
  // Cheap gate: normally an append sets mtime at or after the record it wrote,
  // so an mtime sitting in [newest, newest+threshold] means nothing can be ahead
  // and the healthy case never reads the file.
  //
  // "Normally" is doing work there, and the exception runs the wrong way: a
  // transcript that was copied without -p, restored from a backup, rehydrated by
  // a sync client, or touched to an older time can carry an mtime BEHIND content
  // that is hours ahead of the index — exactly the session this exists to catch.
  // So the trusted band is symmetric around our newest evidence: an mtime
  // MATERIALLY behind it (a restore, a touch, a clock set back) is unexplained
  // and falls through to the read. The band has to be symmetric rather than
  // "any negative is suspicious" — measured over 194 locatable real sessions,
  // 34 sit a few seconds to a few minutes behind for ordinary reasons, and
  // treating that as anomalous would read 34 extra files to learn nothing.
  const mtimeAhead = found.mtimeMs - newest;
  if (Math.abs(mtimeAhead) <= thresholdMs) return null;
  const turnMs = newestTranscriptTurnMs(found.file);
  if (turnMs == null) return null;
  const aheadMs = turnMs - newest;
  if (aheadMs <= thresholdMs) return null;
  // Report how old the numbers ARE, not how far the transcript ran ahead: the
  // reader needs "this is from 11h ago", and the two differ whenever the session
  // also stopped writing a while back.
  const ageMs = Math.max(0, nowMs - newest);
  return { ageMs, aheadMs, text: `stale ${formatAge(ageMs)}` };
}

function summarizeTurnGroup(turns, fallback = {}, nowMs = Date.now(), opts = {}) {
  const sorted = orderedTurns(turns);
  // Context%, cache%, and the model label read the main agent only; a second
  // conversation riding the same sessionId otherwise sets them whenever it
  // happens to finish last, so the badge oscillates with no compaction.
  // Cost, age, and the turn count stay whole-session — those are facts about
  // the session, not about one conversation inside it.
  const anchor = mainDisplayTurns(sorted);
  const latest = anchor.at(-1) || {};
  const firstTs = sorted.find(t => Number.isFinite(t.receivedAt))?.receivedAt;
  const windowCost = sorted.reduce((sum, t) => sum + (t.cost?.cost || 0), 0);
  // Prefer the hub's per-session aggregate over this window's sum: the window is
  // a 4 MiB tail of a much larger index, so its sum is a SAMPLE and disagrees
  // with the dashboard even when perfectly deduped. Turns newer than the last
  // flushed one are added on top so a live session is not stuck at the last
  // flush; they cannot double-count, being newer than everything the aggregate
  // folded. Absent aggregate (new session, missing file) → previous behaviour.
  const agg = opts.aggregate || null;
  // A row without a usable flush cursor must NOT be topped up. `|| 0` would make
  // every tail turn look post-flush and add it to a total that already counts
  // it — a legacy or partially written row would double the number rather than
  // merely lag it. No cursor → trust the aggregate alone.
  const flushedAt = agg ? Number(agg.lastReceivedAt) : NaN;
  const canTopUp = Number.isFinite(flushedAt) && flushedAt > 0;
  const postFlush = canTopUp ? sorted.filter(t => Number(t.receivedAt || 0) > flushedAt) : [];
  const cost = agg
    ? Number(agg.totalCost || 0) + postFlush.reduce((sum, t) => sum + (t.cost?.cost || 0), 0)
    : windowCost;
  const turnCount = agg ? Number(agg.count || 0) + postFlush.length : sorted.length;
  // Duration has to move with the top-up too, or a post-flush turn shows its
  // cost and its count while the elapsed time stays frozen at the last flush.
  const aggLastAt = agg
    ? Math.max(Number(agg.lastReceivedAt) || 0,
      ...postFlush.map(t => Number(t.receivedAt) || 0))
    : 0;
  const foldFromAgg = agg ? {
    count: Number(agg.count || 0),
    fallbackCount: Number(agg.fallbackCount || 0),
    fallbackCost: Number(agg.fallbackCost || 0),
    unknownCount: Number(agg.unknownCount || 0),
  } : null;
  const fold = agg
    ? mergeCostFolds(foldFromAgg, costFold(postFlush))
    : (sorted.length ? costFold(sorted) : (fallback.costAgg || {}));
  const win = sessionWindow(anchor, agg);
  const ctxWindowSource = sessionWindowSource(anchor, win, agg);
  const ctxWindowMarker = contextWindowMarker(ctxWindowSource);
  const ctxDirection = contextTrendDirection(anchor, win);
  const used = contextUsed(latest);
  const ctxPct = used != null && win ? used / win * 100 : null;
  const ctxText = ctxPct == null ? '?' : formatWholePercent(ctxPct);
  const detail = {
    ctxPct,
    ctxText,
    ctxDirection,
    ctxWindowSource,
    ctxWindowMarker,
    ctxBand: ctxWindowSource === 'default' || ctxWindowSource === 'contradicted'
      ? 'unknown'
      : contextBand(ctxPct),
  };
  // Freshness reads EVERY turn, not just the anchored ones: a subagent turn
  // logged a minute ago proves ccxray is still watching this session, even when
  // the main conversation has been quiet.
  const stale = evidenceStaleness(sorted, nowMs, opts);
  // A stale number must not keep a confident colour: the reported case rendered
  // a green 35% for a session actually sitting at 89%, so the band that says
  // "this session is fine" is precisely the part that was wrong. Owner decision
  // (2026-08-17) is to withdraw the colour and let the text carry the reason.
  //
  // Note this is the channel-INVERSE of ADR 0013's provenance markers, which
  // mark the number ('60% of 200K?') and keep colour as saturation. The badge
  // has no room for a marked number, so the colour is the only channel wide
  // enough to carry the doubt here. Do not cite ADR 0013 as endorsing this.
  //
  // Row 2 owns context and nothing else. This tail used to carry whichever alert
  // ranked highest: 'full'/'near full', which is a FOURTH encoding of the
  // percentage sitting right beside it (percentage + sparkline + colour band +
  // text), or the stale text, which row 3's $alert now carries. Both were the
  // duplication the three-row layout removes — the reported screenshot showed
  // `21% · stal…` on one row and `21% stale` on another. What stays is the one
  // context fact no other row shows: how much of it came from cache.
  //
  // A config that renders ONLY $ctx_bar therefore loses the stale WORD from this
  // tail and keeps the withdrawn colour. The reason is not lost from the token
  // set — $ctx still carries `21% stale` (refresh-badges) and $alert carries it
  // in full — but such a config must be migrated to see it as text.
  const signal = cacheHitText(anchor);
  return {
    sessionId: latest.sessionId || fallback.sessionId || null,
    ctxPct,
    ctxText,
    ctxDirection,
    ctxWindowSource,
    ctxWindowMarker,
    ctxBand: stale ? 'unknown' : detail.ctxBand,
    stale,
    // Raw alert signals, exposed so row 3's $alert ranks them through the one
    // shared list (paneConcerns) rather than re-deriving a third ordering. All
    // three read `anchor`, the same main-agent turns ctx%/cache%/model read, so
    // a subagent's failure cannot raise an alert about the main conversation.
    failures: toolFailureCount(anchor),
    cacheDropped: cacheDroppedAfterPromptChange(anchor),
    refusedCount: quotaRefusalCount(anchor),
    ctxBar: formatContextBar(anchor, win, `${ctxText}${ctxDirection}${ctxWindowMarker}`, {
      sidebarCols: opts.sidebarCols,
      signal,
    }),
    cacheText: signal,
    // The DURATION this session ran (last turn - first), not how long ago it
    // started. The two differ by however long the session has been idle — for a
    // session that started 9.9h ago and ran 2.2h, they differ by 4x — and both
    // were printed in the same terse `9.9h` / `2.2h` shape, so the badge looked
    // like it disagreed with the dashboard about the same number. Reporting the
    // duration puts every figure on this badge (cost, turns, ctx%, time) on the
    // same footing as the dashboard's session card.
    ageText: agg && aggLastAt && Number(agg.firstReceivedAt)
      ? formatAge(Math.max(0, aggLastAt - Number(agg.firstReceivedAt)))
      : (firstTs ? formatAge(nowMs - firstTs) : '?'),
    cost: (agg || sorted.length) ? cost : fallback.cost,
    // INVARIANT(ADR 0017): aggregate cost goes through the shared fold-aware
    // helper, never a bare formatMoney — see costFold/aggCostText above.
    costAgg: fold,
    costText: aggCostText(agg || sorted.length ? cost : fallback.cost, fold),
    // The label reports the LATEST main turn, the same turn ctx%/cache% above
    // read — not a plurality over the session. A plurality kept rendering the
    // pre-/model model until the new one out-counted the old: measured on the
    // real 4 MiB badge window, a median of 41 further turns (p90 132, worst
    // 400). mainDisplayTurns has already dropped subagent turns, so the noise
    // the plurality was damping is filtered upstream. Owner decision 2026-08-19.
    model: latest.model || fallback.model || 'unknown',
    turns: turnCount || fallback.turns || 0,
  };
}

function sessionSummaryDetails(data, opts = {}) {
  const top = data?.sessions?.topSessions?.[0] || {};
  const nowMs = Number(opts.nowMs || opts.env?.CCXRAY_HERDR_NOW_MS) || Date.now();
  const paneId = opts.paneId || null;
  const agentId = opts.agentId || (paneId ? `herdr:${paneId}` : null);
  // env-injection launch writes agentId from a header (X-Ccxray-Agent-Id),
  // keyed on a launchId rather than the paneId. Try both.
  const launchAgentId = opts.launchId ? `herdr:${opts.launchId}` : null;
  const nativeSessionId = opts.sessionId || null;
  // INVARIANT: dedup by responseId BEFORE anything sums. The same logical
  // response appears as several index lines (multi-instance / importer-vs-proxy,
  // ADR 0012), so a raw sum inflates cost and the turn count together. Measured
  // on session 9ea7a6d4: 297 lines / $46.35 raw vs 156 / $26.27 deduped — 1.90x
  // and 1.76x. Mission Control already dedups (it goes through
  // filterEntriesToWorkspace); this path read the index directly and did not, so
  // the sidebar badge and the dashboard disagreed on the same session while ctx%
  // — which reads ONE latest turn, not a sum — matched, making it look like a
  // rendering quirk instead of a double count.
  const allEntries = dedupeObservedEntries(readIndexTailEntries({ env: opts.env }));
  const entries = allEntries.filter(entry => entry.sessionId);
  const routed = Boolean(opts.routed)
    || (agentId && allEntries.some(entry => entry.agentId === agentId))
    || (launchAgentId && allEntries.some(entry => entry.agentId === launchAgentId));

  const unlinked = (summary, repairCandidate = null, linkReason = 'not-linked') => ({
    matched: false,
    liveLinked: false,
    historyOnly: false,
    sessionId: null,
    ctxPct: null,
    ctxText: '?',
    ctxBand: contextBand(null),
    ctxBar: emptyContextBar(opts),
    stale: null,
    ageText: '?',
    cost: null,
    costText: 'n/a',
    model: 'unknown',
    turns: 0,
    summary,
    repairCandidate,
    linkReason,
  });
  if (opts.identityConflict) {
    return unlinked('ccxray: identity conflict', null, 'identity-conflict');
  }

  let turns = [];
  if (nativeSessionId) {
    // Herdr's native session is the pane's current identity. Once it exists,
    // every fallback below is historical or ambiguous: the same pane agentId
    // survives session rotation, cwd is shared by parallel panes, and `top` is
    // global usage. None is allowed to answer for a missing native session.
    turns = entries.filter(e => e.sessionId === nativeSessionId);
  } else {
    if (agentId) turns = entries.filter(e => e.agentId === agentId);
    if (!turns.length && launchAgentId) turns = entries.filter(e => e.agentId === launchAgentId);
    if (!turns.length && top.sessionId) turns = entries.filter(e => e.sessionId === top.sessionId);
    if (!turns.length && opts.cwd) turns = entries.filter(e => e.cwd === opts.cwd);
  }

  const exactAgentMatch = (agentId && turns.some(entry => entry.agentId === agentId))
    || (launchAgentId && turns.some(entry => entry.agentId === launchAgentId));
  const nativeSessionMatch = nativeSessionId && turns.some(entry => entry.sessionId === nativeSessionId);
  const nativeAggregate = nativeSessionId ? readSessionAggregate(nativeSessionId, opts.env) : null;
  const nativeSessionMissing = nativeSessionId && !nativeSessionMatch;
  const linkMissing = Boolean(nativeSessionMissing
    || ((agentId || launchAgentId) && !exactAgentMatch && !nativeSessionMatch));
  const historyIncomplete = nativeSessionId
    && opts.allowRepair !== false
    && sessionHistoryNeedsRepair(turns, nativeAggregate);
  let repairCandidate = null;
  let repairedEvidence = null;
  let repairedSamples = null;
  let repairNeedsSamples = false;
  if (linkMissing || historyIncomplete) {
    repairCandidate = nativeSessionId && opts.allowRepair !== false
      ? repairTranscript(nativeSessionId, opts.cwd, opts.agent, opts.env)
      : null;
    // The 4 MiB Sidebar read is intentionally bounded. A targeted worker may
    // discover that this exact session is already indexed earlier in a large
    // file; its completed fingerprint caches both the newest exact row and a
    // bounded context history for this hot path.
    repairedEvidence = repairCandidate
      ? completedRepairEvidence(repairCandidate, opts.env)
      : null;
    repairedSamples = repairCandidate
      ? completedRepairSamples(repairCandidate, opts.env)
      : null;
    if (repairedSamples?.length) {
      turns = mergeRecoveredSessionSamples(turns, repairedSamples, nativeSessionId, opts.cwd);
    } else if (repairedEvidence && nativeSessionMissing) {
      // Backward compatibility for link-repair state written before the sample
      // ring existed. It still repairs linkage, while a history-incomplete
      // match below requests a one-time refresh of that old state.
      turns = [repairedEvidence];
    } else if (repairCandidate && repairedSamples === null
      && (historyIncomplete || repairedEvidence)) {
      // A completed pre-ring state proved linkage but cannot render a recovered
      // trend yet. Mark it for one migration import even when the exact row is
      // currently outside the tail and would otherwise be sufficient to link.
      repairNeedsSamples = true;
    }
    if (linkMissing && !repairedEvidence && !repairedSamples?.length) {
      const summary = nativeSessionId
        ? 'ccxray: not linked'
        : (routed ? 'ccxray: ready · send prompt' : 'ccxray: not linked');
      return unlinked(summary, repairCandidate,
        repairCandidate ? 'repairable-transcript' : 'native-session-missing');
    }
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
    // Every turn from a pane carries that pane's agentId, including turns from a
    // subagent that was given its own sessionId. Taking the most recently active
    // group therefore let a short-lived child displace the pane's own session —
    // a subagent at 95% made the pane look nearly full while its conversation sat
    // at 30%. Prefer a group that is not a child of another group we can see; if
    // the named parent is not among them there is no root to prefer, so keep the
    // old ordering rather than hiding the only session the pane has.
    const known = new Set(bySession.keys());
    const roots = groups.filter(turns => !turns.some(turn => (
      turn.parentSessionId
      && turn.parentSessionId !== (turn.sessionId || 'unknown')
      && known.has(turn.parentSessionId)
    )));
    const group = (roots.length ? roots : groups)[0];
    const sortedGroup = group.slice().sort((a, b) => (
      Number(a.receivedAt || 0) - Number(b.receivedAt || 0)
      || String(a.id || '').localeCompare(String(b.id || ''))
    ));
    const newestEvidenceAt = Math.max(...sortedGroup.map(turn => Number(turn.receivedAt) || 0));
    const newestEvidence = sortedGroup.filter(turn => (Number(turn.receivedAt) || 0) === newestEvidenceAt);
    // A resumed session may contain old proxy-observed turns followed by newer
    // transcript imports. "Has ever been live" is not "is live now": only the
    // newest exact evidence may classify the current linkage.
    const historyOnly = newestEvidence.every(turn => turn.imported === true);
    // The session this badge is actually about — look its hub-maintained
    // aggregate up so the totals match the dashboard by construction instead of
    // being re-derived from a 4 MiB sample of the index.
    const groupSid = sortedGroup.at(-1)?.sessionId || sortedGroup[0]?.sessionId || null;
    const aggregate = readSessionAggregate(groupSid, opts.env) || nativeAggregate;
    const detail = summarizeTurnGroup(sortedGroup, top, nowMs, { ...opts, aggregate });
    // The sidebar is often narrower than the signal slot, so ctx_bar drops the
    // stale text and only the dimmed band survives there. The summary has 80
    // columns and is the one place the reason is always spelled out.
    const base = `${shortModel(detail.model)}, ${detail.ageText}, ${detail.costText}`;
    const observedSummary = detail.stale ? `${base} · ${detail.stale.text}` : base;
    const summary = historyOnly
      ? `history-only · live off · ${observedSummary}`
      : observedSummary;
    return {
      ...detail,
      matched: true,
      historyOnly,
      liveLinked: !historyOnly,
      // Exact index evidence has already answered the linkage question. A stale
      // metric remains visibly stale. The short-term repair may still be
      // pending when the tail matched the session but did not contain enough
      // usable context samples; its detached importer is requested once.
      repairCandidate: repairCandidate && (repairNeedsSamples || (!repairedEvidence && !repairedSamples?.length))
        ? repairCandidate
        : null,
      repairNeedsSamples,
      summary: clip(summary, 80),
    };
  }

  const fallback = {
    sessionId: top.sessionId || null,
    ctxPct: null,
    ctxText: '?',
    ageText: top.durationMin ? formatAge(top.durationMin * 60000) : '?',
    cost: top.cost ?? data?.meta?.totalCost ?? 0,
    // INVARIANT(ADR 0017): even with no fold to show, the aggregate goes through
    // the shared helper — a bare formatMoney here is the unmarked-fabrication
    // path the ADR exists to close. An empty fold renders clean, which is the
    // honest output when no confidence data reached us.
    costText: aggCostText(top.cost ?? data?.meta?.totalCost, top.costAgg || {}),
    model: top.model || data?.models?.[0]?.model || 'unknown',
    turns: top.turns || data?.meta?.totalEntries || 0,
    ctxBar: emptyContextBar(opts),
    ctxBand: contextBand(null),
    // The fallback renders the whole-index top session, not a located one, so
    // there is no transcript to compare against — no evidence, no claim.
    stale: null,
  };
  return {
    ...fallback,
    summary: clip(`${shortModel(fallback.model)}, ${fallback.ageText}, ${fallback.costText}`, 80),
  };
}

// Fire-and-forget a single-transcript repair for a pane whose native session has
// no exact index evidence.
//
// The badge refresh is on Herdr's event path, so this must never join its
// lifecycle: detached + unref'd + stdio ignored means the child outlives this
// process and this process does not wait for transcript parsing or index I/O.
function linkRepairRetryMs(env = process.env) {
  const raw = Number(env.CCXRAY_LINK_REPAIR_RETRY_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 10 * 60 * 1000) : 30000;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function retryableRepairState(state, now, env) {
  if (!state || typeof state !== 'object') return false;
  if (state.status === 'failed') {
    return now >= (Number(state.retryAfter) || Number(state.finishedAt) + linkRepairRetryMs(env));
  }
  if (state.status !== 'requested' && state.status !== 'running') return false;
  const startedAt = Number(state.startedAt || state.requestedAt) || now;
  // The worker's own command timeout is 35s. Two minutes is therefore a hard
  // upper bound even if its pid has since been reused by an unrelated process.
  return now - startedAt >= 2 * 60 * 1000;
}

function repairFingerprint(target, stat = null) {
  let fileStat = stat;
  try { fileStat = fileStat || fs.statSync(target.file); } catch { return null; }
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: target.provider,
    sessionId: target.sessionId,
    cwd: target.cwd,
    file: path.resolve(target.file),
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  })).digest('hex');
}

function repairStateFile(target, env, stat = null) {
  const fingerprint = repairFingerprint(target, stat);
  return fingerprint
    ? path.join(pluginStateDir(env), 'link-repair-v1', `${fingerprint}.json`)
    : null;
}

function completedRepairState(target, env = process.env) {
  const file = repairStateFile(target, env);
  if (!file) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (state?.status !== 'complete') return null;
  const evidence = state.exactEvidence;
  if (!evidence || evidence.sessionId !== target.sessionId) return null;
  if (evidence.cwd && path.resolve(evidence.cwd) !== path.resolve(target.cwd)) return null;
  return state;
}

function completedRepairEvidence(target, env = process.env) {
  return completedRepairState(target, env)?.exactEvidence || null;
}

function completedRepairSamples(target, env = process.env) {
  const state = completedRepairState(target, env);
  if (!Array.isArray(state?.contextSamples)) return null;
  return state.contextSamples
    .filter(entry => entry?.sessionId === target.sessionId)
    .filter(entry => !entry.cwd || path.resolve(entry.cwd) === path.resolve(target.cwd));
}

function completedRepairEvidenceForAgent(agent, env = process.env) {
  const sessionId = agent?.agent_session?.kind === 'id' ? agent.agent_session.value : null;
  const cwd = agent?.foreground_cwd || agent?.cwd || null;
  const kind = agent?.agent || agent?.display_agent || null;
  if (!sessionId || !cwd || !kind) return null;
  const target = repairTranscript(sessionId, cwd, kind, env);
  return target ? completedRepairEvidence(target, env) : null;
}

function claimRepairState(stateFile, value, env, opts = {}) {
  const write = () => fs.writeFileSync(stateFile, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    write();
    return { ok: true };
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, reason: 'claim-failed' };
  }

  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* fail closed below */ }
  const now = Date.now();
  const missingSamples = opts.refreshSamples
    && prior?.status === 'complete'
    && !Array.isArray(prior.contextSamples);
  if (!missingSamples && !retryableRepairState(prior, now, env)) {
    return { ok: false, reason: 'already-requested' };
  }

  // Serialize expiry/retry. Without this small reclaim file, two Sidebar event
  // processes can both unlink an expired claim and one can then unlink the
  // other's fresh replacement.
  const reclaim = `${stateFile}.reclaim`;
  try { fs.writeFileSync(reclaim, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 }); }
  catch {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(reclaim, 'utf8')); } catch { /* fail closed */ }
    const ownerAt = Number(owner?.at) || now;
    if (owner && (!processAlive(Number(owner.pid)) || now - ownerAt >= 2 * 60 * 1000)) {
      // Only clear on this attempt. A later Sidebar event may claim it; not
      // recreating here prevents two stale-reclaim observers from deleting a
      // fresh reclaim file belonging to one another.
      try { fs.unlinkSync(reclaim); } catch { /* somebody else cleared it */ }
    }
    return { ok: false, reason: 'already-requested' };
  }
  try {
    try { prior = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { prior = null; }
    const stillMissingSamples = opts.refreshSamples
      && prior?.status === 'complete'
      && !Array.isArray(prior.contextSamples);
    if (!stillMissingSamples && !retryableRepairState(prior, Date.now(), env)) {
      return { ok: false, reason: 'already-requested' };
    }
    try { fs.unlinkSync(stateFile); } catch { return { ok: false, reason: 'claim-failed' }; }
    try { write(); return { ok: true }; }
    catch { return { ok: false, reason: 'claim-failed' }; }
  } finally {
    try { fs.unlinkSync(reclaim); } catch { /* another process cannot own ours */ }
  }
}

function requestImport(opts = {}) {
  const env = opts.env || process.env;
  if (env.CCXRAY_BADGE_IMPORT_DISABLE === '1') return { ok: false, reason: 'disabled' };
  const target = opts.target || {};
  if (!target.file || !target.provider || !target.sessionId || !target.cwd) {
    return { ok: false, reason: 'no-target' };
  }
  let stat;
  try { stat = fs.statSync(target.file); } catch { return { ok: false, reason: 'transcript-missing' }; }
  if (!stat.isFile()) return { ok: false, reason: 'transcript-missing' };

  const stateFile = repairStateFile(target, env, stat);
  if (!stateFile) return { ok: false, reason: 'claim-failed' };
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  } catch { return { ok: false, reason: 'claim-failed' }; }
  const claimed = claimRepairState(stateFile, {
    status: 'requested',
    requestedAt: Date.now(),
    paneId: opts.paneId || null,
    provider: target.provider,
    sessionId: target.sessionId,
  }, env, { refreshSamples: Boolean(opts.refreshSamples) });
  if (!claimed.ok) return claimed;

  const worker = path.resolve(__dirname, '..', 'repair-session-link.js');
  try {
    const child = spawn(process.execPath, [worker], {
      env: {
        ...env,
        CCXRAY_LINK_REPAIR_TARGET: JSON.stringify(target),
        CCXRAY_LINK_REPAIR_STATE: stateFile,
        CCXRAY_BADGE_IMPORT_DISABLE: '1',
      },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      try { fs.unlinkSync(stateFile); } catch { /* a later transcript version can retry */ }
    });
    child.unref();
    return { ok: true };
  } catch {
    try { fs.unlinkSync(stateFile); } catch { /* nothing to release */ }
    return { ok: false, reason: 'spawn-failed' };
  }
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

function paneTelemetryCandidates(entries, agent, env = process.env) {
  const linkedEntries = entries.filter(entry => entry.sessionId);
  const agentId = `herdr:${agent.pane_id}`;
  // A pane launched through the env-injection path stamps its traffic with a
  // launch token, not `herdr:<pane_id>` — recorded per pane in routed-panes when
  // the launch succeeds. Without matching it, such a pane has no exact match,
  // and when Herdr also reports no native session id it lands on `unlinked`:
  // "no ccxray telemetry" for a session that is being traced fine.
  const launchToken = routedPaneLaunchId(agent.pane_id, env);
  const launchAgentId = launchToken ? `herdr:${launchToken}` : null;
  const exact = linkedEntries.filter(entry => (
    entry.agentId === agentId || (launchAgentId && entry.agentId === launchAgentId)
  ));
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
    costAgg: costFold(turns),
    recentCost: recentTurns.reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0),
    exactRecentCost: recentTurns.every(turn => turn.cost?.confidence === 'exact'),
    recentCostAgg: costFold(recentTurns),
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
  const sortedTurns = orderedTurns(turns);
  const latest = sortedTurns.at(-1) || {};
  // INVARIANT(ADR 0005): this row must split main-agent figures from
  // whole-session ones exactly as `summarizeTurnGroup` does, or the two surfaces
  // report different numbers for one pane. This row's `turns` arrive filtered
  // only by raw `!isSubagent` (paneSessionTelemetry) or not at all (the
  // no-agents branch), and a Task-tool subagent turn commonly carries the
  // parent's sessionId with isSubagent false — so raw `turns` is NOT the main
  // agent. `anchor` is the same set the badge anchors on.
  //
  // ANCHORED (main agent only, must match the badge): model label, context
  // window + ctx%, cache%, tool failures, prompt-change signals.
  // WHOLE-SESSION (deliberate, also matches the badge): cost, turn count, the
  // 5m rate, and `latest`/`first` — freshness proves ccxray is still watching
  // the pane, which a subagent turn does just as well as a main one.
  //
  // Fixing only the model label (the first pass here) left ctx% reading raw
  // turns, so a `general-purpose` turn carrying isSubagent:false still moved
  // the percentage the badge refused to move.
  const anchor = mainDisplayTurns(sortedTurns);
  const mainLatest = anchor.at(-1) || latest;
  const first = sortedTurns[0] || {};
  const win = anchor.length ? sessionWindow(anchor) : 0;
  const ctxWindowSource = anchor.length ? sessionWindowSource(anchor, win) : null;
  const ctxWindowMarker = contextWindowMarker(ctxWindowSource);
  const measuredCtx = ctxWindowSource === 'declared' || ctxWindowSource === 'observed';
  const pcts = win ? contextPercents(anchor, win) : [];
  // Read the LATEST ANCHORED TURN, not the last finite percentage:
  // `contextPercents` drops turns with no usage, so `pcts.at(-1)` silently
  // reports an OLDER turn's context whenever the newest main turn carries no
  // usage. The badge reads `contextUsed(latest)` directly and shows `?` there,
  // so the two disagreed again — same class as the anchoring fix itself.
  const latestUsed = contextUsed(mainLatest);
  const ctxPct = win && latestUsed != null ? latestUsed / win * 100 : null;
  // Only meaningful when the latest turn has its own value: if ctxPct is null
  // there is no "current" to subtract a previous from.
  const previousPct = ctxPct != null
    ? pcts.slice(0, Math.max(0, anchor.length - 1)).reverse().find(Number.isFinite)
    : null;
  const ctxDelta = Number.isFinite(ctxPct) && Number.isFinite(previousPct)
    ? ctxPct - previousPct
    : null;
  const cost = sortedTurns.reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0);
  const fiveMinAgo = nowMs - 5 * 60000;
  const recentCost = sortedTurns
    .filter(turn => Number(turn.receivedAt || 0) >= fiveMinAgo)
    .reduce((sum, turn) => sum + Number(turn.cost?.cost || 0), 0);
  const recentTurns = sortedTurns.filter(turn => Number(turn.receivedAt || 0) >= fiveMinAgo);
  const failures = anchor.slice(-6).filter(turnFailed).length;
  const failureCoverage = anchor.slice(-6).filter(hasFailureCoverage).length;
  const hashChanged = promptChanged(anchor);
  const cacheDropped = cacheDroppedAfterPromptChange(anchor);
  const status = agent?.agent_status || 'recent';
  const paneId = agent?.pane_id || null;
  const latestAt = Number(latest.receivedAt || 0) || null;

  let severity = 'green';
  const reasons = [];
  if (!turns.length) {
    severity = 'yellow';
    reasons.push('no ccxray telemetry');
  }
  if (Number.isFinite(ctxPct) && measuredCtx) {
    if (ctxPct > 80) severity = 'red';
    else if (ctxPct > 40 && severity === 'green') severity = 'yellow';
  }
  if (Number.isFinite(ctxPct) && ctxWindowMarker && ctxPct > 40) {
    reasons.push(ctxWindowSource === 'contradicted'
      ? `context window contradicted ${Math.round(ctxPct)}%${ctxWindowMarker}`
      : `context window assumed ${Math.round(ctxPct)}%${ctxWindowMarker}`);
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
  // codex round 1, P2b: quota refusal must update severity/reasons, not just
  // action — otherwise MC shows a green row with `action: 'wait for quota reset'`
  // and excludes it from its attention filter.
  const refusedCount = quotaRefusalCount(anchor);
  if (refusedCount > 0) {
    severity = 'red';
    reasons.push(refusedCount > 1 ? `quota refused ${refusedCount}x` : 'quota refused');
  }

  // INVARIANT(ADR 0005 shape): the ordering lives in paneConcerns, shared with
  // the sidebar badge's row-3 $alert — see PANE_CONCERN_TIERS. This chain used to
  // rank `cache dropped` above `fail == 1` while the badge ranked every failure
  // above context, so one pane could read "near full" on the sidebar and
  // "inspect last error" here. The shared list ranks any failure above a dropped
  // cache; that swap is this chain's only behaviour change.
  const action = paneAction({
    hasTelemetry: turns.length > 0,
    refusedCount: quotaRefusalCount(anchor),
    status,
    failures,
    ctxPct: measuredCtx ? ctxPct : null,
    cacheDropped,
    ready: severity === 'ready',
  });

  const exactCost = turns.length > 0 && turns.every(turn => turn.cost?.confidence === 'exact');
  const unknownCost = turns.length > 0 && !turns.some(turn => turn.cost?.cost != null && turn.cost.confidence !== 'unknown');
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
  // ADR 0017 folds, carried alongside the sums. `total*` folds include the
  // subagent rollup because the rendered number does — omitting a component
  // stream is the documented way this silently reverts to unmarked fabrication.
  const mainCostAgg = costFold(turns);
  const totalCostAgg = mergeCostFolds(mainCostAgg, subagents?.costAgg);
  const totalRecentCostAgg = mergeCostFolds(costFold(recentTurns), subagents?.recentCostAgg);
  return {
    paneId,
    workspaceId: agent?.workspace_id || null,
    tabId: agent?.tab_id || null,
    status,
    agent: agent?.display_agent || agent?.agent || latest.agentType || latest.agent || shortModel(latest.model),
    // Same latest-MAIN-turn rule as the sidebar badge (summarizeTurnGroup,
    // which sessionSummaryDetails folds through) — see mainLatest above.
    model: mainLatest.model || 'unknown',
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
    ctxWindowSource,
    ctxWindowMarker,
    ctxDelta,
    cost,
    totalCost,
    costAgg: mainCostAgg,
    totalCostAgg,
    recentCost,
    totalRecentCost,
    totalRecentCostAgg,
    exactRecentCost,
    exactCost,
    unknownCost,
    exactTotalCost,
    cachePct: sessionCachePercent(anchor),
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
    // "seen" is EVIDENCE freshness, so it folds every turn: a subagent turn
    // logged a minute ago proves ccxray is still watching this pane just as well
    // as a main turn does, which is the reason the badge's `evidenceStaleness`
    // reads the whole session. Built from main-only `latestAt`, this row called a
    // pane stale while its subagent was actively working.
    //
    // `latestAt` is left alone for the row SORT below — a separate question this
    // does not settle. Note it is main-only only when this row came from the
    // agents branch: the no-agent fallback hands over every turn of a session
    // with no `subagentTurns`, so there `latestAt` and `observedLatestAt` are
    // the same value.
    freshness: observedLatestAt ? formatAge(nowMs - observedLatestAt) : 'none',
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
      const candidates = paneTelemetryCandidates(entries, agent, env);
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
    unknownRecentCost: rows.length > 0 && rows.every(row => row.unknownCost),
    recentCostAgg: mergeCostFolds(...rows.map(row => row.totalRecentCostAgg)),
    nowMs,
    scope: scoped.scope,
  };
}

// `pane layout.area.x` is the outer Sidebar edge, while custom agent-row
// tokens begin after Herdr's native icon/indent chrome.
const HERDR_SIDEBAR_CHROME_COLS = 4;

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
  // Herdr's layout x is the outer Sidebar width. Agent rows reserve four
  // cells for the native icon, indentation, and right-side breathing room;
  // custom tokens are rendered inside that content area. Passing the outer
  // width through makes a fixed trend fill the row and lets Herdr truncate
  // its right-aligned scalar (the percentage becomes the invisible part).
  return clampNumber(Number(inferred) - HERDR_SIDEBAR_CHROME_COLS, 8, 96) || 18;
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

function linkEvidence(entries) {
  const deduped = dedupeObservedEntries(entries || []);
  const livePaneIds = new Set();
  const sessions = new Map();
  for (const entry of deduped) {
    if (entry.imported !== true) {
      const match = String(entry.agentId || '').match(/^herdr:(.+)$/);
      if (match) livePaneIds.add(match[1]);
    }
    if (!entry.sessionId) continue;
    if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, []);
    sessions.get(entry.sessionId).push(entry);
  }

  const liveSessionIds = new Set();
  const historySessionIds = new Set();
  for (const [sessionId, turns] of sessions) {
    const newestAt = Math.max(...turns.map(turn => Number(turn.receivedAt) || 0));
    const newest = turns.filter(turn => (Number(turn.receivedAt) || 0) === newestAt);
    if (newest.some(turn => turn.imported !== true)) liveSessionIds.add(sessionId);
    else historySessionIds.add(sessionId);
  }
  return { livePaneIds, liveSessionIds, historySessionIds };
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

function recordRoutedPane(paneId, agent, env = process.env, opts = {}) {
  const file = routedPanePath(paneId, env);
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { paneId, agent, routedAt: Date.now() };
  if (opts.launchId) data.launchId = opts.launchId;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
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

function routedPaneLaunchId(paneId, env = process.env) {
  const file = routedPanePath(paneId, env);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).launchId || null;
  } catch {
    return null;
  }
}

function forgetRoutedPane(paneId, env = process.env) {
  const file = routedPanePath(paneId, env);
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

// What Herdr currently holds for a pane. `pane get` returns metadata only — it
// is not the pane's content — so this is cheap and does not touch the terminal.
function paneStateSnapshot(paneId, env) {
  if (!paneId) return null;
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const result = runCommand({ bin: herdr, argsPrefix: [] }, ['pane', 'get', paneId], {
    env,
    timeoutMs: 1500,
  });
  const pane = (parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr))?.result?.pane;
  if (!pane) return null;
  return {
    tokens: pane.tokens || {},
    stateLabels: pane.state_labels || {},
    scroll: pane.scroll || {},
    // All three of the non-token args `report-metadata` accepts. `title` and
    // `display_agent` are ABSENT from the pane object until something sets them,
    // which is why a single observation of an unset pane looked like "herdr does
    // not report these" — measured 2026-08-20 by setting each through
    // `report-metadata` and reading it back, both appear.
    agent: pane.agent ?? null,
    title: pane.title ?? null,
    displayAgent: pane.display_agent ?? null,
  };
}

// Whether a write would change anything Herdr already holds.
//
// The comparison set is DERIVED from the payload — every key we are about to
// send, plus every key we are about to clear, plus the state labels — rather
// than taken from a list of token names kept alongside it. A hand-maintained
// list is the same failure mode as ADR 0002's `sigParts`: adding a token and
// forgetting the list makes the comparison silently stop covering it, and the
// only symptom is that writes quietly resume. Deriving it cannot go stale.
//
// A snapshot we could not read means "write" — never let a failed read suppress
// a real update.
//
// The "derived from the payload" claim above was false for three of the args
// this function's caller sends: `--agent`, `--title`, `--display-agent` were
// written and never compared, so `refresh-badges` supplying a new
// `agent: event.agent` on identical tokens was silently skipped and Herdr kept
// the stale one — the exact sigParts failure the comment says deriving avoids.
//
// All three are compared now. An earlier pass compared only `agent` on the
// stated ground that `pane get` reports nothing for the other two; that was a
// negative claim drawn from ONE reading of a pane where neither was set, and it
// was wrong — both appear once something sets them. Absence in a sample is not
// absence from the schema.
function paneMetadataUnchanged(snapshot, tokens, opts = {}) {
  if (!snapshot) return false;
  for (const [arg, field] of [['agent', 'agent'], ['title', 'title'], ['displayAgent', 'displayAgent']]) {
    if (opts[arg] != null && String(snapshot[field] ?? '') !== String(opts[arg])) return false;
  }
  for (const [name, value] of Object.entries(tokens || {})) {
    if (String(snapshot.tokens[name] ?? '') !== String(value)) return false;
  }
  for (const name of opts.clearTokens || []) {
    if (snapshot.tokens[String(name)] !== undefined) return false;
  }
  for (const [status, label] of Object.entries(opts.stateLabels || {})) {
    if (String(snapshot.stateLabels[status] ?? '') !== String(label)) return false;
  }
  // A pending clear is a change. Without this the skip-write optimisation reads
  // "no token moved" and suppresses the very write that would hand row 1 back to
  // Herdr's own state text.
  if (opts.clearStateLabels && Object.keys(snapshot.stateLabels || {}).length) return false;
  return true;
}

// When we last wrote this pane's metadata. Skipping a write is only safe while
// the previous one has not expired.
function lastPaneWritePath(paneId, env) {
  const dir = pluginStateDir(env);
  if (!dir || !paneId) return null;
  return path.join(dir, 'pane-write-v1', `${encodeURIComponent(paneId)}.json`);
}

function readLastPaneWrite(paneId, env) {
  const file = lastPaneWritePath(paneId, env);
  if (!file) return 0;
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
}

function recordPaneWrite(paneId, env) {
  const file = lastPaneWritePath(paneId, env);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ at: Date.now() })}\n`);
    fs.renameSync(temp, file);
  } catch {}
}

// The session id a pane's agent is on, resolved the way the badge resolves it.
// Extracted from refresh-badges so the dashboard deep link cannot drift from the
// badge: they must agree about which session a pane IS, or `prefix+m` and the
// standalone action open different sessions for the same pane.
//
// `agent_session_known` means the context author already consulted the agent
// list for this pane — including the "no session id" answer — so re-listing
// could only repeat that answer more slowly.
function resolvePaneSessionId(opts = {}) {
  const env = opts.env || process.env;
  const context = opts.context || {};
  if (opts.eventSessionId) return opts.eventSessionId;
  if (context.agent_session?.kind === 'id') return context.agent_session.value;
  if (opts.paneId && !context.agent_session_known) {
    const agents = Array.isArray(opts.agents)
      ? opts.agents
      : herdrAgentReport({ env }).agents;
    const agent = agents.find(item => item.pane_id === opts.paneId);
    if (agent?.agent_session?.kind === 'id') return agent.agent_session.value;
  }
  return null;
}

function reportPaneTokens(tokens, opts = {}) {
  const env = opts.env || process.env;
  if (!env.HERDR_PANE_ID) return { ok: false, reason: 'HERDR_PANE_ID is not set' };
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  // Writing pane metadata is not free: Herdr re-publishes it to the pane, and a
  // full-screen agent TUI repaints when it does. `pane.agent_status_changed`
  // fires twice per turn (idle->working on submit, working->idle on completion),
  // and refresh-badges recomputes the same tokens most of the time, so an
  // unconditional write means the user pays a repaint twice per prompt for no
  // new information. Compare first; skip when nothing moved.
  if (!opts.force) {
    const snapshot = paneStateSnapshot(env.HERDR_PANE_ID, env);
    if (paneMetadataUnchanged(snapshot, tokens, opts)) {
      // Identical is not enough when the write carries a TTL: Herdr drops the
      // tokens when it lapses, so skipping every identical refresh would make
      // the badge VANISH while the agent is still working — a worse regression
      // than the repaint this guard avoids. Re-write once past half the TTL:
      // one write per half-window instead of one per event.
      const ttl = Number(opts.ttlMs) || 0;
      const since = Date.now() - readLastPaneWrite(env.HERDR_PANE_ID, env);
      if (!ttl || since < ttl / 2) {
        return { ok: true, skipped: 'unchanged' };
      }
    }
  }
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
  // Clearing is not the same as omitting: a label Herdr already holds survives a
  // report that simply does not mention it, so a pane that recovered from "not
  // linked" would keep showing it forever. Row 1's native idle/working can only
  // come back if we actively give the state text back.
  if (opts.clearStateLabels) args.push('--clear-state-labels');
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
  if (result.status === 0) recordPaneWrite(env.HERDR_PANE_ID, env);
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

// The port a standalone (non-hub) ccxray holds, read from `ccxray status`'s
// human-readable Note line (#555). Scraping English is fragile; it is here in
// ONE place so the pre-check and the readiness probe cannot disagree, and so a
// future machine-readable status field has a single site to replace.
function standalonePortFromStatus(parsed) {
  const machine = parsed && parsed.machine;
  if (machine && machine.proxy && Number(machine.port)) return Number(machine.port);
  // Fallback for a `ccxray` that predates the Machine line.
  const note = ((parsed && parsed.notes) || [])
    .find(n => /held by a standalone.*ccxray/i.test(n));
  if (!note) return null;
  const m = note.match(/port\s+(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

// Ensure a ccxray proxy is accepting connections on a known port. Returns the
// port number or null on failure. Tries (in order): the running hub, a
// standalone server on the requested PROXY_PORT, then starts one.
function ensureProxy(opts = {}) {
  const env = opts.env || process.env;
  // With PROXY_PORT set the caller asked for a SPECIFIC port. `ccxray status`
  // reads the hub lockfile, which is keyed on CCXRAY_HOME rather than on a port,
  // so a hub listening on 5577 is reported even when PROXY_PORT=5600 — and
  // returning it would route the agent to a port the user deliberately moved
  // away from. Accept a discovered proxy only when it is the requested one.
  const wanted = Number(String(env.PROXY_PORT || '').trim()) || null;
  const acceptable = port => !wanted || Number(port) === wanted;
  const status = statusReport({ env, timeoutMs: opts.timeoutMs || 5000 });
  if (status.parsed.running && status.parsed.port && acceptable(status.parsed.port)) {
    return status.parsed.port;
  }

  // A standalone (non-hub) ccxray is a perfectly good proxy even though
  // parseStatus reports running=false (it's not a hub). The Note line from #555
  // tells us which port it holds. Both the pre-check and the post-start recheck
  // must consult this — recognising standalone only BEFORE starting meant a
  // freshly started one was reported as "port could not be determined".
  const standalone = standalonePortFromStatus(status.parsed);
  if (standalone && acceptable(standalone)) return standalone;

  // Start one, DETACHED. `ccxray --no-browser` with no agent is a FOREGROUND
  // standalone server: per CLAUDE.md, a hub is forked only by `ccxray <agent>`
  // without an explicit --port, and `hubMode` comes solely from the internal
  // `--hub-mode` flag the hub gives itself. So spawnSync blocked for its whole
  // 15s timeout and then SIGTERM'd the very server it had just started, and the
  // recheck then probed for a hub that never existed — the cold-start path
  // could not succeed, and took ~17.5s to say so.
  //
  // TRADE-OFF, deliberate: a standalone has no idle shutdown (that is a hub
  // behaviour), so this leaves a proxy running after the agent exits — the same
  // thing `ccxray` in a terminal does. The pre-check above reuses it, and the
  // port is the mutex for a concurrent second launch, so at most one exists.
  const ccxray = resolveCcxrayCommand(env);
  try {
    const child = spawn(ccxray.bin, [...ccxray.argsPrefix, '--no-browser'], {
      cwd: opts.cwd || findRepoRoot(env) || pluginRoot(env),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn reports a missing/non-executable binary ASYNCHRONOUSLY; without a
    // listener that 'error' event becomes an uncaught exception and takes the
    // launcher down instead of returning a controlled failure. The readiness
    // loop below is what actually decides success, so swallowing it here is
    // correct rather than lossy.
    child.on('error', error => {
      process.stderr.write(`ccxray proxy failed to start: ${error.message}\n`);
    });
    child.unref();
  } catch (error) {
    process.stderr.write(`ccxray proxy failed to start: ${error.message}\n`);
    return null;
  }

  // Readiness probe: a hub writes its lockfile, a standalone only starts
  // listening, so accept either.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    spawnSync('sleep', ['0.5']);
    const recheck = statusReport({ env, timeoutMs: 3000 });
    if (recheck.parsed.running && recheck.parsed.port && acceptable(recheck.parsed.port)) {
      return recheck.parsed.port;
    }
    const port = standalonePortFromStatus(recheck.parsed);
    if (port && acceptable(port)) return port;
  }
  process.stderr.write('ccxray proxy was started but no listening port could be determined.\n');
  return null;
}

// Return the env vars needed to route an agent's API traffic through a ccxray
// proxy on the given port. These become --env flags on herdr tab create.
// The upstream auth token, asked of the CLI rather than derived here — the
// derivation lives in server/auth.js, which this plugin must not require (it can
// be installed without a ccxray checkout, and reaching into server internals
// would couple the two release cycles).
function upstreamAuthToken(env = process.env) {
  const result = runCcxray(['secret', 'upstream'], { env, timeoutMs: 4000 });
  if (result.status !== 0) return null;
  const token = String(result.stdout || '').trim().split('\n').pop().trim();
  return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : null;
}

function proxyEnvVars(agent, port, opts = {}) {
  const base = `http://localhost:${port}`;
  const agentIdHeader = opts.paneId ? `X-Ccxray-Agent-Id: herdr:${opts.paneId}` : '';
  switch (agent) {
    case 'claude': {
      // `createLaunch` in server/providers.js appends this for the wrapped
      // launch path; the env-injection path does not go through it, so without
      // it a pane launched here gets 401s from its own proxy whenever
      // CCXRAY_LOOPBACK_REQUIRE_AUTH=1. Absent token → omit the header rather
      // than send an empty one; loopback is trusted by default, so that keeps
      // working.
      //
      // Resolved INSIDE this branch: the lookup spawns `ccxray secret upstream`,
      // which can derive and persist a secret and carries a 4s timeout. Only
      // this branch consumes the token — grok has no header mechanism at all
      // and codex carries it in a model_providers block (`codexAgentArgs`) — so
      // resolving it before the switch made every grok and codex launch pay for
      // a value it then discarded.
      const authToken = opts.skipAuth ? null : upstreamAuthToken(opts.env || process.env);
      const authHeader = authToken ? `X-Ccxray-Auth: ${authToken}` : '';
      const vars = { ANTHROPIC_BASE_URL: base };
      // Same comma-joined form providers.js uses for this variable — and, like
      // providers.js, the user's own value is PREPENDED rather than replaced.
      // These become `--env KEY=VALUE` on `herdr tab create`, which overrides
      // the inherited variable outright, so assigning ours dropped an existing
      // `ANTHROPIC_CUSTOM_HEADERS="X-Existing: foo"` on the floor.
      const existing = String((opts.env || process.env).ANTHROPIC_CUSTOM_HEADERS || '').trim();
      const headers = [existing, agentIdHeader, authHeader].filter(Boolean).join(', ');
      if (headers) vars.ANTHROPIC_CUSTOM_HEADERS = headers;
      return vars;
    }
    case 'grok':
      return { GROK_CLI_CHAT_PROXY_BASE_URL: `${base}/v1` };
    case 'codex':
      return { CCXRAY_CODEX_PROXY_BASE_URL: `${base}/v1` };
    default:
      return {};
  }
}

// Codex-specific argv for herdr agent start's -- passthrough. Codex routing
// needs -c flags that set the proxy URL, not environment variables.
//
// Codex carries `X-Ccxray-Auth` through a model_providers block, NOT through a
// header env var — this mirrors `createLaunch` in server/providers.js exactly,
// including its `OPENAI_API_KEY` gate: in ChatGPT-OAuth mode codex resolves its
// provider differently, so the legacy base-url form stays the fallback there.
// Emitting only the legacy form meant a codex pane launched here got 401s from
// its own proxy whenever CCXRAY_LOOPBACK_REQUIRE_AUTH=1, while the wrapped
// launch path worked — the same env-injection gap the claude branch had.
function codexAgentArgs(port, opts = {}) {
  const env = opts.env || process.env;
  const baseUrl = `http://localhost:${port}/v1`;
  if (!opts.skipAuth && env.OPENAI_API_KEY) {
    const token = upstreamAuthToken(env);
    if (token) {
      const provider = `model_providers.ccxray={name="ccxray", base_url="${baseUrl}", `
        + `wire_api="responses", http_headers={"X-Ccxray-Auth"="${token}"}}`;
      return ['-c', provider, '-c', 'model_provider="ccxray"'];
    }
  }
  return ['-c', `openai_base_url="${baseUrl}"`, '-c', `chatgpt_base_url="${baseUrl}"`];
}

// Analysis panes open as stable new tabs. v0.4 moved them off `split`, which
// rearranged the layout the user was working in; `overlay` — a temporary
// zoomed pane that restores the previous focus on close — is the lighter shape
// most Herdr plugins use, but it has not been through the same acceptance, so
// it is opt-in. An unrecognized value falls back to the default rather than
// reaching Herdr and failing the open.
const PANE_PLACEMENTS = new Set(['tab', 'overlay', 'popup', 'split', 'zoomed']);
function panePlacement(env = process.env) {
  const requested = env.CCXRAY_HERDR_PANE_PLACEMENT;
  return PANE_PLACEMENTS.has(requested) ? requested : 'tab';
}

// Config writes go through one path: back up, write atomically, let Herdr
// validate, restore the user's own file if it rejects, then reload. The two
// sidebar scripts predate this helper and still carry their own copies; a new
// config writer must call this rather than add a third.
function writeConfigAndReload(file, before, next, opts = {}) {
  const env = opts.env || process.env;
  if (before === next) {
    if (opts.unchangedMessage) console.log(opts.unchangedMessage);
    return 0;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = fs.existsSync(file) ? backupConfigFile(file) : null;
  const tmpFile = `${file}.ccxray-tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, next);
  fs.renameSync(tmpFile, file);

  const done = () => {
    if (opts.successMessage) console.log(opts.successMessage);
    if (backup) console.log(`backup: ${backup}`);
    return 0;
  };

  if (env.CCXRAY_HERDR_SKIP_RELOAD === '1') return done();

  // env must reach runHerdr: without it these two calls resolve HERDR_BIN_PATH from
  // process.env, so a caller-supplied env was honoured for the SKIP_RELOAD gate
  // above and ignored for the binary it actually runs. That is why every
  // keybinding test set CCXRAY_HERDR_SKIP_RELOAD=1 — the reject-and-restore path
  // below could not be reached with a fake herdr, so it had no coverage at all.
  const check = runHerdr(['config', 'check'], { env, timeoutMs: 5000 });
  process.stdout.write(check.stdout || '');
  process.stderr.write(check.stderr || '');
  if (check.status !== 0 || check.error) {
    if (backup) {
      fs.copyFileSync(backup, file);
      console.error(`Herdr config check failed; restored ${backup}`);
    } else {
      fs.rmSync(file, { force: true });
      console.error('Herdr config check failed; restored the absent config');
    }
    return 1;
  }

  const reload = runHerdr(['server', 'reload-config'], { env, timeoutMs: 5000 });
  process.stdout.write(reload.stdout || '');
  process.stderr.write(reload.stderr || '');
  if (reload.status !== 0 || reload.error) {
    console.error('Config was updated, but Herdr reload failed. Restart Herdr to apply it.');
    return 1;
  }
  return done();
}

module.exports = {
  aggCostText,
  backupConfigFile,
  capabilityPortfolio,
  capabilityReview,
  claudeProjectRoots,
  completedRepairEvidenceForAgent,
  codexAgentArgs,
  contextBand,
  contextSidebarColumns,
  costFold,
  displayWidth,
  currentWorkspaceScope,
  ensureProxy,
  filterEntriesToWorkspace,
  findRepoRoot,
  forgetRoutedPane,
  emptyContextBar,
  formatContextBar,
  formatMoney,
  formatPercent,
  herdrAgentReport,
  herdrRuntime,
  linkEvidence,
  missionControlSnapshot,
  paneAction,
  paneAlert,
  paneConcerns,
  panePlacement,
  parseJsonOutput,
  parseStatus,
  pluginRoot,
  pluginStateDir,
  proxyEnvVars,
  quotaRefusalCount,
  readIndexTailEntries,
  recordRoutedPane,
  reportPaneTokens,
  resolvePaneSessionId,
  reportWorkspaceTokens,
  requestImport,
  resolveCcxrayCommand,
  resolveHerdrConfigPath,
  routedPaneKnown,
  routedPaneLaunchId,
  runCcxray,
  runHerdr,
  sessionSummary,
  sessionSummaryDetails,
  sessionWindowSource,
  shortId,
  shortModel,
  statusReport,
  stripAnsi,
  summarizeUsage,
  summarizeUsageCompact,
  summarizeUsageTiny,
  transcriptFile,
  usageReport,
  writeConfigAndReload,
};
