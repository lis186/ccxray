'use strict';

// Usage query over MERGED index data (docs/agentflow-integration.md, Architecture).
// Read-only and side-effect free on require: the agentflow report CLI runs it
// without a server, so it must not pull in modules that start timers or write.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { resolveLogsDir } = require('./paths');
const { mergeByResponseId } = require('./store');

// The proxy copy of a turn is stamped at request time and the imported copy at
// the transcript's timestamp; they differ by seconds. Reading this far past each
// end of the requested range keeps both copies together so they merge, instead
// of a lone copy surviving the time cut with only half the turn's fields.
const MERGE_MARGIN_MS = 10 * 60 * 1000;

function receivedAt(e) {
  const n = Number(e.receivedAt);
  return Number.isFinite(n) && e.receivedAt != null ? n : null;
}

async function readIndexRows({ from = -Infinity, to = Infinity, logsDir = resolveLogsDir() } = {}) {
  const indexPath = path.join(logsDir, 'index.ndjson');
  if (!fs.existsSync(indexPath)) return [];
  const lo = from - MERGE_MARGIN_MS, hi = to + MERGE_MARGIN_MS;
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(indexPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = receivedAt(e);
    if (t == null || t < lo || t >= hi) continue;
    rows.push(e);
  }
  return rows;
}

// Codex (and other non-Anthropic) turns carry no responseId, so a proxy copy and
// an imported copy of the same turn cannot be merged. Until a tested
// reconciliation key exists, each such session is read from ONE source: the
// proxy if it recorded the session, otherwise the import.
function oneSourcePerSession(rows) {
  const proxied = new Set();
  for (const e of rows) if (e.provider !== 'anthropic' && !e.imported && e.sessionId) proxied.add(e.sessionId);
  const sources = {};
  const kept = rows.filter(e => {
    if (e.provider === 'anthropic' || !e.sessionId) return true;
    const fromProxy = proxied.has(e.sessionId);
    sources[e.sessionId] = fromProxy ? 'proxy' : 'import';
    return fromProxy ? !e.imported : true;
  });
  return { rows: kept, sources };
}

// Claude Code's worktree-isolated Task agents run here. A host is never launched
// in one, and legacy imported subagent rows carry no flag that says so.
const AGENT_WORKTREE = /\/\.claude\/worktrees\/agent-[^/]+\/?$/;

// A proxy row recorded before #640 has `cwd: null`. Merging gives it the path of
// its imported twin; a proxy-only row (prompt suggestion, title generation) has
// no twin and takes its session's cwd: the most frequent host cwd. A session is
// launched in one directory, and the transcript cwd leaves it only for a shell
// `cd`, so the nearest row in time is exactly the one most likely to be off.
// Ties go to the earliest-seen cwd, then the lexically smallest, so the result
// does not depend on index order.
function sessionCwd(sessionRows) {
  const stats = new Map();
  for (const e of sessionRows) {
    if (!e.cwd || e.cwdFromSession || e.isSubagent === true || e.subagentId || AGENT_WORKTREE.test(e.cwd)) continue;
    const t = receivedAt(e) ?? Infinity;
    const s = stats.get(e.cwd) || { n: 0, first: Infinity };
    s.n++;
    if (t < s.first) s.first = t;
    stats.set(e.cwd, s);
  }
  let best = null;
  for (const [cwd, s] of stats) {
    if (!best || s.n > best.s.n || (s.n === best.s.n && (s.first < best.s.first || (s.first === best.s.first && cwd < best.cwd)))) best = { cwd, s };
  }
  return best ? best.cwd : null;
}

function fillSessionCwd(rows) {
  const bySession = new Map();
  for (const e of rows) {
    if (!e.sessionId) continue;
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }
  // Decide every session before filling any row, so a filled cwd never becomes
  // evidence for the next one.
  const cwdBySession = new Map();
  for (const [sid, sessionRows] of bySession) cwdBySession.set(sid, sessionCwd(sessionRows));
  for (const e of rows) {
    if (e.cwd || !e.sessionId) continue;
    const cwd = cwdBySession.get(e.sessionId);
    if (cwd) { e.cwd = cwd; e.cwdFromSession = true; }
  }
  return rows;
}

