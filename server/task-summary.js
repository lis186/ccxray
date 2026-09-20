'use strict';

// Aggregation behind GET /_api/task-summary. Pure over an entries array so the
// arithmetic is testable without a server.
//
// Entry `usage` is already canonical by the time it reaches the store: the
// OpenAI-wire parser subtracts cached tokens from input_tokens
// (normalizeUsageForProvider), so for every provider
//   input_tokens  = uncached input
//   cache_read_input_tokens / cache_creation_input_tokens = cache traffic
// and the four fields are disjoint. The per-entry total is therefore their sum;
// never trust a provider's own total_tokens here — OpenAI's counts cached input
// inside input, which would double it against the canonical fields.

function tokenBucket() {
  return { input: 0, output: 0, cache_read: 0, cache_create: 0, reasoning: 0, total: 0 };
}

function entryTokens(usage) {
  const u = usage || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  // Reasoning is a subset of output, reported for visibility — not added to total.
  const reasoning = u.output_tokens_details?.reasoning_tokens || 0;
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_create: cacheCreate,
    reasoning,
    total: input + output + cacheRead + cacheCreate,
  };
}

function addTokens(bucket, tokens) {
  for (const key of Object.keys(bucket)) bucket[key] += tokens[key];
}

function addCounts(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [name, count] of Object.entries(source)) {
    target[name] = (target[name] || 0) + (typeof count === 'number' ? count : 1);
  }
}

function cacheHitRate(tokens) {
  const denom = tokens.input + tokens.cache_read + tokens.cache_create;
  return denom > 0 ? Math.round((tokens.cache_read / denom) * 1000) / 1000 : 0;
}

function roundUsd(value) {
  return Math.round(value * 10000) / 10000;
}

// An entry that declared its project must match exactly. One that did not (a
// header-only integrator that sent no project) falls back to its cwd, matched
// as a whole PATH SEGMENT: a substring test would let `ipadpos` swallow a
// worker running in `…/ipadpos-web`.
function matchesProject(entry, project) {
  if (!project) return true;
  if (entry.taskProject) return entry.taskProject === project;
  if (!entry.cwd) return true;
  return String(entry.cwd).split(/[\\/]+/).includes(project);
}

function summarizeTask(entries, { task, role = null, project = null } = {}) {
  const tokens = tokenBucket();
  const byRole = {};
  const tools = {};
  const skills = {};
  const models = new Set();
  const agents = new Set();
  const sessions = new Set();
  let calls = 0;
  let cost = 0;
  let toolFailures = 0;
  let firstTs = null;
  let lastTs = null;

  for (const e of entries || []) {
    if (!e || e.task !== task) continue;
    if (role && e.role !== role) continue;
    if (!matchesProject(e, project)) continue;

    calls += 1;
    const t = entryTokens(e.usage);
    addTokens(tokens, t);
    const entryCost = e.cost && typeof e.cost.cost === 'number' ? e.cost.cost : 0;
    cost += entryCost;

    const roleKey = e.role || 'unattributed';
    const r = byRole[roleKey] || (byRole[roleKey] = { calls: 0, cost: 0, tokens: tokenBucket() });
    r.calls += 1;
    r.cost += entryCost;
    addTokens(r.tokens, t);

    // Per-turn fields are preferred: toolCalls/toolFail are cumulative over the
    // request history and would count one tool call once per later turn (#427).
    if (e.turnToolFail ?? e.toolFail) toolFailures += 1;
    addCounts(tools, e.turnToolCalls || e.toolCalls);
    addCounts(skills, e.skillCalls);

    if (e.model) models.add(e.model);
    if (e.agent) agents.add(e.agent);
    if (e.sessionId) sessions.add(e.sessionId);
    if (Number.isFinite(e.receivedAt)) {
      if (firstTs === null || e.receivedAt < firstTs) firstTs = e.receivedAt;
      if (lastTs === null || e.receivedAt > lastTs) lastTs = e.receivedAt;
    }
  }

  const by_role = {};
  for (const [name, r] of Object.entries(byRole)) {
    by_role[name] = {
      calls: r.calls,
      cost_usd: roundUsd(r.cost),
      tokens: r.tokens,
      cache_hit_rate: cacheHitRate(r.tokens),
    };
  }

  return {
    task,
    role: role || null,
    project: project || null,
    calls,
    cost_usd: roundUsd(cost),
    tokens,
    cache_hit_rate: cacheHitRate(tokens),
    tools,
    tool_failures: toolFailures,
    skills,
    by_role,
    models: [...models].sort(),
    agents: [...agents].sort(),
    sessions: sessions.size,
    first_ts: firstTs,
    last_ts: lastTs,
  };
}

module.exports = { summarizeTask, entryTokens, matchesProject };