// Merged rows in [from, to) ± margin, before any cwd/session selection: merging
// first is what lets a pre-#640 proxy row be selected by its twin's cwd.
async function readMergedTurns(opts = {}) {
  const raw = await readIndexRows(opts);
  // Which sources observed each turn, for the completeness label: a host turn
  // seen by both the transcript import and the proxy has a proxy twin.
  const seenBy = new Map();
  for (const e of raw) {
    if (!e.responseId) continue;
    if (!seenBy.has(e.responseId)) seenBy.set(e.responseId, new Set());
    seenBy.get(e.responseId).add(e.imported ? 'import' : 'proxy');
  }
  for (const e of raw) e.sources = e.responseId ? null : [e.imported ? 'import' : 'proxy'];
  const merged = mergeByResponseId(raw);
  for (const e of merged) if (e.responseId) e.sources = [...seenBy.get(e.responseId)].sort();
  const { rows, sources } = oneSourcePerSession(merged);
  return { turns: fillSessionCwd(rows), codexSources: sources };
}

function stripSlash(p) { return p.length > 1 ? p.replace(/\/+$/, '') : p; }

// Roots match the cwd exactly: a checkout's linked worktrees live beneath it
// (`.worktrees/x`, `.claude/worktrees/agent-*`) and are different checkouts.
function selectTurns(turns, { roots = null, from = -Infinity, to = Infinity, sessions = null } = {}) {
  const rootSet = roots && new Set(roots.map(stripSlash));
  const sessionSet = sessions && new Set(sessions);
  return turns.filter(e => {
    const t = receivedAt(e);
    if (t == null || t < from || t >= to) return false;
    if (rootSet && !(e.cwd && rootSet.has(stripSlash(e.cwd)))) return false;
    if (sessionSet && !sessionSet.has(e.sessionId)) return false;
    return true;
  });
}

function aggregate(turns) {
  const out = {
    calls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    // ADR 0017 fold; rendered through formatAggCostText, never as a bare number.
    costFold: { fallbackCost: 0, fallbackCount: 0, unknownCount: 0, count: 0 },
    models: {},
    effort: {},
    durationMs: 0,
    durationEstimated: false,
    firstAt: null,
    lastAt: null,
  };
  let measured = false;
  for (const e of turns) {
    // A row with neither a model nor usage is not a model call (the proxy also
    // records unbilled requests); it would only inflate the call count.
    if (!e.model && !e.usage) continue;
    out.calls++;
    const u = e.usage || {};
    out.tokens.input += u.input_tokens || 0;
    out.tokens.output += u.output_tokens || 0;
    out.tokens.cacheRead += u.cache_read_input_tokens || 0;
    out.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
    out.costFold.count++;
    const c = e.cost && typeof e.cost === 'object' ? e.cost : null;
    const amount = c && typeof c.cost === 'number' && Number.isFinite(c.cost)
      ? c.cost
      : (typeof e.cost === 'number' && Number.isFinite(e.cost) ? e.cost : null);
    if (c && c.confidence === 'unknown') {
      out.costFold.unknownCount++;
    } else if (amount != null) {
      out.cost += amount;
      if (c && c.confidence === 'fallback') { out.costFold.fallbackCost += amount; out.costFold.fallbackCount++; }
    } else {
      // A model call with no finite price is an under-count even when the
      // confidence object itself is absent or incomplete. Keep the fold
      // complete so the aggregate renders the ADR 0017 lower-bound marker.
      out.costFold.unknownCount++;
    }
    const model = e.model || 'unknown';
    out.models[model] = (out.models[model] || 0) + 1;
    const effort = e.effort || 'unknown';
    out.effort[effort] = (out.effort[effort] || 0) + 1;
    if (Number.isFinite(e.turnDurationMs)) { out.durationMs += e.turnDurationMs; measured = true; }
    const t = receivedAt(e);
    if (t != null) {
      if (out.firstAt == null || t < out.firstAt) out.firstAt = t;
      if (out.lastAt == null || t > out.lastAt) out.lastAt = t;
    }
  }
  // turnDurationMs is written only by interactive Claude sessions; without it,
  // executor time falls back to first-to-last turn and says so.
  if (!measured && out.firstAt != null) {
    out.durationMs = out.lastAt - out.firstAt;
    out.durationEstimated = true;
  }
  const denom = out.tokens.input + out.tokens.cacheRead + out.tokens.cacheWrite;
  out.readShare = denom ? out.tokens.cacheRead / denom : null;
  return out;
}

async function query({ roots, from, to, sessions } = {}, { logsDir } = {}) {
  const { turns, codexSources } = await readMergedTurns({ from, to, logsDir });
  const selected = selectTurns(turns, { roots, from, to, sessions });
  return { ...aggregate(selected), codexSources };
}

module.exports = {
  MERGE_MARGIN_MS,
  AGENT_WORKTREE,
  readIndexRows,
  oneSourcePerSession,
  sessionCwd,
  fillSessionCwd,
  readMergedTurns,
  selectTurns,
  aggregate,
  query,
};
